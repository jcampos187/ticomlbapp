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
