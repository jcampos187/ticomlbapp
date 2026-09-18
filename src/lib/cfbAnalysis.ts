import type { CfbGame, CfbTopPick, CfbAtsPick, CfbTotalPick, CfbParlay, CfbModelEdge } from "./cfbTypes";
import { formatOdds, calculateParlayPayout, sigmoid, fairMarketProbability, expectedValue, edgeConfidence, marketProbability } from "./analysis";
import calibration from "./calibration-cfb.json";

// ── Model Edge: logistic win-probability model vs market implied ────
// CFB has wider PPG spreads and a bigger home advantage than the NFL, so the
// PPG coefficient and home offset are calibrated higher. Moneylines are often
// OFF in CFB — games without an ML simply produce no edge.
const CFB_LEAGUE_AVG = {
  winRate: 0.5,
  ppg: 28.0,
};

// A record must represent at least this many games before win rate counts as
// a real signal. Early-season CFB records (1-2 games, e.g. a 2-0 FCS team
// vs a 0-1 Power-5 team) are noise, not information — below the floor teams
// fall back to the league baseline and no edges are produced.
const MIN_EDGE_GAMES = 4;

// CFB home field ≈ 2.5-3 points, and ~1 point of expected margin ≈ 0.16
// logits (a 10-pt CFB favorite ≈ 85% win prob, a 21-pt favorite ≈ 96%).
const CFB_HOME_ADV = 0.42;
const CFB_COEF_WIN_RATE = 3.2;
const CFB_COEF_PPG = 0.16;

interface CfbModelInputs {
  winRate: number;
  ppg: number;
  complete: boolean;
}

function cfbInputs(game: CfbGame, side: "away" | "home"): CfbModelInputs {
  const winRateRaw = (side === "away" ? game.awayRecord : game.homeRecord) || "";
  const [w, l] = winRateRaw.split("-").map(Number);
  const games = Number.isFinite(w) && Number.isFinite(l) ? w + l : 0;
  const winRate = games >= MIN_EDGE_GAMES ? w / games : null;
  const ppg = side === "away" ? game.awayPpg : game.homePpg;
  return {
    winRate: winRate ?? CFB_LEAGUE_AVG.winRate,
    ppg: ppg ?? CFB_LEAGUE_AVG.ppg,
    // Strong data = both sides have record (4+ games) + PPG (4 of 4 inputs).
    complete: winRate != null && ppg != null,
  };
}

/**
 * Whether the model has enough real inputs to compare against a market price.
 *
 * DO NOT relax this to "at least one side has some data". Below the
 * MIN_EDGE_GAMES floor the win-rate term collapses to the 0.5 fallback on both
 * sides, which leaves the ENTIRE model as one unbounded PPG term. PPG is not
 * opponent-adjusted, so in the first weeks — when slates are full of FCS
 * tune-ups — a 20-30 point PPG gap turns into a 60-90% model probability and
 * produces "edges" like `UT Martin +4000 · model 46.7% · edge +44.3pp ·
 * EV +1815%`, and `Giants +295 · model 82.7% · edge +58.4pp`. Those are not
 * opportunities, they are the absence of a model. Every model-driven section
 * must fail closed until records clear the floor.
 */
function hasModelSignal(probs: ReturnType<typeof computeCfbNormProbs>): boolean {
  if (!probs) return false;
  return probs.awayInputs.complete || probs.homeInputs.complete;
}

/**
 * Apply Platt scaling calibration to a raw logit (fitted by the backtest
 * script for CFB; see `calibration-cfb.json`, generated via `npm run
 * backtest -- --sport cfb`). A≈0.68 < 1 means the raw logits are
 * overconfident — calibration compresses them toward 50%.
 */
function calibrateLogit(rawLogit: number): number {
  const { A, B } = calibration.plattScaling;
  return A * rawLogit + B;
}

/** Raw log-odds (z-score) for one side of a CFB game — NOT a probability. */
function cfbRawLogit(t: CfbModelInputs, o: CfbModelInputs, isHome: boolean): number {
  let z = isHome ? CFB_HOME_ADV : 0;
  z += (t.winRate - o.winRate) * CFB_COEF_WIN_RATE;
  z += (t.ppg - o.ppg) * CFB_COEF_PPG;
  return z;
}

/**
 * Compute normalised model probabilities (%) for both sides of a CFB game.
 *
 * Raw logits are converted to odds-ratio space via sigmoid, then normalised
 * so that P(away) + P(home) = 100%. Computing independent sigmoids allowed
 * P(away) + P(home) to drift away from 100%; normalising keeps the model a
 * true two-outcome distribution.
 */
export function computeCfbNormProbs(game: CfbGame): {
  awayProb: number;
  homeProb: number;
  awayInputs: CfbModelInputs;
  homeInputs: CfbModelInputs;
} | null {
  const awayML = game.awayML;
  const homeML = game.homeML;
  if (!awayML || !homeML) return null;

  const t = cfbInputs(game, "away");
  const o = cfbInputs(game, "home");

  const awayRawLogit = cfbRawLogit(t, o, false);
  const homeRawLogit = cfbRawLogit(o, t, true);

  // Apply Platt scaling calibration to the raw logits before normalisation.
  // This corrects systematic biases in the model's probability outputs.
  const eAway = sigmoid(calibrateLogit(awayRawLogit));
  const eHome = sigmoid(calibrateLogit(homeRawLogit));
  const total = eAway + eHome;

  // Clamp to [3%, 97%] to avoid displaying extreme probabilities.
  const awayProb = Math.min(0.97, Math.max(0.03, eAway / total)) * 100;
  const homeProb = 100 - awayProb; // guaranteed to sum to exactly 100

  return { awayProb, homeProb, awayInputs: t, homeInputs: o };
}

/**
 * Logistic win probability (%) for one side of a CFB game.
 *
 * NOTE: This uses the normalised approach so both sides always sum to 100%.
 * Returns null when there's no moneyline on the game (no odds = no bettable
 * game).
 */
export function cfbTeamWinProbability(game: CfbGame, side: "away" | "home"): number | null {
  const probs = computeCfbNormProbs(game);
  if (!probs) return null;
  return side === "away" ? probs.awayProb : probs.homeProb;
}

/**
 * Compute the model edge for every CFB team with a moneyline and surface the
 * positive ones (model likes the team more than the market does).
 *
 * Model probabilities are NORMALISED (both sides sum to 100%) and market
 * probabilities are DE-VIGGED (both sides sum to 100%), so the edge is
 * model vs fair market.
 */
export function computeCfbModelEdges(games: CfbGame[]): CfbModelEdge[] {
  const edges: CfbModelEdge[] = [];

  for (const game of games) {
    const probs = computeCfbNormProbs(game);
    if (!probs) continue;

    // No meaningful model data on either side (records below the floor, e.g.
    // the first weeks of the season) means every "edge" would be noise, not
    // signal. See hasModelSignal for what happens when this is relaxed.
    if (!hasModelSignal(probs)) continue;

    // De-vig the market
    const fairAway = fairMarketProbability(game.awayML, game.homeML, "away");
    const fairHome = fairMarketProbability(game.awayML, game.homeML, "home");
    if (fairAway == null || fairHome == null) continue;

    for (const side of ["away", "home"] as const) {
      const team = side === "away" ? game.awayTeam : game.homeTeam;
      const abbrev = side === "away" ? game.awayAbbrev : game.homeAbbrev;
      const opponent = side === "away" ? game.homeTeam : game.awayTeam;
      const ml = side === "away" ? game.awayML : game.homeML;
      if (!ml) continue;

      const modelProb = side === "away" ? probs.awayProb : probs.homeProb;
      const fairMkt = side === "away" ? fairAway : fairHome;
      const edge = modelProb - fairMkt;
      const ev = expectedValue(modelProb, ml) * 100;

      const t = side === "away" ? probs.awayInputs : probs.homeInputs;
      const o = side === "away" ? probs.homeInputs : probs.awayInputs;

      const reasons: string[] = [];
      if (t.winRate > o.winRate + 0.03) reasons.push(`${(t.winRate * 100).toFixed(0)}% win rate`);
      if (t.ppg > o.ppg + 2) reasons.push(`${t.ppg.toFixed(1)} PPG offense`);
      if (side === "home") reasons.push("Home field");
      // One side can clear the floor while the other hasn't. Say why the
      // confidence grade is reduced rather than just showing a B/C.
      if (!(t.complete && o.complete)) {
        reasons.push(`⚠ Thin sample — one side is under ${MIN_EDGE_GAMES} games`);
      }

      edges.push({
        team,
        abbrev,
        opponent,
        gameId: game.id,
        ml,
        home: side === "home",
        modelProb: Math.round(modelProb * 10) / 10,
        fairMarketProb: Math.round(fairMkt * 10) / 10,
        edge: Math.round(edge * 10) / 10,
        ev: Math.round(ev * 10) / 10,
        confidence: edgeConfidence(edge, t.complete && o.complete),
        reasons,
        pitcherConfirmed: true, // CFB has no TBD pitcher concept
      });
    }
  }

  return edges
    .filter(e => e.edge >= 3)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 6);
}

// ── Line-movement thresholds ────────────────────────────────────────
const SHARP_SPREAD_MOVE = 2;   // spread moved 2+ points toward a team
const MILD_SPREAD_MOVE = 1;
const SHARP_ML_CENTS = 30;     // higher threshold for CFB (wider markets)
const MILD_ML_CENTS = 15;      // half of sharp

// Large edges (>10pp) are flagged as needing validation because they may
// indicate either a genuine opportunity or a model/data problem.
const HIGH_EDGE_THRESHOLD = 10;

// ── Moneyline picks — ranked by model edge + EV (not just odds magnitude)
// Same structure as MLB's analyzeFavorites: both sides of each game are
// evaluated, an underdog with positive EV beats a heavy favorite with
// negative EV, and the score weights model edge first.
export function analyzeCfbFavorites(games: CfbGame[]): CfbTopPick[] {
  const picks: (CfbTopPick & { score: number })[] = [];

  for (const game of games) {
    const probs = computeCfbNormProbs(game);
    if (!probs) continue;

    // Same data gate as the edge layer. Without it this section happily
    // surfaced `UT Martin +4000 · model 46.7% · EV +1815%` in week 3: the
    // model's inputs were entirely league-average fallbacks, so the "edge"
    // was the fallback vs a sharp price, not a prediction.
    if (!hasModelSignal(probs)) continue;

    const fairAway = fairMarketProbability(game.awayML, game.homeML, "away");
    const fairHome = fairMarketProbability(game.awayML, game.homeML, "home");
    if (fairAway == null || fairHome == null) continue;

    // Evaluate both sides — an underdog with positive EV is a better bet
    // than a heavy favorite with negative EV.
    const sides = [
      { side: "away" as const, team: game.awayTeam, opponent: game.homeTeam, ml: game.awayML, modelProb: probs.awayProb, fairMkt: fairAway },
      { side: "home" as const, team: game.homeTeam, opponent: game.awayTeam, ml: game.homeML, modelProb: probs.homeProb, fairMkt: fairHome },
    ];

    for (const s of sides) {
      if (!s.ml) continue;

      const edge = s.modelProb - s.fairMkt;
      const ev = expectedValue(s.modelProb, s.ml) * 100; // as percentage

      // Only include picks with positive edge (model disagrees with market)
      if (edge <= 0) continue;

      // Line movement signal (this side's own open → current)
      const isHome = s.side === "home";
      const open = isHome ? game.homeMLOpen : game.awayMLOpen;
      const lineMoveBonus = (() => {
        if (!open) return 0;
        const move = s.ml - open;
        if (move <= -SHARP_ML_CENTS) return 3; // sharp money on this side
        if (move <= -MILD_ML_CENTS) return 1;
        return 0;
      })();

      // Score: edge is the primary factor, EV confirms it, data quality
      // adds confidence. Odds magnitude alone does NOT drive the score.
      const score =
        edge * 0.5 +           // model edge (pp)
        Math.max(0, ev) * 0.3 + // positive EV bonus
        (probs.awayInputs.complete && probs.homeInputs.complete ? 1.5 : 0) + // data quality
        lineMoveBonus; // sharp money signal

      const reasons: string[] = [];
      reasons.push(`Edge +${edge.toFixed(1)}%`);
      reasons.push(`EV ${ev >= 0 ? "+" : ""}${ev.toFixed(1)}%`);
      if (edge >= HIGH_EDGE_THRESHOLD) reasons.push("⚠ HIGH EDGE — needs validation");
      if (s.modelProb > 60) reasons.push(`Model ${s.modelProb.toFixed(1)}%`);
      if (s.ml <= -150) reasons.push(`${formatOdds(s.ml)} favorite`);
      if (s.ml > 0) reasons.push(`${formatOdds(s.ml)} underdog`);
      if (lineMoveBonus >= 2) reasons.push("Sharp money");

      picks.push({
        team: s.team,
        opponent: s.opponent,
        ml: s.ml,
        impliedProb: Math.round(marketProbability(s.ml) * 10) / 10,
        fairMarketProb: Math.round(s.fairMkt * 10) / 10,
        modelProb: Math.round(s.modelProb * 10) / 10,
        edge: Math.round(edge * 10) / 10,
        ev: Math.round(ev * 10) / 10,
        reasons,
        score,
      });
    }
  }

  // Sort by score (edge-weighted), not by odds magnitude.
  // Take top 5 by score, ensuring no duplicate teams.
  const seen = new Set<string>();
  return picks
    .sort((a, b) => b.score - a.score)
    .filter(p => {
      if (seen.has(p.team)) return false;
      seen.add(p.team);
      return true;
    })
    .slice(0, 5);
}

// ── Against the spread ──────────────────────────────────────────────
export function analyzeCfbAts(games: CfbGame[]): CfbAtsPick[] {
  const picks: (CfbAtsPick & { score: number })[] = [];

  for (const game of games) {
    if (game.awaySpread == null && game.homeSpread == null) continue;

    // The favorite is the side with a negative spread
    const favIsAway = (game.awaySpread ?? 0) < (game.homeSpread ?? 0);
    const favSpread = favIsAway ? game.awaySpread : game.homeSpread;
    const favTeam = favIsAway ? game.awayTeam : game.homeTeam;
    const dogTeam = favIsAway ? game.homeTeam : game.awayTeam;
    const isHome = !favIsAway;
    const mag = Math.abs(favSpread ?? 0);

    const record = isHome ? game.homeRecord : game.awayRecord;
    const [w, l] = record.split("-").map(Number);
    const winPct = w + l > 0 ? (w / (w + l)) * 100 : 0;

    let score = 0;
    const reasons: string[] = [];

    // CFB spreads are often huge — adjust thresholds
    if (mag >= 21) { score += 3; reasons.push(`Dominant ${favSpread}`); }
    else if (mag >= 14) { score += 2; reasons.push(`Big favorite ${favSpread}`); }
    else if (mag >= 7) { score += 1; reasons.push(`Favored by ${mag}`); }
    else if (mag >= 3) { score += 1; reasons.push(`Favored by ${mag}`); }

    if (isHome) { score += 1; reasons.push("Home favorite"); }
    if (winPct > 65) { score += 2; reasons.push(`${winPct.toFixed(0)}% win rate`); }
    else if (winPct > 55) { score += 1; reasons.push(`${winPct.toFixed(0)}% win rate`); }

    // Spread movement
    const favOpen = favIsAway ? game.awaySpreadOpen : game.homeSpreadOpen;
    if (favOpen != null && favSpread != null) {
      const move = favSpread - favOpen; // e.g. -3 -> -5 = -2
      if (move <= -SHARP_SPREAD_MOVE) {
        score += 2;
        reasons.push(`Spread moved ${favOpen} → ${favSpread} (sharp money)`);
      } else if (move <= -MILD_SPREAD_MOVE) {
        score += 1;
        reasons.push(`Line movement: ${favOpen} → ${favSpread}`);
      }
    }

    if (score > 0) {
      picks.push({
        team: favTeam,
        opponent: dogTeam,
        line: `${favTeam} ${favSpread}`,
        spread: favSpread ?? 0,
        reasons,
        score,
      });
    }
  }

  return picks.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ── Over/Under totals ───────────────────────────────────────────────
export function analyzeCfbTotals(games: CfbGame[]): CfbTotalPick[] {
  const picks: (CfbTotalPick & { score: number })[] = [];

  for (const game of games) {
    if (!game.overUnder) continue;

    let overVotes = 0;
    let underVotes = 0;
    const overReasons: string[] = [];
    const underReasons: string[] = [];

    // Team scoring trends (points per game)
    const ppg = [game.awayPpg, game.homePpg].filter((v): v is number => v != null && v > 0);
    if (ppg.length === 2) {
      const avgPpg = (ppg[0] + ppg[1]) / 2;
      if (avgPpg >= 35) { overVotes += 2; overReasons.push(`High-scoring offenses avg ${avgPpg.toFixed(1)} PPG`); }
      else if (avgPpg >= 30) { overVotes += 1; overReasons.push(`Offenses avg ${avgPpg.toFixed(1)} PPG`); }
      else if (avgPpg <= 20) { underVotes += 2; underReasons.push(`Low-scoring offenses avg ${avgPpg.toFixed(1)} PPG`); }
      else if (avgPpg <= 24) { underVotes += 1; underReasons.push(`Offenses avg ${avgPpg.toFixed(1)} PPG`); }
    }

    // CFB totals tend to be higher than NFL
    if (game.overUnder >= 65) { overVotes += 2; overReasons.push(`High total ${game.overUnder.toFixed(1)}`); }
    else if (game.overUnder >= 55) { overVotes += 1; overReasons.push(`Total ${game.overUnder.toFixed(1)}`); }
    else if (game.overUnder <= 40) { underVotes += 2; underReasons.push(`Low total ${game.overUnder.toFixed(1)}`); }
    else if (game.overUnder <= 45) { underVotes += 1; underReasons.push(`Total ${game.overUnder.toFixed(1)}`); }

    // Total line movement (via O/U open from odds)
    // Not available from scoreboard directly, but the close vs default
    // can be inferred — skip for now.

    if (overVotes === underVotes) continue;
    const pick: "Over" | "Under" = overVotes > underVotes ? "Over" : "Under";
    const reasons = pick === "Over" ? overReasons : underReasons;

    picks.push({
      away: game.awayTeam,
      home: game.homeTeam,
      overUnder: game.overUnder,
      pick,
      reasons,
      score: Math.max(overVotes, underVotes),
    });
  }

  return picks.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ── Parlays ─────────────────────────────────────────────────────────
export function buildCfbParlays(
  edges: CfbModelEdge[],
  topAts: CfbAtsPick[],
  topTotals: CfbTotalPick[]
): CfbParlay[] {
  const parlays: CfbParlay[] = [];

  // Moneyline legs come from the model-edge layer, capped at one leg per
  // game so a same-game pair can't create correlated legs.
  const mlEdges: CfbModelEdge[] = [];
  const seenGames = new Set<string>();
  for (const e of edges) {
    if (seenGames.has(e.gameId)) continue;
    seenGames.add(e.gameId);
    mlEdges.push(e);
    if (mlEdges.length >= 3) break;
  }
  const mlOdds = mlEdges.map(e => e.ml);
  const mlLabels = mlEdges.map(e => `${e.team} ML (${formatOdds(e.ml)})`);

  const atsOdds = topAts.slice(0, 2).map(() => -110);
  const atsLabels = topAts.slice(0, 2).map(p => `${p.line} (-110)`);

  // Pick a total from a different game to avoid correlated legs
  const mlTeams = new Set<string>();
  for (const e of mlEdges.slice(0, 3)) {
    mlTeams.add(e.team);
    mlTeams.add(e.opponent);
  }
  const totalLeg =
    topTotals.find(t => !mlTeams.has(t.away) && !mlTeams.has(t.home)) ?? topTotals[0];
  const totalLabel = totalLeg
    ? `${totalLeg.away} @ ${totalLeg.home} ${totalLeg.pick} ${totalLeg.overUnder.toFixed(1)} (-110)`
    : null;

  // Parlay 1: Top 3 Moneyline (from model edges, if enough ML games)
  if (mlOdds.length >= 3) {
    const p = calculateParlayPayout(mlOdds.slice(0, 3));
    parlays.push({ name: "Top 3 Model Edge MLs", legs: mlLabels.slice(0, 3), ...p });
  }

  // Parlay 2: 2 ML + 1 ATS
  if (mlOdds.length >= 2 && atsOdds.length >= 1) {
    const p = calculateParlayPayout([mlOdds[0], mlOdds[1], atsOdds[0]]);
    parlays.push({ name: "Moneyline + Spread (2 ML + 1 ATS)", legs: [mlLabels[0], mlLabels[1], atsLabels[0]], ...p });
  }

  // Parlay 3: 2 ML + 1 Total
  if (mlOdds.length >= 2 && totalLabel) {
    const p = calculateParlayPayout([mlOdds[0], mlOdds[1], -110]);
    parlays.push({ name: "Totals Special (2 ML + 1 O/U)", legs: [mlLabels[0], mlLabels[1], totalLabel], ...p });
  }

  // Parlay 4: 3 ATS (when too few ML edges exist — common in CFB). Uses its
  // own slice of topAts because atsOdds/atsLabels are capped at 2 for the
  // mixed parlays above.
  if (mlEdges.length < 2 && topAts.length >= 3) {
    const ats3 = topAts.slice(0, 3);
    const p = calculateParlayPayout(ats3.map(() => -110));
    parlays.push({ name: "Spread Hat Trick (3 ATS)", legs: ats3.map(a => `${a.line} (-110)`), ...p });
  }

  // Parlay 5: Grand Slam (3 ML + 1 ATS + 1 O/U)
  if (mlOdds.length >= 3 && atsOdds.length >= 1 && totalLabel) {
    const p = calculateParlayPayout([...mlOdds.slice(0, 3), atsOdds[0], -110]);
    parlays.push({
      name: "Grand Slam (3 ML + 1 ATS + 1 O/U)",
      legs: [...mlLabels.slice(0, 3), atsLabels[0], totalLabel],
      ...p,
    });
  }

  return parlays;
}
