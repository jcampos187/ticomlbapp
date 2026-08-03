import { Game, TopPick, KProp, TotalPick, Parlay } from "./types";

export function americanToDecimal(odds: number): number {
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

export function decimalToAmerican(decimal: number): number {
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

export function calculateParlayPayout(odds: number[], bet: number = 10): { payout: number; profit: number; odds: number; bet: number } {
  const decimal = odds.reduce((acc, o) => acc * americanToDecimal(o), 1);
  const payout = Math.round(bet * decimal * 100) / 100;
  return {
    payout,
    profit: Math.round((payout - bet) * 100) / 100,
    odds: decimalToAmerican(decimal),
    bet,
  };
}

const HIGH_K_OFFENSES = new Set([
  "Rockies", "Mariners", "Athletics", "Angels", "White Sox",
  "Marlins", "Rays", "Diamondbacks", "Brewers",
]);

const LOW_K_OFFENSES = new Set([
  "Guardians", "Astros", "Cardinals", "Royals", "Padres",
  "Nationals", "Yankees", "Blue Jays",
]);

// Line-movement thresholds (American-odds cents). A moneyline that moved
// this many cents toward a team (e.g. -150 -> -180, or +180 -> +150) is
// interpreted as sharp money backing that team.
const SHARP_MOVE_CENTS = 20;
const MILD_MOVE_CENTS = 10;

export function analyzeFavorites(games: Game[]): TopPick[] {
  const picks: (TopPick & { score: number })[] = [];

  for (const game of games) {
    const favML = game.awayML < 0 ? game.awayML : game.homeML;
    const favTeam = game.awayML < 0 ? game.awayTeam : game.homeTeam;
    const dogTeam = game.awayML < 0 ? game.homeTeam : game.awayTeam;
    const isHome = game.homeML < 0;
    const impliedProb = (1 / americanToDecimal(favML)) * 100;

    // Parse record
    const record = isHome ? game.homeRecord : game.awayRecord;
    const [w, l] = record.split("-").map(Number);
    const winPct = w + l > 0 ? (w / (w + l)) * 100 : 0;

    let score = 0;
    const reasons: string[] = [];

    if (favML <= -140) { score += 1; reasons.push(`${formatOdds(favML)} favorite`); }
    if (favML <= -150) score += 2;
    if (favML <= -200) { score += 3; reasons.push("Heavy favorite"); }
    if (isHome) { score += 1; reasons.push("Home field"); }
    if (winPct > 55) { score += 1; reasons.push(`${winPct.toFixed(0)}% win rate`); }
    if (winPct > 60) score += 1;

    // Line-movement signal: a moneyline that moved sharply toward a team
    // (current - open is negative) means the market is backing them.
    // A 0/null opening line means ESPN never posted one — skip the signal.
    const awayIsFav = game.awayML < 0;
    const favOpen = awayIsFav ? game.awayMLOpen : game.homeMLOpen;
    const dogOpen = awayIsFav ? game.homeMLOpen : game.awayMLOpen;
    const dogML = awayIsFav ? game.homeML : game.awayML;

    if (favOpen) {
      const favMove = favML - favOpen;
      if (favMove <= -SHARP_MOVE_CENTS) {
        score += 2;
        reasons.push(`Sharp money on ${favTeam} (ML ${formatOdds(favOpen)} → ${formatOdds(favML)})`);
      } else if (favMove <= -MILD_MOVE_CENTS) {
        score += 1;
        reasons.push(`Sharp money on ${favTeam} (ML ${formatOdds(favOpen)} → ${formatOdds(favML)})`);
      }
    }
    if (dogOpen) {
      const dogMove = dogML - dogOpen;
      if (dogMove <= -SHARP_MOVE_CENTS) {
        score -= 1;
        reasons.push(`Sharp money on ${dogTeam} (ML ${formatOdds(dogOpen)} → ${formatOdds(dogML)})`);
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

export function analyzeKProps(games: Game[]): KProp[] {
  const props: (KProp & { score: number })[] = [];

  for (const game of games) {
    for (const side of ["away", "home"] as const) {
      const pitcher = side === "away" ? game.awayPitcher : game.homePitcher;
      const team = side === "away" ? game.awayTeam : game.homeTeam;
      const opponent = side === "away" ? game.homeTeam : game.awayTeam;
      const k9 = side === "away" ? game.awayK9 : game.homeK9;
      const avgK = side === "away" ? game.awayAvgK : game.homeAvgK;
      const overRate = side === "away" ? game.awayOver6_5 : game.homeOver6_5;

      if (!pitcher) continue;

      let score = 0;
      const reasons: string[] = [];

      if (k9 && k9 > 9) { score += 3; reasons.push(`K/9: ${k9.toFixed(1)}`); }
      else if (k9 && k9 > 8) { score += 1; reasons.push(`K/9: ${k9.toFixed(1)}`); }

      if (HIGH_K_OFFENSES.has(opponent)) { score += 2; reasons.push(`vs ${opponent} (high K rate)`); }
      if (LOW_K_OFFENSES.has(opponent)) score -= 1;
      if (overRate && overRate >= 0.6) { score += 3; reasons.push(`Over 6.5: ${(overRate * 100).toFixed(0)}%`); }
      if (avgK && avgK >= 7) { score += 2; reasons.push(`Avg ${avgK.toFixed(1)} K/start`); }

      if (score > 0) {
        props.push({
          pitcher,
          team,
          opponent,
          k9,
          avgK,
          over6_5Rate: overRate,
          reasons,
          score,
        });
      }
    }
  }

  return props.sort((a, b) => b.score - a.score).slice(0, 5);
}

export function analyzeTotals(games: Game[]): TotalPick[] {
  const picks: (TotalPick & { score: number })[] = [];

  for (const game of games) {
    if (!game.overUnder) continue;

    let overVotes = 0;
    let underVotes = 0;
    let overReasons: string[] = [];
    let underReasons: string[] = [];

    // 1) Starting pitching signal
    const eras = [game.awayEra, game.homeEra].filter((e): e is number => !!e);
    if (eras.length === 2) {
      const avgEra = (eras[0] + eras[1]) / 2;
      if (avgEra <= 3.0) {
        underVotes += 2; underReasons.push(`Starters avg ERA ${avgEra.toFixed(2)} (elite pitching)`);
      } else if (avgEra <= 3.5) {
        underVotes += 1; underReasons.push(`Starters avg ERA ${avgEra.toFixed(2)}`);
      } else if (avgEra >= 5.0) {
        overVotes += 2; overReasons.push(`Starters avg ERA ${avgEra.toFixed(2)} (weak pitching)`);
      } else if (avgEra >= 4.5) {
        overVotes += 1; overReasons.push(`Starters avg ERA ${avgEra.toFixed(2)}`);
      }
    }

    // 2) Team scoring trends (runs per game)
    const rpg = [game.awayRunsPerGame, game.homeRunsPerGame].filter((v): v is number => !!v);
    if (rpg.length === 2) {
      const avgRpg = (rpg[0] + rpg[1]) / 2;
      if (avgRpg >= 5.0) {
        overVotes += 2; overReasons.push(`Offenses avg ${avgRpg.toFixed(2)} R/G`);
      } else if (avgRpg >= 4.6) {
        overVotes += 1; overReasons.push(`Offenses avg ${avgRpg.toFixed(2)} R/G`);
      } else if (avgRpg <= 3.8) {
        underVotes += 2; underReasons.push(`Offenses avg ${avgRpg.toFixed(2)} R/G`);
      } else if (avgRpg <= 4.2) {
        underVotes += 1; underReasons.push(`Offenses avg ${avgRpg.toFixed(2)} R/G`);
      }
    }

    // 3) Bullpen signal
    const bullpens = [game.awayBullpenEra, game.homeBullpenEra].filter((v): v is number => !!v);
    if (bullpens.length === 2) {
      const avgBp = (bullpens[0] + bullpens[1]) / 2;
      if (avgBp <= 3.3) {
        underVotes += 2; underReasons.push(`Bullpens avg ERA ${avgBp.toFixed(2)} (elite relief)`);
      } else if (avgBp <= 3.6) {
        underVotes += 1; underReasons.push(`Bullpens avg ERA ${avgBp.toFixed(2)}`);
      } else if (avgBp >= 4.5) {
        overVotes += 2; overReasons.push(`Bullpens avg ERA ${avgBp.toFixed(2)} (weak relief)`);
      } else if (avgBp >= 4.2) {
        overVotes += 1; overReasons.push(`Bullpens avg ERA ${avgBp.toFixed(2)}`);
      }
    }

    // 4) Extreme total lines
    if (game.overUnder >= 11.0) {
      overVotes += 2;
      overReasons.push(`High total ${game.overUnder.toFixed(1)}`);
    } else if (game.overUnder <= 7.0) {
      underVotes += 2;
      underReasons.push(`Low total ${game.overUnder.toFixed(1)}`);
    }

    // Decide by votes; ties produce no pick
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

export function buildParlays(games: Game[], topPicks: TopPick[], topKProps: KProp[], topTotals: TotalPick[] = []): Parlay[] {
  const parlays: Parlay[] = [];

  const mlOdds = topPicks.slice(0, 3).map(p => p.ml);
  const mlLabels = topPicks.slice(0, 3).map(p => `${p.team} ML (${formatOdds(p.ml)})`);

  // Estimate K prop odds
  const estimateKOdds = (prop: KProp): number => {
    if (prop.over6_5Rate && prop.over6_5Rate >= 0.55) return -120;
    if (prop.k9 && prop.k9 >= 9) return -110;
    if (prop.k9 && prop.k9 >= 8) return +100;
    return +110;
  };

  const kOdds = topKProps.slice(0, 2).map(estimateKOdds);
  const kLabels = topKProps.slice(0, 2).map((p, i) => `${p.pitcher} Over 6.5 Ks (${formatOdds(kOdds[i])})`);

  // Parlay 1: Top 3 ML
  if (mlOdds.length >= 3) {
    const p = calculateParlayPayout(mlOdds.slice(0, 3));
    parlays.push({ name: "Top 3 Moneyline Favorites", legs: mlLabels.slice(0, 3), ...p });
  }

  // Parlay 2: 2 ML + 1 K
  if (mlOdds.length >= 2 && kOdds.length >= 1) {
    const p = calculateParlayPayout([mlOdds[0], mlOdds[1], kOdds[0]]);
    parlays.push({ name: "Strikeout Special (2 ML + 1 K)", legs: [mlLabels[0], mlLabels[1], kLabels[0]], ...p });
  }

  // Parlay 3: 2 ML + 2 K
  if (mlOdds.length >= 2 && kOdds.length >= 2) {
    const p = calculateParlayPayout([mlOdds[0], mlOdds[1], kOdds[0], kOdds[1]]);
    parlays.push({ name: "K Prop Stack (2 ML + 2 K)", legs: [mlLabels[0], mlLabels[1], kLabels[0], kLabels[1]], ...p });
  }

  // Parlay 4: 3 ML + 2 K
  if (mlOdds.length >= 3 && kOdds.length >= 2) {
    const p = calculateParlayPayout([...mlOdds.slice(0, 3), ...kOdds]);
    parlays.push({ name: "Grand Slam (3 ML + 2 K)", legs: [...mlLabels.slice(0, 3), ...kLabels], ...p });
  }

  // Parlay 5: 2 ML + Best Total (pick a total from a different game to
  // avoid correlated legs, e.g. a team ML + that same game's total)
  if (mlOdds.length >= 2 && topTotals.length >= 1) {
    const mlTeams = new Set<string>();
    for (const p of topPicks.slice(0, 2)) {
      mlTeams.add(p.team);
      mlTeams.add(p.opponent);
    }
    const tp =
      topTotals.find(t => !mlTeams.has(t.away) && !mlTeams.has(t.home)) ??
      topTotals[0];
    const p = calculateParlayPayout([mlOdds[0], mlOdds[1], -110]);
    parlays.push({
      name: "Totals Special (2 ML + 1 O/U)",
      legs: [
        mlLabels[0],
        mlLabels[1],
        `${tp.away} @ ${tp.home} ${tp.pick} ${tp.overUnder.toFixed(1)} (-110)`,
      ],
      ...p,
    });
  }

  return parlays;
}
