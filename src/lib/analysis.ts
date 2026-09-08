import { Game, TopPick, KProp, TotalPick, Parlay, ModelEdge, Confidence } from "./types";

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

// ---------------------------------------------------------------------------
// Model Edge: logistic win-probability model vs market implied probability
// ---------------------------------------------------------------------------

// League-average baselines used only to fill gaps when a team's stat is
// missing (rookie starters, TBD pitchers, no trends fetched). Centering on
// per-game *differences* between the two teams keeps the model relative, so
// these baselines only matter when one side lacks a stat.
const LEAGUE_AVG = {
  winRate: 0.5,
  runsPerGame: 4.5,
  starterEra: 4.25,
  k9: 8.6,
  bullpenEra: 4.1,
};

// A record must represent at least this many games before win rate counts as
// a real signal. A 2-0 start is noise; a 45-30 record is information. Teams
// below the floor fall back to the league baseline (and are marked
// incomplete), so early-season slates never produce confident fake edges.
const MIN_EDGE_GAMES = 4;

// Logistic coefficients. Each feature contributes to the log-odds z:
//   z = homeAdv + b1*(winRate diff) + b2*(R/G diff) + b3*(ERA diff)
//       + b4*(K/9 diff) + b5*(bullpen ERA diff)
// P(win) = sigmoid(z). The magnitudes are calibrated so a strong team vs a
// weak one (e.g. a -190 favorite) lands around a 70-75% model probability.
//
// Every feature is also capped (see MAX_FEATURE_LOGIT below) so a single
// extreme mismatch — say a 3.2 vs 5.6 starter ERA — can't dominate the model
// and print a +25% edge. Teams don't differ by 25 points of true win
// probability on one stat alone; caps keep extreme edges rare.
const HOME_ADV = 0.24;
const COEF_WIN_RATE = 2.8; // +0.10 win-rate diff ~ +7pp
const COEF_RUNS_PER_GAME = 0.22; // +1.0 R/G diff ~ +5.5pp
const COEF_STARTER_ERA = 0.28; // +1.0 ERA edge ~ +7pp
const COEF_K9 = 0.05; // +3.0 K/9 diff ~ +3.7pp
const COEF_BULLPEN_ERA = 0.18; // +1.0 bullpen ERA edge ~ +4.5pp

// Per-feature logit caps: the most one feature may move the win probability
// (a 0.5 logit cap ≈ +12pp; 0.4 ≈ +10pp; 0.3 ≈ +7.5pp). Applied symmetrically.
const MAX_FEATURE_LOGIT = {
  winRate: 0.6,
  runsPerGame: 0.4,
  starterEra: 0.5,
  k9: 0.3,
  bullpenEra: 0.4,
};

function clampFeature(term: number, cap: number): number {
  return Math.max(-cap, Math.min(cap, term));
}

// Edge thresholds for the A-D confidence grade. Data completeness (how many
// of the model's inputs actually exist for both teams) can knock a grade
// down a notch so we don't call an edge confident off a half-built model.
const EDGE_A = 8; // A: large edge + complete data
const EDGE_B = 5; // B: solid edge
const EDGE_C = 3; // C: marginal edge (still shown as a pick)

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function parseWinRate(record: string): number | null {
  if (!record) return null;
  const [w, l] = record.split("-").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(l)) return null;
  const games = w + l;
  if (games < MIN_EDGE_GAMES) return null;
  return w / games;
}

interface TeamModelInputs {
  winRate: number;
  runsPerGame: number;
  starterEra: number;
  k9: number;
  bullpenEra: number;
  complete: boolean;
}

/** Gather the model inputs for one side of a game, filling gaps with league averages. */
function teamInputs(
  game: Game,
  side: "away" | "home",
): TeamModelInputs {
  const winRate = parseWinRate(side === "away" ? game.awayRecord : game.homeRecord);
  const runsPerGame = side === "away" ? game.awayRunsPerGame : game.homeRunsPerGame;
  const starterEra = side === "away" ? game.awayEra : game.homeEra;
  const k9 = side === "away" ? game.awayK9 : game.homeK9;
  const bullpenEra = side === "away" ? game.awayBullpenEra : game.homeBullpenEra;

  const present = [winRate, runsPerGame, starterEra, k9, bullpenEra]
    .filter((v): v is number => v != null).length;

  return {
    winRate: winRate ?? LEAGUE_AVG.winRate,
    runsPerGame: runsPerGame ?? LEAGUE_AVG.runsPerGame,
    starterEra: starterEra ?? LEAGUE_AVG.starterEra,
    k9: k9 ?? LEAGUE_AVG.k9,
    bullpenEra: bullpenEra ?? LEAGUE_AVG.bullpenEra,
    // Strong data = both teams have at least 4 of 5 core stats (counts both
    // sides, so >= 8 of 10 present).
    complete: present >= 4,
  };
}

/**
 * Logistic win probability (%) for one side of a game. Returns null when
 * there's no moneyline to anchor the matchup (no odds = no bettable game).
 */
export function teamWinProbability(game: Game, side: "away" | "home"): number | null {
  const ml = side === "away" ? game.awayML : game.homeML;
  const oppMl = side === "away" ? game.homeML : game.awayML;
  if (!ml || !oppMl) return null;

  const t = teamInputs(game, side);
  const o = teamInputs(game, side === "away" ? "home" : "away");

  let z = side === "home" ? HOME_ADV : 0;
  z += clampFeature((t.winRate - o.winRate) * COEF_WIN_RATE, MAX_FEATURE_LOGIT.winRate);
  z += clampFeature((t.runsPerGame - o.runsPerGame) * COEF_RUNS_PER_GAME, MAX_FEATURE_LOGIT.runsPerGame);
  z += clampFeature((o.starterEra - t.starterEra) * COEF_STARTER_ERA, MAX_FEATURE_LOGIT.starterEra); // lower ERA is better
  z += clampFeature((t.k9 - o.k9) * COEF_K9, MAX_FEATURE_LOGIT.k9);
  z += clampFeature((o.bullpenEra - t.bullpenEra) * COEF_BULLPEN_ERA, MAX_FEATURE_LOGIT.bullpenEra);

  // Clamp to a sane range so a lopsided feature set can't print 99.9%.
  return Math.min(0.97, Math.max(0.03, sigmoid(z))) * 100;
}

/** Implied market probability (%) straight from the moneyline (includes vig). */
export function marketProbability(ml: number): number {
  return (1 / americanToDecimal(ml)) * 100;
}

/** A-D confidence grade shared by all sports' model-edge layers. */
export function edgeConfidence(edge: number, complete: boolean): Confidence {
  if (edge >= EDGE_A) return complete ? "A" : "B";
  if (edge >= EDGE_B) return complete ? "B" : "C";
  if (edge >= EDGE_C) return "C";
  return "D";
}

/**
 * Compute the model edge for every team in every game with odds and surface
 * the positive ones (model likes the team more than the market does).
 */
export function computeModelEdges(games: Game[]): ModelEdge[] {
  const edges: ModelEdge[] = [];

  for (const game of games) {
    for (const side of ["away", "home"] as const) {
      const team = side === "away" ? game.awayTeam : game.homeTeam;
      const abbrev = side === "away" ? game.awayAbbrev : game.homeAbbrev;
      const opponent = side === "away" ? game.homeTeam : game.awayTeam;
      const ml = side === "away" ? game.awayML : game.homeML;
      if (!ml) continue;

      // No meaningful model data on either side (e.g. 0-0 records, no trends)
      // means every "edge" would just be 50% vs the market price — noise, not
      // signal. Skip these games entirely.
      const t = teamInputs(game, side);
      const o = teamInputs(game, side === "away" ? "home" : "away");
      if (!t.complete && !o.complete) continue;

      const modelProb = teamWinProbability(game, side);
      if (modelProb == null) continue;

      const marketProb = marketProbability(ml);
      const edge = modelProb - marketProb;

      const reasons: string[] = [];
      if (t.winRate > o.winRate + 0.03) reasons.push(`${(t.winRate * 100).toFixed(0)}% win rate`);
      if (t.runsPerGame > o.runsPerGame + 0.3) reasons.push(`${t.runsPerGame.toFixed(2)} R/G offense`);
      if (t.starterEra < o.starterEra - 0.3) reasons.push(`Starter ERA ${t.starterEra.toFixed(2)}`);
      if (t.k9 > o.k9 + 1) reasons.push(`K/9 ${t.k9.toFixed(1)}`);
      if (t.bullpenEra < o.bullpenEra - 0.3) reasons.push(`BP ERA ${t.bullpenEra.toFixed(2)}`);
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
    .filter(e => e.edge >= EDGE_C)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 6);
}

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

export function buildParlays(edges: ModelEdge[], topKProps: KProp[], topTotals: TotalPick[] = []): Parlay[] {
  const parlays: Parlay[] = [];

  // Moneyline legs come from the model-edge layer (strongest positive edges),
  // capped at one leg per game so a same-game pair can't create correlated
  // legs (both teams of one game are never in the same parlay).
  const mlEdges: ModelEdge[] = [];
  const seenGames = new Set<string>();
  for (const e of edges) {
    if (seenGames.has(e.gameId)) continue;
    seenGames.add(e.gameId);
    mlEdges.push(e);
    if (mlEdges.length >= 3) break;
  }
  const mlOdds = mlEdges.map(e => e.ml);
  const mlLabels = mlEdges.map(e => `${e.team} ML (${formatOdds(e.ml)})`);

  // Estimate K prop odds
  const estimateKOdds = (prop: KProp): number => {
    if (prop.over6_5Rate && prop.over6_5Rate >= 0.55) return -120;
    if (prop.k9 && prop.k9 >= 9) return -110;
    if (prop.k9 && prop.k9 >= 8) return +100;
    return +110;
  };

  const kOdds = topKProps.slice(0, 2).map(estimateKOdds);
  const kLabels = topKProps.slice(0, 2).map((p, i) => `${p.pitcher} Over 6.5 Ks (${formatOdds(kOdds[i])})`);

  // Parlay 1: Top 3 ML (from model edges)
  if (mlOdds.length >= 3) {
    const p = calculateParlayPayout(mlOdds.slice(0, 3));
    parlays.push({ name: "Top 3 Model Edge MLs", legs: mlLabels.slice(0, 3), ...p });
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
    for (const e of mlEdges.slice(0, 2)) {
      mlTeams.add(e.team);
      mlTeams.add(e.opponent);
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
