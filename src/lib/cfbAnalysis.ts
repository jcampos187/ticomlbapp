import type { CfbGame, CfbTopPick, CfbAtsPick, CfbTotalPick, CfbParlay } from "./cfbTypes";
import { americanToDecimal, formatOdds, calculateParlayPayout } from "./analysis";

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
  topPicks: CfbTopPick[],
  topAts: CfbAtsPick[],
  topTotals: CfbTotalPick[]
): CfbParlay[] {
  const parlays: CfbParlay[] = [];

  const mlOdds = topPicks.slice(0, 3).map(p => p.ml);
  const mlLabels = topPicks.slice(0, 3).map(p => `${p.team} ML (${formatOdds(p.ml)})`);

  const atsOdds = topAts.slice(0, 2).map(() => -110);
  const atsLabels = topAts.slice(0, 2).map(p => `${p.line} (-110)`);

  // Pick a total from a different game to avoid correlated legs
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

  // Parlay 1: Top 3 Moneyline (if enough ML games)
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

  // Parlay 4: 3 ATS (when no ML games available — common in CFB)
  if (topPicks.length < 2 && topAts.length >= 3) {
    const p = calculateParlayPayout(atsOdds.slice(0, 3));
    parlays.push({ name: "Spread Hat Trick (3 ATS)", legs: atsLabels.slice(0, 3), ...p });
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
