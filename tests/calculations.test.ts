import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  americanToDecimal,
  decimalToAmerican,
  expectedValue,
  rawMarketProbability,
  marketProbability,
  fairMarketProbability,
  computeNormModelProbs,
  evaluateSide,
  validateProbabilities,
  modelConfidence,
  modelEdgeValueScore,
  plattParameters,
  shrinkStat,
  calculateParlayPayout,
  analyzeFavorites,
  analyzeBestValue,
  computeModelEdges,
  capStarterBundle,
  buildCalibrationReport,
  calibrationReport,
  MODEL_FEATURE_SET,
  LEAGUE_AVG,
} from "@/lib/analysis";
import { parseInningsPitched } from "@/lib/mlb";
import type { Game, ModelEdge, PitcherMetrics } from "@/lib/types";
import { computeCfbModelEdges, analyzeCfbFavorites, cfbTeamWinProbability } from "@/lib/cfbAnalysis";
import { computeOpponentAdjustedMargins, computeMarginsAsOf, SRS_ITERATIONS, SRS_PRIOR_GAMES } from "@/lib/srs";
import { computeNflModelEdges, analyzeNflFavorites, analyzeNflProps, buildNflParlays, nflTeamWinProbability } from "@/lib/nflAnalysis";
import { selectPropCandidates, blendPlayerStats, PRIOR_SEASON_WEIGHT_GAMES } from "@/lib/nfl";
import type { SkillPlayer, PlayerSeasonStats } from "@/lib/nfl";
import type { CfbGame } from "@/lib/cfbTypes";
import type { NflGame, NflPropCandidate, NflAtsPick, NflTotalPick } from "@/lib/nflTypes";

/** Baseline synthetic game — a normal, fully-populated matchup. */
function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "g1",
    startTime: "2026-09-11T23:05:00Z",
    status: "scheduled",
    awayTeam: "Rangers",
    homeTeam: "Mariners",
    awayAbbrev: "TEX",
    homeAbbrev: "SEA",
    awayRecord: "70-71",
    homeRecord: "75-66",
    awayML: 108,
    homeML: -128,
    overUnder: 8.5,
    awayPitcher: "Away Starter",
    homePitcher: "Home Starter",
    awayPitcherRecord: "",
    homePitcherRecord: "",
    awayK9: 8.5,
    homeK9: 9.1,
    awayAvgK: 5.4,
    homeAvgK: 6.2,
    awayOver6_5: 0.4,
    homeOver6_5: 0.5,
    awayEra: 4.1,
    homeEra: 3.5,
    awayIp: 150,
    homeIp: 165,
    awayRunsPerGame: 4.4,
    homeRunsPerGame: 4.7,
    awayBullpenEra: 4.0,
    homeBullpenEra: 3.7,
    awayMLOpen: 115,
    homeMLOpen: -125,
    pitcherConfirmed: true,
    awayPitcherMetrics: null,
    homePitcherMetrics: null,
    ...overrides,
  };
}

/** A complete, league-average starter metrics object for model-input tests. */
function metrics(over: Partial<PitcherMetrics> = {}): PitcherMetrics {
  return {
    era: LEAGUE_AVG.starterEra,
    k9: LEAGUE_AVG.k9,
    bb9: LEAGUE_AVG.bb9,
    hr9: LEAGUE_AVG.hr9,
    whip: 1.3,
    fip: LEAGUE_AVG.fip,
    ip: 150,
    starts: 25,
    avgK: 5.5,
    over6_5Rate: 0.4,
    source: "test",
    season: 2026,
    ...over,
  };
}

/** A game whose two teams are identical, so only the named change matters. */
function symmetricGame(over: Partial<Game> = {}): Game {
  return makeGame({
    awayRecord: "75-75",
    homeRecord: "75-75",
    awayRunsPerGame: 4.5,
    homeRunsPerGame: 4.5,
    awayBullpenEra: 4.1,
    homeBullpenEra: 4.1,
    awayEra: LEAGUE_AVG.starterEra,
    homeEra: LEAGUE_AVG.starterEra,
    awayK9: LEAGUE_AVG.k9,
    homeK9: LEAGUE_AVG.k9,
    awayIp: 150,
    homeIp: 150,
    ...over,
  });
}

function expectFinite(value: number) {
  expect(Number.isFinite(value)).toBe(true);
  expect(Number.isNaN(value)).toBe(false);
}

describe("odds conversion", () => {
  it("converts American odds to decimal", () => {
    expect(americanToDecimal(108)).toBeCloseTo(2.08, 10);
    expect(americanToDecimal(-108)).toBeCloseTo(1 + 100 / 108, 10);
    expect(americanToDecimal(100)).toBeCloseTo(2, 10);
    expect(americanToDecimal(-100)).toBeCloseTo(2, 10);
    expect(americanToDecimal(150)).toBeCloseTo(2.5, 10);
    expect(americanToDecimal(-150)).toBeCloseTo(1 + 100 / 150, 10);
  });

  it("round-trips decimal back to American", () => {
    expect(decimalToAmerican(2.08)).toBe(108);
    expect(decimalToAmerican(1.5)).toBe(-200);
    expect(decimalToAmerican(3)).toBe(200);
  });
});

describe("raw vs fair market probability", () => {
  it("computes raw implied probability from the American odds formulas", () => {
    expect(rawMarketProbability(108)).toBeCloseTo(48.0769, 3);
    expect(rawMarketProbability(-108)).toBeCloseTo(51.9231, 3);
    expect(rawMarketProbability(200)).toBeCloseTo(33.3333, 3);
    expect(rawMarketProbability(-200)).toBeCloseTo(66.6667, 3);
  });

  it("agrees with the legacy marketProbability helper", () => {
    for (const ml of [108, -108, 145, -220, 100, -100]) {
      expect(rawMarketProbability(ml)).toBeCloseTo(marketProbability(ml), 10);
    }
  });

  it("raw implied probabilities include vig (sum > 100) while fair sums to 100", () => {
    const rawAway = rawMarketProbability(108);
    const rawHome = rawMarketProbability(-128);
    expect(rawAway + rawHome).toBeGreaterThan(100);

    const fairAway = fairMarketProbability(108, -128, "away")!;
    const fairHome = fairMarketProbability(108, -128, "home")!;
    expect(fairAway + fairHome).toBeCloseTo(100, 10);
    // +108 alone is 48.08% raw, but de-vigged it is ~46.1% — this is exactly
    // why the dashboard showed 46.0% while the raw price implied 48.08%.
    expect(fairAway).toBeCloseTo(46.1, 1);
    expect(fairAway).toBeLessThan(rawAway);
  });

  it("returns 0 rather than NaN for a missing price", () => {
    expect(rawMarketProbability(0)).toBe(0);
    expect(rawMarketProbability(Number.NaN)).toBe(0);
  });
});

describe("model probability", () => {
  const games = [
    makeGame(),
    makeGame({ awayML: -150, homeML: 130 }),
    makeGame({ awayML: 260, homeML: -320 }),
    makeGame({ awayML: -105, homeML: -115 }),
    makeGame({
      awayRecord: "95-45",
      homeRecord: "40-100",
      awayEra: 2.4,
      homeEra: 5.8,
      awayRunsPerGame: 5.6,
      homeRunsPerGame: 3.2,
      awayML: 200,
      homeML: -240,
    }),
  ];

  it("produces probabilities that sum to exactly 100%", () => {
    for (const game of games) {
      const p = computeNormModelProbs(game)!;
      expect(p.awayProb + p.homeProb).toBe(100);
    }
  });

  it("keeps both sides inside [0, 100] with no NaN", () => {
    for (const game of games) {
      const p = computeNormModelProbs(game)!;
      for (const v of [p.awayProb, p.homeProb, p.awayRawLogit, p.homeRawLogit]) {
        expectFinite(v);
      }
      expect(p.awayProb).toBeGreaterThanOrEqual(0);
      expect(p.awayProb).toBeLessThanOrEqual(100);
      expect(p.homeProb).toBeGreaterThanOrEqual(0);
      expect(p.homeProb).toBeLessThanOrEqual(100);
    }
  });

  it("returns null when either side has no price (never fabricates a probability)", () => {
    expect(computeNormModelProbs(makeGame({ awayML: 0 }))).toBeNull();
    expect(computeNormModelProbs(makeGame({ homeML: 0 }))).toBeNull();
    expect(computeNormModelProbs(makeGame({ awayML: Number.NaN }))).toBeNull();
  });

  it("is independent of the odds VALUE — only the presence of a market matters", () => {
    // Same teams, wildly different prices: the model probability must not move.
    const a = computeNormModelProbs(makeGame({ awayML: 108, homeML: -128 }))!;
    const b = computeNormModelProbs(makeGame({ awayML: 400, homeML: -500 }))!;
    expect(a.awayProb).toBeCloseTo(b.awayProb, 10);
    expect(a.homeProb).toBeCloseTo(b.homeProb, 10);
  });

  it("applies Platt calibration to the normalised logit, matching how A/B were fitted", () => {
    const game = makeGame();
    const p = computeNormModelProbs(game)!;
    const { A, B } = plattParameters();

    const observedLogit = Math.log(p.homeProb / (100 - p.homeProb));
    // The fit was sigmoid(A * normalisedLogit + B), so the exposed probability
    // must satisfy exactly that identity.
    expect(observedLogit).toBeCloseTo(A * p.homeNormalizedLogit + B, 9);

    // The raw per-side logit is a different quantity — this is the transform
    // the previous code (incorrectly) calibrated.
    expect(p.homeNormalizedLogit).not.toBeCloseTo(p.homeRawLogit, 6);
  });
});

describe("edge and EV", () => {
  it("computes edge as model − FAIR market (not raw, not EV)", () => {
    const game = makeGame();
    const away = evaluateSide(game, "away")!;
    const p = computeNormModelProbs(game)!;
    const fair = fairMarketProbability(game.awayML, game.homeML, "away")!;

    expect(away.edge).toBeCloseTo(p.awayProb - fair, 10);
    // Using the raw price would give a different (misleading) number.
    expect(away.edge).not.toBeCloseTo(p.awayProb - away.rawMarketProb, 6);
  });

  it("computes EV from the model probability and the posted decimal odds", () => {
    const game = makeGame();
    const away = evaluateSide(game, "away")!;
    expect(away.decimalOdds).toBeCloseTo(americanToDecimal(game.awayML), 10);
    expect(away.ev / 100).toBeCloseTo(
      expectedValue(away.modelProb, game.awayML),
      10,
    );
  });

  it("matches the worked +108 example", () => {
    // Model 50.6% at +108 -> EV = 0.506 * 2.08 - 1 = +5.248%
    expect(expectedValue(50.6, 108) * 100).toBeCloseTo(5.248, 3);
  });

  it("handles missing stats without producing NaN or silently using zero", () => {
    const bare = makeGame({
      awayRecord: "",
      homeRecord: "",
      awayK9: null,
      homeK9: null,
      awayEra: null,
      homeEra: null,
      awayIp: null,
      homeIp: null,
      awayRunsPerGame: null,
      homeRunsPerGame: null,
      awayBullpenEra: null,
      homeBullpenEra: null,
      awayPitcher: "",
      homePitcher: "",
      pitcherConfirmed: false,
    });
    const s = evaluateSide(bare, "away");
    expect(s).not.toBeNull();
    for (const v of [
      s!.modelProb,
      s!.rawMarketProb,
      s!.fairMarketProb,
      s!.edge,
      s!.ev,
      s!.decimalOdds,
      s!.rawModelLogit,
    ]) {
      expectFinite(v);
    }
    expect(s!.dataQuality).toBe("LOW");
  });
});

describe("validation", () => {
  it("passes a sound calculation", () => {
    const game = makeGame();
    const p = computeNormModelProbs(game)!;
    const fairAway = fairMarketProbability(game.awayML, game.homeML, "away")!;
    const fairHome = fairMarketProbability(game.awayML, game.homeML, "home")!;
    const errors = validateProbabilities(
      game,
      p.awayProb,
      p.homeProb,
      fairAway,
      fairHome,
      rawMarketProbability(game.awayML),
      rawMarketProbability(game.homeML),
    );
    expect(errors).toEqual([]);
    expect(evaluateSide(game, "away")!.valid).toBe(true);
  });

  it("flags probabilities that do not sum to 100", () => {
    const game = makeGame();
    const errors = validateProbabilities(game, 60, 60, 50, 50, 48, 52);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/sum to 120/);
  });

  it("flags out-of-range and non-finite probabilities", () => {
    const game = makeGame();
    expect(validateProbabilities(game, 120, -20, 50, 50, 48, 52).length).toBeGreaterThan(0);
    expect(
      validateProbabilities(game, Number.NaN, 40, 50, 50, 48, 52).length,
    ).toBeGreaterThan(0);
  });
});

describe("confidence is not just the edge", () => {
  it("grades a big edge on thin data below a modest edge on complete data", () => {
    // +10pp edge but only 2/7 quality checks -> thin data caps it at B.
    expect(modelConfidence(10, 2, 7)).toBe("B");
    // +5pp edge with every data check passing -> A.
    expect(modelConfidence(5, 7, 7)).toBe("A");
  });

  it("demotes a marginal edge on poor data", () => {
    expect(modelConfidence(3, 1, 7)).toBe("D");
  });

  it("varies with data quality at a fixed edge", () => {
    const grades = new Set(
      [0, 2, 4, 6, 7].map(q => modelConfidence(6, q, 7)),
    );
    expect(grades.size).toBeGreaterThan(1);
  });
});

describe("ranking", () => {
  const edge = (over: Partial<ModelEdge>): ModelEdge => ({
    team: "T",
    abbrev: "T",
    opponent: "O",
    gameId: "g",
    ml: -300,
    home: true,
    modelProb: 70,
    rawMarketProb: 75,
    fairMarketProb: 72,
    edge: 3,
    ev: 1,
    confidence: "C",
    dataQuality: "MEDIUM",
    qualityScore: 4,
    qualityMax: 7,
    valid: true,
    validationErrors: [],
    flag: null,
    reasons: [],
    pitcherConfirmed: true,
    ...over,
  });

  it("ranks an underdog with real value above a short-priced favorite", () => {
    const underdog = edge({
      team: "Underdog",
      ml: 108,
      modelProb: 58,
      rawMarketProb: 48.1,
      fairMarketProb: 46.1,
      edge: 11.9,
      ev: 20.6,
      confidence: "A",
      dataQuality: "HIGH",
    });
    const favorite = edge({
      team: "Favorite",
      ml: -300,
      modelProb: 78,
      rawMarketProb: 75,
      fairMarketProb: 73,
      edge: 5,
      ev: -3,
      confidence: "B",
      dataQuality: "MEDIUM",
    });
    expect(modelEdgeValueScore(underdog)).toBeGreaterThan(
      modelEdgeValueScore(favorite),
    );
  });

  it("never caps a large edge", () => {
    const huge = edge({ edge: 22, ev: 40, confidence: "A", dataQuality: "HIGH" });
    expect(modelEdgeValueScore(huge)).toBeGreaterThan(0);
    expect(huge.edge).toBe(22);
  });
});

describe("pitcher sample-size regression", () => {
  const LEAGUE_ERA = 4.25;

  it("pulls a tiny sample hard toward the league average", () => {
    const regressed = shrinkStat(0.56, 16, LEAGUE_ERA, 100)!;
    expect(regressed).toBeGreaterThan(3.5);
    expect(regressed).toBeLessThan(LEAGUE_ERA);
  });

  it("barely moves a large sample", () => {
    const regressed = shrinkStat(2.0, 200, LEAGUE_ERA, 100)!;
    expect(regressed).toBeGreaterThan(2.0);
    expect(regressed).toBeLessThan(2.9);
  });

  it("leaves the stat alone when there is no sample size to judge by", () => {
    expect(shrinkStat(3.0, null, LEAGUE_ERA, 100)).toBe(3.0);
    expect(shrinkStat(null, 100, LEAGUE_ERA, 100)).toBeNull();
  });
});

describe("innings pitched parsing", () => {
  it("converts baseball thirds notation to true innings", () => {
    expect(parseInningsPitched("123.1")).toBeCloseTo(123 + 1 / 3, 10);
    expect(parseInningsPitched("123.2")).toBeCloseTo(123 + 2 / 3, 10);
    expect(parseInningsPitched("123")).toBe(123);
    expect(parseInningsPitched("16.0")).toBe(16);
  });

  it("returns null for missing or invalid values instead of NaN", () => {
    expect(parseInningsPitched(null)).toBeNull();
    expect(parseInningsPitched("")).toBeNull();
    expect(parseInningsPitched("abc")).toBeNull();
    // ".3" is not valid baseball notation
    expect(parseInningsPitched("12.3")).toBeNull();
  });
});

describe("pick categories stay separate", () => {
  const slate: Game[] = [
    // Heavy home favorite the model also likes.
    makeGame({
      id: "fav",
      awayRecord: "55-85",
      homeRecord: "92-48",
      awayEra: 5.4,
      homeEra: 2.6,
      awayRunsPerGame: 3.4,
      homeRunsPerGame: 5.3,
      awayBullpenEra: 4.9,
      homeBullpenEra: 3.2,
      awayML: 240,
      homeML: -290,
    }),
    // Underdog the model rates far higher than the market does.
    makeGame({
      id: "dog",
      awayRecord: "88-52",
      homeRecord: "58-82",
      awayEra: 2.7,
      homeEra: 5.2,
      awayRunsPerGame: 5.4,
      homeRunsPerGame: 3.6,
      awayBullpenEra: 3.3,
      homeBullpenEra: 4.8,
      awayML: 155,
      homeML: -180,
    }),
  ];

  it("Model Edge picks are sorted by blended value, not odds", () => {
    const edges = computeModelEdges(slate);
    for (let i = 1; i < edges.length; i++) {
      expect(modelEdgeValueScore(edges[i - 1])).toBeGreaterThanOrEqual(
        modelEdgeValueScore(edges[i]),
      );
    }
  });

  it("Top Favorite picks contain only favorites ranked by model probability", () => {
    const picks = analyzeFavorites(slate);
    for (const p of picks) {
      expect(p.ml).toBeLessThan(0);
      expect(p.modelProb).toBeGreaterThanOrEqual(55);
    }
    for (let i = 1; i < picks.length; i++) {
      expect(picks[i - 1].modelProb).toBeGreaterThanOrEqual(picks[i].modelProb);
    }
  });

  it("Best Value picks require positive edge AND positive EV, ranked by EV", () => {
    const picks = analyzeBestValue(slate);
    for (const p of picks) {
      expect(p.edge).toBeGreaterThan(0);
      expect(p.ev).toBeGreaterThan(0);
    }
    for (let i = 1; i < picks.length; i++) {
      expect(picks[i - 1].ev).toBeGreaterThanOrEqual(picks[i].ev);
    }
  });
});

describe("parlay payout arithmetic", () => {
  it("multiplies decimal odds and never returns NaN", () => {
    const p = calculateParlayPayout([108, -128], 10);
    expectFinite(p.payout);
    expectFinite(p.odds);
    expect(p.payout).toBeCloseTo(
      10 * americanToDecimal(108) * americanToDecimal(-128),
      6,
    );
    expect(p.profit).toBeCloseTo(p.payout - 10, 6);
  });
});

describe("FIP / BB/9 / HR/9 as model inputs", () => {
  // Both starters league-average: every starter term should contribute zero.
  const league: Partial<Game> = {
    awayPitcherMetrics: metrics(),
    homePitcherMetrics: metrics(),
  };

  it("raises a side's probability when its FIP improves, holding ERA fixed", () => {
    const neutral = computeNormModelProbs(symmetricGame(league))!;
    const betterFip = computeNormModelProbs(
      symmetricGame({
        awayPitcherMetrics: metrics({ fip: 2.9 }),
        homePitcherMetrics: metrics({ fip: LEAGUE_AVG.fip }),
      }),
    )!;
    expect(betterFip.awayProb).toBeGreaterThan(neutral.awayProb);
    expect(betterFip.awayProb + betterFip.homeProb).toBe(100);
  });

  it("moves the model on BB/9 alone", () => {
    const neutral = computeNormModelProbs(symmetricGame(league))!;
    const better = computeNormModelProbs(
      symmetricGame({
        awayPitcherMetrics: metrics({ bb9: 2.0 }),
        homePitcherMetrics: metrics({ bb9: LEAGUE_AVG.bb9 }),
      }),
    )!;
    expect(better.awayProb).toBeGreaterThan(neutral.awayProb);
  });

  it("moves the model on HR/9 alone", () => {
    const neutral = computeNormModelProbs(symmetricGame(league))!;
    const better = computeNormModelProbs(
      symmetricGame({
        awayPitcherMetrics: metrics({ hr9: 0.7 }),
        homePitcherMetrics: metrics({ hr9: LEAGUE_AVG.hr9 }),
      }),
    )!;
    expect(better.awayProb).toBeGreaterThan(neutral.awayProb);
  });

  it("treats missing metrics as neutral, never as zero or NaN", () => {
    const none = computeNormModelProbs(
      symmetricGame({ awayPitcherMetrics: null, homePitcherMetrics: null }),
    )!;
    const leagueAvg = computeNormModelProbs(symmetricGame(league))!;
    // Missing on both sides must be exactly as neutral as league-average on
    // both sides — an absent metric is unknown, not zero.
    expect(none.awayProb).toBeCloseTo(leagueAvg.awayProb, 9);
    for (const v of [
      none.awayProb,
      none.homeProb,
      none.awayRawLogit,
      none.homeRawLogit,
    ]) {
      expectFinite(v);
    }
  });

  it("regresses the new metrics harder on a small sample", () => {
    const bigSample = computeNormModelProbs(
      symmetricGame({
        awayIp: 150,
        awayPitcherMetrics: metrics({ fip: 2.0 }),
        homePitcherMetrics: metrics(),
      }),
    )!;
    const smallSample = computeNormModelProbs(
      symmetricGame({
        awayIp: 16,
        awayPitcherMetrics: metrics({ fip: 2.0, ip: 16 }),
        homePitcherMetrics: metrics(),
      }),
    )!;
    // Same 2.00 FIP, but 16 IP is not evidence yet — it must move the model less.
    expect(smallSample.awayProb).toBeLessThan(bigSample.awayProb);
  });

  it("bounds the starter package with a shared logit budget", () => {
    // Every term individually at its own cap: the SUM must still be bounded.
    const capped = capStarterBundle([0.5, 0.4, 0.3, 0.15, 0.15]);
    expect(capped).toBeGreaterThan(0);
    expect(capped).toBeLessThanOrEqual(0.8 + 1e-12);

    // One oversized term is scaled to the budget, not passed through.
    expect(capStarterBundle([5])).toBeLessThanOrEqual(0.8 + 1e-12);

    // Opposite-signed terms can't cancel their way past the cap.
    const mixed = capStarterBundle([2.0, -0.5]);
    expect(Math.abs(mixed)).toBeLessThanOrEqual(0.8 + 1e-12);
  });

  it("counts the independent metrics toward data quality", () => {
    const withMetrics = evaluateSide(symmetricGame(league), "away")!;
    const withoutMetrics = evaluateSide(
      symmetricGame({ awayPitcherMetrics: null, homePitcherMetrics: null }),
      "away",
    )!;
    expect(withMetrics.qualityScore).toBeGreaterThan(withoutMetrics.qualityScore);
    expect(withMetrics.qualityMax).toBe(withoutMetrics.qualityMax);
  });

  it("keeps the model independent of the odds VALUE with the new inputs present", () => {
    const a = computeNormModelProbs(
      symmetricGame({ ...league, awayML: 108, homeML: -128 }),
    )!;
    const b = computeNormModelProbs(
      symmetricGame({ ...league, awayML: 400, homeML: -500 }),
    )!;
    expect(a.awayProb).toBeCloseTo(b.awayProb, 10);
  });
});

describe("calibration report (what the debug reliability chart reads)", () => {
  const base = { version: 1, plattScaling: { A: 0.9987, B: 0 } };

  it("flags a fit stamped with an older feature set as stale", () => {
    const r = buildCalibrationReport({ ...base, featureSet: MODEL_FEATURE_SET - 1 }, MODEL_FEATURE_SET);
    expect(r.stale).toBe(true);
    expect(r.fittedFeatureSet).toBe(MODEL_FEATURE_SET - 1);
  });

  it("accepts a fit stamped with the current feature set", () => {
    const r = buildCalibrationReport({ ...base, featureSet: MODEL_FEATURE_SET }, MODEL_FEATURE_SET);
    expect(r.stale).toBe(false);
  });

  it("treats an unrecorded feature set as stale rather than assuming it matches", () => {
    const r = buildCalibrationReport(base, MODEL_FEATURE_SET);
    expect(r.fittedFeatureSet).toBeNull();
    expect(r.stale).toBe(true);
  });

  it("detects a near-identity calibration as a no-op", () => {
    expect(buildCalibrationReport({ plattScaling: { A: 1, B: 0 } }).identity).toBe(true);
    expect(buildCalibrationReport({ plattScaling: { A: 1.005, B: -0.004 } }).identity).toBe(true);
    expect(buildCalibrationReport({ plattScaling: { A: 0.8, B: 0.2 } }).identity).toBe(false);
  });

  it("passes reliability buckets through, and defaults to none when absent", () => {
    const bucket = { bucket: 55, count: 40, rawProb: 56.2, calibratedProb: 56.2, actual: 51.0 };
    expect(buildCalibrationReport({ ...base, reliability: [bucket] }).reliability).toEqual([bucket]);
    expect(buildCalibrationReport(base).reliability).toEqual([]);
  });

  it("keeps optional metadata null when the file does not carry it", () => {
    const r = buildCalibrationReport(base);
    expect(r.fittedAt).toBeNull();
    expect(r.trainingGames).toBeNull();
    expect(r.trainingSamples).toBeNull();
    expect(r.metrics).toBeNull();
  });

  it("ships a calibration fitted on the model's CURRENT feature set", () => {
    // Asserting the invariant rather than a stored A/B value: the shipped file
    // must match the shipped model. A feature-set change that ships without a
    // re-fit (`npm run backtest`) fails here instead of silently applying a
    // calibration for a model that no longer exists.
    const r = calibrationReport();
    expect(r.fittedFeatureSet).toBe(MODEL_FEATURE_SET);
    expect(r.stale).toBe(false);
    expect(Number.isFinite(r.A)).toBe(true);
    expect(Number.isFinite(r.B)).toBe(true);
  });

  it("ships reliability buckets the debug chart can plot", () => {
    const r = calibrationReport();
    expect(r.reliability.length).toBeGreaterThan(0);
    for (const b of r.reliability) {
      expect(b.count).toBeGreaterThan(0);
      expect(b.bucket).toBeGreaterThanOrEqual(0);
      expect(b.bucket).toBeLessThanOrEqual(100);
      for (const v of [b.rawProb, b.calibratedProb, b.actual]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

/**
 * The backtest fits the Platt parameters this app applies, so its model must be
 * the production model — not a copy that has drifted from it. That drift is not
 * hypothetical: the starter package moved to five metrics (feature set 2) while
 * the backtest still reproduced the old two-metric version, so any fit it
 * produced described a model the app no longer ran.
 *
 * These tests compare the two files' shared constants numerically. They are
 * source-level checks on purpose: the backtest is a standalone .mjs script that
 * cannot import the TypeScript model, so the constants are the only contract
 * between them.
 */
describe("backtest mirrors the production model", () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const production = readFileSync(path.join(projectRoot, "src/lib/analysis.ts"), "utf8");
  const backtest = readFileSync(path.join(projectRoot, "scripts/backtest-model.mjs"), "utf8");
  // The FIP constant lives in mlb.ts, where the metric is computed.
  const mlbSource = readFileSync(path.join(projectRoot, "src/lib/mlb.ts"), "utf8");

  /** Read `[export ]const NAME = <number>` from a source file. */
  function num(source: string, name: string): number {
    const m = new RegExp(`\\b${name}\\s*=\\s*(-?[\\d.]+)`).exec(source);
    expect(m, `${name} not found`).not.toBeNull();
    return Number(m![1]);
  }

  /** Read one `key: <number>` out of a `const NAME = { ... }` object literal. */
  function key(source: string, objectName: string, keyName: string): number {
    const body = new RegExp(`const ${objectName} = \\{([^}]*)\\}`).exec(source);
    expect(body, `${objectName} not found`).not.toBeNull();
    const m = new RegExp(`\\b${keyName}\\s*:\\s*(-?[\\d.]+)`).exec(body![1]);
    expect(m, `${objectName}.${keyName} not found`).not.toBeNull();
    return Number(m![1]);
  }

  // Coefficients, shrinkage priors and thresholds must be identical: the
  // backtest fits A/B for the logits these numbers produce.
  const SCALARS = [
    "HOME_ADV",
    "COEF_WIN_RATE",
    "COEF_RUNS_PER_GAME",
    "COEF_STARTER_ERA",
    "COEF_FIP",
    "COEF_K9",
    "COEF_BB9",
    "COEF_HR9",
    "COEF_BULLPEN_ERA",
    "PRIOR_IP_ERA",
    "PRIOR_IP_FIP",
    "PRIOR_IP_K9",
    "PRIOR_IP_BB9",
    "PRIOR_IP_HR9",
    "SMALL_SAMPLE_IP",
  ];

  it.each(SCALARS)("%s matches production", (name) => {
    expect(num(backtest, name)).toBe(num(production, name));
  });

  it("uses the same FIP constant as the metric it mirrors", () => {
    expect(num(backtest, "FIP_CONSTANT")).toBe(num(mlbSource, "FIP_CONSTANT"));
  });

  it("agrees on every per-feature logit cap", () => {
    for (const k of [
      "winRate",
      "runsPerGame",
      "starterEra",
      "fip",
      "k9",
      "bb9",
      "hr9",
      "bullpenEra",
    ]) {
      expect(key(backtest, "MAX_FEATURE_LOGIT", k)).toBe(key(production, "MAX_FEATURE_LOGIT", k));
    }
  });

  it("agrees on the league-average baselines", () => {
    for (const k of ["winRate", "runsPerGame", "starterEra", "fip", "k9", "bb9", "hr9", "bullpenEra"]) {
      expect(key(backtest, "LEAGUE_AVG", k)).toBe(key(production, "LEAGUE_AVG", k));
    }
  });

  it("stamps the feature set the app expects, and derives the starter budget from the caps", () => {
    expect(num(backtest, "FEATURE_SET_VERSION")).toBe(MODEL_FEATURE_SET);

    // The shared starter budget is the SUM of the ERA and K/9 caps in both
    // files, so it tracks the caps instead of being a third number to keep in
    // sync. Asserting the expression (not just the value it computes to) also
    // catches one file hard-coding a literal while the other derives it.
    expect(backtest).toContain("MAX_FEATURE_LOGIT.starterEra + MAX_FEATURE_LOGIT.k9");
    expect(production).toContain("MAX_FEATURE_LOGIT.starterEra + MAX_FEATURE_LOGIT.k9");
    const budget =
      key(production, "MAX_FEATURE_LOGIT", "starterEra") + key(production, "MAX_FEATURE_LOGIT", "k9");
    expect(budget).toBeCloseTo(0.8, 10);
  });
});

/**
 * CFB and NFL model an early-season week with only two inputs — win rate and
 * scoring margin. Until a team has MIN_EDGE_GAMES (4) games, the win-rate term
 * falls back to 0.5, and because scoring margin is not opponent-adjusted (a
 * 40-point win over an FCS tune-up counts the same as one over a contender) the
 * whole model collapses to one scoring term.
 *
 * That produced, on real slates: `UT Martin +4000 · model 46.7% · edge +44.3pp ·
 * EV +1815%` (CFB week 3) and `Giants +295 · model 82.7% · edge +58.4pp`
 * (NFL week 2). Both are the ABSENCE of a model, not opportunities, so the
 * model-driven sections must fail closed instead of printing them.
 *
 * These tests pin that boundary: a below-floor game with an extreme PPG gap and
 * a wildly mispriced underdog must produce no edges and no picks.
 */
describe("early-season gate (CFB / NFL)", () => {
  function cfbEarlySeasonGame(overrides: Partial<CfbGame> = {}): CfbGame {
    return {
      id: "cfb1",
      startTime: "2026-09-19T19:00:00Z",
      status: "scheduled",
      // 2-0 vs 2-0: both records are BELOW the 4-game floor.
      awayTeam: "UT Martin",
      homeTeam: "Georgia",
      awayAbbrev: "UTM",
      homeAbbrev: "UGA",
      awayRecord: "2-0",
      homeRecord: "2-0",
      // Market: a massive underdog, correctly priced.
      awayML: 4000,
      homeML: -20000,
      overUnder: 55.5,
      details: "UGA -38.5",
      awaySpread: 38.5,
      homeSpread: -38.5,
      awayMLOpen: 4000,
      homeMLOpen: -20000,
      awaySpreadOpen: 38.5,
      homeSpreadOpen: -38.5,
      provider: "DraftKings",
      // The extreme scoring gap that blows the uncapped model up, expressed as
      // net margin (points scored minus points allowed).
      awayPpg: 47.0,
      homePpg: 21.0,
      awayPpgAllowed: 21.0,
      homePpgAllowed: 47.0,
      // No opponent-adjusted rating yet (the season graph is empty this early).
      awayAdjMargin: null,
      homeAdjMargin: null,
      awayConference: null,
      homeConference: null,
      ...overrides,
    };
  }

  function nflEarlySeasonGame(overrides: Partial<NflGame> = {}): NflGame {
    return {
      id: "nfl1",
      startTime: "2026-09-20T17:00:00Z",
      status: "scheduled",
      awayTeam: "Giants",
      homeTeam: "Eagles",
      awayAbbrev: "NYG",
      homeAbbrev: "PHI",
      awayRecord: "1-0",
      homeRecord: "1-0",
      awayML: 295,
      homeML: -370,
      overUnder: 45.5,
      details: "PHI -7.5",
      awaySpread: 7.5,
      homeSpread: -7.5,
      awayMLOpen: 295,
      homeMLOpen: -370,
      awaySpreadOpen: 7.5,
      homeSpreadOpen: -7.5,
      provider: "DraftKings",
      awayPpg: 30.0,
      homePpg: 18.0,
      awayPpgAllowed: 24.0,
      homePpgAllowed: 21.0,
      // No opponent-adjusted rating yet (the season graph is empty this early),
      // so the model must fail closed rather than read the raw gap.
      awayAdjMargin: null,
      homeAdjMargin: null,
      // The defensive-context and prop-candidate fields are not read by the
      // edge/pick layers under test, so the cast stands in for them here.
      ...overrides,
    } as NflGame;
  }

  it("emits no CFB edges or moneyline picks before records clear the floor", () => {
    const games = [cfbEarlySeasonGame()];
    expect(computeCfbModelEdges(games)).toEqual([]);
    expect(analyzeCfbFavorites(games)).toEqual([]);
  });

  it("emits no NFL edges or moneyline picks before records clear the floor", () => {
    const games = [nflEarlySeasonGame()];
    expect(computeNflModelEdges(games)).toEqual([]);
    expect(analyzeNflFavorites(games)).toEqual([]);
  });

  it("starts producing CFB edges again once records AND ratings are available", () => {
    const games = [
      cfbEarlySeasonGame({
        awayRecord: "4-1",
        homeRecord: "4-1",
        // Records clear the 4-game floor and the season graph has produced a
        // rating for both sides, so the layer may disagree with the market.
        awayAdjMargin: 5,
        homeAdjMargin: -5,
      }),
    ];
    // The gate opens, so the layer is free to disagree with the market again.
    expect(computeCfbModelEdges(games).length + analyzeCfbFavorites(games).length).toBeGreaterThan(0);
  });
});

/**
 * NFL prop candidates were chosen by slicing the roster, which is ordered
 * alphabetically rather than by depth chart. Every team contributed three
 * QUARTERBACKS (Buffalo's roster reads Josh Allen, Kyle Allen, then the
 * practice squad), so the fetched stats were mostly backups with no games
 * played and the props section never showed a running back or receiver prop.
 */
describe("NFL prop candidate selection", () => {
  const QB = (id: number, name: string): SkillPlayer => ({ id, name, position: "QB" });
  const RB = (id: number, name: string): SkillPlayer => ({ id, name, position: "RB" });
  const WR = (id: number, name: string): SkillPlayer => ({ id, name, position: "WR" });
  const TE = (id: number, name: string): SkillPlayer => ({ id, name, position: "TE" });

  const LIMITS = { qbs: 1, rbs: 1, receivers: 2 };

  // Alphabetical, exactly like ESPN's offense group.
  const roster = [
    QB(1, "Josh Allen"),
    QB(2, "Kyle Allen"),
    WR(3, "Skyler Bell"),
    RB(4, "James Cook III"),
    RB(5, "Frank Gore Jr."),
    TE(6, "Dalton Kincaid"),
    WR(7, "Khalil Shakir"),
  ];

  it("picks the producing QB from leaders, not the first name on the roster", () => {
    // Kyle Allen (id 2) has the passing production in this fixture; the
    // alphabetically-first QB is Josh Allen (id 1).
    const chosen = selectPropCandidates(
      roster,
      { qbs: [2], rbs: [4], receivers: [7, 6] },
      LIMITS,
    );
    const qb = chosen.filter(p => p.position === "QB");
    expect(qb.map(p => p.id)).toEqual([2]);
    expect(chosen.map(p => p.id)).toEqual([2, 4, 7, 6]);
  });

  it("does not top a role up from roster order when leaders answered it", () => {
    // One receiver identified → exactly one receiver chosen, even though the
    // quota is two. Supplementing from roster order is how alphabetical
    // backups got in originally.
    const chosen = selectPropCandidates(
      roster,
      { qbs: [2], rbs: [5], receivers: [6] },
      LIMITS,
    );
    expect(chosen.map(p => p.id)).toEqual([2, 5, 6]);
  });

  it("covers running backs and receivers, not just quarterbacks", () => {
    const chosen = selectPropCandidates(
      roster,
      { qbs: [1], rbs: [4], receivers: [6, 7] },
      LIMITS,
    );
    expect(chosen.map(p => p.position).sort()).toEqual(["QB", "RB", "TE", "WR"]);
  });

  it("never returns more than the role quotas", () => {
    const chosen = selectPropCandidates(
      roster,
      { qbs: [1, 2], rbs: [4, 5], receivers: [3, 6, 7] },
      LIMITS,
    );
    const byPos = chosen.reduce<Record<string, number>>((m, p) => {
      m[p.position] = (m[p.position] || 0) + 1;
      return m;
    }, {});
    expect(byPos.QB).toBe(1);
    expect(byPos.RB).toBe(1);
    expect((byPos.WR || 0) + (byPos.TE || 0)).toBe(2);
  });

  it("falls back to roster order when a team has no leaders", () => {
    const chosen = selectPropCandidates(roster, null, LIMITS);
    expect(chosen.length).toBe(4);
    expect(chosen.filter(p => p.position === "RB").length).toBe(1);
  });
});

describe("NFL props and the ATS-only parlay", () => {
  function cand(overrides: Partial<NflPropCandidate>): NflPropCandidate {
    return {
      playerId: 1,
      name: "Player",
      position: "WR",
      teamAbbrev: "AAA",
      statsSeason: 2026,
      gamesPlayed: 4,
      passingYardsPerGame: null,
      passingTdsPerGame: null,
      rushingYardsPerGame: null,
      rushingTdsPerGame: null,
      receivingYardsPerGame: null,
      receivingTdsPerGame: null,
      receptionsPerGame: null,
      ...overrides,
    };
  }

  function game(props: NflPropCandidate[]): NflGame {
    return {
      id: "g",
      startTime: "2026-09-20T17:00:00Z",
      status: "scheduled",
      awayTeam: "Away",
      homeTeam: "Home",
      awayAbbrev: "AAA",
      homeAbbrev: "HHH",
      awayRecord: "4-1",
      homeRecord: "4-1",
      awayML: -120,
      homeML: 100,
      overUnder: 45.5,
      details: "AAA -1.5",
      awaySpread: -1.5,
      homeSpread: 1.5,
      awayMLOpen: -120,
      homeMLOpen: 100,
      awaySpreadOpen: -1.5,
      homeSpreadOpen: 1.5,
      provider: "DraftKings",
      awayPpg: 25,
      homePpg: 23,
      awayPpgAllowed: 22,
      homePpgAllowed: 20,
      awayProps: props,
      homeProps: [],
      // Defensive-context fields aren't read by the props layer under test.
    } as unknown as NflGame;
  }

  it("projects rushing and receiving markets, not only quarterback ones", () => {
    const props = analyzeNflProps([
      game([
        cand({ name: "Bell Cow", position: "RB", rushingYardsPerGame: 95, rushingTdsPerGame: 0.8 }),
        cand({ name: "WR One", position: "WR", receivingYardsPerGame: 88, receptionsPerGame: 6.5 }),
      ]),
    ]);
    expect(props.length).toBeGreaterThan(0);
    expect(props.map(p => p.position).some(pos => pos === "RB" || pos === "WR")).toBe(true);
  });

  it("still excludes players without a second game of data", () => {
    const props = analyzeNflProps([
      game([cand({ name: "One Game", position: "RB", gamesPlayed: 1, rushingYardsPerGame: 140 })]),
    ]);
    expect(props).toEqual([]);
  });

  it("builds an ATS-only parlay when no moneyline edges exist", () => {
    const ats: NflAtsPick[] = [
      { team: "Ravens", opponent: "Browns", line: "Ravens -8.5", spread: -8.5, reasons: [] },
      { team: "49ers", opponent: "Rams", line: "49ers -12.5", spread: -12.5, reasons: [] },
      { team: "Bears", opponent: "Lions", line: "Bears -4.5", spread: -4.5, reasons: [] },
    ];
    const parlays = buildNflParlays([], ats, [] as NflTotalPick[]);
    expect(parlays.length).toBe(1);
    expect(parlays[0].legs.length).toBe(3);
    expect(parlays[0].name).toContain("ATS");
  });
});

/* ------------------------------------------------------------------ */
/* Football model edge: net scoring margin                             */
/* ------------------------------------------------------------------ */

/** A CFB game with both records above the floor, so the model has signal. */
function cfbModelGame(overrides: Partial<CfbGame> = {}): CfbGame {
  return {
    id: "cfb-model",
    startTime: "2026-10-10T19:00:00Z",
    status: "scheduled",
    awayTeam: "Away",
    homeTeam: "Home",
    awayAbbrev: "AWY",
    homeAbbrev: "HOM",
    awayRecord: "5-1",
    homeRecord: "5-1",
    awayML: -110,
    homeML: -110,
    overUnder: 55.5,
    details: "HOM -1.0",
    awaySpread: 1,
    homeSpread: -1,
    awayMLOpen: -110,
    homeMLOpen: -110,
    awaySpreadOpen: 1,
    homeSpreadOpen: -1,
    provider: "DraftKings",
    awayPpg: 28,
    homePpg: 28,
    awayPpgAllowed: 28,
    homePpgAllowed: 28,
    // Both sides rated league-average by the season graph.
    awayAdjMargin: 0,
    homeAdjMargin: 0,
    awayConference: null,
    homeConference: null,
    ...overrides,
  };
}

/** An NFL game with both records above the floor. */
function nflModelGame(overrides: Partial<NflGame> = {}): NflGame {
  return {
    ...cfbModelGame(),
    id: "nfl-model",
    awayTeam: "Away",
    homeTeam: "Home",
    ...overrides,
  } as unknown as NflGame;
}

/**
 * CFB and NFL once modelled a game on win rate plus OFFENSE-only points per
 * game (blind to defense: 28 scored/14 allowed equalled 28/34), then on raw net
 * scoring margin (blind to schedule: a blowout of an FCS tune-up counted as much
 * as a win over a contender). The feature is now the OPPONENT-ADJUSTED margin
 * from srs.ts, still capped per feature the way MLB caps its inputs.
 */
describe("football model: opponent-adjusted scoring margin", () => {
  it("uses the opponent-adjusted margin — equal records are not equal teams", () => {
    const even = cfbModelGame(); // both sides rated league-average
    const homeStrong = cfbModelGame({ homeAdjMargin: 10, awayAdjMargin: -10 });
    expect(cfbTeamWinProbability(homeStrong, "home")!).toBeGreaterThan(
      cfbTeamWinProbability(even, "home")!,
    );
  });

  it("works for the NFL too", () => {
    const even = nflModelGame();
    const homeStrong = nflModelGame({ homeAdjMargin: 8, awayAdjMargin: -8 });
    expect(nflTeamWinProbability(homeStrong, "home")!).toBeGreaterThan(
      nflTeamWinProbability(even, "home")!,
    );
  });

  it("ignores raw scoring entirely — a padded margin buys nothing", () => {
    // Identical adjusted ratings, but one side has gaudy raw scoring numbers.
    // If the model still read raw margin, this would move the probability.
    const plain = cfbModelGame();
    const padded = cfbModelGame({
      awayPpg: 55,
      awayPpgAllowed: 3,
      homePpg: 10,
      homePpgAllowed: 45,
    });
    expect(cfbTeamWinProbability(padded, "home")).toBeCloseTo(
      cfbTeamWinProbability(plain, "home")!,
      10,
    );
  });

  it("caps the CFB margin feature so one stat can't run away with the logit", () => {
    // 0.15 × 20 points already exceeds the 2.0 cap, so a 20-point adjusted
    // margin gap and a 42-point one must land on the SAME probability…
    const moderate = cfbModelGame({ homeAdjMargin: 10, awayAdjMargin: -10 });
    const extreme = cfbModelGame({ homeAdjMargin: 21, awayAdjMargin: -21 });
    expect(cfbTeamWinProbability(extreme, "home")).toBeCloseTo(
      cfbTeamWinProbability(moderate, "home")!,
      10,
    );
    // …while smaller gaps still move the model, so the cap isn't just flat.
    const small = cfbModelGame({ homeAdjMargin: 4, awayAdjMargin: -4 });
    expect(cfbTeamWinProbability(small, "home")!).toBeLessThan(
      cfbTeamWinProbability(moderate, "home")!,
    );
  });

  it("caps the NFL margin feature the same way", () => {
    // 0.13 × 10 points exceeds the 0.6 cap.
    const moderate = nflModelGame({ homeAdjMargin: 5, awayAdjMargin: -5 });
    const extreme = nflModelGame({ homeAdjMargin: 21, awayAdjMargin: -21 });
    expect(nflTeamWinProbability(extreme, "home")).toBeCloseTo(
      nflTeamWinProbability(moderate, "home")!,
      10,
    );
    const small = nflModelGame({ homeAdjMargin: 1, awayAdjMargin: -1 });
    expect(nflTeamWinProbability(small, "home")!).toBeLessThan(
      nflTeamWinProbability(moderate, "home")!,
    );
  });

  it("treats a missing rating as league-average, never as the raw margin", () => {
    // Raw scoring says the home side is a 42-point monster; with no rating both
    // sides are average, so only home field remains.
    const unknown = cfbModelGame({
      awayAdjMargin: null,
      homeAdjMargin: null,
      homePpg: 45,
      homePpgAllowed: 3,
    });
    const home = cfbTeamWinProbability(unknown, "home")!;
    expect(home).toBeGreaterThan(50);
    expect(home).toBeLessThan(60);
  });

  it("fails closed when no opponent-adjusted rating is available", () => {
    // A raw margin — even a huge one — is no longer model signal, so the layer
    // emits nothing rather than guessing off a schedule-blind average.
    const noRating = cfbModelGame({ awayAdjMargin: null, homeAdjMargin: null });
    expect(computeCfbModelEdges([noRating])).toEqual([]);
    expect(computeNflModelEdges([nflModelGame({ awayAdjMargin: null, homeAdjMargin: null })])).toEqual([]);
  });
});

/**
 * The opponent adjustment itself. A raw margin is not comparable across
 * schedules: a 30-point win over a weak team looks like a contender's result
 * until it is measured against what those opponents did to everyone else. These
 * tests pin the two properties the model depends on — beating up on weak
 * opponents is discounted, and the ratings stay centred on zero.
 */
describe("opponent-adjusted margin (SRS)", () => {
  it("discounts a big margin piled up against weak opponents", () => {
    // Strong plays only cupcakes and wins huge; Cupcake loses to everyone.
    // Weak beats Nobody, and Nobody beats Cupcake, so Cupcake's rating is low.
    const games = [
      { homeTeamId: 1, awayTeamId: 4, homeScore: 50, awayScore: 7 }, // Strong over Cupcake
      { homeTeamId: 1, awayTeamId: 5, homeScore: 45, awayScore: 10 }, // Strong over Nobody
      { homeTeamId: 5, awayTeamId: 4, homeScore: 21, awayScore: 0 }, // Nobody over Cupcake
    ];
    const r = computeOpponentAdjustedMargins(games);
    // Raw margin for team 1 is (43 + 35) / 2 = 39, but its opponents are weak
    // (both lost badly to it), so the adjusted rating is well below that.
    expect(r.get(1)!).toBeLessThan(39);
    // Cupcake, beaten by both, is the worst team.
    expect(r.get(4)!).toBeLessThan(r.get(5)!);
    expect(r.get(5)!).toBeLessThan(r.get(1)!);
  });

  it("rewards a margin earned against strong opponents", () => {
    // Same two wins by 7 for A and B…
    const evenSchedule = [
      { homeTeamId: 1, awayTeamId: 2, homeScore: 24, awayScore: 17 },
      { homeTeamId: 3, awayTeamId: 4, homeScore: 24, awayScore: 17 },
    ];
    // …but A's opponent is a good team (it beat a good side), while B's is not.
    const withContext = [
      { homeTeamId: 1, awayTeamId: 2, homeScore: 24, awayScore: 17 },
      { homeTeamId: 2, awayTeamId: 3, homeScore: 30, awayScore: 3 }, // B is good
      { homeTeamId: 3, awayTeamId: 4, homeScore: 24, awayScore: 17 },
    ];
    const flat = computeOpponentAdjustedMargins(evenSchedule);
    const adjusted = computeOpponentAdjustedMargins(withContext);
    // Beating a team that itself wins big is worth more than beating a loser.
    expect(adjusted.get(1)!).toBeGreaterThan(flat.get(1)!);
  });

  it("centres the ratings on zero", () => {
    const games = [
      { homeTeamId: 1, awayTeamId: 2, homeScore: 30, awayScore: 10 },
      { homeTeamId: 2, awayTeamId: 3, homeScore: 21, awayScore: 14 },
      { homeTeamId: 3, awayTeamId: 1, homeScore: 17, awayScore: 17 },
    ];
    const r = computeOpponentAdjustedMargins(games);
    const mean = [...r.values()].reduce((a, b) => a + b, 0) / r.size;
    expect(Math.abs(mean)).toBeLessThan(1e-9);
    for (const v of r.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it("returns an empty map (not NaN) when there are no games", () => {
    expect(computeOpponentAdjustedMargins([]).size).toBe(0);
    // A malformed row is skipped rather than poisoning every rating.
    const r = computeOpponentAdjustedMargins([
      { homeTeamId: 1, awayTeamId: 2, homeScore: Number.NaN, awayScore: 10 },
      { homeTeamId: 1, awayTeamId: 2, homeScore: 20, awayScore: 10 },
    ]);
    for (const v of r.values()) expectFinite(v);
  });

  it("shrinks a small sample toward league average instead of letting it run", () => {
    // Team 1 beat team 2 by 63 and team 3 by 7; team 3 beat team 2 by 4. Every
    // team has barely played, and one result is a 63-point blowout.
    const games = [
      { homeTeamId: 1, awayTeamId: 2, homeScore: 66, awayScore: 3 },
      { homeTeamId: 3, awayTeamId: 2, homeScore: 24, awayScore: 20 },
      { homeTeamId: 1, awayTeamId: 3, homeScore: 27, awayScore: 20 },
    ];
    const r = computeOpponentAdjustedMargins(games);
    // Without the prior these run to ~±23 off the 63-point margin; CFB is full
    // of one-game teams (FCS schools) and those extremes distorted the centred
    // zero point enough to rate a 4-0 team near +54 and print a 40pp edge.
    for (const v of r.values()) {
      expect(Math.abs(v)).toBeLessThan(10);
      expectFinite(v);
    }
    // Shrinkage must not flatten the ordering: team 1 beat team 3 head to head.
    expect(r.get(1)!).toBeGreaterThan(r.get(3)!);
    expect(r.get(1)!).toBeGreaterThan(0);
  });

  it("keeps a well-sampled rating closer to its raw value than a thin one", () => {
    // Build a connected league so games-played actually differs.
    const games: { homeTeamId: number; awayTeamId: number; homeScore: number; awayScore: number }[] = [];
    for (let i = 0; i < 12; i++) {
      games.push({ homeTeamId: 1, awayTeamId: 100 + i, homeScore: 30, awayScore: 10 });
    }
    // Team 1 has 12 games; each opponent has exactly 1.
    const r = computeOpponentAdjustedMargins(games);
    const rawTeam1 = 20;
    const keep = 12 / (12 + SRS_PRIOR_GAMES);
    const thinKeep = 1 / (1 + SRS_PRIOR_GAMES);
    // The well-sampled team retains far more of its rating than a one-game team.
    expect(keep).toBeGreaterThan(thinKeep);
    expect(Math.abs(r.get(1)!)).toBeLessThanOrEqual(rawTeam1 / keep + 1e-9);
  });
});

/**
 * Look-ahead is the one bug this module cannot be allowed to have: a rating that
 * saw its own game (or a same-day game) makes the backtest's accuracy a fiction.
 * The old football fit did exactly that by reading full-season team stats.
 */
describe("point-in-time integrity", () => {
  const games = [
    { date: "2026-09-01", homeTeamId: 1, awayTeamId: 2, homeScore: 40, awayScore: 3 },
    { date: "2026-09-08", homeTeamId: 2, awayTeamId: 3, homeScore: 21, awayScore: 20 },
  ];

  it("excludes a game played on the SAME date as the cut-off", () => {
    // As of 09-08 only the 09-01 game is knowable, so team 3 is not rated yet.
    const asOf = computeMarginsAsOf(games, "2026-09-08");
    expect(asOf.has(1)).toBe(true);
    expect(asOf.has(2)).toBe(true);
    expect(asOf.has(3)).toBe(false);
  });

  it("includes a game once its date has passed", () => {
    const later = computeMarginsAsOf(games, "2026-09-09");
    expect(later.has(3)).toBe(true);
  });

  it("rates nothing before the season's first game", () => {
    expect(computeMarginsAsOf(games, "2026-09-01").size).toBe(0);
  });
});

/**
 * The backtest fits the Platt parameters the app applies, so its copy of each
 * sport's model has to be the production model. It is a standalone .mjs script
 * that cannot import the TypeScript it mirrors, so these source-level checks on
 * the shared constants are the contract between them — the same drift the MLB
 * coefficients are guarded against.
 */
describe("backtest mirrors the football models", () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const cfbProduction = readFileSync(path.join(projectRoot, "src/lib/cfbAnalysis.ts"), "utf8");
  const nflProduction = readFileSync(path.join(projectRoot, "src/lib/nflAnalysis.ts"), "utf8");
  const backtest = readFileSync(path.join(projectRoot, "scripts/backtest-model.mjs"), "utf8");

  /** Read `[export ]const NAME = <number>` from a source file. */
  function num(source: string, name: string): number {
    const m = new RegExp(`\\b${name}\\s*=\\s*(-?[\\d.]+)`).exec(source);
    expect(m, `${name} not found`).not.toBeNull();
    return Number(m![1]);
  }

  /** The `cfb: { … }` / `nfl: { … }` block of FOOTBALL_CONFIG. */
  function configBlock(sport: "cfb" | "nfl"): string {
    const start = backtest.indexOf(`\n  ${sport}: {`);
    expect(start, `${sport} config block not found`).toBeGreaterThan(-1);
    const end = backtest.indexOf("\n  },", start);
    expect(end, `${sport} config block is unterminated`).toBeGreaterThan(start);
    return backtest.slice(start, end);
  }

  function cfg(sport: "cfb" | "nfl", key: string): number {
    const m = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(configBlock(sport));
    expect(m, `${sport}.${key} not found`).not.toBeNull();
    return Number(m![1]);
  }

  /** A nested `key: <number>` inside a named object literal (production side). */
  function prodNested(source: string, constName: string, key: string): number {
    const block = new RegExp(`const ${constName} = \\{[\\s\\S]*?\\n\\};`).exec(source);
    expect(block, `${constName} not found`).not.toBeNull();
    const v = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(block![0]);
    expect(v, `${constName}.${key} not found`).not.toBeNull();
    return Number(v![1]);
  }

  /** A nested `key: <number>` in the same shape inside a config block (backtest side). */
  function cfgNested(sport: "cfb" | "nfl", objName: string, key: string): number {
    const obj = new RegExp(`${objName}:\\s*\\{[^}]*\\}`).exec(configBlock(sport));
    expect(obj, `${sport}.${objName} not found`).not.toBeNull();
    const v = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(obj![0]);
    expect(v, `${sport}.${objName}.${key} not found`).not.toBeNull();
    return Number(v![1]);
  }

  const cases = [
    { sport: "cfb" as const, production: cfbProduction, prefix: "CFB", leagueAvg: "CFB_LEAGUE_AVG" },
    { sport: "nfl" as const, production: nflProduction, prefix: "NFL", leagueAvg: "NFL_LEAGUE_AVG" },
  ];

  it("shares the margin coefficient, win-rate coefficient and home edge", () => {
    for (const { sport, production, prefix } of cases) {
      for (const [prodName, cfgKey] of [
        [`${prefix}_COEF_MARGIN`, "coefMargin"],
        [`${prefix}_COEF_WIN_RATE`, "coefWinRate"],
        [`${prefix}_HOME_ADV`, "homeAdv"],
      ] as const) {
        const m = new RegExp(`\\b${prodName}\\s*=\\s*(-?[\\d.]+)`).exec(production);
        expect(m, `${prodName} not found`).not.toBeNull();
        expect(Number(m![1]), `${prodName} drifted from ${sport}.${cfgKey}`).toBe(cfg(sport, cfgKey));
      }
    }
  });

  it("shares the per-feature caps and the league-average margin", () => {
    for (const { sport, production, leagueAvg } of cases) {
      expect(prodNested(production, "MAX_FEATURE_LOGIT", "winRate"))
        .toBe(cfgNested(sport, "maxFeatureLogit", "winRate"));
      expect(prodNested(production, "MAX_FEATURE_LOGIT", "margin"))
        .toBe(cfgNested(sport, "maxFeatureLogit", "margin"));
      // Both sides must agree that an unknown team is exactly average (0),
      // not "a team that has allowed no points".
      expect(prodNested(production, leagueAvg, "margin")).toBe(cfgNested(sport, "leagueAvg", "margin"));
      expect(prodNested(production, leagueAvg, "margin")).toBe(0);
    }
  });

  it("shares the opponent-adjustment iteration count", () => {
    // The backtest mirrors computeOpponentAdjustedMargins because it is a
    // standalone .mjs script that cannot import the TypeScript. If the two
    // loops disagree on how many passes they run, they stop computing the same
    // rating — and the fit silently describes a model the app no longer has.
    expect(num(backtest, "SRS_ITERATIONS")).toBe(SRS_ITERATIONS);
  });

  it("shares the opponent-adjustment sample-size prior", () => {
    // Shrinkage changes every rating, so a mismatch would mean the fit was
    // computed for a different feature than the app runs.
    expect(num(backtest, "SRS_PRIOR_GAMES")).toBe(SRS_PRIOR_GAMES);
  });

  it("cannot look ahead — a rating is built strictly from earlier games", () => {
    // The old football fit read each team's FULL-SEASON scoring stats to
    // "predict" mid-season games; that look-ahead is why its Brier looked far
    // better than the model really was. Both halves of the contract are pinned:
    // a strict date filter, and no full-season stat source at all.
    expect(backtest).toContain("g.date < date");
    expect(backtest).not.toContain("g.date <= date");
    expect(backtest).not.toContain("fetchFootballTeamStats");
  });

  it("ships calibrations stamped with the feature set the backtest fits", () => {
    for (const [sport, file] of [
      ["cfb", "calibration-cfb.json"],
      ["nfl", "calibration-nfl.json"],
    ] as const) {
      const cal = JSON.parse(readFileSync(path.join(projectRoot, "src/lib", file), "utf8"));
      expect(cal.featureSet, `${file} is stale — re-run the backtest`).toBe(cfg(sport, "featureSet"));
      expect(Number.isFinite(cal.plattScaling.A)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* NFL props: prior-season blend and line/direction agreement          */
/* ------------------------------------------------------------------ */

const seasonStats = (over: Partial<PlayerSeasonStats>): PlayerSeasonStats => ({
  gamesPlayed: 0,
  passingYardsPerGame: null,
  passingTds: null,
  rushingYardsPerGame: null,
  rushingTds: null,
  receivingYardsPerGame: null,
  receivingTds: null,
  receptions: null,
  receptionsPerGame: null,
  ...over,
});

/** An NFL game carrying one team's prop candidates. */
function nflPropGame(awayProps: NflPropCandidate[]): NflGame {
  return {
    id: "prop-game",
    startTime: "2026-10-04T17:00:00Z",
    status: "scheduled",
    awayTeam: "Away",
    homeTeam: "Home",
    awayAbbrev: "AAA",
    homeAbbrev: "HHH",
    awayRecord: "4-1",
    homeRecord: "4-1",
    awayML: -120,
    homeML: 100,
    overUnder: 45.5,
    details: "AAA -1.5",
    awaySpread: -1.5,
    homeSpread: 1.5,
    awayMLOpen: -120,
    homeMLOpen: 100,
    awaySpreadOpen: -1.5,
    homeSpreadOpen: 1.5,
    provider: "DraftKings",
    awayPpg: 25,
    homePpg: 23,
    awayPpgAllowed: 22,
    homePpgAllowed: 20,
    awayProps,
    homeProps: [],
  } as unknown as NflGame;
}

const propCandidate = (over: Partial<NflPropCandidate>): NflPropCandidate => ({
  playerId: 1,
  name: "Bell Cow",
  position: "RB",
  teamAbbrev: "AAA",
  statsSeason: 2026,
  gamesPlayed: 4,
  passingYardsPerGame: null,
  passingTdsPerGame: null,
  rushingYardsPerGame: null,
  rushingTdsPerGame: null,
  receivingYardsPerGame: null,
  receivingTdsPerGame: null,
  receptionsPerGame: null,
  ...over,
});

describe("NFL props: prior-season blend", () => {
  it("weights the prior season as PRIOR_SEASON_WEIGHT_GAMES games", () => {
    const current = seasonStats({ gamesPlayed: 1, rushingYardsPerGame: 100, rushingTds: 2 });
    const prior = seasonStats({ gamesPlayed: 17, rushingYardsPerGame: 60, rushingTds: 1 });
    const { stats, blended } = blendPlayerStats(current, prior);
    expect(blended).toBe(true);
    const w = 1 + PRIOR_SEASON_WEIGHT_GAMES;
    expect(stats.rushingYardsPerGame).toBeCloseTo((100 + 60 * PRIOR_SEASON_WEIGHT_GAMES) / w, 10);
    expect(stats.rushingTds).toBeCloseTo((2 + 1 * PRIOR_SEASON_WEIGHT_GAMES) / w, 10);
    // The CURRENT game count survives, so the thin-sample warning still fires.
    expect(stats.gamesPlayed).toBe(1);
  });

  it("ignores a prior season too short to be a prior", () => {
    const current = seasonStats({ gamesPlayed: 1, rushingYardsPerGame: 100 });
    const cameo = seasonStats({ gamesPlayed: 3, rushingYardsPerGame: 5 });
    const { stats, blended } = blendPlayerStats(current, cameo);
    expect(blended).toBe(false);
    expect(stats).toEqual(current);
    expect(blendPlayerStats(current, null).blended).toBe(false);
  });

  it("does not blend when there is no current sample to stabilise", () => {
    const none = seasonStats({ gamesPlayed: 0, rushingYardsPerGame: null });
    const prior = seasonStats({ gamesPlayed: 17, rushingYardsPerGame: 60 });
    expect(blendPlayerStats(none, prior).blended).toBe(false);
  });

  it("supplies a market the current season has no data for", () => {
    const current = seasonStats({ gamesPlayed: 1, receivingYardsPerGame: null });
    const prior = seasonStats({ gamesPlayed: 16, receivingYardsPerGame: 70 });
    expect(blendPlayerStats(current, prior).stats.receivingYardsPerGame).toBe(70);
  });

  it("projects from a blended one-game sample, and records where it came from", () => {
    const props = analyzeNflProps([
      nflPropGame([
        propCandidate({
          gamesPlayed: 1,
          rushingYardsPerGame: 82,
          rushingTdsPerGame: 0.9,
          blendedWithPrior: true,
          priorGamesPlayed: 17,
        }),
      ]),
    ]);
    expect(props.length).toBeGreaterThan(0);
    // Provenance travels with the pick, so a tracked row still shows how thin
    // its sample was after the fact.
    expect(props[0].statsBasis).toContain("2025");
    expect(props[0].statsBasis).toContain("blended");
  });

  it("stays dark for that same player when the blend flag is the only thing missing", () => {
    // Proves the floor can't be bypassed by simply having played one game — the
    // gate opens only for a sample the model actually blended.
    const props = analyzeNflProps([
      nflPropGame([
        propCandidate({ gamesPlayed: 1, rushingYardsPerGame: 82, rushingTdsPerGame: 0.9 }),
      ]),
    ]);
    expect(props).toEqual([]);
  });
});

describe("prop lines agree with their direction", () => {
  it("never publishes an Over line at or above the projection it came from", () => {
    // Plain rounding to the nearest half produced "Over 1" on a 0.9/game
    // projection — a line above the number the model actually believes.
    let checked = 0;
    let subOneOver = 0;
    for (const tds of [0.3, 0.5, 0.7, 0.9, 1.1, 1.2, 1.6, 2.5, 3.4]) {
      const props = analyzeNflProps([
        nflPropGame([propCandidate({ gamesPlayed: 4, rushingTdsPerGame: tds })]),
      ]);
      for (const p of props) {
        if (p.playerAvg == null) continue;
        checked++;
        if (p.direction === "Over") expect(p.projectedLine).toBeLessThan(p.playerAvg);
        else expect(p.projectedLine).toBeGreaterThan(p.playerAvg);
        // The case that used to break: a sub-1.0 average rounding UP to a
        // whole-number line while still being called an Over.
        if (p.direction === "Over" && p.playerAvg < 1) subOneOver++;
      }
    }
    // Guard against a vacuous pass: this loop must actually produce props, and
    // specifically the sub-1.0 TD markets where the old rounding inverted.
    expect(checked).toBeGreaterThan(0);
    expect(subOneOver).toBeGreaterThan(0);
  });

  it("falls back to the league baseline instead of quoting a 0.00 defense", () => {
    // With no defensive allowance there is nothing to compare against, so the
    // reasons must say so rather than printing "~0.00 TDs/g allowed".
    const props = analyzeNflProps([
      nflPropGame([propCandidate({ gamesPlayed: 4, rushingTdsPerGame: 1.2 })]),
    ]);
    expect(props.length).toBeGreaterThan(0);
    expect(props[0].reasons.join(" ")).toContain("league baseline");
    expect(props[0].reasons.join(" ")).not.toContain("~0.00");
  });
});

/**
 * The tracker captures picks from the API and grades them later, so a market
 * the app can emit but the grader cannot resolve becomes a row that sits
 * pending forever. NFL props never graded at all (category "Prop" had no
 * parser), and now that props are emitted every week a new market must not
 * silently join them.
 */
describe("tracker scripts cover every market the app emits", () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const grader = readFileSync(path.join(projectRoot, "scripts/grade-picks.mjs"), "utf8");
  const capture = readFileSync(path.join(projectRoot, "scripts/capture-picks.mjs"), "utf8");
  const nflProduction = readFileSync(path.join(projectRoot, "src/lib/nflAnalysis.ts"), "utf8");

  it("can grade every NFL prop market the model emits", () => {
    const markets = new Set(
      [...nflProduction.matchAll(/market: "([^"]+)"/g)].map((m) => m[1]),
    );
    expect(markets.size).toBeGreaterThan(0);
    for (const market of markets) {
      expect(grader, `"${market}" has no box-score mapping in grade-picks.mjs`)
        .toContain(`"${market}"`);
    }
  });

  it("parses the prop line format the capture script writes", () => {
    // capture-picks writes `${player} ${direction} ${line} ${market} (${team})`;
    // grade-picks must recognise that exact shape.
    expect(capture).toContain(
      "${p.player} ${p.direction} ${p.projectedLine} ${p.market} (${p.team})",
    );
    expect(grader).toContain('category === "Prop"');
  });

  it("persists the model metrics it calculates", () => {
    // These were computed per row and then dropped by a hardcoded field list,
    // leaving every tracked pick unusable for edge/EV analysis.
    expect(capture).toContain("...metrics,");
    expect(capture).toContain("const { id, date, sport: rowSport, category, pick, ...metrics } = row;");
  });
});
