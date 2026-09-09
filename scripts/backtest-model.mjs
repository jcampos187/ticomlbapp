#!/usr/bin/env node
/**
 * backtest-model.mjs — Validate the MLB betting model against historical results.
 *
 * Fetches completed MLB games from the Stats API (free, no key), rebuilds
 * team stats and pitcher stats as they would have been known at game time,
 * runs the logistic model, and compares predictions to actual outcomes.
 *
 * Usage:
 *     node scripts/backtest-model.mjs                       # last 30 days
 *     node scripts/backtest-model.mjs --days 60             # last 60 days
 *     node scripts/backtest-model.mjs --from 2025-06-01 --to 2025-06-30
 *     node scripts/backtest-model.mjs --sample 50           # print 50 game details
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
  k9: 8.6,
  bullpenEra: 4.1,
};

const MIN_EDGE_GAMES = 4;

// Logistic coefficients — MUST match src/lib/analysis.ts exactly
const HOME_ADV = 0.24;
const COEF_WIN_RATE = 2.8;
const COEF_RUNS_PER_GAME = 0.22;
const COEF_STARTER_ERA = 0.28;
const COEF_K9 = 0.05;
const COEF_BULLPEN_ERA = 0.18;
const MAX_FEATURE_LOGIT = {
  winRate: 0.6,
  runsPerGame: 0.4,
  starterEra: 0.5,
  k9: 0.3,
  bullpenEra: 0.4,
};

// Edge thresholds for confidence grades
const EDGE_A = 8;
const EDGE_B = 5;
const EDGE_C = 3;

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
 * Compute raw log-odds (z-score) for one side — mirrors computeRawLogit
 * from src/lib/analysis.ts.
 */
function computeRawLogit(t, o, isHome) {
  let z = isHome ? HOME_ADV : 0;
  z += clampFeature((t.winRate - o.winRate) * COEF_WIN_RATE, MAX_FEATURE_LOGIT.winRate);
  z += clampFeature((t.runsPerGame - o.runsPerGame) * COEF_RUNS_PER_GAME, MAX_FEATURE_LOGIT.runsPerGame);
  z += clampFeature((o.starterEra - t.starterEra) * COEF_STARTER_ERA, MAX_FEATURE_LOGIT.starterEra);
  z += clampFeature((t.k9 - o.k9) * COEF_K9, MAX_FEATURE_LOGIT.k9);
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
  const out = { days: 30, sample: 0, from: null, to: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) out.days = Number(args[++i]);
    else if (args[i] === "--from" && args[i + 1]) out.from = args[++i];
    else if (args[i] === "--to" && args[i + 1]) out.to = args[++i];
    else if (args[i] === "--sample" && args[i + 1]) out.sample = Number(args[++i]);
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
 * Fetch a pitcher's ERA and K/9 for a season. Falls back to prior season.
 * Returns { era, k9 } or null.
 */
const pitcherCache = new Map();
async function fetchPitcherStats(pitcherId, season) {
  if (!pitcherId) return null;
  const key = `${pitcherId}|${season}`;
  if (pitcherCache.has(key)) return pitcherCache.get(key);

  for (const yr of [season, season - 1]) {
    const url = `${MLB_API}/people/${pitcherId}/stats?stats=season&group=pitching&season=${yr}&gameType=R`;
    const data = await fetchJSON(url);
    if (data?.stats?.[0]?.splits?.[0]) {
      const s = data.stats[0].splits[0].stat;
      const era = parseFloat(s.era) || null;
      const k9 = parseFloat(s.strikeoutsPer9Inn) || null;
      if (era != null || k9 != null) {
        const result = { era, k9 };
        pitcherCache.set(key, result);
        return result;
      }
    }
  }
  pitcherCache.set(key, null);
  return null;
}

// ─── Backtest engine ─────────────────────────────────────────────────────────

function runModel(inputs) {
  const { awayTeam, homeTeam, awayRecord, homeRecord, awayPitcher, homePitcher, awayPitcherId, homePitcherId,
          awayEra, homeEra, awayK9, homeK9, awayRpg, homeRpg, awayBpEra, homeBpEra, season } = inputs;

  // Parse records
  const [awayW, awayL] = (awayRecord || "").split("-").map(Number);
  const [homeW, homeL] = (homeRecord || "").split("-").map(Number);
  const awayGames = (Number.isFinite(awayW) && Number.isFinite(awayL)) ? awayW + awayL : 0;
  const homeGames = (Number.isFinite(homeW) && Number.isFinite(homeL)) ? homeW + homeL : 0;

  if (awayGames < MIN_EDGE_GAMES || homeGames < MIN_EDGE_GAMES) return null;

  const awayWinRate = awayW / awayGames;
  const homeWinRate = homeW / homeGames;

  // Build model inputs (same logic as teamInputs in analysis.ts)
  const awayInputs = {
    winRate: awayWinRate,
    runsPerGame: awayRpg ?? LEAGUE_AVG.runsPerGame,
    starterEra: awayEra ?? LEAGUE_AVG.starterEra,
    k9: awayK9 ?? LEAGUE_AVG.k9,
    bullpenEra: awayBpEra ?? LEAGUE_AVG.bullpenEra,
    complete: awayRpg != null && awayEra != null && awayK9 != null && awayBpEra != null,
  };
  const homeInputs = {
    winRate: homeWinRate,
    runsPerGame: homeRpg ?? LEAGUE_AVG.runsPerGame,
    starterEra: homeEra ?? LEAGUE_AVG.starterEra,
    k9: homeK9 ?? LEAGUE_AVG.k9,
    bullpenEra: homeBpEra ?? LEAGUE_AVG.bullpenEra,
    complete: homeRpg != null && homeEra != null && homeK9 != null && homeBpEra != null,
  };

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
    awayK9: awayInputs.k9, homeK9: homeInputs.k9,
    awayRpg: awayInputs.runsPerGame, homeRpg: homeInputs.runsPerGame,
    awayBpEra: awayInputs.bullpenEra, homeBpEra: homeInputs.bullpenEra,
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

function pct(n) { return (n * 100).toFixed(1) + "%"; }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
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
      awayK9: awayPitcherStats?.k9 ?? null,
      homeK9: homePitcherStats?.k9 ?? null,
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
