import { NflGame, NflTopPick, NflAtsPick, NflTotalPick, NflPropPick, NflParlay, NflPropCandidate } from "./nflTypes";
import { americanToDecimal, formatOdds, calculateParlayPayout } from "./analysis";

// --- Line-movement thresholds (American cents / spread points) ---
const SHARP_MOVE_CENTS = 20;
const MILD_MOVE_CENTS = 10;
const SHARP_SPREAD_MOVE = 1; // spread moved a full point toward a team

// --- Moneyline favorites ---
export function analyzeNflFavorites(games: NflGame[]): NflTopPick[] {
  const picks: (NflTopPick & { score: number })[] = [];

  for (const game of games) {
    if (!game.awayML && !game.homeML) continue;

    const favML = game.awayML < 0 ? game.awayML : game.homeML;
    const favTeam = game.awayML < 0 ? game.awayTeam : game.homeTeam;
    const dogTeam = game.awayML < 0 ? game.homeTeam : game.awayTeam;
    const isHome = game.homeML < 0;
    const impliedProb = (1 / americanToDecimal(favML)) * 100;

    const record = isHome ? game.homeRecord : game.awayRecord;
    const [w, l] = record.split("-").map(Number);
    const winPct = w + l > 0 ? (w / (w + l)) * 100 : 0;

    let score = 0;
    const reasons: string[] = [];

    if (favML <= -120) { score += 1; reasons.push(`${formatOdds(favML)} favorite`); }
    if (favML <= -150) { score += 2; reasons.push("Strong favorite"); }
    if (favML <= -200) { score += 3; reasons.push("Heavy favorite"); }
    if (isHome) { score += 1; reasons.push("Home field"); }
    if (winPct > 55) { score += 1; reasons.push(`${winPct.toFixed(0)}% win rate`); }
    if (winPct > 65) score += 1;

    // Line movement toward the favorite = sharp money
    const awayIsFav = game.awayML < 0;
    const favOpen = awayIsFav ? game.awayMLOpen : game.homeMLOpen;
    if (favOpen) {
      const move = favML - favOpen;
      if (move <= -SHARP_MOVE_CENTS) {
        score += 2;
        reasons.push(`Sharp money (ML ${formatOdds(favOpen)} → ${formatOdds(favML)})`);
      } else if (move <= -MILD_MOVE_CENTS) {
        score += 1;
        reasons.push(`ML moved ${formatOdds(favOpen)} → ${formatOdds(favML)}`);
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
  topPicks: NflTopPick[],
  topAts: NflAtsPick[],
  topTotals: NflTotalPick[]
): NflParlay[] {
  const parlays: NflParlay[] = [];

  const mlOdds = topPicks.slice(0, 3).map(p => p.ml);
  const mlLabels = topPicks.slice(0, 3).map(p => `${p.team} ML (${formatOdds(p.ml)})`);

  const atsOdds = topAts.slice(0, 2).map(() => -110);
  const atsLabels = topAts.slice(0, 2).map(p => `${p.line} (-110)`);

  // Pick a total from a game NOT involving the ML-pick teams to avoid
  // correlated legs (a team ML + that same game's total). Mirrors MLB.
  const mlTeams = new Set<string>();
  for (const p of topPicks.slice(0, 3)) {
    mlTeams.add(p.team);
    mlTeams.add(p.opponent);
  }
  const totalLeg =
    topTotals.find(t => !mlTeams.has(t.away) && !mlTeams.has(t.home)) ?? topTotals[0];
  const totalLabel = totalLeg
    ? `${totalLeg.away} @ ${totalLeg.home} ${totalLeg.pick} ${totalLeg.overUnder.toFixed(1)} (-110)`
    : null;

  // Parlay 1: Top 3 Moneyline
  if (mlOdds.length >= 3) {
    const p = calculateParlayPayout(mlOdds.slice(0, 3));
    parlays.push({ name: "Top 3 Moneyline Favorites", legs: mlLabels.slice(0, 3), ...p });
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
