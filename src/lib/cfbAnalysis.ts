import type { CfbGame, CfbTopPick, CfbAtsPick, CfbTotalPick, CfbParlay, CfbModelEdge } from "./cfbTypes";
import { americanToDecimal, formatOdds, calculateParlayPayout, sigmoid, marketProbability, edgeConfidence } from "./analysis";

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

/** Logistic win probability (%) for one side of a CFB game. */
export function cfbTeamWinProbability(game: CfbGame, side: "away" | "home"): number | null {
  const ml = side === "away" ? game.awayML : game.homeML;
  const oppMl = side === "away" ? game.homeML : game.awayML;
  if (!ml || !oppMl) return null;

  const t = cfbInputs(game, side);
  const o = cfbInputs(game, side === "away" ? "home" : "away");

  let z = side === "home" ? CFB_HOME_ADV : 0;
  z += (t.winRate - o.winRate) * CFB_COEF_WIN_RATE;
  z += (t.ppg - o.ppg) * CFB_COEF_PPG;

  return Math.min(0.97, Math.max(0.03, sigmoid(z))) * 100;
}

/**
 * Compute the model edge for every CFB team with a moneyline and surface the
 * positive ones (model likes the team more than the market does).
 */
export function computeCfbModelEdges(games: CfbGame[]): CfbModelEdge[] {
  const edges: CfbModelEdge[] = [];

  for (const game of games) {
    for (const side of ["away", "home"] as const) {
      const team = side === "away" ? game.awayTeam : game.homeTeam;
      const abbrev = side === "away" ? game.awayAbbrev : game.homeAbbrev;
      const opponent = side === "away" ? game.homeTeam : game.awayTeam;
      const ml = side === "away" ? game.awayML : game.homeML;
      if (!ml) continue;

      // No meaningful model data on either side (1-2 game records, e.g. the
      // first weeks of the season) means every "edge" would be noise, not
      // signal. Skip these games entirely.
      const t = cfbInputs(game, side);
      const o = cfbInputs(game, side === "away" ? "home" : "away");
      if (!t.complete && !o.complete) continue;

      const modelProb = cfbTeamWinProbability(game, side);
      if (modelProb == null) continue;

      const marketProb = marketProbability(ml);
      const edge = modelProb - marketProb;

      const reasons: string[] = [];
      if (t.winRate > o.winRate + 0.03) reasons.push(`${(t.winRate * 100).toFixed(0)}% win rate`);
      if (t.ppg > o.ppg + 2) reasons.push(`${t.ppg.toFixed(1)} PPG offense`);
      if (side === "home") reasons.push("Home field");

      edges.push({
        team,
        abbrev,
        opponent,
        gameId: game.id,
        ml,
        home: side === "home",
        modelProb: Math.round(modelProb * 10) / 10,
        marketProb: Math.round(marketProb * 10) / 10,
        edge: Math.round(edge * 10) / 10,
        confidence: edgeConfidence(edge, t.complete && o.complete),
        reasons,
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

// ── Moneyline favorites ─────────────────────────────────────────────
export function analyzeCfbFavorites(games: CfbGame[]): CfbTopPick[] {
  const picks: (CfbTopPick & { score: number })[] = [];

  for (const game of games) {
    // CFB moneylines are often OFF — skip games without them
    if (!game.awayML || !game.homeML) continue;

    const favML = game.awayML < 0 ? game.awayML : game.homeML;
    const favTeam = game.awayML < 0 ? game.awayTeam : game.homeTeam;
    const dogTeam = game.awayML < 0 ? game.homeTeam : game.awayTeam;
    const isHome = game.homeML < 0;
    const impliedProb = (1 / americanToDecimal(favML)) * 10;

    const record = isHome ? game.homeRecord : game.awayRecord;
    const [w, l] = record.split("-").map(Number);
    const winPct = w + l > 0 ? (w / (w + l)) * 100 : 0;

    let score = 0;
    const reasons: string[] = [];

    if (favML <= -200) { score += 3; reasons.push("Heavy favorite"); }
    else if (favML <= -150) { score += 2; reasons.push(`${formatOdds(favML)} favorite`); }
    else if (favML <= -120) { score += 1; reasons.push(`${formatOdds(favML)} favorite`); }

    if (isHome) { score += 1; reasons.push("Home field"); }
    if (winPct > 65) { score += 2; reasons.push(`${winPct.toFixed(0)}% win rate`); }
    else if (winPct > 55) { score += 1; reasons.push(`${winPct.toFixed(0)}% win rate`); }

    // Line movement
    const awayIsFav = game.awayML < 0;
    const favOpen = awayIsFav ? game.awayMLOpen : game.homeMLOpen;
    if (favOpen) {
      const move = favML - favOpen;
      if (move <= -SHARP_ML_CENTS) {
        score += 2;
        reasons.push(`Sharp money (ML ${formatOdds(favOpen)} → ${formatOdds(favML)})`);
      }
    }

    picks.push({
      team: favTeam,
      opponent: dogTeam,
      ml: favML,
      impliedProb: Math.round(impliedProb * 10) / 10,
      reasons,
      score,
    });
  }

  return picks.sort((a, b) => b.score - a.score).filter(p => p.score >= 2).slice(0, 5);
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
