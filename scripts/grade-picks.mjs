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
 * - Strikeout props grade via the MLB Stats API boxscore (free, no key);
 *   if the feed has no pitcher lines the row stays pending.
 * - CFB/NFL player props grade from the ESPN game summary's box score
 *   (passing/rushing/receiving yards, TDs, receptions); any player or market
 *   we can't resolve is left pending for you to grade by hand.
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

// MLB Stats API endpoints (free, no key required)
const MLB_SCHEDULE = (date) =>
  `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`;
const MLB_BOXSCORE = (gamePk) =>
  `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;

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

/* ---------------------------------------------------------------- */
/* MLB Stats API → games + pitcher Ks                                */
/* ---------------------------------------------------------------- */

/** Fetch MLB games from the statsapi for a given date. */
async function mlbGamesFromDate(date) {
  try {
    const data = await fetchJSON(MLB_SCHEDULE(date));
    const out = [];
    for (const g of data.dates?.[0]?.games || []) {
      const status = g.status?.detailedState || "";
      const state = status === "Final" ? "post" : status === "In Progress" ? "in" : "pre";
      const mk = (t) => ({
        name: t.team?.name || "",
        full: t.team?.name || "",
        abbrev: t.team?.abbreviation || "",
        score: Number(t.score || 0),
        winner: !!t.isWinner,
      });
      out.push({
        id: String(g.gamePk),
        date: g.gameDate?.slice(0, 10) || date,
        group: date,
        state,
        status,
        home: mk(g.teams.home),
        away: mlbAway(g),
        _mlbPk: g.gamePk,
      });
    }
    return out;
  } catch (err) {
    console.error(`  MLB Stats API ${date}: fetch failed — ${err.message}`);
    return [];
  }
}

function mlbAway(g) {
  const t = g.teams.away;
  return {
    name: t.team?.name || "",
    full: t.team?.name || "",
    abbrev: t.team?.abbreviation || "",
    score: Number(t.score || 0),
    winner: !!t.isWinner,
  };
}

/** Get pitcher strikeout counts from MLB Stats API boxscore. Returns Map<pitcherNameLower, Ks>. */
async function mlbPitcherKs(gamePk) {
  try {
    const data = await fetchJSON(MLB_BOXSCORE(gamePk));
    const ks = new Map();
    for (const side of ["home", "away"]) {
      const players = data.teams?.[side]?.players || {};
      for (const [, p] of Object.entries(players)) {
        const pitching = p.stats?.pitching;
        if (pitching?.strikeOuts != null) {
          const name = p.person?.fullName || "";
          ks.set(norm(name), Number(pitching.strikeOuts));
          // Also index by last name for fuzzy matching
          const parts = name.split(/\s+/);
          if (parts.length > 1) ks.set(norm(parts[parts.length - 1]), Number(pitching.strikeOuts));
        }
      }
    }
    return ks;
  } catch {
    return new Map();
  }
}

/** Box-score stat index per prop market. Keys are ESPN's machine-readable
 *  stat keys (`boxscore.players[].statistics[].keys`), which sit at the same
 *  index as the athlete's `stats` array. The human labels ("YDS", "TD") are
 *  display-only and shifting between feeds, so never key off those. */
const PROP_STATS = {
  "Passing Yards": ["passing", "passingYards"],
  "Passing TDs": ["passing", "passingTouchdowns"],
  "Rushing Yards": ["rushing", "rushingYards"],
  "Rushing TDs": ["rushing", "rushingTouchdowns"],
  "Receiving Yards": ["receiving", "receivingYards"],
  "Receiving TDs": ["receiving", "receivingTouchdowns"],
  "Receptions": ["receiving", "receptions"],
};

const summaryCache = new Map();

/** A player's stat for one prop market in a finished ESPN football game.
 *  Returns null when the game/market/player can't be resolved, so the caller
 *  leaves the row pending instead of guessing a result. */
async function footballPropStat(sport, eventId, playerName, market) {
  const spec = PROP_STATS[market];
  if (!spec) return null;
  const [group, key] = spec;

  let summary = summaryCache.get(eventId);
  if (summary === undefined) {
    try {
      summary = await fetchJSON(SUMMARY(sport, eventId));
    } catch {
      summary = null;
    }
    summaryCache.set(eventId, summary);
  }
  if (!summary) return null;

  const want = norm(playerName);
  const last = norm(String(playerName).split(/\s+/).pop());
  const lastNameHits = (rows) => rows.filter((a) => norm(a.athlete.displayName).endsWith(last));

  for (const team of summary.boxscore?.players || []) {
    for (const stat of team.statistics || []) {
      if (stat.name !== group) continue;
      const i = (stat.keys || []).indexOf(key);
      if (i < 0) continue;
      const rows = (stat.athletes || []).filter((a) => a.athlete);
      const byLast = lastNameHits(rows);
      // Exact name first; the last-name fallback only when it's unambiguous
      // (two different Joneses must not silently grade the wrong one).
      const hit =
        rows.find((a) => norm(a.athlete.displayName) === want) ||
        rows.find((a) => norm(a.athlete.shortName) === want) ||
        (byLast.length === 1 ? byLast[0] : undefined);
      if (!hit) continue;
      const raw = hit.stats?.[i];
      if (raw == null || raw === "") return null;
      const val = Number(String(raw).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(val) ? val : null;
    }
  }
  return null;
}

/** Match a pitcher name to a K count from the boxscore map. */
function lookupPitcherKs(ksMap, pitcherName) {
  const want = norm(pitcherName);
  if (ksMap.has(want)) return ksMap.get(want);
  // Try last name
  const parts = pitcherName.split(/\s+/);
  if (parts.length > 1 && ksMap.has(norm(parts[parts.length - 1])))
    return ksMap.get(norm(parts[parts.length - 1]));
  // Fuzzy: find any key that contains the pitcher's last name
  const last = norm(parts[parts.length - 1] || pitcherName);
  for (const [k, v] of ksMap) {
    if (k.includes(last) || last.includes(k)) return v;
  }
  return null;
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
        const a = [side.name, side.full, side.abbrev].map(norm).filter(Boolean);
        const other = side === g.home ? g.away : g.home;
        const b = [other.name, other.full, other.abbrev].map(norm).filter(Boolean);
        if (lenient) {
          // Lenient: substring match in either direction
          if (!a.some((n) => n.includes(t) || t.includes(n))) continue;
          if (o && !b.some((n) => n.includes(o) || o.includes(n))) continue;
        } else {
          // Exact: team/opp names must match exactly
          if (!hasTeam(side)) continue;
          if (o && !hasOpp(other)) continue;
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
      const notFinal = arr.filter((s) => s.game.state !== "post");
      if (notFinal.length === 1) return notFinal[0];
      const sameGroup = arr.filter((s) => s.game.group === preferDate);
      if (sameGroup.length === 1) return sameGroup[0];
    }
    return null;
  };
  const exact = uniqueOf(collect(false));
  if (exact.length > 0) return pick(exact);
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
  if (category === "Prop") {
    // "Matthew Stafford Over 2.5 Passing TDs (LAR)"
    const m = p.match(/^(.+?)\s+(Over|Under)\s+(\d+(?:\.\d+)?)\s+(.+?)\s+\(([^)]+)\)$/);
    if (m) return { type: "prop", player: m[1], dir: m[2], line: Number(m[3]), market: m[4], team: m[5] };
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

/** Get a pitcher's K count using the MLB Stats API boxscore. */
async function pitcherKs(sport, gamePk, pitcherName) {
  if (sport !== "MLB" || !gamePk) return null;
  const ksMap = await mlbPitcherKs(gamePk);
  return lookupPitcherKs(ksMap, pitcherName);
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

  // Fetch ESPN scoreboards for all sports
  const gamesByKey = new Map(); // `${sport}|${date}` -> games (ESPN)
  const allBySport = new Map(); // sport -> concat of every fetched date (ESPN)
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
        console.error(`  ${sport} ${date}: ESPN scoreboard fetch failed — ${err.message}`);
      }
    }
  }

  // Fetch MLB Stats API games for K prop grading
  const mlbGamesAll = []; // all MLB games from statsapi
  const mlbGamesByDate = new Map(); // date -> games
  const hasKProps = pending.some((p) => p.category === "Strikeout Prop" && p.sport === "MLB");
  if (hasKProps) {
    for (const date of fetchDates) {
      try {
        const gs = await mlbGamesFromDate(date);
        mlbGamesByDate.set(date, gs);
        mlbGamesAll.push(...gs);
      } catch (err) {
        console.error(`  MLB Stats API ${date}: fetch failed — ${err.message}`);
      }
    }
  }

  // Cache: gamePk -> pitcher Ks map (avoid re-fetching for parlays)
  const kCache = new Map();

  let changed = 0;
  for (const row of pending) {
    if (row.date > todayET) {
      console.log(`  — ${row.date} ${row.sport} ${row.category} [${row.pick.slice(0, 60)}…] · future slate — not played yet`);
      continue;
    }

    // For K props, prefer MLB Stats API matching; for everything else, use ESPN
    const isKProp = row.category === "Strikeout Prop" && row.sport === "MLB";
    const games = isKProp
      ? [
          ...(mlbGamesByDate.get(row.date) || []),
          ...(mlbGamesByDate.get(minusOne(row.date)) || []),
        ]
      : row.category === "Parlay"
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
      // For MLB K props, use MLB Stats API game matching + boxscore
      if (row.sport === "MLB") {
        // Match game from MLB Stats API list.
        // For doubleheaders, try each game until we find one with the pitcher's Ks.
        let mlbMatch = matchGame(games, parsed.team, parsed.opp, row.date);
        if (!mlbMatch) {
          // Doubleheader: matchGame returned null — find all candidate games
          // and try each one's boxscore for the pitcher.
          const candidates = [];
          const t = norm(parsed.team), o = norm(parsed.opp);
          for (const g of games) {
            for (const side of [g.home, g.away]) {
              const a = [side.name, side.full, side.abbrev].map(norm).filter(Boolean);
              if (!a.some((n) => n.includes(t) || t.includes(n))) continue;
              const other = side === g.home ? g.away : g.home;
              const b = [other.name, other.full, other.abbrev].map(norm).filter(Boolean);
              if (o && !b.some((n) => n.includes(o) || o.includes(n))) continue;
              candidates.push(g);
            }
          }
          const seen = new Set();
          const uniqueCandidates = candidates.filter(g => (seen.has(g.id) ? false : (seen.add(g.id), true)));
          for (const c of uniqueCandidates) {
            if (c.state !== "post") continue;
            const gPk = c._mlbPk || c.id;
            if (!kCache.has(gPk)) kCache.set(gPk, await mlbPitcherKs(gPk));
            const ksMap = kCache.get(gPk);
            if (lookupPitcherKs(ksMap, parsed.pitcher) != null) {
              mlbMatch = { game: c, side: c.home };
              break;
            }
          }
          // If still no match, fall back to the first candidate
          if (!mlbMatch && uniqueCandidates.length > 0) mlbMatch = { game: uniqueCandidates[0], side: uniqueCandidates[0].home };
        }
        if (!mlbMatch) {
          why = "game not found on MLB schedule";
        } else if (mlbMatch.game.state !== "post") {
          why = mlbMatch.game.status || "game not finished";
        } else {
          const gamePk = mlbMatch.game._mlbPk || mlbMatch.game.id;
          if (!kCache.has(gamePk)) {
            kCache.set(gamePk, await mlbPitcherKs(gamePk));
          }
          const ksMap = kCache.get(gamePk);
          const ks = lookupPitcherKs(ksMap, parsed.pitcher);
          if (ks == null) {
            why = "pitcher not found in boxscore — grade manually";
          } else {
            const over = ks > parsed.line;
            status = parsed.dir === "Over" ? (over ? "W" : "L") : (over ? "L" : "W");
            console.log(`  ✓ ${parsed.pitcher}: ${ks} Ks (line: ${parsed.line}) → ${status}`);
          }
        }
      } else {
        // Non-MLB sports: use ESPN (unlikely to have K props, but fallback)
        const m = matchGame(games, parsed.team, parsed.opp, row.date);
        if (!m) { why = "game not found on slate"; }
        else if (m.game.state !== "post") { why = m.game.status; }
        else {
          const ks = await pitcherKs(row.sport, m.game.id, parsed.pitcher);
          if (ks == null) { why = "final box has no pitcher lines — grade manually"; }
          else { const over = ks > parsed.line; status = parsed.dir === "Over" ? (over ? "W" : "L") : (over ? "L" : "W"); }
        }
      }
    } else if (parsed.type === "prop") {
      const m = matchGame(games, parsed.team, parsed.opp, row.date);
      if (!m) { why = "game not found on slate"; }
      else if (m.game.state !== "post") { why = m.game.status; }
      else {
        const val = await footballPropStat(row.sport, m.game.id, parsed.player, parsed.market);
        if (val == null) {
          why = `${parsed.market} not found for ${parsed.player} in the box score — grade manually`;
        } else {
          const over = val > parsed.line;
          status = parsed.dir === "Over" ? (over ? "W" : "L") : (over ? "L" : "W");
          console.log(`  ✓ ${parsed.player}: ${val} ${parsed.market} (line: ${parsed.line}) → ${status}`);
        }
      }
    } else if (parsed.type === "parlay") {
      // Parlays should only search games from the pick's date (+day before),
      // NOT all games across all dates — otherwise a leg can match a previous
      // day's final game and incorrectly grade the parlay.
      const parlayGames = [
        ...(gamesByKey.get(`${row.sport}|${row.date}`) || []),
        ...(gamesByKey.get(`${row.sport}|${minusOne(row.date)}`) || []),
      ];
      const mlbParlayGames = [
        ...(mlbGamesByDate.get(row.date) || []),
        ...(mlbGamesByDate.get(minusOne(row.date)) || []),
      ];
      const sportGames = parlayGames;
      const legResults = [];
      for (const leg of parsed.legs) {
        const lp = parseLeg(leg);
        if (!lp) { legResults.push("unparseable"); continue; }
        if (lp.type === "ml") {
          const m = matchGame(sportGames, lp.team, null, row.date);
          if (!m || m.game.state !== "post") { legResults.push("pending"); continue; }
          legResults.push(gradeMl(m));
        } else if (lp.type === "ats") {
          const m = matchGame(sportGames, lp.team, null, row.date);
          if (!m || m.game.state !== "post") { legResults.push("pending"); continue; }
          legResults.push(gradeAts(m, lp.line));
        } else if (lp.type === "total") {
          const m = matchGame(sportGames, lp.teamA, lp.teamB, row.date);
          if (!m || m.game.state !== "post") { legResults.push("pending"); continue; }
          legResults.push(gradeTotal(m, lp.dir, lp.line));
        } else if (lp.type === "k") {
          // K prop in a parlay: use MLB Stats API if MLB
          if (row.sport === "MLB") {
            let found = false;
            for (const g of mlbParlayGames) {
              const gPk = g._mlbPk || g.id;
              // Fetch boxscore if not already cached
              if (!kCache.has(gPk)) {
                kCache.set(gPk, await mlbPitcherKs(gPk));
              }
              const kMap = kCache.get(gPk);
              if (kMap && lookupPitcherKs(kMap, lp.pitcher) != null) {
                const ks = lookupPitcherKs(kMap, lp.pitcher);
                const over = ks > lp.line;
                legResults.push(over ? "W" : "L");
                found = true;
                break;
              }
            }
            if (!found) legResults.push("pending");
          } else {
            legResults.push("pending");
          }
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
