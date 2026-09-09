import { NflGame, NflTopPick, NflAtsPick, NflTotalPick, NflPropPick, NflParlay, NflPropCandidate, NflModelEdge } from "./nflTypes";
import { formatOdds, calculateParlayPayout, sigmoid, fairMarketProbability, expectedValue, edgeConfidence, marketProbability } from "./analysis";

// --- Model Edge: logistic win-probability model vs market implied ---
// Same structure as MLB but NFL games have no pitcher stats, so the model
// leans on record + scoring output (+ home field).
const NFL_LEAGUE_AVG = {
  winRate: 0.5,
  ppg: 23.0,
};

// A record must represent at least this many games before win rate counts as
// a real signal. Before the season (0-0 records, null PPG) no team qualifies,
// so no edges are produced — honest behavior instead of 50%-vs-market noise.
const MIN_EDGE_GAMES = 4;

// NFL home field ≈ 2.5 points, and ~1 point of expected margin ≈ 0.13
// logits (a 7-pt favorite ≈ 72% win prob). Win-rate diff reuses the MLB
// coefficient — a win rate is a win rate.
const NFL_HOME_ADV = 0.33;
const NFL_COEF_WIN_RATE = 3.2;
const NFL_COEF_PPG = 0.13;

interface NflModelInputs {
  winRate: number;
  ppg: number;
  complete: boolean;
}

function nflInputs(game: NflGame, side: "away" | "home"): NflModelInputs {
  const winRateRaw = (side === "away" ? game.awayRecord : game.homeRecord) || "";
  const [w, l] = winRateRaw.split("-").map(Number);
  const games = Number.isFinite(w) && Number.isFinite(l) ? w + l : 0;
  const winRate = games >= MIN_EDGE_GAMES ? w / games : null;
  const ppg = side === "away" ? game.awayPpg : game.homePpg;
  return {
    winRate: winRate ?? NFL_LEAGUE_AVG.winRate,
    ppg: ppg ?? NFL_LEAGUE_AVG.ppg,
    // Strong data = both sides have record (4+ games) + PPG (4 of 4 inputs).
    complete: winRate != null && ppg != null,
  };
}

/** Raw log-odds (z-score) for one side of an NFL game — NOT a probability. */
function nflRawLogit(t: NflModelInputs, o: NflModelInputs, isHome: boolean): number {
  let z = isHome ? NFL_HOME_ADV : 0;
  z += (t.winRate - o.winRate) * NFL_COEF_WIN_RATE;
  z += (t.ppg - o.ppg) * NFL_COEF_PPG;
  return z;
}

/**
 * Compute normalised model probabilities (%) for both sides of an NFL game.
 *
 * Raw logits are converted to odds-ratio space via sigmoid, then normalised
 * so that P(away) + P(home) = 100%. Computing independent sigmoids allowed
 * P(away) + P(home) to drift away from 100%; normalising keeps the model a
 * true two-outcome distribution.
 */
export function computeNflNormProbs(game: NflGame): {
  awayProb: number;
  homeProb: number;
  awayInputs: NflModelInputs;
  homeInputs: NflModelInputs;
} | null {
  const awayML = game.awayML;
  const homeML = game.homeML;
  if (!awayML || !homeML) return null;

  const t = nflInputs(game, "away");
  const o = nflInputs(game, "home");

  const awayRawLogit = nflRawLogit(t, o, false);
  const homeRawLogit = nflRawLogit(o, t, true);

  // Odds-ratio space, then normalise so both sides sum to exactly 100%.
  const eAway = sigmoid(awayRawLogit);
  const eHome = sigmoid(homeRawLogit);
  const total = eAway + eHome;

  // Clamp to [3%, 97%] to avoid displaying extreme probabilities.
  const awayProb = Math.min(0.97, Math.max(0.03, eAway / total)) * 100;
  const homeProb = 100 - awayProb; // guaranteed to sum to exactly 100

  return { awayProb, homeProb, awayInputs: t, homeInputs: o };
}

/**
 * Logistic win probability (%) for one side of an NFL game.
 *
 * NOTE: This uses the normalised approach so both sides always sum to 100%.
 * Returns null when there's no moneyline on the game (no odds = no bettable
 * game).
 */
export function nflTeamWinProbability(game: NflGame, side: "away" | "home"): number | null {
  const probs = computeNflNormProbs(game);
  if (!probs) return null;
  return side === "away" ? probs.awayProb : probs.homeProb;
}

/**
 * Compute the model edge for every NFL team with a moneyline and surface the
 * positive ones (model likes the team more than the market does).
 *
 * Model probabilities are NORMALISED (both sides sum to 100%) and market
 * probabilities are DE-VIGGED (both sides sum to 100%), so the edge is
 * model vs fair market.
 */
export function computeNflModelEdges(games: NflGame[]): NflModelEdge[] {
  const edges: NflModelEdge[] = [];

  for (const game of games) {
    const probs = computeNflNormProbs(game);
    if (!probs) continue;

    // No meaningful model data on either side (0-0 records, null PPG — e.g.
    // preseason) means every "edge" would just be 50% vs the market price:
    // noise, not signal. Skip these games entirely.
    if (!probs.awayInputs.complete && !probs.homeInputs.complete) continue;

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
      if (t.ppg > o.ppg + 1.5) reasons.push(`${t.ppg.toFixed(1)} PPG offense`);
      if (side === "home") reasons.push("Home field");

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
        pitcherConfirmed: true, // NFL has no TBD pitcher concept
      });
    }
  }

  return edges
    .filter(e => e.edge >= 3)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 6);
}

// --- Line-movement thresholds (American cents / spread points) ---
const SHARP_MOVE_CENTS = 20;
const MILD_MOVE_CENTS = 10;
const SHARP_SPREAD_MOVE = 1; // spread moved a full point toward a team

// Large edges (>10pp) are flagged as needing validation because they may
// indicate either a genuine opportunity or a model/data problem.
const HIGH_EDGE_THRESHOLD = 10;

// --- Moneyline picks — ranked by model edge + EV (not just odds magnitude)
// Same structure as MLB's analyzeFavorites: both sides of each game are
// evaluated, an underdog with positive EV beats a heavy favorite with
// negative EV, and the score weights model edge first.
export function analyzeNflFavorites(games: NflGame[]): NflTopPick[] {
  const picks: (NflTopPick & { score: number })[] = [];

  for (const game of games) {
    const probs = computeNflNormProbs(game);
    if (!probs) continue;

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
        if (move <= -SHARP_MOVE_CENTS) return 3; // sharp money on this side
        if (move <= -MILD_MOVE_CENTS) return 1;
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

// --- Against the spread ---
export function analyzeNflAts(games: NflGame[]): NflAtsPick[] {
  const picks: (NflAtsPick & { score: number })[] = [];

  for (const game of games) {
    if (!game.awaySpread && !game.homeSpread) continue;
    if (!game.awayML && !game.homeML) continue;

    // The favorite is the side with a negative spread line.
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

    if (mag >= 7) { score += 2; reasons.push(`Big favorite ${favSpread}`); }
    else if (mag >= 3) { score += 1; reasons.push(`Favored by ${mag}`); }
    if (isHome) { score += 1; reasons.push("Home favorite"); }
    if (winPct > 55) { score += 1; reasons.push(`${winPct.toFixed(0)}% win rate`); }
    if (winPct > 65) score += 1;

    // Spread movement toward the favorite (more negative) = sharp money
    const favOpen = favIsAway ? game.awaySpreadOpen : game.homeSpreadOpen;
    if (favOpen != null && favSpread != null) {
      const move = favSpread - favOpen; // e.g. -3 -> -4 = -1 point
      if (move <= -SHARP_SPREAD_MOVE) {
        score += 2;
        reasons.push(`Spread moved ${favOpen} → ${favSpread} (sharp money)`);
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

// --- Over/Under totals ---
export function analyzeNflTotals(games: NflGame[]): NflTotalPick[] {
  const picks: (NflTotalPick & { score: number })[] = [];

  for (const game of games) {
    if (!game.overUnder) continue;

    let overVotes = 0;
    let underVotes = 0;
    const overReasons: string[] = [];
    const underReasons: string[] = [];

    // Team scoring trends (points per game)
    const ppg = [game.awayPpg, game.homePpg].filter((v): v is number => !!v && v > 0);
    if (ppg.length === 2) {
      const avgPpg = (ppg[0] + ppg[1]) / 2;
      if (avgPpg >= 26) { overVotes += 2; overReasons.push(`Offenses avg ${avgPpg.toFixed(1)} PPG`); }
      else if (avgPpg >= 23) { overVotes += 1; overReasons.push(`Offenses avg ${avgPpg.toFixed(1)} PPG`); }
      else if (avgPpg <= 18) { underVotes += 2; underReasons.push(`Offenses avg ${avgPpg.toFixed(1)} PPG`); }
      else if (avgPpg <= 21) { underVotes += 1; underReasons.push(`Offenses avg ${avgPpg.toFixed(1)} PPG`); }
    }

    // Extreme total lines
    if (game.overUnder >= 50) { overVotes += 2; overReasons.push(`High total ${game.overUnder.toFixed(1)}`); }
    else if (game.overUnder >= 46) { overVotes += 1; overReasons.push(`Total ${game.overUnder.toFixed(1)}`); }
    else if (game.overUnder <= 36) { underVotes += 2; underReasons.push(`Low total ${game.overUnder.toFixed(1)}`); }
    else if (game.overUnder <= 40) { underVotes += 1; underReasons.push(`Total ${game.overUnder.toFixed(1)}`); }

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

// --- Player props (statistical projections — clearly NOT sportsbook lines) ---
interface PropProjection {
  market: string;
  playerAvg: number;
  baseline: number;
  projectedLine: number;
  direction: "Over" | "Under";
  matchup: "easy" | "tough";
  score: number;
  reasons: string[];
}

/** Minimum games played for a player to qualify for a projected prop (filters out backups/one-game wonders). */
const MIN_GAMES = 4;

interface OppDef {
  passYds: number | null;
  rushYds: number | null;
  passTds: number | null;
  rushTds: number | null;
  recTds: number | null;
  recYds: number | null;
  recRecs: number | null;
}

/**
 * A single receiver's typical share of an opponent defense's total receiving
 * yards allowed. The defense's allowance is spread across all receivers on the
 * opposing team, so comparing one WR's yards to the FULL allowance would make
 * every WR look like an Under. We compare against this share instead.
 */
const REC_SHARE = 0.3;

/**
 * A lead back's typical share of an opponent defense's total rushing yards
 * allowed. Like receiving, a defense's rushing allowance is split across the
 * whole backfield, so comparing one RB's yards to the FULL allowance would make
 * every RB look like an Under. A bell-cow RB handles roughly 70% of carries.
 */
const RUSH_SHARE = 0.7;

/** A candidate market for a player's projected prop (one per qualifying market). */
interface PropCandidate {
  market: string;
  playerAvg: number;
  baseline: number;
  oppVal: number | null;
  oppLabel: string;
  unit: "yds" | "TDs" | "recs";
  /** Positional share of the defense's allowance this player competes for
   * (WR/TE/RB split the corps/backfield), or null for whole-allowance markets
   * like QB passing yards/TDs. Non-null means share-adjusted. */
  share: number | null;
  shareLabel: string | null;
}

/**
 * Every qualifying market for a player, ordered as fallbacks but evaluated by
 * edge strength (see `projectProp`). Backups with a handful of stats never
 * rank because each market requires meaningful per-game volume.
 */
function buildCandidates(player: NflPropCandidate, oppDef: OppDef): PropCandidate[] {
  const out: PropCandidate[] = [];

  if (player.position === "QB") {
    if (player.passingYardsPerGame && player.passingYardsPerGame > 100) {
      out.push({ market: "Passing Yards", playerAvg: player.passingYardsPerGame, baseline: 235, oppVal: oppDef.passYds, oppLabel: "pass DEF allows", unit: "yds", share: null, shareLabel: null });
    }
    if (player.passingTdsPerGame && player.passingTdsPerGame > 0.5) {
      out.push({ market: "Passing TDs", playerAvg: player.passingTdsPerGame, baseline: 1.5, oppVal: oppDef.passTds, oppLabel: "pass DEF allows", unit: "TDs", share: null, shareLabel: null });
    }
  }

  if (player.position === "RB") {
    if (player.rushingYardsPerGame && player.rushingYardsPerGame > 25) {
      out.push({ market: "Rushing Yards", playerAvg: player.rushingYardsPerGame, baseline: 65, oppVal: oppDef.rushYds, oppLabel: "rush DEF allows", unit: "yds", share: RUSH_SHARE, shareLabel: "RB" });
    }
    if (player.rushingTdsPerGame && player.rushingTdsPerGame > 0.2) {
      out.push({ market: "Rushing TDs", playerAvg: player.rushingTdsPerGame, baseline: 0.5, oppVal: oppDef.rushTds, oppLabel: "rush DEF allows", unit: "TDs", share: null, shareLabel: null });
    }
    if (player.receivingYardsPerGame && player.receivingYardsPerGame > 15) {
      out.push({ market: "Receiving Yards", playerAvg: player.receivingYardsPerGame, baseline: 35, oppVal: oppDef.recYds, oppLabel: "rec DEF allows", unit: "yds", share: REC_SHARE, shareLabel: "WR" });
    }
    if (player.receivingTdsPerGame && player.receivingTdsPerGame > 0.2) {
      out.push({ market: "Receiving TDs", playerAvg: player.receivingTdsPerGame, baseline: 0.4, oppVal: oppDef.recTds, oppLabel: "rec TD DEF allows", unit: "TDs", share: null, shareLabel: null });
    }
    if (player.receptionsPerGame && player.receptionsPerGame > 2) {
      out.push({ market: "Receptions", playerAvg: player.receptionsPerGame, baseline: 2.5, oppVal: oppDef.recRecs, oppLabel: "rec DEF allows", unit: "recs", share: REC_SHARE, shareLabel: "WR" });
    }
  }

  if (player.position === "WR" || player.position === "TE") {
    if (player.receivingYardsPerGame && player.receivingYardsPerGame > 20) {
      out.push({ market: "Receiving Yards", playerAvg: player.receivingYardsPerGame, baseline: 55, oppVal: oppDef.recYds, oppLabel: "rec DEF allows", unit: "yds", share: REC_SHARE, shareLabel: "WR" });
    }
    if (player.receptionsPerGame && player.receptionsPerGame > 2.5) {
      out.push({ market: "Receptions", playerAvg: player.receptionsPerGame, baseline: 4.5, oppVal: oppDef.recRecs, oppLabel: "rec DEF allows", unit: "recs", share: REC_SHARE, shareLabel: "WR" });
    }
    if (player.receivingTdsPerGame && player.receivingTdsPerGame > 0.2) {
      out.push({ market: "Receiving TDs", playerAvg: player.receivingTdsPerGame, baseline: 0.4, oppVal: oppDef.recTds, oppLabel: "rec TD DEF allows", unit: "TDs", share: null, shareLabel: null });
    }
  }

  return out;
}

/**
 * Project a line for a player's most relevant market, blending the player's
 * season per-game average with the opponent defense's actual yards/TDs
 * allowed per game (from the site API's `results.opponent` split). The result
 * is a statistical projection — never a real sportsbook number.
 *
 * Direction: Over when the player produces more per game than this specific
 * defense typically concedes (good matchup); Under when the defense allows
 * far less than the player's average (tough matchup). Falls back to league
 * baselines when defensive data is unavailable.
 */
function projectProp(
  player: NflPropCandidate,
  oppDef: OppDef
): PropProjection | null {
  if (player.gamesPlayed < MIN_GAMES) return null;

  // Pick the player's best market by position, requiring meaningful volume
  // so backups with a handful of yards never rank. Yards markets use the
  // defense's yards allowed; TD markets use the defense's TDs allowed.
  // Evaluate every qualifying market and keep the strongest edge (highest
  // score). This is the "best player, any market" approach: a WR whose
  // Receptions edge beats a thin Receiving-Yards edge surfaces the receptions
  // prop; an RB whose Receiving TDs beat Rushing TDs surfaces the receiving
  // TD prop.
  let best: PropProjection | null = null;
  for (const candidate of buildCandidates(player, oppDef)) {
    const proj = evaluateCandidate(player, candidate);
    if (proj && (!best || proj.score > best.score)) best = proj;
  }
  return best;
}

/** Score a single candidate market for a player against the opponent defense. */
function evaluateCandidate(
  player: NflPropCandidate,
  candidate: PropCandidate
): PropProjection | null {
  const reasons: string[] = [
    `${player.statsSeason} season: ${candidate.playerAvg.toFixed(1)}/game (${player.gamesPlayed} GP)`,
  ];

  // Matchup-aware: blend the player's average with what the opponent defense
  // actually concedes per game when we have it. For yards/receptions markets
  // that are spread across multiple players (receiving yards across the corps,
  // rushing yards across the backfield, receptions across the targets), the
  // defense's TOTAL allowance is compared against a share of it — otherwise
  // every WR/RB would read as a huge Under and never rank.
  let blended = candidate.playerAvg;
  let margin = candidate.playerAvg - candidate.baseline;
  const oppVal = candidate.oppVal; // capture so TS narrows the union prop
  const share = candidate.share; // capture so TS narrows the nullable prop
  const isShare = share != null;
  const effOpp =
    oppVal != null && oppVal > 0 && isShare
      ? oppVal * share
      : oppVal;
  if (effOpp != null && effOpp > 0) {
    blended = candidate.playerAvg * 0.6 + effOpp * 0.4;
    margin = candidate.playerAvg - effOpp;
    reasons.push(
      isShare
        ? `${candidate.oppLabel} ~${oppVal!.toFixed(0)} ${candidate.unit}/g (${candidate.shareLabel} share ~${effOpp.toFixed(candidate.unit === "recs" ? 1 : 0)})`
        : `${candidate.oppLabel} ~${effOpp.toFixed(candidate.unit === "TDs" ? 2 : 0)} ${candidate.unit}/g`
    );
  } else {
    reasons.push(`League baseline ~${candidate.baseline}`);
  }

  // The projected line is the matchup-blended estimate, rounded to a typical
  // prop increment (0.5).
  const projectedLine = Math.round(blended * 2) / 2;

  // Direction + score: Over when the player out-produces the specific defense
  // (or baseline), scored by how much. Under leans are mild fades ranked below
  // Over stars so they only surface when few Over props exist.
  // NOTE: thresholds are unit-aware — yards move in tens, TD markets in
  // fractions (e.g. +0.5 TDs/g is a meaningful edge), receptions in single
  // catches (e.g. +1.0 recs/g).
  const isTd = candidate.unit === "TDs";
  const isRecs = candidate.unit === "recs";
  const overThreshold = isTd ? 0.3 : isRecs ? 1.0 : 10;
  const underThreshold = isTd ? -0.4 : isRecs ? -1.5 : -15;
  let direction: "Over" | "Under";
  let score: number;
  const refVal = effOpp != null ? effOpp : candidate.baseline;
  // Share-adjusted labels read better without the verb: "rec DEF WR-share"
  // instead of "rec DEF allows WR-share".
  const defLabel = candidate.oppLabel.replace(/ allows$/, "");
  const refLabel =
    effOpp != null
      ? isShare
        ? `${defLabel} ${candidate.shareLabel}-share`
        : candidate.oppLabel
      : "league baseline";
  if (margin >= overThreshold) {
    direction = "Over";
    reasons.push(`Outpaces ${refLabel} (~${refVal.toFixed(isTd ? 2 : isRecs ? 1 : 0)} ${candidate.unit}/g)`);
    // Score is normalized by the player's own average so smaller-yards markets
    // (WR/TE receiving, receptions) rank fairly against QB passing yards
    // instead of being buried by raw margin (QBs always have the biggest
    // yardage numbers). Capped so a marginal TD/receptions edge (fractional
    // margins, big ratio) can't pathologically outrank a massive yards edge.
    score = Math.min(25, 10 + (margin / candidate.playerAvg) * 20);
  } else if (margin <= underThreshold) {
    direction = "Under";
    reasons.push(`Below ${refLabel} (~${refVal.toFixed(isTd ? 2 : isRecs ? 1 : 0)} ${candidate.unit}/g)`);
    // Cap Under fades below the Over floor (10) so a mild fade on a low-avg
    // market (e.g. a 0.5 TDs/g RB) can never outrank a genuine Over star.
    score = Math.min(7, (-margin / candidate.playerAvg) * 10);
  } else {
    // No clear lean — skip to keep picks meaningful.
    return null;
  }

  // Matchup badge: easy (player clears the defense/baseline), tough (below).
  // (A "balanced" state is unreachable here — mid-range margins return null.)
  const matchup: "easy" | "tough" = direction === "Over" ? "easy" : "tough";

  return {
    market: candidate.market,
    playerAvg: candidate.playerAvg,
    baseline: candidate.baseline,
    projectedLine,
    direction,
    score,
    reasons,
    matchup,
  };
}

export function analyzeNflProps(games: NflGame[]): NflPropPick[] {
  const props: (NflPropPick & { score: number })[] = [];

  for (const game of games) {
    if (!game.awayML && !game.homeML) continue;

    for (const side of ["away", "home"] as const) {
      const candidates = side === "away" ? game.awayProps : game.homeProps;
      const opponent = side === "away" ? game.homeTeam : game.awayTeam;
      const teamAbbrev = side === "away" ? game.awayAbbrev : game.homeAbbrev;
      // A player on the away team faces the HOME defense and vice versa.
      const oppDef: OppDef = {
        passYds: side === "away" ? game.homeDefPassYds : game.awayDefPassYds,
        rushYds: side === "away" ? game.homeDefRushYds : game.awayDefRushYds,
        passTds: side === "away" ? game.homeDefPassTds : game.awayDefPassTds,
        rushTds: side === "away" ? game.homeDefRushTds : game.awayDefRushTds,
        recTds: side === "away" ? game.homeDefRecTds : game.awayDefRecTds,
        recYds: side === "away" ? game.homeDefRecYds : game.awayDefRecYds,
        recRecs: side === "away" ? game.homeDefRecRecs : game.awayDefRecRecs,
      };

      for (const player of candidates) {
        const proj = projectProp(player, oppDef);
        if (!proj) continue;

        props.push({
          player: player.name,
          position: player.position,
          team: teamAbbrev,
          opponent,
          market: proj.market,
          projectedLine: proj.projectedLine,
          direction: proj.direction,
          matchup: proj.matchup,
          playerAvg: proj.playerAvg,
          statsSeason: player.statsSeason,
          reasons: proj.reasons,
          score: proj.score,
        });
      }
    }
  }

  // Prefer strong Over-leans (stars), then fades; enforce variety so the list
  // isn't all one position. Max 2 per position, max 1 per game.
  const sorted = props.sort((a, b) => b.score - a.score);
  const seenPlayer = new Set<string>();
  const seenGame = new Set<string>();
  const posCount = new Map<string, number>();
  const top: NflPropPick[] = [];
  for (const p of sorted) {
    if (seenPlayer.has(p.player)) continue;
    const gameKey = `${p.team}@${p.opponent}`;
    if (seenGame.has(gameKey)) continue;
    const pos = p.position;
    if ((posCount.get(pos) || 0) >= 2) continue;
    seenPlayer.add(p.player);
    seenGame.add(gameKey);
    posCount.set(pos, (posCount.get(pos) || 0) + 1);
    top.push(p);
    if (top.length >= 6) break;
  }
  return top;
}

// --- Parlays ($10, same style as MLB) ---
export function buildNflParlays(
  edges: NflModelEdge[],
  topAts: NflAtsPick[],
  topTotals: NflTotalPick[]
): NflParlay[] {
  const parlays: NflParlay[] = [];

  // Moneyline legs come from the model-edge layer, capped at one leg per
  // game so a same-game pair can't create correlated legs.
  const mlEdges: NflModelEdge[] = [];
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

  // Pick a total from a game NOT involving the ML-pick teams to avoid
  // correlated legs (a team ML + that same game's total). Mirrors MLB.
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

  // Parlay 1: Top 3 Moneyline (from model edges)
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

  // Parlay 4: 3 ML + 1 ATS + 1 Total (Grand Slam)
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
