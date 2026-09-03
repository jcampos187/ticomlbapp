#!/usr/bin/env node
/**
 * grade-picks.mjs — settle pending picks against real final scores.
 *
 * Reads tracker-data/picks.json, fetches ESPN scoreboards for each
 * sport+date that has pending rows, and marks every pick whose game(s)
 * are FINAL as "W" or "L".
 *
 * - Only touches rows with status "pending" — your manual grades are
 *   never overwritten, and re-running is safe.
 * - Moneyline / Spread / Total rows grade from the final score.
 * - Strikeout props grade from the game's final box (per-pitcher Ks);
 *   if the feed has no pitcher lines the row stays pending.
 * - Parlays grade the moment ANY final leg loses (parlay is dead);
 *   a parlay wins only once every leg is final and won.
 *
 * Usage:
 *     node scripts/grade-picks.mjs            # grade everything pending
 *     node scripts/grade-picks.mjs --dry-run  # show what WOULD change
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "..", "tracker-data");
const PICKS_FILE = path.join(DATA_DIR, "picks.json");
const SCOREBOARD = (sport, date) =>
  `https://site.api.espn.com/apis/site/v2/sports/${sportPath(sport)}/scoreboard?dates=${date.replace(/-/g, "")}`;
const SUMMARY = (sport, eventId) =>
  `https://site.api.espn.com/apis/site/v2/sports/${sportPath(sport)}/summary?event=${eventId}`;

function sportPath(sport) {
  return { MLB: "baseball/mlb", NFL: "football/nfl", CFB: "football/college-football" }[sport] || "";
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const oddsNum = (s) => (s == null ? null : Number(String(s).replace(/[^0-9.+-]/g, "")) || null);

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/* ---------------------------------------------------------------- */
/* Scoreboard → structured games                                     */
/* ---------------------------------------------------------------- */

function gamesFromScoreboard(d, groupDate) {
  const out = [];
  for (const ev of d?.events || []) {
    const c = ev.competitions?.[0];
    if (!c) continue;
    const comps = c.competitors || [];
    const bySide = {};
    for (const t of comps) bySide[t.homeAway] = t;
    const both = [bySide.home, bySide.away].filter(Boolean);
    if (both.length !== 2) continue;
    const mk = (t) => ({
      name: t.team?.shortDisplayName || t.team?.displayName || "",
      full: t.team?.displayName || "",
      abbrev: t.team?.abbreviation || "",
      score: Number(t.score || 0),
      winner: !!t.winner,
    });
    out.push({
      id: ev.id,
      date: String(ev.date || "").slice(0, 10),
      group: groupDate,
      state: c.status?.type?.state,
      status: c.status?.type?.description || "",
      home: mk(bySide.home),
      away: mk(bySide.away),
    });
  }
  return out;
}

/** Best match of a team name to a game in a list; returns the game or null.
 *  A team can appear in several nearby games (doubleheaders, series), so pick
 *  deterministically: the analysis only picks upcoming games, so prefer the
 *  non-final candidate, then the one ESPN groups under the row's own date. */
function matchGame(games, team, opp, preferDate) {
  const t = norm(team);
  if (!t) return null;
  const o = norm(opp);
  const hasTeam = (side) => [side.name, side.full, side.abbrev].map(norm).includes(t);
  const hasOpp = (side) =>
    !o || [side.name, side.full, side.abbrev].map(norm).includes(o);
  const collect = (lenient) => {
    const out = [];
    for (const g of games) {
      for (const side of [g.home, g.away]) {
        if (!hasTeam(side)) continue;
        const other = side === g.home ? g.away : g.home;
        if (o && !hasOpp(other)) continue;
        if (lenient) {
          const a = [side.name, side.full, side.abbrev].map(norm).filter(Boolean);
          const b = [other.name, other.full, other.abbrev].map(norm).filter(Boolean);
          if (!a.some((n) => n.includes(t) || t.includes(n))) continue;
          if (o && !b.some((n) => n.includes(o) || o.includes(n))) continue;
        }
        out.push({ game: g, side });
      }
    }
    return out;
  };
  const uniqueOf = (arr) => {
    const seen = new Set();
    return arr.filter((s) => (seen.has(s.game.id) ? false : (seen.add(s.game.id), true)));
  };
  const pick = (arr) => {
    if (arr.length === 0) return null;
    if (arr.length === 1) return arr[0];
    if (preferDate) {
      // The analysis only picks upcoming games, so a lone non-final candidate
      // is the row's game (doubleheaders share a UTC date across two days).
      const notFinal = arr.filter((s) => s.game.state !== "post");
      if (notFinal.length === 1) return notFinal[0];
      const sameGroup = arr.filter((s) => s.game.group === preferDate);
      if (sameGroup.length === 1) return sameGroup[0];
    }
    return null;
  };
  const exact = uniqueOf(collect(false));
  if (exact.length > 0) return pick(exact);
  // Lenient pass: substring containment either way (e.g. "N Dakota St").
  return pick(uniqueOf(collect(true)));
}

/* ---------------------------------------------------------------- */
/* Pick parsing                                                       */
/* ---------------------------------------------------------------- */

function parsePick(category, pick) {
  const p = String(pick || "");
  if (category === "Moneyline") {
    const m = p.match(/^(.+?)\s+ML\s+\(([^)]*)\)\s+vs\s+(.+)$/);
    if (m) return { type: "ml", team: m[1], opp: m[3] };
    const m2 = p.match(/^(.+?)\s+ML\s+\(([^)]*)\)$/);
    if (m2) return { type: "ml", team: m2[1] };
  }
  if (category === "Spread") {
    const m = p.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)\s+vs\s+(.+)$/);
    if (m) return { type: "ats", team: m[1], line: Number(m[2]), opp: m[3] };
  }
  if (category === "Total") {
    const m = p.match(/^(.+?)\s+@\s+(.+?)\s+(Over|Under)\s+(\d+(?:\.\d+)?)$/);
    if (m) return { type: "total", teamA: m[1], teamB: m[2], dir: m[3], line: Number(m[4]) };
  }
  if (category === "Strikeout Prop") {
    const m = p.match(/^(.+?)\s+\(([^)]+)\)\s+(Over|Under)\s+(\d+(?:\.\d+)?)\s+Ks?\s+vs\s+(.+)$/);
    if (m) return { type: "k", pitcher: m[1], team: m[2], dir: m[3], line: Number(m[4]), opp: m[5] };
  }
  if (category === "Parlay") {
    const colon = p.indexOf(": ");
    const legs = (colon >= 0 ? p.slice(colon + 2) : p).split(" + ").map((s) => s.trim());
    return { type: "parlay", legs };
  }
  return null;
}

const parseLeg = (leg) => {
  let m = leg.match(/^(.+?)\s+@\s+(.+?)\s+(Over|Under)\s+(\d+(?:\.\d+)?)\s+\(([^)]*)\)$/);
  if (m) return { type: "total", teamA: m[1], teamB: m[2], dir: m[3], line: Number(m[4]) };
  m = leg.match(/^(.+?)\s+ML\s+\(([^)]*)\)$/);
  if (m) return { type: "ml", team: m[1] };
  m = leg.match(/^(.+?)\s+Over\s+(\d+(?:\.\d+)?)\s+Ks?\s+\(([^)]*)\)$/);
  if (m) return { type: "k", pitcher: m[1], line: Number(m[2]) };
  m = leg.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)\s+\(([^)]*)\)$/);
  if (m) return { type: "ats", team: m[1], line: Number(m[2]) };
  return null;
};

/* ---------------------------------------------------------------- */
/* Result computation                                                */
/* ---------------------------------------------------------------- */

/** Grade one game side vs a line/outcome. Returns "W" | "L" | "push" | null. */
function gradeMl(g) {
  const side = g.side, other = g.side === g.game.home ? g.game.away : g.game.home;
  if (g.game.state !== "post") return null;
  if (side.score > other.score) return "W";
  if (side.score < other.score) return "L";
  return "push";
}
function gradeAts(g, line) {
  const side = g.side, other = g.side === g.game.home ? g.game.away : g.game.home;
  if (g.game.state !== "post") return null;
  const margin = side.score - other.score;
  if (margin + line > 0) return "W";
  if (margin + line < 0) return "L";
  return "push";
}
function gradeTotal(g, dir, line) {
  if (g.game.state !== "post") return null;
  const total = g.game.home.score + g.game.away.score;
  if (total > line) return dir === "Over" ? "W" : "L";
  if (total < line) return dir === "Under" ? "W" : "L";
  return "push";
}

/** Count a named pitcher's strikeouts from a final game summary (null if unavailable). */
async function pitcherKs(sport, eventId, pitcherName, teamName) {
  try {
    const d = await fetchJSON(SUMMARY(sport, eventId));
    const want = norm(pitcherName);
    let found = null;
    for (const team of d.rosters || []) {
      if (teamName && norm(team.team?.displayName || team.team?.abbreviation) !== norm(teamName) &&
          norm(team.team?.abbreviation) !== norm(teamName) &&
          norm(team.team?.shortDisplayName) !== norm(teamName)) {
        // still scan all teams — teamName may not be present; pitchers carry their own team
      }
      for (const r of team.roster || []) {
        const pos = r.position?.abbreviation || "";
        const nm = norm(r.athlete?.displayName || "");
        if (pos !== "P" && pos !== "SP") continue;
        if (!nm.includes(norm(pitcherName.split(" ").pop())) && want !== nm) continue;
        const ks = (r.stats || []).find((s) => s.name === "strikeouts" || /strikeout/i.test(s.name));
        found = ks?.value;
        if (found != null) return Number(found);
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ---------------------------------------------------------------- */
/* Main                                                               */
/* ---------------------------------------------------------------- */

async function loadPicks() {
  try {
    const raw = await readFile(PICKS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.picks || [];
  } catch {
    return [];
  }
}

async function savePicks(picks) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PICKS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(picks, null, 2) + "\n", "utf8");
  await rename(tmp, PICKS_FILE);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const picks = await loadPicks();
  const pending = picks.filter((p) => p.status === "pending");
  if (pending.length === 0) {
    console.log("Nothing pending — all picks already graded.");
    return;
  }

  // ESPN groups games by US-Eastern date, but pick rows are stamped with the
  // UTC date, so a late game (e.g. 10pm ET) can be off by one day. Fetch each
  // sport's needed dates plus the day before, capped at today (ET), then match
  // games across the whole sport list (a team plays once per slate).
  const todayET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const minusOne = (d) => {
    const dt = new Date(`${d}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  };
  const fetchDates = new Set();
  for (const p of pending) {
    for (const d of [p.date, minusOne(p.date)]) if (d <= todayET) fetchDates.add(d);
  }
  const gamesByKey = new Map(); // `${sport}|${date}` -> games
  const allBySport = new Map(); // sport -> concat of every fetched date
  for (const sport of [...new Set(pending.map((p) => p.sport))]) {
    if (!sportPath(sport)) continue;
    allBySport.set(sport, []);
    for (const date of fetchDates) {
      try {
        const d = await fetchJSON(SCOREBOARD(sport, date));
        const gs = gamesFromScoreboard(d, date);
        gamesByKey.set(`${sport}|${date}`, gs);
        allBySport.get(sport).push(...gs);
      } catch (err) {
        console.error(`  ${sport} ${date}: scoreboard fetch failed — ${err.message}`);
      }
    }
  }

  let changed = 0;
  for (const row of pending) {
    if (row.date > todayET) {
      console.log(`  — ${row.date} ${row.sport} ${row.category} [${row.pick.slice(0, 60)}…] · future slate — not played yet`);
      continue;
    }
    // A team plays on consecutive days (MLB), so only search the dates that
    // could hold THIS row's game: its own date plus the day before (ESPN uses
    // ET while rows are stamped in UTC). Parlays search the whole sport.
    const games =
      row.category === "Parlay"
        ? allBySport.get(row.sport) || []
        : [
            ...(gamesByKey.get(`${row.sport}|${row.date}`) || []),
            ...(gamesByKey.get(`${row.sport}|${minusOne(row.date)}`) || []),
          ];
    const parsed = parsePick(row.category, row.pick);
    if (!parsed) continue;

    let status = null;
    let why = "";

    if (parsed.type === "ml") {
      const m = matchGame(games, parsed.team, parsed.opp, row.date);
      if (!m) { why = "game not found on slate"; }
      else if (m.game.state !== "post") { why = m.game.status; }
      else { const r = gradeMl(m); if (r === "push") { why = "push — no W/L recorded"; } else status = r; }
    } else if (parsed.type === "ats") {
      const m = matchGame(games, parsed.team, parsed.opp, row.date);
      if (!m) { why = "game not found on slate"; }
      else if (m.game.state !== "post") { why = m.game.status; }
      else { const r = gradeAts(m, parsed.line); if (r === "push") { why = "push — no W/L recorded"; } else status = r; }
    } else if (parsed.type === "total") {
      const m = matchGame(games, parsed.teamA, parsed.teamB, row.date);
      if (!m) { why = "game not found on slate"; }
      else if (m.game.state !== "post") { why = m.game.status; }
      else { const r = gradeTotal(m, parsed.dir, parsed.line); if (r === "push") { why = "push — no W/L recorded"; } else status = r; }
    } else if (parsed.type === "k") {
      const m = matchGame(games, parsed.team, parsed.opp, row.date);
      if (!m) { why = "game not found on slate"; }
      else if (m.game.state !== "post") { why = m.game.status; }
      else {
        const ks = await pitcherKs(row.sport, m.game.id, parsed.pitcher, parsed.team);
        if (ks == null) { why = "final box has no pitcher lines — grade manually"; }
        else { const over = ks > parsed.line; status = parsed.dir === "Over" ? (over ? "W" : "L") : (over ? "L" : "W"); }
      }
    } else if (parsed.type === "parlay") {
      // Parlays may reference games on later dates — search the whole sport.
      const sportGames = games;
      const legResults = [];
      for (const leg of parsed.legs) {
        const lp = parseLeg(leg);
        if (!lp) { legResults.push("unparseable"); continue; }
        if (lp.type === "ml") {
          const m = matchGame(sportGames, lp.team);
          if (!m || m.game.state !== "post") { legResults.push("pending"); continue; }
          legResults.push(gradeMl(m));
        } else if (lp.type === "ats") {
          const m = matchGame(sportGames, lp.team);
          if (!m || m.game.state !== "post") { legResults.push("pending"); continue; }
          legResults.push(gradeAts(m, lp.line));
        } else if (lp.type === "total") {
          const m = matchGame(sportGames, lp.teamA, lp.teamB);
          if (!m || m.game.state !== "post") { legResults.push("pending"); continue; }
          legResults.push(gradeTotal(m, lp.dir, lp.line));
        } else if (lp.type === "k") {
          // A leg only names the pitcher (no team), so we can't find its game
          // from the scoreboard alone — treat as pending until resolved.
          legResults.push("pending");
        }
      }
      if (legResults.includes("L")) { status = "L"; }
      else if (legResults.includes("unparseable")) { why = "unparseable leg"; }
      else if (legResults.every((r) => r === "W")) { status = "W"; }
      else if (legResults.every((r) => r === "push")) { why = "all legs pushed — grade manually"; }
      else if (legResults.some((r) => r === "push") && legResults.every((r) => r === "W" || r === "push")) { why = "has a pushed leg — grade manually"; }
      else { why = "waiting on unfinished legs"; }
    }

    if (status === "W" || status === "L") {
      if (dryRun) {
        console.log(`  would grade  ${row.date} ${row.sport} ${row.category}: ${row.pick}  → ${status}`);
      } else {
        row.status = status;
        row.gradedAt = new Date().toISOString();
      }
      changed++;
    } else {
      console.log(`  — ${row.date} ${row.sport} ${row.category} [${row.pick.slice(0, 60)}…] ${why ? "· " + why : ""}`);
    }
  }

  if (dryRun) {
    console.log(`\n${changed} pick(s) would be graded.`);
    return;
  }
  if (changed > 0) {
    await savePicks(picks);
    console.log(`\nGraded ${changed} pick(s) → saved to ${PICKS_FILE}.`);
  } else {
    console.log("\nNo pick was gradable yet — no finals among the pending rows.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
