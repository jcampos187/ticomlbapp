#!/usr/bin/env node
/**
 * capture-picks.mjs — save today's recommended picks into a local tracker file.
 *
 * Pulls the same analysis the site's MLB / NFL / CFB tabs show (from the
 * deployed API) and merges the picks into tracker-data/picks.json.
 *
 * - Idempotent: a pick already in the file is never added twice.
 * - Never modifies existing rows (your W/L marks are untouched).
 * - Usage:
 *     node scripts/capture-picks.mjs              # capture all three sports
 *     node scripts/capture-picks.mjs --sport nfl  # just NFL
 *     node scripts/capture-picks.mjs --dry-run    # show what would be added
 *     PICKS_API_BASE=https://... node scripts/capture-picks.mjs
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "..", "tracker-data");
const PICKS_FILE = path.join(DATA_DIR, "picks.json");
const BASE = process.env.PICKS_API_BASE || "https://ticomlbapp.vercel.app";

const SPORTS = [
  { key: "MLB", url: "/api/analysis" },
  { key: "NFL", url: "/api/nfl-analysis" },
  { key: "CFB", url: "/api/cfb-analysis" },
];

const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const fmtOdds = (o) => (o == null ? "" : o > 0 ? `+${o}` : `${o}`);

/** Find a game by full name or abbrev for both sides. */
function findGame(games, sideA, sideB) {
  if (!games || !sideA) return null;
  const a = String(sideA).toLowerCase();
  const b = String(sideB ?? "").toLowerCase();
  for (const g of games) {
    const names = [
      g.awayTeam, g.homeTeam,
      g.awayAbbrev, g.homeAbbrev,
    ].map((x) => String(x ?? "").toLowerCase());
    const hasA = names.includes(a);
    const hasB = !b || names.includes(b);
    if (hasA && hasB) return g;
  }
  return null;
}

const dateOf = (game) => (game?.startTime ? String(game.startTime).slice(0, 10) : null);

/* ------------------------------------------------------------------ */
/* Row builders — one per pick category. Each returns { id, date,     */
/* sport, category, pick } or null.                                    */
/* ------------------------------------------------------------------ */

function mlbRows(d, sport, dateFallback) {
  const games = d.games || [];
  const rows = [];
  for (const p of d.topPicks || []) {
    const g = findGame(games, p.team, p.opponent);
    rows.push({
      id: `${sport}-ml-${slug(p.team)}-vs-${slug(p.opponent)}-${dateOf(g) || dateFallback}`,
      date: dateOf(g) || dateFallback,
      sport,
      category: "Moneyline",
      pick: `${p.team} ML (${fmtOdds(p.ml)}) vs ${p.opponent}`,
      // Persist the numbers the model produced so picks captured from now on
      // can be bucketed by edge/EV and validated against outcomes later.
      // Rows written before this change simply lack these fields.
      ml: p.ml,
      modelProb: p.modelProb,
      rawMarketProb: p.rawMarketProb,
      fairMarketProb: p.fairMarketProb,
      edge: p.edge,
      ev: p.ev,
      confidence: p.confidence,
      dataQuality: p.dataQuality,
    });
  }
  for (const p of d.topKProps || []) {
    const g = findGame(games, p.team, p.opponent);
    rows.push({
      id: `${sport}-k-${slug(p.pitcher)}-${dateOf(g) || dateFallback}`,
      date: dateOf(g) || dateFallback,
      sport,
      category: "Strikeout Prop",
      pick: `${p.pitcher} (${p.team}) Over 6.5 Ks vs ${p.opponent}`,
    });
  }
  for (const p of d.topTotals || []) {
    const g = findGame(games, p.away, p.home);
    rows.push({
      id: `${sport}-total-${slug(p.away)}-${slug(p.home)}-${dateOf(g) || dateFallback}`,
      date: dateOf(g) || dateFallback,
      sport,
      category: "Total",
      pick: `${p.away} @ ${p.home} ${p.pick} ${p.overUnder}`,
    });
  }
  // Anchor parlays to the earliest game date this sport's picks actually use,
  // so ids stay stable across daily runs (fetch-date stamps would duplicate).
  const slate = rows.map((r) => r.date).filter(Boolean).sort()[0] || dateFallback;
  for (const p of d.parlays || []) {
    rows.push({
      id: `${sport}-parlay-${slug(p.name)}-${slate}`,
      date: slate,
      sport,
      category: "Parlay",
      pick: `${p.name}: ${(p.legs || []).join(" + ")}`,
    });
  }
  return rows;
}

function gridRows(d, sport, dateFallback) {
  const games = d.games || [];
  const rows = [];
  for (const p of d.topPicks || []) {
    const g = findGame(games, p.team, p.opponent);
    rows.push({
      id: `${sport}-ml-${slug(p.team)}-vs-${slug(p.opponent)}-${dateOf(g) || dateFallback}`,
      date: dateOf(g) || dateFallback,
      sport,
      category: "Moneyline",
      pick: `${p.team} ML (${fmtOdds(p.ml)}) vs ${p.opponent}`,
    });
  }
  for (const p of d.topAts || []) {
    const g = findGame(games, p.team, p.opponent);
    rows.push({
      id: `${sport}-ats-${slug(p.team)}-vs-${slug(p.opponent)}-${dateOf(g) || dateFallback}`,
      date: dateOf(g) || dateFallback,
      sport,
      category: "Spread",
      pick: `${p.line} vs ${p.opponent}`,
    });
  }
  for (const p of d.topTotals || []) {
    const g = findGame(games, p.away, p.home);
    rows.push({
      id: `${sport}-total-${slug(p.away)}-${slug(p.home)}-${dateOf(g) || dateFallback}`,
      date: dateOf(g) || dateFallback,
      sport,
      category: "Total",
      pick: `${p.away} @ ${p.home} ${p.pick} ${p.overUnder}`,
    });
  }
  for (const p of d.topProps || []) {
    const g = findGame(games, p.team);
    rows.push({
      id: `${sport}-prop-${slug(p.player)}-${slug(p.market)}-${dateOf(g) || dateFallback}`,
      date: dateOf(g) || dateFallback,
      sport,
      category: "Prop",
      pick: `${p.player} ${p.direction} ${p.projectedLine} ${p.market} (${p.team})`,
    });
  }
  // Anchor parlays to the earliest game date this sport's picks actually use.
  const slate = rows.map((r) => r.date).filter(Boolean).sort()[0] || dateFallback;
  for (const p of d.parlays || []) {
    rows.push({
      id: `${sport}-parlay-${slug(p.name)}-${slate}`,
      date: slate,
      sport,
      category: "Parlay",
      pick: `${p.name}: ${(p.legs || []).join(" + ")}`,
    });
  }
  return rows;
}

function buildRows(sportKey, d) {
  const dateFallback = d.date || new Date().toISOString().slice(0, 10);
  return sportKey === "MLB" ? mlbRows(d, sportKey, dateFallback) : gridRows(d, sportKey, dateFallback);
}

/* ------------------------------------------------------------------ */

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

function printSummary(label, added, skipped) {
  const extra = skipped ? ` (${skipped} already in file)` : "";
  console.log(`${label}: ${added} new${extra}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const wantSport = args.includes("--sport")
    ? args[args.indexOf("--sport") + 1]?.toLowerCase()
    : null;

  const existing = await loadPicks();
  const byId = new Map(existing.map((p) => [p.id, p]));
  const seen = new Set();

  let totalNew = 0;
  for (const sport of SPORTS) {
    if (wantSport && sport.key.toLowerCase() !== wantSport) continue;
    let d;
    try {
      const res = await fetch(`${BASE}${sport.url}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      d = await res.json();
    } catch (err) {
      console.error(`  ${sport.key}: could not fetch ${BASE}${sport.url} — ${err.message}`);
      continue;
    }

    let added = 0;
    for (const row of buildRows(sport.key, d)) {
      if (!row.id || seen.has(row.id) || byId.has(row.id)) continue;
      seen.add(row.id);
      if (dryRun) {
        console.log(`    would add [${row.date}] ${row.sport} ${row.category}: ${row.pick}`);
      } else {
        byId.set(row.id, {
          id: row.id,
          date: row.date,
          sport: row.sport,
          category: row.category,
          pick: row.pick,
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      }
      added++;
    }
    totalNew += added;
    if (!dryRun || added > 0) printSummary(`  ${sport.key}`, added);
  }

  if (dryRun) {
    console.log(`\n${totalNew} pick(s) would be added.`);
    return;
  }

  if (totalNew > 0) {
    const picks = [...byId.values()];
    picks.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
    await savePicks(picks);
    console.log(`\nSaved ${picks.length} total pick(s) to ${PICKS_FILE} (+${totalNew}).`);
  } else {
    console.log("\nNothing new — the file is already up to date.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
