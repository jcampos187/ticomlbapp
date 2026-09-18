#!/usr/bin/env node
/**
 * backtest-model.mjs — Validate the betting models against historical results.
 *
 * Supports all three sports the app models:
 *   MLB  — fetches completed games from the MLB Stats API (free, no key),
 *          rebuilding team + pitcher stats as known at game time.
 *   CFB/NFL — fetches completed games from ESPN's scoreboard (free, no key)
 *          using the same endpoints the app already calls. Records are
 *          reconstructed to their pre-game values and PPG uses the season
 *          averages ESPN reports, mirroring what the model sees in production.
 *
 * Each sport runs its own logistic model, compares predictions to actual
 * outcomes, and fits Platt-scaling calibration parameters (A, B) that get
 * saved to a per-sport calibration file the production models load:
 *     MLB  → src/lib/calibration.json
 *     CFB  → src/lib/calibration-cfb.json
 *     NFL  → src/lib/calibration-nfl.json
 *
 * Usage:
 *     node scripts/backtest-model.mjs                                   # MLB, last 30 days
 *     node scripts/backtest-model.mjs --sport cfb                       # CFB, last 30 days
 *     node scripts/backtest-model.mjs --sport nfl --days 60             # NFL, last 60 days
 *     node scripts/backtest-model.mjs --sport cfb --from 2025-09-01 --to 2025-09-30
 *     node scripts/backtest-model.mjs --sample 50                       # print 50 game details
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ───────────────────────────────────────────────────────────────

const MLB_API = "https://statsapi.mlb.com/api/v1";
const USER_AGENT = "MLBBacktest/1.0";

// League-average fallbacks (same as the production model)
const LEAGUE_AVG = {
  winRate: 0.5,
  runsPerGame: 4.5,
  starterEra: 4.25,
  fip: 4.1,
  k9: 8.6,
  bb9: 3.2,
  hr9: 1.25,
  bullpenEra: 4.1,
};

const MIN_EDGE_GAMES = 4;

// Logistic coefficients — MUST match src/lib/analysis.ts exactly
const HOME_ADV = 0.24;
const COEF_WIN_RATE = 2.8;
const COEF_RUNS_PER_GAME = 0.22;
const COEF_STARTER_ERA = 0.28;
const COEF_FIP = 0.22;
const COEF_K9 = 0.05;
const COEF_BB9 = 0.06;
const COEF_HR9 = 0.18;
const COEF_BULLPEN_ERA = 0.18;
const MAX_FEATURE_LOGIT = {
  winRate: 0.6,
  runsPerGame: 0.4,
  starterEra: 0.5,
  fip: 0.4,
  k9: 0.3,
  bb9: 0.15,
  hr9: 0.15,
  bullpenEra: 0.4,
};

/**
 * Shared logit budget for the whole starting-pitcher package — MUST match
 * MAX_STARTER_BUNDLE_LOGIT in src/lib/analysis.ts. ERA, FIP, K/9, BB/9 and HR/9
 * all describe one quantity (how many runs a starter prevents) and FIP is built
 * from the other three, so the terms are summed under one ceiling instead of
 * stacking independently.
 */
const MAX_STARTER_BUNDLE_LOGIT = MAX_FEATURE_LOGIT.starterEra + MAX_FEATURE_LOGIT.k9;

// Empirical-Bayes shrinkage priors (phantom IP of league-average performance),
// per stat because they stabilise at very different rates. MUST match the
// PRIOR_IP_* constants in src/lib/analysis.ts.
const PRIOR_IP_ERA = 100;
const PRIOR_IP_FIP = 80;
const PRIOR_IP_K9 = 60;
const PRIOR_IP_BB9 = 55;
const PRIOR_IP_HR9 = 130;
const SMALL_SAMPLE_IP = 20;

/** Conventional FIP offset (league-average ERA constant) — matches analysis.ts. */
const FIP_CONSTANT = 3.1;

// Edge thresholds for confidence grades
const EDGE_A = 8;
const EDGE_B = 5;
const EDGE_C = 3;

/**
 * Feature-set version this backtest mirrors, stamped into the calibration file
 * so the app can tell whether a fitted calibration still matches the model it
 * is applied to.
 *
 *   1 = win rate, R/G, starter ERA, K/9, bullpen ERA
 *   2 = the v2 starter package: FIP, BB/9 and HR/9 added alongside ERA and
 *       K/9, the five terms combined under a shared logit budget, and every
 *       starter rate stat shrunk toward league average by innings pitched
 *
 * MUST equal MODEL_FEATURE_SET in src/lib/analysis.ts. Do not bump this constant
 * without first updating computeRawLogit, the coefficient list, the shrinkage
 * priors and runModel's input assembly above/below to match analysis.ts exactly
 * — a calibration fitted on one feature set is not valid for another, and the
 * app flags the mismatch as stale.
 */
const FEATURE_SET_VERSION = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function clampFeature(term, cap) {
  return Math.max(-cap, Math.min(cap, term));
}

function americanToDecimal(odds) {
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

function formatOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/**
 * Parse a numeric API field, returning null instead of NaN/0-for-missing —
 * mirrors numOrNull in src/lib/mlb.ts. `parseFloat(s.era) || null` would turn a
 * genuine 0.00 ERA into "missing", which changes the model inputs.
 */
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse MLB's `inningsPitched`, which uses baseball notation where the
 * fractional digit is thirds: "123.1" = 123 1/3 innings, "123.2" = 123 2/3.
 * Mirrors parseInningsPitched in src/lib/mlb.ts.
 */
function parseInningsPitched(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d+)(?:\.([0-2]))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const third = m[2] ? Number(m[2]) : 0;
  return whole + third / 3;
}

/** Per-nine rate from a counting stat, or null when it can't be computed. */
function per9(count, ip) {
  if (count == null || ip == null || ip <= 0) return null;
  return (count / ip) * 9;
}

/**
 * Sum a group of pitching terms under a shared logit budget — mirrors
 * capStarterBundle in src/lib/analysis.ts. Positive and negative contributions
 * are bounded separately, so one big opposite-signed term cannot cancel another
 * and slip past the cap.
 */
function capStarterBundle(terms, budget = MAX_STARTER_BUNDLE_LOGIT) {
  const positive = terms.filter((t) => t > 0).reduce((a, b) => a + b, 0);
  const negative = terms.filter((t) => t < 0).reduce((a, b) => a + b, 0);
  const worst = Math.max(positive, -negative);
  const scale = worst > budget ? budget / worst : 1;
  return (positive + negative) * scale;
}

/**
 * Regress a pitcher stat toward the league average by sample size (innings
 * pitched) — mirrors shrinkStat in src/lib/analysis.ts. Without this the
 * backtest would fit a model that is not the one production runs: a 16-inning
 * 0.56 ERA would move the backtest probability at full strength while the app
 * regresses it to near league average.
 */
function shrinkStat(stat, ip, leagueAvg, priorIp) {
  if (stat == null) return null;
  if (ip == null) return stat;
  const n = Math.max(0, ip);
  const weight = n / (n + priorIp);
  return stat * weight + leagueAvg * (1 - weight);
}

/**
 * Compute raw log-odds (z-score) for one side — mirrors computeRawLogit
 * from src/lib/analysis.ts, including the shared starter-package budget.
 */
function computeRawLogit(t, o, isHome) {
  let z = isHome ? HOME_ADV : 0;
  z += clampFeature((t.winRate - o.winRate) * COEF_WIN_RATE, MAX_FEATURE_LOGIT.winRate);
  z += clampFeature((t.runsPerGame - o.runsPerGame) * COEF_RUNS_PER_GAME, MAX_FEATURE_LOGIT.runsPerGame);
  // Starting-pitcher package. Lower is better for ERA/FIP/BB9/HR9 (so the
  // opponent's value is subtracted), higher is better for K/9.
  z += capStarterBundle([
    clampFeature((o.starterEra - t.starterEra) * COEF_STARTER_ERA, MAX_FEATURE_LOGIT.starterEra),
    clampFeature((o.fip - t.fip) * COEF_FIP, MAX_FEATURE_LOGIT.fip),
    clampFeature((t.k9 - o.k9) * COEF_K9, MAX_FEATURE_LOGIT.k9),
    clampFeature((o.bb9 - t.bb9) * COEF_BB9, MAX_FEATURE_LOGIT.bb9),
    clampFeature((o.hr9 - t.hr9) * COEF_HR9, MAX_FEATURE_LOGIT.hr9),
  ]);
  z += clampFeature((o.bullpenEra - t.bullpenEra) * COEF_BULLPEN_ERA, MAX_FEATURE_LOGIT.bullpenEra);
  return z;
}

function extractScore(teamObj, gameObj, side) {
  // MLB Stats API puts scores in several possible locations depending on hydration
  const candidates = [
    teamObj.score,
    gameObj.linescore?.teams?.[side]?.runs,
    gameObj.linescore?.[side]?.runs,
    gameObj.teams?.[side]?.score,
  ];
  for (const v of candidates) {
    if (v != null && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return 0;
}

function confidenceGrade(edge, complete) {
  if (edge >= EDGE_A) return complete ? "A" : "B";
  if (edge >= EDGE_B) return complete ? "B" : "C";
  if (edge >= EDGE_C) return "C";
  return "D";
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { sport: "mlb", days: 30, sample: 0, from: null, to: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sport" && args[i + 1]) out.sport = args[++i].toLowerCase();
    else if (args[i] === "--days" && args[i + 1]) out.days = Number(args[++i]);
    else if (args[i] === "--from" && args[i + 1]) out.from = args[++i];
    else if (args[i] === "--to" && args[i + 1]) out.to = args[++i];
    else if (args[i] === "--sample" && args[i + 1]) out.sample = Number(args[++i]);
  }
  if (!["mlb", "cfb", "nfl"].includes(out.sport)) {
    console.error(`Unknown sport "${out.sport}" — expected mlb, cfb, or nfl.`);
    process.exit(1);
  }
  return out;
}

function dateRange(from, to) {
  const dates = [];
  const d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

// ─── MLB Stats API fetchers ──────────────────────────────────────────────────

async function fetchJSON(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    next: { revalidate: 3600 },
  });
  if (!resp.ok) return null;
  return resp.json();
}

/**
 * Fetch completed MLB games for a date (with scores, probable pitchers,
 * and team records).
 */
async function fetchGames(date) {
  const data = await fetchJSON(
    `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=linescore,probablePitcher,team(league),decisions`
  );
  if (!data) return [];
  const out = [];
  for (const g of data.dates?.[0]?.games || []) {
    const detailed = g.status?.detailedState || "";
    if (detailed !== "Final" && detailed !== "Final: Examined Replays") continue;
    const away = g.teams?.away;
    const home = g.teams?.home;
    if (!away?.team || !home?.team) continue;
    const awayScore = Number(away.score ?? 0);
    const homeScore = Number(home.score ?? 0);
    if (!awayScore && !homeScore) continue;
    const awayRec = away.leagueRecord || {};
    const homeRec = home.leagueRecord || {};
    const awayPitcher = away.probablePitcher || g.decisions?.winner || null;
    const homePitcher = home.probablePitcher || null;
    out.push({
      id: String(g.gamePk),
      date: g.gameDate?.slice(0, 10) || date,
      awayTeam: away.team.name || "",
      homeTeam: home.team.name || "",
      awayAbbrev: away.team.abbreviation || "",
      homeAbbrev: home.team.abbreviation || "",
      awayRecord: `${awayRec.wins}-${awayRec.losses}`,
      homeRecord: `${homeRec.wins}-${homeRec.losses}`,
      awayScore: extractScore(away, g, 'away'),
      homeScore: extractScore(home, g, 'home'),
      homeWinner: extractScore(home, g, 'home') > extractScore(away, g, 'away'),
      awayPitcher: awayPitcher?.fullName || "",
      homePitcher: homePitcher?.fullName || "",
      awayPitcherId: awayPitcher?.id || null,
      homePitcherId: homePitcher?.id || null,
    });
  }
  return out;
}

/**
 * Fetch team season stats (W-L record, R/G, bullpen ERA).
 * Returns { record: "W-L", rpg: number, bullpenEra: number } or null.
 */
const teamStatCache = new Map();
async function fetchTeamStats(teamName, season) {
  const key = `${teamName}|${season}`;
  if (teamStatCache.has(key)) return teamStatCache.get(key);

  // Find team ID
  const teamData = await fetchJSON(`${MLB_API}/teams?sportId=1&season=${season}`);
  let teamId = null;
  for (const t of teamData?.teams || []) {
    if (t.name === teamName) { teamId = t.id; break; }
  }
  if (!teamId) {
    // Try partial match
    for (const t of teamData?.teams || []) {
      if (t.name?.toLowerCase().includes(teamName.toLowerCase().slice(0, 6))) {
        teamId = t.id;
        break;
      }
    }
  }
  if (!teamId) return null;

  const [hitting, bullpen] = await Promise.all([
    fetchJSON(`${MLB_API}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}&gameType=R`),
    fetchJSON(`${MLB_API}/teams/${teamId}/stats?stats=statSplits&group=pitching&season=${season}&gameType=R&sportIds=1&sitCodes=rp`),
  ]);

  let record = null;
  let rpg = null;

  const hitSplit = hitting?.stats?.[0]?.splits?.[0]?.stat;
  if (hitSplit) {
    const w = Number(hitSplit.wins ?? 0);
    const l = Number(hitSplit.losses ?? 0);
    if (w + l >= MIN_EDGE_GAMES) record = `${w}-${l}`;
    if (hitSplit.runs && hitSplit.gamesPlayed) {
      rpg = Math.round((hitSplit.runs / hitSplit.gamesPlayed) * 100) / 100;
    }
  }

  let bullpenEra = null;
  const bpSplit = bullpen?.stats?.[0]?.splits?.[0]?.stat;
  if (bpSplit?.era) bullpenEra = parseFloat(bpSplit.era);

  const result = { record, rpg, bullpenEra };
  teamStatCache.set(key, result);
  return result;
}

/**
 * Fetch a pitcher's season rate stats for a season, falling back to the prior
 * season when the current one has no line yet.
 *
 * Returns { era, k9, bb9, hr9, fip, ip } or null. Everything returned is either
 * a real published value, computed from real counting stats (FIP), or null —
 * mirrors fetchPitcherStats in src/lib/mlb.ts so the calibration is fitted on
 * the same inputs production runs.
 */
const pitcherCache = new Map();
async function fetchPitcherStats(pitcherId, season) {
  if (!pitcherId) return null;
  const key = `${pitcherId}|${season}`;
  if (pitcherCache.has(key)) return pitcherCache.get(key);

  for (const yr of [season, season - 1]) {
    const url = `${MLB_API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${yr}&gameType=R`;
    const data = await fetchJSON(url);
    const s = data?.stats?.[0]?.splits?.[0]?.stat;
    if (!s) continue;

    const ip = parseInningsPitched(s.inningsPitched);
    const hr = numOrNull(s.homeRuns);
    const bb = numOrNull(s.baseOnBalls);
    const hbp = numOrNull(s.hitByPitch);
    const so = numOrNull(s.strikeOuts);

    const result = {
      era: numOrNull(s.era),
      k9: numOrNull(s.strikeoutsPer9Inn),
      bb9: numOrNull(s.walksPer9Inn) ?? per9(bb, ip),
      hr9: numOrNull(s.homeRunsPer9) ?? per9(hr, ip),
      // FIP from real counting stats only: (13*HR + 3*(BB+HBP) - 2*SO)/IP + C
      fip:
        ip != null && ip > 0 && hr != null && bb != null && so != null
          ? (13 * hr + 3 * (bb + (hbp ?? 0)) - 2 * so) / ip + FIP_CONSTANT
          : null,
      ip,
    };

    if (result.era != null || result.k9 != null || result.fip != null || result.ip != null) {
      pitcherCache.set(key, result);
      return result;
    }
  }

  pitcherCache.set(key, null);
  return null;
}

// ─── Backtest engine ─────────────────────────────────────────────────────────

function runModel(inputs) {
  const { awayTeam, homeTeam, awayRecord, homeRecord, awayPitcher, homePitcher, awayPitcherId, homePitcherId,
          awayEra, homeEra, awayK9, homeK9, awayFip, homeFip, awayBb9, homeBb9, awayHr9, homeHr9,
          awayIp, homeIp, awayRpg, homeRpg, awayBpEra, homeBpEra, season } = inputs;

  // Parse records
  const [awayW, awayL] = (awayRecord || "").split("-").map(Number);
  const [homeW, homeL] = (homeRecord || "").split("-").map(Number);
  const awayGames = (Number.isFinite(awayW) && Number.isFinite(awayL)) ? awayW + awayL : 0;
  const homeGames = (Number.isFinite(homeW) && Number.isFinite(homeL)) ? homeW + homeL : 0;

  if (awayGames < MIN_EDGE_GAMES || homeGames < MIN_EDGE_GAMES) return null;

  const awayWinRate = awayW / awayGames;
  const homeWinRate = homeW / homeGames;

  // Build model inputs (same logic as teamInputs in analysis.ts). Every starter
  // rate stat is regressed toward its league baseline by innings pitched, so a
  // small sample cannot masquerade as an elite arm in the fit.
  const buildSide = (winRate, rpg, era, fip, k9, bb9, hr9, bpEra, ip) => {
    const present = [winRate, rpg, era, k9, bpEra].filter((v) => v != null).length;
    const smallSample = ip != null && ip < SMALL_SAMPLE_IP;
    return {
      winRate,
      runsPerGame: rpg ?? LEAGUE_AVG.runsPerGame,
      starterEra: shrinkStat(era, ip, LEAGUE_AVG.starterEra, PRIOR_IP_ERA) ?? LEAGUE_AVG.starterEra,
      fip: shrinkStat(fip, ip, LEAGUE_AVG.fip, PRIOR_IP_FIP) ?? LEAGUE_AVG.fip,
      k9: shrinkStat(k9, ip, LEAGUE_AVG.k9, PRIOR_IP_K9) ?? LEAGUE_AVG.k9,
      bb9: shrinkStat(bb9, ip, LEAGUE_AVG.bb9, PRIOR_IP_BB9) ?? LEAGUE_AVG.bb9,
      hr9: shrinkStat(hr9, ip, LEAGUE_AVG.hr9, PRIOR_IP_HR9) ?? LEAGUE_AVG.hr9,
      bullpenEra: bpEra ?? LEAGUE_AVG.bullpenEra,
      complete: present >= 4 && !smallSample,
      smallSample,
      starterMetrics: [era, fip, k9, bb9, hr9].filter((v) => v != null).length,
    };
  };

  const awayInputs = buildSide(awayWinRate, awayRpg, awayEra, awayFip, awayK9, awayBb9, awayHr9, awayBpEra, awayIp);
  const homeInputs = buildSide(homeWinRate, homeRpg, homeEra, homeFip, homeK9, homeBb9, homeHr9, homeBpEra, homeIp);

  // Compute normalised model probabilities
  const zAway = computeRawLogit(awayInputs, homeInputs, false);
  const zHome = computeRawLogit(homeInputs, awayInputs, true);
  const eAway = sigmoid(zAway);
  const eHome = sigmoid(zHome);
  const total = eAway + eHome;
  const awayProb = Math.min(0.97, Math.max(0.03, eAway / total)) * 100;
  const homeProb = 100 - awayProb;

  const complete = awayInputs.complete && homeInputs.complete;

  return {
    awayTeam, homeTeam,
    awayProb, homeProb,
    awayWinRate, homeWinRate,
    awayEra: awayInputs.starterEra, homeEra: homeInputs.starterEra,
    awayFip: awayInputs.fip, homeFip: homeInputs.fip,
    awayK9: awayInputs.k9, homeK9: homeInputs.k9,
    awayBb9: awayInputs.bb9, homeBb9: homeInputs.bb9,
    awayHr9: awayInputs.hr9, homeHr9: homeInputs.hr9,
    awayRpg: awayInputs.runsPerGame, homeRpg: homeInputs.runsPerGame,
    awayBpEra: awayInputs.bullpenEra, homeBpEra: homeInputs.bullpenEra,
    smallSample: awayInputs.smallSample || homeInputs.smallSample,
    complete,
    awayScore: inputs.awayScore ?? 0,
    homeScore: inputs.homeScore ?? 0,
  };
}

function confidenceLabel(grade) {
  return { A: "A (large edge)", B: "B (solid)", C: "C (marginal)", D: "D (below threshold)" }[grade] || grade;
}

// ─── Platt scaling calibration ───────────────────────────────────────────────

/**
 * Platt scaling: fit A, B parameters so that calibrated(z) = sigmoid(A*z + B)
 * maps the model's raw logit z to a better-calibrated probability.
 *
 * Training data: pairs of (raw_logit, actual_outcome) where outcome ∈ {0, 1}.
 * Uses gradient descent to minimise log-loss.
 *
 * Returns { A, B, brierBefore, brierAfter, logLossBefore, logLossAfter }.
 */
function fitPlattScaling(gamesWithStats) {
  // Collect (raw_logit, outcome) pairs from the backtest
  // Each game contributes two data points: one for away, one for home
  const data = [];
  for (const g of gamesWithStats) {
    const homeLogit = Math.log(g.homeProb / (100 - g.homeProb)); // inverse sigmoid
    const awayLogit = Math.log(g.awayProb / (100 - g.awayProb));
    data.push({ logit: homeLogit, outcome: g.homeWinner ? 1 : 0 });
    data.push({ logit: awayLogit, outcome: g.homeWinner ? 0 : 1 });
  }

  if (data.length < 20) {
    console.log("  Not enough data for Platt scaling (< 20 samples). Skipping.");
    return null;
  }

  // Compute pre-calibration metrics
  const brierBefore = data.reduce((sum, d) => {
    const p = 1 / (1 + Math.exp(-d.logit));
    return sum + (p - d.outcome) ** 2;
  }, 0) / data.length;

  const logLossBefore = data.reduce((sum, d) => {
    const p = Math.max(0.001, Math.min(0.999, 1 / (1 + Math.exp(-d.logit))));
    return sum - (d.outcome * Math.log(p) + (1 - d.outcome) * Math.log(1 - p));
  }, 0) / data.length;

  // Fit A and B via gradient descent on log-loss
  let A = 1.0;
  let B = 0.0;
  const lr = 0.01;
  const epochs = 500;

  for (let epoch = 0; epoch < epochs; epoch++) {
    let gradA = 0;
    let gradB = 0;
    for (const d of data) {
      const az = A * d.logit + B;
      const sig = 1 / (1 + Math.exp(-az));
      const err = sig - d.outcome;
      gradA += err * d.logit;
      gradB += err;
    }
    gradA /= data.length;
    gradB /= data.length;
    A -= lr * gradA;
    B -= lr * gradB;
  }

  // Compute post-calibration metrics
  const brierAfter = data.reduce((sum, d) => {
    const p = 1 / (1 + Math.exp(-(A * d.logit + B)));
    return sum + (p - d.outcome) ** 2;
  }, 0) / data.length;

  const logLossAfter = data.reduce((sum, d) => {
    const p = Math.max(0.001, Math.min(0.999, 1 / (1 + Math.exp(-(A * d.logit + B)))));
    return sum - (d.outcome * Math.log(p) + (1 - d.outcome) * Math.log(1 - p));
  }, 0) / data.length;

  return { A, B, brierBefore, brierAfter, logLossBefore, logLossAfter, samples: data.length };
}

/**
 * Reliability (calibration) buckets, persisted so the app's debug view can draw
 * a reliability diagram without re-running a backtest.
 *
 * Each game contributes two samples (home + away). Samples are grouped by the
 * model's 5%-rounded probability bucket; per bucket we record the mean raw
 * predicted probability, the mean calibrated probability, the observed win
 * rate and the sample count. A reliability diagram plots `rawProb` (x) against
 * `actual` (y): the diagonal is perfect calibration, a point above it means the
 * model was under-confident, below it over-confident. `calibratedProb` is the
 * same x-position after Platt scaling, so the two points' horizontal offset is
 * exactly what the calibration currently does.
 */
function computeReliability(gamesWithStats, platt) {
  const buckets = {};
  for (const g of gamesWithStats) {
    const samples = [
      { logit: Math.log(g.homeProb / (100 - g.homeProb)), outcome: g.homeWinner ? 1 : 0 },
      { logit: Math.log(g.awayProb / (100 - g.awayProb)), outcome: g.homeWinner ? 0 : 1 },
    ];
    for (const d of samples) {
      const rawProb = 1 / (1 + Math.exp(-d.logit));
      const calProb = platt ? 1 / (1 + Math.exp(-(platt.A * d.logit + platt.B))) : rawProb;
      const key = Math.round(rawProb * 20) * 5; // nearest 5%
      if (!buckets[key]) buckets[key] = { raw: [], cal: [], outcomes: [] };
      buckets[key].raw.push(rawProb * 100);
      buckets[key].cal.push(calProb * 100);
      buckets[key].outcomes.push(d.outcome);
    }
  }
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  return Object.entries(buckets)
    .map(([key, b]) => ({
      bucket: parseInt(key, 10),
      count: b.outcomes.length,
      rawProb: mean(b.raw),
      calibratedProb: mean(b.cal),
      actual: mean(b.outcomes) * 100,
    }))
    .filter((b) => b.count >= 3)
    .sort((a, b) => a.bucket - b.bucket);
}

function pct(n) { return (n * 100).toFixed(1) + "%"; }

// ─── CFB / NFL (ESPN) — data fetchers ───────────────────────────────────────
// ESPN's edge fingerprint-checks the User-Agent, so these fetch calls must
// NOT set a custom UA (the runtime's default is allowed).

const ESPN_BASE = {
  "college-football": "https://site.api.espn.com/apis/site/v2/sports/football/college-football",
  "nfl": "https://site.api.espn.com/apis/site/v2/sports/football/nfl",
};

/** ESPN sport configs — coefficients MUST match src/lib/cfbAnalysis.ts and
 *  src/lib/nflAnalysis.ts. Each sport backtests its own logistic model and
 *  writes its own calibration file. */
const FOOTBALL_CONFIG = {
  cfb: {
    label: "CFB",
    banner: "CFB Model Backtest",
    calibrationFile: "calibration-cfb.json",
    /** Feature-set version of the CFB model (cfbAnalysis.ts), not MLB's. */
    featureSet: 1,
    moduleLabel: "cfbAnalysis.ts",
    leagueAvg: { winRate: 0.5, ppg: 28.0 },
    homeAdv: 0.42,
    coefWinRate: 3.2,
    coefPpg: 0.16,
    api: "college-football",
  },
  nfl: {
    label: "NFL",
    banner: "NFL Model Backtest",
    calibrationFile: "calibration-nfl.json",
    /** Feature-set version of the NFL model (nflAnalysis.ts), not MLB's. */
    featureSet: 1,
    moduleLabel: "nflAnalysis.ts",
    leagueAvg: { winRate: 0.5, ppg: 23.0 },
    homeAdv: 0.33,
    coefWinRate: 3.2,
    coefPpg: 0.13,
    api: "nfl",
  },
};

/** Fetch one date of ESPN scoreboard events (regular season only). */
async function espnFetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return resp.json();
}

/**
 * Fetch completed CFB/NFL games for one calendar date. ESPN embeds each
 * team's current-season record on the competition, but for a completed game
 * that record INCLUDES the game's own result. We reconstruct the pre-game
 * record (what the model sees in production) by subtracting this result.
 */
async function fetchFootballGames(cfg, date, season) {
  const ymd = date.replace(/-/g, "");
  const data = await espnFetchJson(
    `${ESPN_BASE[cfg.api]}/scoreboard?dates=${ymd}&seasontype=2&season=${season}`
  );
  if (!data) return [];
  const out = [];

  for (const event of data.events || []) {
    if (event.status?.type?.state !== "post") continue;
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    if (!away || !home) continue;

    const awayScore = Number(away.score ?? 0);
    const homeScore = Number(home.score ?? 0);
    if (!awayScore && !homeScore) continue;
    const homeWinner = homeScore > awayScore;

    // Displayed record is post-game: away won → away W already includes it,
    // home L already includes it; home won → mirrored.
    const awayRec = away.records?.[0]?.summary || "";
    const homeRec = home.records?.[0]?.summary || "";
    const parse = (s) => {
      const [w, l] = s.split("-").map(Number);
      return { w: Number.isFinite(w) ? w : 0, l: Number.isFinite(l) ? l : 0 };
    };
    const awayP = parse(awayRec);
    const homeP = parse(homeRec);

    // Reconstruct pre-game record.
    let awayPre, homePre;
    if (homeWinner) {
      awayPre = `${awayP.w}-${Math.max(0, awayP.l - 1)}`;
      homePre = `${Math.max(0, homeP.w - 1)}-${homeP.l}`;
    } else {
      awayPre = `${Math.max(0, awayP.w - 1)}-${awayP.l}`;
      homePre = `${homeP.w}-${Math.max(0, homeP.l - 1)}`;
    }

    out.push({
      id: String(event.id ?? comp.id),
      date,
      awayTeam: away.team?.shortDisplayName || away.team?.displayName || "",
      homeTeam: home.team?.shortDisplayName || home.team?.displayName || "",
      awayAbbrev: away.team?.abbreviation || "",
      homeAbbrev: home.team?.abbreviation || "",
      awayRecord: awayPre,
      homeRecord: homePre,
      awayScore,
      homeScore,
      homeWinner,
      awayTeamId: Number(away.team?.id),
      homeTeamId: Number(home.team?.id),
    });
  }
  return out;
}

/** The season a football date belongs to (season runs Aug–Feb). */
function footballSeason(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return m >= 8 ? y : y - 1;
}

const footballTeamStatCache = new Map();

/** Season points-per-game for a team (site API, same source as the app). */
async function fetchFootballTeamStats(cfg, teamId, season) {
  if (!teamId) return null;
  const key = `${cfg.api}|${teamId}|${season}`;
  if (footballTeamStatCache.has(key)) return footballTeamStatCache.get(key);
  const data = await espnFetchJson(
    `https://site.api.espn.com/apis/site/v2/sports/football/${cfg.api}/teams/${teamId}/statistics?season=${season}`
  );
  let ppg = null;
  try {
    const cats = data?.results?.stats?.categories || [];
    const scoring = cats.find((c) => c.name === "scoring");
    const stat = scoring?.stats?.find((s) => s.name === "totalPointsPerGame");
    if (stat?.value != null) {
      const n = Number(stat.value);
      ppg = Number.isNaN(n) ? null : n;
    }
  } catch {
    ppg = null;
  }
  footballTeamStatCache.set(key, ppg);
  return ppg;
}

/**
 * Mirror of computeCfbNormProbs / computeNflNormProbs: raw logits for both
 * sides → sigmoid → normalise so P(away)+P(home)=100% → clamp to [3,97].
 * Returns null when either side has too few games to be meaningful.
 */
function footballRawLogit(cfg, t, o, isHome) {
  let z = isHome ? cfg.homeAdv : 0;
  z += (t.winRate - o.winRate) * cfg.coefWinRate;
  z += (t.ppg - o.ppg) * cfg.coefPpg;
  return z;
}

function runFootballModel(cfg, game, awayPpg, homePpg) {
  const [aw, al] = (game.awayRecord || "").split("-").map(Number);
  const [hw, hl] = (game.homeRecord || "").split("-").map(Number);
  const aGames = Number.isFinite(aw) && Number.isFinite(al) ? aw + al : 0;
  const hGames = Number.isFinite(hw) && Number.isFinite(hl) ? hw + hl : 0;
  if (aGames < MIN_EDGE_GAMES || hGames < MIN_EDGE_GAMES) return null;

  const t = {
    winRate: aw / aGames,
    ppg: awayPpg ?? cfg.leagueAvg.ppg,
    complete: awayPpg != null,
  };
  const o = {
    winRate: hw / hGames,
    ppg: homePpg ?? cfg.leagueAvg.ppg,
    complete: homePpg != null,
  };

  const zAway = footballRawLogit(cfg, t, o, false);
  const zHome = footballRawLogit(cfg, o, t, true);
  const eAway = sigmoid(zAway);
  const eHome = sigmoid(zHome);
  const total = eAway + eHome;
  const awayProb = Math.min(0.97, Math.max(0.03, eAway / total)) * 100;
  const homeProb = 100 - awayProb;

  return {
    awayTeam: game.awayTeam,
    homeTeam: game.homeTeam,
    awayProb,
    homeProb,
    awayWinRate: t.winRate,
    homeWinRate: o.winRate,
    awayPpg: t.ppg,
    homePpg: o.ppg,
    complete: t.complete && o.complete,
    awayScore: game.awayScore ?? 0,
    homeScore: game.homeScore ?? 0,
  };
}

/**
 * Build the shared backtest report + Platt fit + calibration save for the
 * football sports. Mirrors the MLB report (identical overall/betting/
 * calibration tables) minus the pitcher-data-quality section, which doesn't
 * exist for CFB/NFL.
 */
async function reportFootball(cfg, gamesWithStats, from, to, opts) {
  const total = gamesWithStats.length;
  const correct = gamesWithStats.filter((g) => g.correct).length;
  const accuracy = correct / total;

  const brierScores = gamesWithStats.map((g) => {
    const outcome = g.homeWinner ? 1 : 0;
    const prob = g.homeProb / 100;
    return (prob - outcome) ** 2;
  });
  const brierScore = brierScores.reduce((a, b) => a + b, 0) / brierScores.length;

  const logLosses = gamesWithStats.map((g) => {
    const outcome = g.homeWinner ? 1 : 0;
    const prob = Math.max(0.001, Math.min(0.999, g.homeProb / 100));
    return -(outcome * Math.log(prob) + (1 - outcome) * Math.log(1 - prob));
  });
  const logLoss = logLosses.reduce((a, b) => a + b, 0) / logLosses.length;

  const buckets = {};
  for (const g of gamesWithStats) {
    const bucket = Math.round(g.homeProb / 5) * 5;
    const key = `${bucket}%`;
    if (!buckets[key]) buckets[key] = { count: 0, homeWins: 0 };
    buckets[key].count++;
    if (g.homeWinner) buckets[key].homeWins++;
  }

  const edgeBuckets = [
    { label: "0-3%", min: 0, max: 3, count: 0, correct: 0 },
    { label: "3-5%", min: 3, max: 5, count: 0, correct: 0 },
    { label: "5-8%", min: 5, max: 8, count: 0, correct: 0 },
    { label: "8-12%", min: 8, max: 12, count: 0, correct: 0 },
    { label: "12%+", min: 12, max: 99, count: 0, correct: 0 },
  ];
  for (const g of gamesWithStats) {
    for (const b of edgeBuckets) {
      if (g.gameEdge >= b.min && g.gameEdge < b.max) {
        b.count++;
        if (g.correct) b.correct++;
      }
    }
  }

  const homeGames2 = gamesWithStats.filter((g) => g.homeProb > g.awayProb);
  const awayGames2 = gamesWithStats.filter((g) => g.awayProb > g.homeProb);
  const homePickCorrect = homeGames2.filter((g) => g.correct).length;
  const awayPickCorrect = awayGames2.filter((g) => g.correct).length;
  const homeAvg = gamesWithStats.reduce((s, g) => s + g.homeProb, 0) / total;
  const awayAvg = gamesWithStats.reduce((s, g) => s + g.awayProb, 0) / total;

  let bettingProfit = 0;
  let bettingBets = 0;
  let winningBets = 0;
  for (const g of gamesWithStats) {
    const payout = 10 * (210 / 110);
    if (g.correct) {
      bettingProfit += payout - 10;
      winningBets++;
    } else {
      bettingProfit -= 10;
    }
    bettingBets++;
  }
  const bettingROI = (bettingProfit / (bettingBets * 10)) * 100;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    OVERALL RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Games analyzed:        ${total}`);
  console.log(`  Model correct picks:   ${correct} / ${total} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`  Brier score:           ${brierScore.toFixed(4)}  (0=perfect, 0.25=coin-flip)`);
  console.log(`  Log-loss:              ${logLoss.toFixed(4)}  (lower=better, <0.69=beats coin-flip)`);
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    SIMULATED BETTING");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Strategy:              Flat $10 on model's pick each game`);
  console.log(`  Total bets:            ${bettingBets}`);
  console.log(`  Winning bets:          ${winningBets} / ${bettingBets} (${(winningBets / bettingBets * 100).toFixed(1)}%)`);
  console.log(`  Total P/L:             ${bettingProfit >= 0 ? "+" : ""}$${bettingProfit.toFixed(2)}`);
  console.log(`  ROI:                   ${bettingROI >= 0 ? "+" : ""}${bettingROI.toFixed(1)}%`);
  console.log(`  Breakeven win rate:    ${(100 / 2.1).toFixed(1)}% (at -110 vig)`);
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    PICK DIRECTION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Home-favored games:    ${homeGames2.length}`);
  console.log(`    → Model correct:     ${homePickCorrect} / ${homeGames2.length} (${homeGames2.length > 0 ? (homePickCorrect / homeGames2.length * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  Away-favored games:    ${awayGames2.length}`);
  console.log(`    → Model correct:     ${awayPickCorrect} / ${awayGames2.length} (${awayGames2.length > 0 ? (awayPickCorrect / awayGames2.length * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  Avg home model prob:   ${homeAvg.toFixed(1)}%  (avg away: ${awayAvg.toFixed(1)}%)`);
  console.log(`  Home-field advantage:  +${(homeAvg - 50).toFixed(1)}pp in model`);
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("              ACCURACY BY MODEL CONFIDENCE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Edge Range   Games   Correct   Accuracy   Interpretation");
  console.log("  ──────────   ─────   ───────   ────────   ───────────────");
  for (const b of edgeBuckets) {
    if (b.count === 0) continue;
    const acc = (b.correct / b.count * 100).toFixed(1);
    const bar = "█".repeat(Math.round(b.correct / b.count * 20));
    console.log(`  ${b.label.padEnd(10)}   ${String(b.count).padStart(5)}   ${String(b.correct).padStart(7)}   ${acc.padStart(6)}%    ${bar}`);
  }
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                   CALIBRATION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Model says   Games   Actual Win%   Gap      Calibration");
  console.log("  ──────────   ─────   ───────────   ────     ────────────");
  const sortedBuckets = Object.entries(buckets)
    .map(([k, v]) => ({ prob: parseInt(k), ...v }))
    .sort((a, b) => a.prob - b.prob);
  for (const b of sortedBuckets) {
    if (b.count < 3) continue;
    const actual = (b.homeWins / b.count * 100).toFixed(1);
    const gap = (b.homeWins / b.count * 100 - b.prob).toFixed(1);
    const gapNum = parseFloat(gap);
    const calib = Math.abs(gapNum) < 3 ? "Good" : Math.abs(gapNum) < 6 ? "Fair" : "Poor";
    const indicator = gapNum > 0 ? "↑" : gapNum < 0 ? "↓" : "=";
    console.log(`  ${String(b.prob + "%").padStart(10)}   ${String(b.count).padStart(5)}   ${actual.padStart(9)}%   ${gap.padStart(5)}pp  ${calib} ${indicator}`);
  }
  console.log("");

  // ── Platt Scaling Calibration ──────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("            PLATT SCALING CALIBRATION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Fitting calibration on backtest data…");

  const platt = fitPlattScaling(gamesWithStats);

  if (platt) {
    const brierImprove = ((platt.brierBefore - platt.brierAfter) / platt.brierBefore * 100).toFixed(1);
    const logLossImprove = ((platt.logLossBefore - platt.logLossAfter) / platt.logLossBefore * 100).toFixed(1);

    console.log(`  Samples:               ${platt.samples} (2 per game: home + away)`);
    console.log("");
    console.log(`  Calibration params:    A = ${platt.A.toFixed(6)}, B = ${platt.B.toFixed(6)}`);
    console.log("");
    console.log(`  Brier score:           ${platt.brierBefore.toFixed(4)} → ${platt.brierAfter.toFixed(4)}  (${brierImprove >= 0 ? "-" : "+"}${Math.abs(brierImprove).toFixed(1)}% improvement)`);
    console.log(`  Log-loss:              ${platt.logLossBefore.toFixed(4)} → ${platt.logLossAfter.toFixed(4)}  (${logLossImprove >= 0 ? "-" : "+"}${Math.abs(logLossImprove).toFixed(1)}% improvement)`);
    console.log("");

    console.log("  Bucket   Before   After    Actual   Before-Gap  After-Gap");
    console.log("  ──────   ──────   ─────    ──────   ──────────  ─────────");
    const calData = [];
    for (const g of gamesWithStats) {
      const homeLogit = Math.log(g.homeProb / (100 - g.homeProb));
      const awayLogit = Math.log(g.awayProb / (100 - g.awayProb));
      calData.push({ logit: homeLogit, outcome: g.homeWinner ? 1 : 0 });
      calData.push({ logit: awayLogit, outcome: g.homeWinner ? 0 : 1 });
    }
    const calBuckets = {};
    for (const d of calData) {
      const rawProb = 1 / (1 + Math.exp(-d.logit));
      const calProb = 1 / (1 + Math.exp(-(platt.A * d.logit + platt.B)));
      const bucket = Math.round(rawProb * 20) * 5;
      const key = `${bucket}%`;
      if (!calBuckets[key]) calBuckets[key] = { raw: [], cal: [], outcomes: [] };
      calBuckets[key].raw.push(rawProb * 100);
      calBuckets[key].cal.push(calProb * 100);
      calBuckets[key].outcomes.push(d.outcome);
    }
    for (const [key, bucket] of Object.entries(calBuckets).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
      if (bucket.outcomes.length < 3) continue;
      const avgRaw = bucket.raw.reduce((a, b) => a + b, 0) / bucket.raw.length;
      const avgCal = bucket.cal.reduce((a, b) => a + b, 0) / bucket.cal.length;
      const actual = bucket.outcomes.reduce((a, b) => a + b, 0) / bucket.outcomes.length * 100;
      const beforeGap = (actual - avgRaw).toFixed(1);
      const afterGap = (actual - avgCal).toFixed(1);
      const afterCalib = Math.abs(parseFloat(afterGap)) < 3 ? "Good" : Math.abs(parseFloat(afterGap)) < 6 ? "Fair" : "Poor";
      console.log(`  ${key.padStart(6)}   ${avgRaw.toFixed(1)}%    ${avgCal.toFixed(1)}%    ${actual.toFixed(1)}%    ${(parseFloat(beforeGap) >= 0 ? "+" : "") + beforeGap}pp    ${(parseFloat(afterGap) >= 0 ? "+" : "") + afterGap}pp  ${afterCalib}`);
    }

    console.log("");
    const calibrationDir = path.join(HERE, "..", "src", "lib");
    const calibrationPath = path.join(calibrationDir, cfg.calibrationFile);
    const calibrationData = {
      version: 1,
      fittedAt: new Date().toISOString(),
      // Each sport stamps its OWN feature-set version. Using the MLB constant
      // here would label a football fit with a version that describes an
      // unrelated model.
      featureSet: cfg.featureSet,
      trainingPeriod: { from, to },
      trainingGames: total,
      trainingSamples: platt.samples,
      plattScaling: { A: platt.A, B: platt.B },
      metrics: {
        brierBefore: platt.brierBefore,
        brierAfter: platt.brierAfter,
        logLossBefore: platt.logLossBefore,
        logLossAfter: platt.logLossAfter,
      },
      reliability: computeReliability(gamesWithStats, platt),
    };
    await writeFile(calibrationPath, JSON.stringify(calibrationData, null, 2) + "\n");
    console.log(`  ✓ Calibration saved to ${calibrationPath}`);
    console.log("");
    console.log(`  ℹ️  The production model in ${cfg.moduleLabel} will automatically load`);
    console.log("     these parameters and apply calibration to all future predictions.");
    console.log("");
  } else {
    console.log("  ⚠️  Could not fit calibration — not enough data.");
    console.log("");
  }

  if (opts.sample > 0) {
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`              SAMPLE GAMES (first ${opts.sample})`);
    console.log("═══════════════════════════════════════════════════════════\n");
    for (const g of gamesWithStats.slice(0, opts.sample)) {
      const pick = g.homeProb > g.awayProb ? g.homeTeam : g.awayTeam;
      const pickProb = Math.max(g.homeProb, g.awayProb);
      const edge = Math.abs(g.homeProb - 50);
      const result = g.correct ? "✓ CORRECT" : "✗ WRONG";
      console.log(`  ${g.date}  ${g.awayTeam} @ ${g.homeTeam}`);
      console.log(`    Raw model:  ${g.awayTeam} ${g.awayProb.toFixed(1)}%  |  ${g.homeTeam} ${g.homeProb.toFixed(1)}%`);
      console.log(`    Pick:       ${pick} (${pickProb.toFixed(1)}%)  Edge: ${edge.toFixed(1)}pp`);
      console.log(`    Actual:     ${g.homeWinner ? "HOME WIN" : "AWAY WIN"} (${g.homeScore} - ${g.awayScore})`);
      console.log(`    Result:     ${result}`);
      console.log("");
    }
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                     VERDICT");
  console.log("═══════════════════════════════════════════════════════════");
  if (accuracy >= 0.58 && brierScore < 0.24) {
    console.log("  🟢 STRONG — Model shows meaningful predictive signal.");
    console.log("     Consider paper-trading before real money.");
  } else if (accuracy >= 0.54 && brierScore < 0.245) {
    console.log("  🟡 PROMISING — Model shows some signal but needs more data.");
    console.log("     Backtest over a full season before betting real money.");
  } else if (brierScore >= 0.25) {
    console.log("  🔴 WEAK — Model is no better than a coin flip (Brier ≥ 0.25).");
    console.log("     Do NOT bet real money. Retrain coefficients or add features.");
  } else {
    console.log("  🟠 MARGINAL — Model has slight signal but likely not profitable");
    console.log("     after vig. Needs longer backtest and calibration tuning.");
  }
  if (platt) {
    const brierImprove = ((platt.brierBefore - platt.brierAfter) / platt.brierBefore * 100).toFixed(1);
    console.log(`  📐 Platt scaling calibration: Brier improved ${brierImprove}% (saved to src/lib/${cfg.calibrationFile})`);
  }
  console.log("");
  console.log("  ℹ️  This backtest uses simulated vigged odds (-110). Real");
  console.log("     closing lines may be sharper. Always validate with real odds.");
  console.log("");
}

/** Full CFB/NFL backtest: fetch completed games, rebuild team PPG, run the
 *  sport's logistic model, and report + fit + save calibration. */
async function runFootball(opts) {
  const cfg = FOOTBALL_CONFIG[opts.sport];
  const today = new Date();
  let from, to;

  if (opts.from && opts.to) {
    from = opts.from;
    to = opts.to;
  } else {
    to = today.toISOString().slice(0, 10);
    const d = new Date(today);
    d.setDate(d.getDate() - opts.days);
    from = d.toISOString().slice(0, 10);
  }

  const dates = dateRange(from, to);
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║           ${cfg.banner.padEnd(47)}║`);
  console.log(`║  Period: ${from} → ${to}  (${dates.length} days)`.padEnd(59) + "║");
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  // 1. Fetch all completed games (ESPN regular-season scoreboard).
  console.log("Phase 1/3: Fetching game data…");
  const allGames = [];
  let daysProcessed = 0;
  for (const date of dates) {
    const season = footballSeason(date);
    const games = await fetchFootballGames(cfg, date, season);
    allGames.push(...games);
    daysProcessed++;
    if (daysProcessed % 7 === 0) {
      process.stdout.write(`  ${daysProcessed}/${dates.length} days fetched (${allGames.length} games)…\r`);
    }
  }
  console.log(`  ✓ ${allGames.length} completed games across ${daysProcessed} days\n`);

  if (allGames.length === 0) {
    console.log("No completed games found in the specified range.");
    return;
  }

  // 2. Fetch team PPG and run the sport model for each game.
  console.log("Phase 2/3: Fetching team stats and running the model…");
  const gamesWithStats = [];
  let statsFetched = 0;

  for (const game of allGames) {
    const season = footballSeason(game.date);
    const [awayPpg, homePpg] = await Promise.all([
      fetchFootballTeamStats(cfg, game.awayTeamId, season),
      fetchFootballTeamStats(cfg, game.homeTeamId, season),
    ]);

    const result = runFootballModel(cfg, game, awayPpg, homePpg);
    if (!result) continue;

    const homeWinner = game.homeWinner;
    const modelPickHome = result.homeProb > result.awayProb;
    const correct = modelPickHome === homeWinner;
    const gameEdge = Math.max(Math.abs(result.homeProb - 50), Math.abs(result.awayProb - 50));

    gamesWithStats.push({
      ...result,
      homeWinner,
      correct,
      gameEdge,
      date: game.date,
    });
    statsFetched++;
    if (statsFetched % 40 === 0) {
      process.stdout.write(`  ${statsFetched}/${allGames.length} games processed…\r`);
    }
  }
  console.log(`  ✓ ${gamesWithStats.length} games with complete model data\n`);

  if (gamesWithStats.length === 0) {
    console.log("No games had sufficient data for the model. Try a different date range.");
    return;
  }

  // 3. Analyze results
  console.log("Phase 3/3: Analyzing results…\n");
  await reportFootball(cfg, gamesWithStats, from, to, opts);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  if (opts.sport !== "mlb") {
    await runFootball(opts);
    return;
  }

  const today = new Date();
  let from, to;

  if (opts.from && opts.to) {
    from = opts.from;
    to = opts.to;
  } else {
    to = today.toISOString().slice(0, 10);
    const d = new Date(today);
    d.setDate(d.getDate() - opts.days);
    from = d.toISOString().slice(0, 10);
  }

  const dates = dateRange(from, to);
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║           MLB Model Backtest                            ║`);
  console.log(`║  Period: ${from} → ${to}  (${dates.length} days)`.padEnd(59) + "║");
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);

  // 1. Fetch all games
  console.log("Phase 1/3: Fetching game data…");
  const allGames = [];
  let daysProcessed = 0;
  for (const date of dates) {
    const games = await fetchGames(date);
    allGames.push(...games);
    daysProcessed++;
    if (daysProcessed % 7 === 0) {
      process.stdout.write(`  ${daysProcessed}/${dates.length} days fetched (${allGames.length} games)…\r`);
    }
  }
  console.log(`  ✓ ${allGames.length} completed games across ${daysProcessed} days\n`);

  if (allGames.length === 0) {
    console.log("No completed games found in the specified range.");
    return;
  }

  // 2. Fetch team + pitcher stats for each game
  console.log("Phase 2/3: Fetching team and pitcher stats…");
  let statsFetched = 0;
  const gamesWithStats = [];

  for (const game of allGames) {
    const season = parseInt(game.date.slice(0, 4));

    // Fetch team stats
    const [awayTeamStats, homeTeamStats] = await Promise.all([
      fetchTeamStats(game.awayTeam, season),
      fetchTeamStats(game.homeTeam, season),
    ]);

    // Fetch pitcher stats (lazy — cached after first fetch)
    let awayPitcherStats = null;
    let homePitcherStats = null;
    if (game.awayPitcherId) {
      awayPitcherStats = await fetchPitcherStats(game.awayPitcherId, season);
    }
    if (game.homePitcherId) {
      homePitcherStats = await fetchPitcherStats(game.homePitcherId, season);
    }

    statsFetched++;
    if (statsFetched % 20 === 0) {
      process.stdout.write(`  ${statsFetched}/${allGames.length} games processed…\r`);
    }

    // Run model
    const result = runModel({
      awayTeam: game.awayTeam,
      homeTeam: game.homeTeam,
      awayRecord: game.awayRecord,
      homeRecord: game.homeRecord,
      awayPitcher: game.awayPitcher,
      homePitcher: game.homePitcher,
      awayPitcherId: game.awayPitcherId,
      homePitcherId: game.homePitcherId,
      awayEra: awayPitcherStats?.era ?? null,
      homeEra: homePitcherStats?.era ?? null,
      awayFip: awayPitcherStats?.fip ?? null,
      homeFip: homePitcherStats?.fip ?? null,
      awayK9: awayPitcherStats?.k9 ?? null,
      homeK9: homePitcherStats?.k9 ?? null,
      awayBb9: awayPitcherStats?.bb9 ?? null,
      homeBb9: homePitcherStats?.bb9 ?? null,
      awayHr9: awayPitcherStats?.hr9 ?? null,
      homeHr9: homePitcherStats?.hr9 ?? null,
      awayIp: awayPitcherStats?.ip ?? null,
      homeIp: homePitcherStats?.ip ?? null,
      awayRpg: awayTeamStats?.rpg ?? null,
      homeRpg: homeTeamStats?.rpg ?? null,
      awayBpEra: awayTeamStats?.bullpenEra ?? null,
      homeBpEra: homeTeamStats?.bullpenEra ?? null,
      awayScore: game.awayScore,
      homeScore: game.homeScore,
      season,
    });

    if (!result) continue;

    const homeWinner = game.homeWinner;
    const modelPickHome = result.homeProb > result.awayProb;
    const correct = modelPickHome === homeWinner;
    const edge = Math.abs(result.homeProb - 50); // distance from 50% = confidence
    const awayEdge = Math.abs(result.awayProb - 50);
    const gameEdge = Math.max(edge, awayEdge);

    gamesWithStats.push({
      ...result,
      homeWinner,
      correct,
      gameEdge,
      date: game.date,
      awayPitcher: game.awayPitcher || "TBD",
      homePitcher: game.homePitcher || "TBD",
    });
  }
  console.log(`  ✓ ${gamesWithStats.length} games with complete model data\n`);

  if (gamesWithStats.length === 0) {
    console.log("No games had sufficient data for the model. Try a different date range.");
    return;
  }

  // 3. Analyze results
  console.log("Phase 3/3: Analyzing results…\n");

  // Overall accuracy
  const total = gamesWithStats.length;
  const correct = gamesWithStats.filter(g => g.correct).length;
  const accuracy = correct / total;

  // Brier score: mean((prob - outcome)^2) where outcome is 1 for home win, 0 for away
  const brierScores = gamesWithStats.map(g => {
    const outcome = g.homeWinner ? 1 : 0;
    const prob = g.homeProb / 100;
    return (prob - outcome) ** 2;
  });
  const brierScore = brierScores.reduce((a, b) => a + b, 0) / brierScores.length;

  // Log-loss: -mean(y*log(p) + (1-y)*log(1-p))
  const logLosses = gamesWithStats.map(g => {
    const outcome = g.homeWinner ? 1 : 0;
    const prob = Math.max(0.001, Math.min(0.999, g.homeProb / 100));
    return -(outcome * Math.log(prob) + (1 - outcome) * Math.log(1 - prob));
  });
  const logLoss = logLosses.reduce((a, b) => a + b, 0) / logLosses.length;

  // Calibration: group by probability bucket and check actual win rate
  const buckets = {};
  for (const g of gamesWithStats) {
    const bucket = Math.round(g.homeProb / 5) * 5; // round to nearest 5%
    const key = `${bucket}%`;
    if (!buckets[key]) buckets[key] = { count: 0, homeWins: 0 };
    buckets[key].count++;
    if (g.homeWinner) buckets[key].homeWins++;
  }

  // Edge buckets: accuracy by model confidence
  const edgeBuckets = [
    { label: "0-3%", min: 0, max: 3, count: 0, correct: 0 },
    { label: "3-5%", min: 3, max: 5, count: 0, correct: 0 },
    { label: "5-8%", min: 5, max: 8, count: 0, correct: 0 },
    { label: "8-12%", min: 8, max: 12, count: 0, correct: 0 },
    { label: "12%+", min: 12, max: 99, count: 0, correct: 0 },
  ];
  for (const g of gamesWithStats) {
    for (const b of edgeBuckets) {
      if (g.gameEdge >= b.min && g.gameEdge < b.max) {
        b.count++;
        if (g.correct) b.correct++;
      }
    }
  }

  // Home-field accuracy
  const homeGames2 = gamesWithStats.filter(g => g.homeProb > g.awayProb);
  const awayGames2 = gamesWithStats.filter(g => g.awayProb > g.homeProb);
  const homePickCorrect = homeGames2.filter(g => g.correct).length;
  const awayPickCorrect = awayGames2.filter(g => g.correct).length;

  // Home-field advantage quantification
  const homeAvg = gamesWithStats.reduce((s, g) => s + g.homeProb, 0) / total;
  const awayAvg = gamesWithStats.reduce((s, g) => s + g.awayProb, 0) / total;

  // Pitcher data quality
  const tbdGames = gamesWithStats.filter(g =>
    g.awayPitcher === "TBD" || g.homePitcher === "TBD"
  );
  const tbdAccuracy = tbdGames.length > 0
    ? tbdGames.filter(g => g.correct).length / tbdGames.length
    : null;

  const confirmedGames = gamesWithStats.filter(g =>
    g.awayPitcher !== "TBD" && g.homePitcher !== "TBD"
  );
  const confirmedAccuracy = confirmedGames.length > 0
    ? confirmedGames.filter(g => g.correct).length / confirmedGames.length
    : null;

  // Simulated betting ROI: flat $10 bet on model's pick each game
  // Using fair market odds (vigged at -110 each side)
  let bettingProfit = 0;
  let bettingBets = 0;
  let winningBets = 0;
  for (const g of gamesWithStats) {
    // Simulate: we bet $10 on the model's pick
    // Fair odds would be: payout = 10 * (1 / pickProb) * (1 - vig)
    // With -110 vig: implied total = 109.09%, fair payout ≈ pickProb * (1 + 1/110) * 100
    const pickProb = Math.max(g.homeProb, g.awayProb) / 100;
    // At -110, a fair bet pays out $10 * (210/110) = $19.09 on win
    const payout = 10 * (210 / 110); // standard -110 vig payout
    if (g.correct) {
      bettingProfit += payout - 10;
      winningBets++;
    } else {
      bettingProfit -= 10;
    }
    bettingBets++;
  }
  const bettingROI = (bettingProfit / (bettingBets * 10)) * 100;

  // Print results
  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    OVERALL RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Games analyzed:        ${total}`);
  console.log(`  Model correct picks:   ${correct} / ${total} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`  Brier score:           ${brierScore.toFixed(4)}  (0=perfect, 0.25=coin-flip)`);
  console.log(`  Log-loss:              ${logLoss.toFixed(4)}  (lower=better, <0.69=beats coin-flip)`);
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    SIMULATED BETTING");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Strategy:              Flat $10 on model's pick each game`);
  console.log(`  Total bets:            ${bettingBets}`);
  console.log(`  Winning bets:          ${winningBets} / ${bettingBets} (${(winningBets / bettingBets * 100).toFixed(1)}%)`);
  console.log(`  Total P/L:             ${bettingProfit >= 0 ? "+" : ""}$${bettingProfit.toFixed(2)}`);
  console.log(`  ROI:                   ${bettingROI >= 0 ? "+" : ""}${bettingROI.toFixed(1)}%`);
  console.log(`  Breakeven win rate:    ${(100/2.1).toFixed(1)}% (at -110 vig)`);
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    PICK DIRECTION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Home-favored games:    ${homeGames2.length}`);
  console.log(`    → Model correct:     ${homePickCorrect} / ${homeGames2.length} (${homeGames2.length > 0 ? (homePickCorrect / homeGames2.length * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  Away-favored games:    ${awayGames2.length}`);
  console.log(`    → Model correct:     ${awayPickCorrect} / ${awayGames2.length} (${awayGames2.length > 0 ? (awayPickCorrect / awayGames2.length * 100).toFixed(1) : "N/A"}%)`);
  console.log(`  Avg home model prob:   ${homeAvg.toFixed(1)}%  (avg away: ${awayAvg.toFixed(1)}%)`);
  console.log(`  Home-field advantage:  +${(homeAvg - 50).toFixed(1)}pp in model`);
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("              ACCURACY BY MODEL CONFIDENCE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Edge Range   Games   Correct   Accuracy   Interpretation");
  console.log("  ──────────   ─────   ───────   ────────   ───────────────");
  for (const b of edgeBuckets) {
    if (b.count === 0) continue;
    const acc = (b.correct / b.count * 100).toFixed(1);
    const bar = "█".repeat(Math.round(b.correct / b.count * 20));
    console.log(`  ${b.label.padEnd(10)}   ${String(b.count).padStart(5)}   ${String(b.correct).padStart(7)}   ${acc.padStart(6)}%    ${bar}`);
  }
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                   CALIBRATION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Model says   Games   Actual Win%   Gap      Calibration");
  console.log("  ──────────   ─────   ───────────   ────     ────────────");
  const sortedBuckets = Object.entries(buckets)
    .map(([k, v]) => ({ prob: parseInt(k), ...v }))
    .sort((a, b) => a.prob - b.prob);
  for (const b of sortedBuckets) {
    if (b.count < 3) continue;
    const actual = (b.homeWins / b.count * 100).toFixed(1);
    const gap = (b.homeWins / b.count * 100 - b.prob).toFixed(1);
    const gapNum = parseFloat(gap);
    const calib = Math.abs(gapNum) < 3 ? "Good" : Math.abs(gapNum) < 6 ? "Fair" : "Poor";
    const indicator = gapNum > 0 ? "↑" : gapNum < 0 ? "↓" : "=";
    console.log(`  ${String(b.prob + "%").padStart(10)}   ${String(b.count).padStart(5)}   ${actual.padStart(9)}%   ${gap.padStart(5)}pp  ${calib} ${indicator}`);
  }
  console.log("");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("                PITCHER DATA QUALITY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Confirmed pitcher games:  ${confirmedGames.length}`);
  console.log(`    → Accuracy:              ${confirmedAccuracy != null ? (confirmedAccuracy * 100).toFixed(1) : "N/A"}%`);
  console.log(`  TBD pitcher games:        ${tbdGames.length}`);
  console.log(`    → Accuracy:              ${tbdAccuracy != null ? (tbdAccuracy * 100).toFixed(1) : "N/A"}%`);
  if (tbdGames.length > 0 && confirmedGames.length > 0) {
    const diff = (confirmedAccuracy - tbdAccuracy) * 100;
    console.log(`  Confirmed vs TBD gap:     ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}pp`);
  }
  console.log("");

  // ── Platt Scaling Calibration ──────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log("            PLATT SCALING CALIBRATION");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Fitting calibration on backtest data…");

  const platt = fitPlattScaling(gamesWithStats);

  if (platt) {
    const brierImprove = ((platt.brierBefore - platt.brierAfter) / platt.brierBefore * 100).toFixed(1);
    const logLossImprove = ((platt.logLossBefore - platt.logLossAfter) / platt.logLossBefore * 100).toFixed(1);

    console.log(`  Samples:               ${platt.samples} (2 per game: home + away)`);
    console.log("");
    console.log(`  Calibration params:    A = ${platt.A.toFixed(6)}, B = ${platt.B.toFixed(6)}`);
    console.log("");
    console.log(`  Brier score:           ${platt.brierBefore.toFixed(4)} → ${platt.brierAfter.toFixed(4)}  (${brierImprove >= 0 ? "-" : "+"}${Math.abs(brierImprove).toFixed(1)}% improvement)`);
    console.log(`  Log-loss:              ${platt.logLossBefore.toFixed(4)} → ${platt.logLossAfter.toFixed(4)}  (${logLossImprove >= 0 ? "-" : "+"}${Math.abs(logLossImprove).toFixed(1)}% improvement)`);
    console.log("");

    // Show calibration table: before vs after
    console.log("  Bucket   Before   After    Actual   Before-Gap  After-Gap");
    console.log("  ──────   ──────   ─────    ──────   ──────────  ─────────");

    // Rebuild the data pairs for the calibration table
    const calData = [];
    for (const g of gamesWithStats) {
      const homeLogit = Math.log(g.homeProb / (100 - g.homeProb));
      const awayLogit = Math.log(g.awayProb / (100 - g.awayProb));
      calData.push({ logit: homeLogit, outcome: g.homeWinner ? 1 : 0 });
      calData.push({ logit: awayLogit, outcome: g.homeWinner ? 0 : 1 });
    }

    const calBuckets = {};
    for (const d of calData) {
      const rawProb = 1 / (1 + Math.exp(-d.logit));
      const calProb = 1 / (1 + Math.exp(-(platt.A * d.logit + platt.B)));
      const bucket = Math.round(rawProb * 20) * 5;
      const key = `${bucket}%`;
      if (!calBuckets[key]) calBuckets[key] = { raw: [], cal: [], outcomes: [] };
      calBuckets[key].raw.push(rawProb * 100);
      calBuckets[key].cal.push(calProb * 100);
      calBuckets[key].outcomes.push(d.outcome);
    }

    for (const [key, bucket] of Object.entries(calBuckets).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
      if (bucket.outcomes.length < 3) continue;
      const avgRaw = bucket.raw.reduce((a, b) => a + b, 0) / bucket.raw.length;
      const avgCal = bucket.cal.reduce((a, b) => a + b, 0) / bucket.cal.length;
      const actual = bucket.outcomes.reduce((a, b) => a + b, 0) / bucket.outcomes.length * 100;
      const beforeGap = (actual - avgRaw).toFixed(1);
      const afterGap = (actual - avgCal).toFixed(1);
      const afterCalib = Math.abs(parseFloat(afterGap)) < 3 ? "Good" : Math.abs(parseFloat(afterGap)) < 6 ? "Fair" : "Poor";
      console.log(`  ${key.padStart(6)}   ${avgRaw.toFixed(1)}%    ${avgCal.toFixed(1)}%    ${actual.toFixed(1)}%    ${(parseFloat(beforeGap) >= 0 ? "+" : "") + beforeGap}pp    ${(parseFloat(afterGap) >= 0 ? "+" : "") + afterGap}pp  ${afterCalib}`);
    }

    console.log("");

    // Save calibration parameters
    const calibrationDir = path.join(HERE, "..", "src", "lib");
    const calibrationPath = path.join(calibrationDir, "calibration.json");
    const calibrationData = {
      version: 1,
      fittedAt: new Date().toISOString(),
      featureSet: FEATURE_SET_VERSION,
      trainingPeriod: { from, to },
      trainingGames: total,
      trainingSamples: platt.samples,
      plattScaling: { A: platt.A, B: platt.B },
      metrics: {
        brierBefore: platt.brierBefore,
        brierAfter: platt.brierAfter,
        logLossBefore: platt.logLossBefore,
        logLossAfter: platt.logLossAfter,
      },
      reliability: computeReliability(gamesWithStats, platt),
    };
    await writeFile(calibrationPath, JSON.stringify(calibrationData, null, 2) + "\n");
    console.log(`  ✓ Calibration saved to ${calibrationPath}`);
    console.log("");
    console.log("  ℹ️  The production model in analysis.ts will automatically load");
    console.log("     these parameters and apply calibration to all future predictions.");
    console.log("");
  } else {
    console.log("  ⚠️  Could not fit calibration — not enough data.");
    console.log("");
  }

  // Sample games
  if (opts.sample > 0) {
    const sample = gamesWithStats.slice(0, opts.sample);
    const plattRef = platt; // capture for use in sample display
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`              SAMPLE GAMES (first ${opts.sample})`);
    console.log("═══════════════════════════════════════════════════════════\n");
    for (const g of sample) {
      const pick = g.homeProb > g.awayProb ? g.homeTeam : g.awayTeam;
      const pickProb = Math.max(g.homeProb, g.awayProb);
      const edge = Math.abs(g.homeProb - 50);
      const result = g.correct ? "✓ CORRECT" : "✗ WRONG";
      // Calibrated probabilities
      let calHome = null, calAway = null;
      if (plattRef) {
        const homeLogit = Math.log(g.homeProb / (100 - g.homeProb));
        const awayLogit = Math.log(g.awayProb / (100 - g.awayProb));
        calHome = (1 / (1 + Math.exp(-(plattRef.A * homeLogit + plattRef.B)))) * 100;
        calAway = 100 - calHome;
      }
      console.log(`  ${g.date}  ${g.awayTeam} @ ${g.homeTeam}`);
      console.log(`    Pitchers:   ${g.awayPitcher} vs ${g.homePitcher}`);
      console.log(`    Raw model:  ${g.awayTeam} ${g.awayProb.toFixed(1)}%  |  ${g.homeTeam} ${g.homeProb.toFixed(1)}%`);
      if (calHome != null) {
        console.log(`    Calibrated: ${g.awayTeam} ${calAway.toFixed(1)}%  |  ${g.homeTeam} ${calHome.toFixed(1)}%`);
      }
      console.log(`    Pick:       ${pick} (${pickProb.toFixed(1)}%)  Edge: ${edge.toFixed(1)}pp`);
      console.log(`    Actual:     ${g.homeWinner ? "HOME WIN" : "AWAY WIN"} (${g.homeScore} - ${g.awayScore})`);
      console.log(`    Result:     ${result}`);
      console.log("");
    }
  }

  // Verdict
  console.log("═══════════════════════════════════════════════════════════");
  console.log("                     VERDICT");
  console.log("═══════════════════════════════════════════════════════════");
  if (accuracy >= 0.58 && brierScore < 0.24) {
    console.log("  🟢 STRONG — Model shows meaningful predictive signal.");
    console.log("     Consider paper-trading before real money.");
  } else if (accuracy >= 0.54 && brierScore < 0.245) {
    console.log("  🟡 PROMISING — Model shows some signal but needs more data.");
    console.log("     Backtest over a full season before betting real money.");
  } else if (brierScore >= 0.25) {
    console.log("  🔴 WEAK — Model is no better than a coin flip (Brier ≥ 0.25).");
    console.log("     Do NOT bet real money. Retrain coefficients or add features.");
  } else {
    console.log("  🟠 MARGINAL — Model has slight signal but likely not profitable");
    console.log("     after vig. Needs longer backtest and calibration tuning.");
  }
  if (platt) {
    const brierImprove = ((platt.brierBefore - platt.brierAfter) / platt.brierBefore * 100).toFixed(1);
    console.log(`  📐 Platt scaling calibration: Brier improved ${brierImprove}% (saved to src/lib/calibration.json)`);
  }
  console.log("");
  console.log("  ℹ️  This backtest uses simulated vigged odds (-110). Real");
  console.log("     closing lines may be sharper. Always validate with real odds.");
  console.log("");
}

main().catch(err => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
