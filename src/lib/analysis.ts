import {
  Game,
  TopPick,
  KProp,
  TotalPick,
  Parlay,
  ModelEdge,
  Confidence,
  DataQuality,
  EdgeFlag,
  PitcherMetrics,
} from "./types";
import calibration from "./calibration.json";

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

// Line-movement thresholds (American-odds cents). A moneyline that moved this
// many cents toward a team (e.g. -150 -> -180, or +180 -> +150) is a LINE
// MOVEMENT signal. Opening/current prices alone cannot identify who caused
// the move, so it is never presented as "sharp money".
const LINE_MOVE_STRONG_CENTS = 20;
const LINE_MOVE_MILD_CENTS = 10;

// ---------------------------------------------------------------------------
// Model Edge: logistic win-probability model vs market implied probability
// ---------------------------------------------------------------------------

// League-average baselines used only to fill gaps when a team's stat is
// missing (rookie starters, TBD pitchers, no trends fetched). Centering on
// per-game *differences* between the two teams keeps the model relative, so
// these baselines only matter when one side lacks a stat.
export const LEAGUE_AVG = {
  winRate: 0.5,
  runsPerGame: 4.5,
  starterEra: 4.25,
  /**
   * League-average FIP. FIP is on the same runs-per-nine scale as ERA; the
   * conventional FIP constant places league-average FIP a little below
   * league-average ERA.
   */
  fip: 4.1,
  k9: 8.6,
  bb9: 3.2,
  hr9: 1.25,
  bullpenEra: 4.1,
};

// A record must represent at least this many games before win rate counts as
// a real signal. A 2-0 start is noise; a 45-30 record is information. Teams
// below the floor fall back to the league baseline (and are marked
// incomplete), so early-season slates never produce confident fake edges.
const MIN_EDGE_GAMES = 4;

// A starter's ERA/K/9 over a tiny sample (a rookie's 0.56 ERA across 16 IP)
// is noise, but the model would happily turn it into a huge "edge". Regress
// pitcher stats toward the league baseline using an innings-pitched prior
// (empirical Bayes). Each stat gets its own prior because they stabilise at
// very different rates: ERA needs ~100 IP to be half-trustworthy, K/9 only
// ~60 IP. A 16-IP rookie keeps ~14% of his numbers; a 100+ IP veteran keeps
// most of his.
const PRIOR_IP_ERA = 100; // phantom IP of league-average ERA
const PRIOR_IP_FIP = 80; // FIP removes defence/sequencing, so it stabilises sooner than ERA
const PRIOR_IP_K9 = 60; // phantom IP of league-average K/9
const PRIOR_IP_BB9 = 55; // walk rate stabilises comparatively quickly
const PRIOR_IP_HR9 = 130; // home-run rate is famously slow to stabilise
export const SMALL_SAMPLE_IP = 20; // below this, flag the starter in the UI

// Logistic coefficients. Each feature contributes to the log-odds z:
//   z = homeAdv + b1*(winRate diff) + b2*(R/G diff)
//       + [starter package: ERA, FIP, K/9, BB/9, HR/9]
//       + b7*(bullpen ERA diff)
// P(win) = sigmoid(z). The magnitudes are calibrated so a strong team vs a
// weak one (e.g. a -190 favorite) lands around a 70-75% model probability.
//
// Starting-pitcher quality is now a five-metric package. ERA and FIP are on
// the same runs-per-nine scale and measure the same thing, so FIP carries a
// slightly smaller coefficient than ERA rather than being stacked on top of
// it at full weight; K/9, BB/9 and HR/9 are the components of FIP and get
// small individual weights. The whole package is bounded by
// MAX_STARTER_BUNDLE_LOGIT below, which is the real safeguard against
// correlated metrics stacking one signal without limit (that budget also
// notes why the existing calibration is now stale).
//
// Every feature is also capped individually (see MAX_FEATURE_LOGIT below) so
// a single extreme mismatch — say a 3.2 vs 5.6 starter ERA — can't dominate
// the model and print a +25% edge. Teams don't differ by 25 points of true
// win probability on one stat alone; caps keep extreme edges rare.
const HOME_ADV = 0.24;
const COEF_WIN_RATE = 2.8; // +0.10 win-rate diff ~ +7pp
const COEF_RUNS_PER_GAME = 0.22; // +1.0 R/G diff ~ +5.5pp
const COEF_STARTER_ERA = 0.28; // +1.0 ERA edge ~ +7pp
const COEF_FIP = 0.22; // +1.0 FIP edge ~ +5.5pp (correlated with ERA — see bundle cap)
const COEF_K9 = 0.05; // +3.0 K/9 diff ~ +3.7pp
const COEF_BB9 = 0.06; // +1.5 BB/9 diff ~ +2.2pp
const COEF_HR9 = 0.18; // +0.8 HR/9 diff ~ +3.5pp
const COEF_BULLPEN_ERA = 0.18; // +1.0 bullpen ERA edge ~ +4.5pp

// Per-feature logit caps: the most one feature may move the win probability
// (a 0.5 logit cap ≈ +12pp; 0.4 ≈ +10pp; 0.3 ≈ +7.5pp). Applied symmetrically.
const MAX_FEATURE_LOGIT = {
  winRate: 0.6,
  runsPerGame: 0.4,
  starterEra: 0.5,
  fip: 0.4,
  k9: 0.3,
  bb9: 0.15,
  hr9: 0.15,
  bullpenEra: 0.4,
};

/**
 * Shared logit budget for the whole starting-pitcher package.
 *
 * ERA, FIP, K/9, BB/9 and HR/9 all describe one quantity — how many runs a
 * starter prevents — and FIP is literally built from the other three, so
 * summing five independently-capped terms would count that one signal several
 * times over and can manufacture edges. This budget is exactly the range the
 * old ERA+K/9 pair could occupy (0.5 + 0.3 = 0.8), so the added metrics can
 * never stack without limit: the TOTAL pitcher influence stays inside the
 * ceiling the previous model had.
 *
 * Note the budget bounds the ceiling, it does not hold the average constant.
 * Within the ceiling a five-metric read can move a probability more than the
 * old ERA+K/9 pair did, which is the intended effect of adding real
 * information. Because the feature set changed, the Platt calibration in
 * calibration.json (fitted on the old features) is now stale and should be
 * re-fitted with `npm run backtest`.
 */
const MAX_STARTER_BUNDLE_LOGIT = MAX_FEATURE_LOGIT.starterEra + MAX_FEATURE_LOGIT.k9;

// Shared with the CFB/NFL models, which cap their features the same way.
export function clampFeature(term: number, cap: number): number {
  return Math.max(-cap, Math.min(cap, term));
}

/**
 * Sum a group of pitching terms under a shared logit budget. Positive and
 * negative contributions are bounded separately, so one big opposite-signed
 * term cannot cancel another and slip past the cap.
 *
 * Exported for tests so the bound on pitcher influence is directly checkable.
 */
export function capStarterBundle(
  terms: number[],
  budget: number = MAX_STARTER_BUNDLE_LOGIT,
): number {
  const positive = terms.filter((t) => t > 0).reduce((a, b) => a + b, 0);
  const negative = terms.filter((t) => t < 0).reduce((a, b) => a + b, 0);
  const worst = Math.max(positive, -negative);
  const scale = worst > budget ? budget / worst : 1;
  return (positive + negative) * scale;
}

/**
 * Regress a pitcher stat toward the league average by sample size (innings
 * pitched). Blends own numbers with the league baseline weighted by
 * n / (n + priorIp) — the standard empirical-Bayes shrinkage, where priorIp
 * is the innings count at which a stat is ~50% reliable. Returns the stat
 * unchanged when there's no innings info to judge the sample by.
 */
export function shrinkStat(
  stat: number | null,
  ip: number | null,
  leagueAvg: number,
  priorIp: number,
): number | null {
  if (stat == null) return null;
  if (ip == null) return stat;
  const n = Math.max(0, ip);
  const weight = n / (n + priorIp);
  return stat * weight + leagueAvg * (1 - weight);
}

// ---------------------------------------------------------------------------
// Platt scaling calibration
// ---------------------------------------------------------------------------

/**
 * Apply Platt scaling calibration to a raw logit.
 *
 * The backtest script fits parameters A and B so that:
 *   calibrated_prob = sigmoid(A * raw_logit + B)
 *
 * When A ≈ 1 and B ≈ 0, calibration is a no-op (the model is already
 * well-calibrated). Deviations from (1, 0) indicate the model needs
 * recalibration.
 *
 * Parameters are loaded from calibration.json which is generated by
 * running: npm run backtest
 */
export function calibrateLogit(rawLogit: number): number {
  const { A, B } = calibration.plattScaling;
  return A * rawLogit + B;
}

/** Platt parameters currently loaded, for the debug view / diagnostics. */
export function plattParameters(): { A: number; B: number; fittedAt: string | null } {
  return {
    A: calibration.plattScaling.A,
    B: calibration.plattScaling.B,
    fittedAt: (calibration as { fittedAt?: string }).fittedAt ?? null,
  };
}

/**
 * Feature-set version the CURRENT model uses. Bump this whenever the inputs to
 * computeRawLogit change. The backtest stamps the version it fitted on into
 * calibration.json, so the debug view can tell whether a stored calibration
 * still matches the model that is applying it.
 *
 *   1 = win rate, R/G, starter ERA, K/9, bullpen ERA
 *   2 = + FIP, BB/9, HR/9 in the starter package, under a shared logit budget
 */
export const MODEL_FEATURE_SET = 2;

/** One reliability-diagram bucket, produced by the backtest. */
export interface ReliabilityBucket {
  /** Bucket centre in % — the nearest 5% the model's probability rounded to. */
  bucket: number;
  /** Samples in the bucket (2 per game: home + away). */
  count: number;
  /** Mean RAW (pre-calibration) predicted probability in the bucket, %. */
  rawProb: number;
  /** Mean post-calibration predicted probability in the bucket, %. */
  calibratedProb: number;
  /** Observed win rate in the bucket, %. The diagonal is perfect calibration. */
  actual: number;
}

/**
 * A calibration file as written by the backtest. Every field except
 * `plattScaling` is optional because files written before a field was
 * introduced are still valid and must load.
 */
export interface RawCalibrationFile {
  version?: number;
  fittedAt?: string;
  /** Feature-set version the fit covers (absent in files predating it). */
  featureSet?: number;
  trainingPeriod?: { from: string; to: string };
  trainingGames?: number;
  trainingSamples?: number;
  plattScaling: { A: number; B: number };
  metrics?: {
    brierBefore?: number;
    brierAfter?: number;
    logLossBefore?: number;
    logLossAfter?: number;
  };
  /** Reliability buckets for the debug view's reliability diagram. */
  reliability?: ReliabilityBucket[];
}

/** Everything the debug view needs to judge a loaded calibration. */
export interface CalibrationReport {
  A: number;
  B: number;
  fittedAt: string | null;
  trainingPeriod: { from: string; to: string } | null;
  trainingGames: number | null;
  trainingSamples: number | null;
  metrics: {
    brierBefore: number | null;
    brierAfter: number | null;
    logLossBefore: number | null;
    logLossAfter: number | null;
  } | null;
  /** Reliability buckets from the fit; empty when the file predates them. */
  reliability: ReliabilityBucket[];
  /** Feature-set version the fit was stamped with, or null when unrecorded. */
  fittedFeatureSet: number | null;
  /** Feature-set version the current model uses. */
  currentFeatureSet: number;
  /**
   * True when the fit does not cover the model's current inputs. A missing
   * version counts as stale: it cannot be shown to match, so it is not assumed
   * to. This is the flag that surfaces a calibration fitted before a feature
   * change (e.g. the move to the five-metric starter package).
   */
  stale: boolean;
  /** True when A ≈ 1 and B ≈ 0 — calibration currently changes nothing. */
  identity: boolean;
}

/**
 * Build a calibration diagnostic from a raw calibration file. Pure, so the
 * staleness rule is testable without re-importing the JSON module.
 */
export function buildCalibrationReport(
  raw: RawCalibrationFile,
  currentFeatureSet: number = MODEL_FEATURE_SET,
): CalibrationReport {
  const { A, B } = raw.plattScaling;
  const fittedFeatureSet = typeof raw.featureSet === "number" ? raw.featureSet : null;
  return {
    A,
    B,
    fittedAt: raw.fittedAt ?? null,
    trainingPeriod: raw.trainingPeriod ?? null,
    trainingGames: raw.trainingGames ?? null,
    trainingSamples: raw.trainingSamples ?? null,
    metrics: raw.metrics
      ? {
          brierBefore: raw.metrics.brierBefore ?? null,
          brierAfter: raw.metrics.brierAfter ?? null,
          logLossBefore: raw.metrics.logLossBefore ?? null,
          logLossAfter: raw.metrics.logLossAfter ?? null,
        }
      : null,
    reliability: raw.reliability ?? [],
    fittedFeatureSet,
    currentFeatureSet,
    stale: fittedFeatureSet !== currentFeatureSet,
    identity: Math.abs(A - 1) < 0.01 && Math.abs(B) < 0.01,
  };
}

/** Calibration diagnostics for the currently loaded calibration file. */
export function calibrationReport(): CalibrationReport {
  return buildCalibrationReport(calibration as RawCalibrationFile);
}

// Model-edge candidate thresholds (percentage points of edge).
const EDGE_A = 8; // reference "large" edge
const EDGE_B = 5; // reference "solid" edge
const EDGE_C = 3; // minimum edge to surface a candidate at all

// Unusually large model-vs-market disagreements are FLAGGED for review, never
// capped or suppressed. The edge is always shown at its real value.
const HIGH_EDGE_THRESHOLD = 10; // >= 10pp: large model-market disagreement
const EXTREME_EDGE_THRESHOLD = 15; // >= 15pp: extreme edge, verify the data

// Reference edge used to normalise edge strength into a 0..1 factor for the
// confidence grade and the pick-ranking composite.
const EDGE_REFERENCE_PP = EDGE_A;

// Confidence = blend of edge strength and data quality. Deliberately NOT
// edge alone: a big edge on thin data must not outrank a modest edge on
// complete, sample-size-backed data.
const CONFIDENCE_EDGE_WEIGHT = 0.5;
const CONFIDENCE_DATA_WEIGHT = 0.5;
const CONFIDENCE_A_MIN = 0.8;
const CONFIDENCE_B_MIN = 0.6;
const CONFIDENCE_C_MIN = 0.4;

/** Grade each confidence letter contributes to the ranking composite. */
const CONFIDENCE_RANK_WEIGHT: Record<Confidence, number> = { A: 1, B: 0.66, C: 0.33, D: 0 };
/** Grade each data-quality label contributes to the ranking composite. */
const QUALITY_RANK_WEIGHT: Record<DataQuality, number> = { HIGH: 1, MEDIUM: 0.6, LOW: 0.2 };

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

export interface TeamModelInputs {
  winRate: number;
  runsPerGame: number;
  /** Starter ERA, regressed toward LEAGUE_AVG.starterEra by sample size. */
  starterEra: number;
  /** Starter FIP, regressed the same way (independent of defence/sequencing). */
  fip: number;
  k9: number;
  bb9: number;
  hr9: number;
  bullpenEra: number;
  complete: boolean;
  /** True when the starter has very few innings — stats were regressed. */
  smallSample: boolean;
  /** How many of the five independent starter metrics were actually present. */
  starterMetrics: number;
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
  const starterIp = side === "away" ? game.awayIp : game.homeIp;

  // FIP / BB/9 / HR/9 come from the pitcher metrics object. All three are
  // nullable: a pitcher with no season line contributes nothing, and because
  // BOTH sides fall back to the same league average the difference is zero.
  const metrics = side === "away" ? game.awayPitcherMetrics : game.homePitcherMetrics;
  const fip = metrics?.fip ?? null;
  const bb9 = metrics?.bb9 ?? null;
  const hr9 = metrics?.hr9 ?? null;

  const present = [winRate, runsPerGame, starterEra, k9, bullpenEra]
    .filter((v): v is number => v != null).length;

  // A starter with very few innings gets every rate stat regressed toward the
  // league baseline — a 0.56 ERA over 16 IP must not move the model 18pp, and
  // the same is true of a flukey 1.00 HR/9 or 1.0 BB/9.
  const smallSample = starterIp != null && starterIp < SMALL_SAMPLE_IP;

  return {
    winRate: winRate ?? LEAGUE_AVG.winRate,
    runsPerGame: runsPerGame ?? LEAGUE_AVG.runsPerGame,
    starterEra: shrinkStat(starterEra, starterIp, LEAGUE_AVG.starterEra, PRIOR_IP_ERA) ?? LEAGUE_AVG.starterEra,
    fip: shrinkStat(fip, starterIp, LEAGUE_AVG.fip, PRIOR_IP_FIP) ?? LEAGUE_AVG.fip,
    k9: shrinkStat(k9, starterIp, LEAGUE_AVG.k9, PRIOR_IP_K9) ?? LEAGUE_AVG.k9,
    bb9: shrinkStat(bb9, starterIp, LEAGUE_AVG.bb9, PRIOR_IP_BB9) ?? LEAGUE_AVG.bb9,
    hr9: shrinkStat(hr9, starterIp, LEAGUE_AVG.hr9, PRIOR_IP_HR9) ?? LEAGUE_AVG.hr9,
    bullpenEra: bullpenEra ?? LEAGUE_AVG.bullpenEra,
    // Strong data = at least 4 of 5 core team stats present AND the starter's
    // sample is big enough to trust (small samples knock the grade down).
    complete: present >= 4 && !smallSample,
    smallSample,
    starterMetrics: [starterEra, fip, k9, bb9, hr9].filter((v) => v != null).length,
  };
}

// ---------------------------------------------------------------------------
// Core model functions
// ---------------------------------------------------------------------------

/**
 * Compute the raw log-odds (z-score) for one side of an MLB game.
 * This is the unscaled logistic input — NOT a probability.
 * Used internally by the model and exported for UI normalisation.
 */
export function computeRawLogit(
  t: TeamModelInputs,
  o: TeamModelInputs,
  isHome: boolean,
): number {
  let z = isHome ? HOME_ADV : 0;
  z += clampFeature((t.winRate - o.winRate) * COEF_WIN_RATE, MAX_FEATURE_LOGIT.winRate);
  z += clampFeature((t.runsPerGame - o.runsPerGame) * COEF_RUNS_PER_GAME, MAX_FEATURE_LOGIT.runsPerGame);
  // Starting-pitcher package. Lower is better for ERA/FIP/BB9/HR9 (so the
  // opponent's value is subtracted), higher is better for K/9.
  z += capStarterBundle([
    clampFeature((o.starterEra - t.starterEra) * COEF_STARTER_ERA, MAX_FEATURE_LOGIT.starterEra),
    clampFeature((o.fip - t.fip) * COEF_FIP, MAX_FEATURE_LOGIT.fip),
    clampFeature((t.k9 - o.k9) * COEF_K9, MAX_FEATURE_LOGIT.k9),
    clampFeature((o.bb9 - t.bb9) * COEF_BB9, MAX_FEATURE_LOGIT.bb9),
    clampFeature((o.hr9 - t.hr9) * COEF_HR9, MAX_FEATURE_LOGIT.hr9),
  ]);
  z += clampFeature((o.bullpenEra - t.bullpenEra) * COEF_BULLPEN_ERA, MAX_FEATURE_LOGIT.bullpenEra);
  return z;
}

/** True when a moneyline is a real, usable price. Odds of 0 mean "no line". */
function isUsableOdds(ml: unknown): ml is number {
  return typeof ml === "number" && Number.isFinite(ml) && ml !== 0;
}

/** Keep probabilities inside [3%, 97%] and never emit NaN. */
function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 50;
  return Math.min(97, Math.max(3, p));
}

/** Round to one decimal for transport/display only. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Both probable starters are known (not empty, not "TBD"). */
function hasConfirmedPitchers(game: Game): boolean {
  const a = game.awayPitcher;
  const h = game.homePitcher;
  return !!a && a !== "TBD" && !!h && h !== "TBD";
}

export interface ModelProbabilities {
  /** 0–100. */
  awayProb: number;
  /** 0–100. Always exactly 100 − awayProb. */
  homeProb: number;
  /** Per-side raw logistic score (before normalisation/calibration). */
  awayRawLogit: number;
  homeRawLogit: number;
  /** logit of the pre-calibration normalised home probability. */
  homeNormalizedLogit: number;
  /** True when Platt calibration actually moved the probability. */
  calibrated: boolean;
  awayInputs: TeamModelInputs;
  homeInputs: TeamModelInputs;
}

/**
 * Compute normalised model probabilities (%) for both sides of a game.
 *
 * The two raw logits are converted to odds-ratio space via sigmoid and then
 * normalised so that P(away) + P(home) = exactly 100%. Deriving home as
 * 100 − away guarantees the invariant holds to full floating-point precision;
 * rounding happens only at the display edge.
 *
 * Odds are used ONLY as a gate (does this game have a market to compare
 * against). No odds VALUE ever enters the probability computation, so the
 * model cannot learn from the market it is being measured against.
 */
export function computeNormModelProbs(game: Game): ModelProbabilities | null {
  if (!isUsableOdds(game.awayML) || !isUsableOdds(game.homeML)) return null;

  const t = teamInputs(game, "away");
  const o = teamInputs(game, "home");

  const awayRawLogit = computeRawLogit(t, o, false);
  const homeRawLogit = computeRawLogit(o, t, true);

  // 1) Normalise the two sigmoids into a proper two-outcome distribution.
  const eAway = sigmoid(awayRawLogit);
  const eHome = sigmoid(homeRawLogit);
  const total = eAway + eHome;
  const homePre = eHome / total;

  // 2) Platt calibration. The backtest fits sigmoid(A*z + B) where z is the
  //    logit of the ALREADY-NORMALISED probability, so calibration must be
  //    applied to that same quantity to be consistent with the fit. Applying
  //    it to the raw per-side logits (the previous behaviour) was a different
  //    transform than the one that was fitted.
  const homeNormalizedLogit = Math.log(homePre / (1 - homePre));
  const homeCal = sigmoid(calibrateLogit(homeNormalizedLogit));

  // 3) Clamp for display safety. home = 100 − away keeps the sum exact.
  const awayProb = clampPct((1 - homeCal) * 100);
  const homeProb = 100 - awayProb;

  return {
    awayProb,
    homeProb,
    awayRawLogit,
    homeRawLogit,
    homeNormalizedLogit,
    calibrated: Math.abs(homeCal - homePre) > 1e-12,
    awayInputs: t,
    homeInputs: o,
  };
}

/**
 * Logistic win probability (%) for one side of a game. Returns null when
 * there's no moneyline to anchor the matchup (no odds = no bettable game).
 *
 * NOTE: This uses the normalised (softmax) approach so both sides always
 * sum to exactly 100%.
 */
export function teamWinProbability(game: Game, side: "away" | "home"): number | null {
  const result = computeNormModelProbs(game);
  if (!result) return null;
  return side === "away" ? result.awayProb : result.homeProb;
}

/**
 * De-vigged (fair) market probability for one side.
 *
 * Raw implied probabilities from American odds include sportsbook vig and
 * typically sum to >100%. This function normalises them so both sides sum
 * to exactly 100%, giving the "fair" market price.
 *
 * Returns null if either side lacks odds.
 */
export function fairMarketProbability(
  awayML: number,
  homeML: number,
  side: "away" | "home",
): number | null {
  if (!awayML || !homeML) return null;

  // Raw implied probabilities (include vig)
  const awayImplied = (1 / americanToDecimal(awayML)) * 100;
  const homeImplied = (1 / americanToDecimal(homeML)) * 100;

  // De-vig: normalise so they sum to exactly 100%
  const total = awayImplied + homeImplied;
  if (total === 0) return null;

  return side === "away"
    ? (awayImplied / total) * 100
    : (homeImplied / total) * 100;
}

/**
 * Raw (vig-included) implied probability from a single moneyline.
 * Kept for backward compatibility and the totals/props analysis.
 */
export function marketProbability(ml: number): number {
  return (1 / americanToDecimal(ml)) * 100;
}

/**
 * RAW market probability from American odds, computed directly from the odds
 * formulas (equivalent to marketProbability, named explicitly at the call
 * site so "raw" and "fair" can never be confused):
 *
 *   positive odds:  100 / (odds + 100)
 *   negative odds:  |odds| / (|odds| + 100)
 *
 *   +108 -> 100 / 208 = 48.08%
 *   -108 -> 108 / 208 = 51.92%
 *
 * This includes the sportsbook's vig and is NEVER used to compute Edge.
 */
export function rawMarketProbability(americanOdds: number): number {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return 0;
  return americanOdds > 0
    ? (100 / (americanOdds + 100)) * 100
    : (Math.abs(americanOdds) / (Math.abs(americanOdds) + 100)) * 100;
}

/**
 * Expected value as a percentage: (modelProb × decimalOdds) − 1.
 * Uses the model probability and actual sportsbook odds — NOT the
 * de-vigged market probability, because EV is about what YOU would
 * earn at the posted price.
 */
export function expectedValue(modelProbPct: number, americanOdds: number): number {
  const decimal = americanToDecimal(americanOdds);
  return (modelProbPct / 100) * decimal - 1; // as a fraction; multiply by 100 for %
}

/** A-D confidence grade shared by all sports' model-edge layers. */
export function edgeConfidence(edge: number, complete: boolean): Confidence {
  if (edge >= EDGE_A) return complete ? "A" : "B";
  if (edge >= EDGE_B) return complete ? "B" : "C";
  if (edge >= EDGE_C) return "C";
  return "D";
}

// ---------------------------------------------------------------------------
// Validation, data quality and confidence
// ---------------------------------------------------------------------------

/**
 * Validate every probability pair for a game and return human-readable
 * problems. An empty array means the calculation is sound.
 *
 * This replaces console-only validation: a failure now marks the evaluation
 * invalid so the UI can flag the row instead of displaying numbers that
 * don't add up.
 */
export function validateProbabilities(
  game: Game,
  modelAway: number,
  modelHome: number,
  fairAway: number,
  fairHome: number,
  rawAway: number,
  rawHome: number,
): string[] {
  const EPSILON = 0.5; // full precision internally; this only tolerates display rounding
  const errors: string[] = [];
  const label = `${game.awayTeam} @ ${game.homeTeam}`;

  if (!Number.isFinite(modelAway) || !Number.isFinite(modelHome)) {
    errors.push(`${label}: model probability is not a finite number`);
  } else if (Math.abs(modelAway + modelHome - 100) > EPSILON) {
    errors.push(
      `${label}: model probabilities sum to ${(modelAway + modelHome).toFixed(2)}% (expected 100%)`,
    );
  }

  if (!Number.isFinite(fairAway) || !Number.isFinite(fairHome)) {
    errors.push(`${label}: fair market probability is not a finite number`);
  } else if (Math.abs(fairAway + fairHome - 100) > EPSILON) {
    errors.push(
      `${label}: fair market probabilities sum to ${(fairAway + fairHome).toFixed(2)}% (expected 100%)`,
    );
  }

  const pairs: [string, number][] = [
    ["modelAway", modelAway],
    ["modelHome", modelHome],
    ["fairAway", fairAway],
    ["fairHome", fairHome],
    ["rawAway", rawAway],
    ["rawHome", rawHome],
  ];
  for (const [name, value] of pairs) {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`${label}: ${name}=${value} out of range [0, 100]`);
    }
  }

  if (!isUsableOdds(game.awayML) || !isUsableOdds(game.homeML)) {
    errors.push(`${label}: invalid odds (awayML=${game.awayML}, homeML=${game.homeML})`);
  }

  return errors;
}

/**
 * How much of the model's required data actually exists for this game.
 *
 * Eight concrete availability checks, deliberately independent of how large
 * the edge is. This is what stops a big edge on thin data from being graded
 * as confident.
 */
export function assessDataQuality(
  game: Game,
  probs: ModelProbabilities,
  pitcherConfirmed: boolean,
  validationErrors: string[],
): { score: number; max: number; quality: DataQuality } {
  const haveIp = (v: number | null): boolean =>
    v != null && Number.isFinite(v) && v >= SMALL_SAMPLE_IP;
  /** All three fielding-independent metrics were published for this starter. */
  const haveIndependentMetrics = (m: PitcherMetrics | null): boolean =>
    m != null && m.fip != null && m.bb9 != null && m.hr9 != null;
  const checks: boolean[] = [
    pitcherConfirmed, // 1. both starters known (not TBD)
    haveIp(game.awayIp) && haveIp(game.homeIp), // 2. sample size adequate
    parseWinRate(game.awayRecord) != null && parseWinRate(game.homeRecord) != null, // 3. records
    game.awayRunsPerGame != null && game.homeRunsPerGame != null, // 4. offence
    game.awayBullpenEra != null && game.homeBullpenEra != null, // 5. bullpen
    game.awayK9 != null && game.homeK9 != null, // 6. strikeout rate
    haveIndependentMetrics(game.awayPitcherMetrics) &&
      haveIndependentMetrics(game.homePitcherMetrics), // 7. FIP / BB/9 / HR/9
    validationErrors.length === 0, // 8. probabilities validated
  ];
  const score = checks.filter(Boolean).length;
  // Ratio thresholds so adding a check doesn't silently regrade everything:
  // >= 85% HIGH, >= 50% MEDIUM, else LOW (6/7 and 7/8 are both HIGH).
  const ratio = score / checks.length;
  return {
    score,
    max: checks.length,
    quality: ratio >= 0.85 ? "HIGH" : ratio >= 0.5 ? "MEDIUM" : "LOW",
  };
}

/**
 * Confidence grade from edge strength AND data quality.
 *
 *   combined = 0.5 * min(edge / 8pp, 1) + 0.5 * (qualityScore / qualityMax)
 *   A >= 0.80, B >= 0.60, C >= 0.40, else D
 *
 * So a +10% edge on thin data lands at B, while a +5% edge on complete,
 * sample-backed data reaches A. Confidence is never just the edge.
 */
export function modelConfidence(
  edge: number,
  qualityScore: number,
  qualityMax: number,
): Confidence {
  const edgeNorm = Math.max(0, Math.min(edge / EDGE_REFERENCE_PP, 1));
  const qualityNorm = qualityMax > 0 ? qualityScore / qualityMax : 0;
  const combined =
    CONFIDENCE_EDGE_WEIGHT * edgeNorm + CONFIDENCE_DATA_WEIGHT * qualityNorm;
  if (combined >= CONFIDENCE_A_MIN) return "A";
  if (combined >= CONFIDENCE_B_MIN) return "B";
  if (combined >= CONFIDENCE_C_MIN) return "C";
  return "D";
}

// ---------------------------------------------------------------------------
// Single source of truth for one side of a game
// ---------------------------------------------------------------------------

/**
 * Every intermediate value for one side of one game, computed in exactly one
 * place so the API, the dashboard and the debug view can never disagree.
 */
export interface SideEvaluation {
  side: "away" | "home";
  team: string;
  opponent: string;
  abbrev: string;
  ml: number;
  home: boolean;

  /** Raw logistic score for this side, before normalisation/calibration. */
  rawModelLogit: number;
  /** logit of the normalised probability that calibration was applied to. */
  normalizedLogit: number;
  /** False when Platt scaling is a no-op (A≈1, B≈0). */
  calibrated: boolean;

  /** 0–100, normalised so the two sides sum to exactly 100. */
  modelProb: number;
  opponentModelProb: number;
  /** 0–100 raw implied probability (vig INCLUDED) at the posted price. */
  rawMarketProb: number;
  /** 0–100 de-vigged fair market probability. */
  fairMarketProb: number;
  opponentFairMarketProb: number;
  decimalOdds: number;

  /** modelProb − fairMarketProb, in percentage points. */
  edge: number;
  /** (modelProb × decimalOdds) − 1 at the posted price, as a percentage. */
  ev: number;

  confidence: Confidence;
  dataQuality: DataQuality;
  qualityScore: number;
  qualityMax: number;

  valid: boolean;
  validationErrors: string[];

  flag: EdgeFlag | null;
  pitcherConfirmed: boolean;
  smallSample: boolean;
  inputsComplete: boolean;

  inputs: TeamModelInputs;
  opponentInputs: TeamModelInputs;
}

/** Compute every metric for one side of a game. Returns null without a market. */
export function evaluateSide(game: Game, side: "away" | "home"): SideEvaluation | null {
  const probs = computeNormModelProbs(game);
  if (!probs) return null;

  const fairAway = fairMarketProbability(game.awayML, game.homeML, "away");
  const fairHome = fairMarketProbability(game.awayML, game.homeML, "home");
  if (fairAway == null || fairHome == null) return null;

  const ml = side === "away" ? game.awayML : game.homeML;
  if (!isUsableOdds(ml)) return null;

  const rawAway = rawMarketProbability(game.awayML);
  const rawHome = rawMarketProbability(game.homeML);

  const validationErrors = validateProbabilities(
    game,
    probs.awayProb,
    probs.homeProb,
    fairAway,
    fairHome,
    rawAway,
    rawHome,
  );

  const pitcherConfirmed = hasConfirmedPitchers(game);
  const modelProb = side === "away" ? probs.awayProb : probs.homeProb;
  const fairMktProb = side === "away" ? fairAway : fairHome;
  const rawMktProb = side === "away" ? rawAway : rawHome;

  // EDGE is model − FAIR market. Never the raw price, and never EV.
  const edge = modelProb - fairMktProb;
  // EV is about the price actually on offer: model probability at posted odds.
  const ev = expectedValue(modelProb, ml) * 100;
  const decimalOdds = americanToDecimal(ml);

  const quality = assessDataQuality(game, probs, pitcherConfirmed, validationErrors);

  const flag: EdgeFlag | null =
    edge >= EXTREME_EDGE_THRESHOLD
      ? "extreme"
      : edge >= HIGH_EDGE_THRESHOLD
        ? "large"
        : null;

  return {
    side,
    team: side === "away" ? game.awayTeam : game.homeTeam,
    opponent: side === "away" ? game.homeTeam : game.awayTeam,
    abbrev: side === "away" ? game.awayAbbrev : game.homeAbbrev,
    ml,
    home: side === "home",
    rawModelLogit: side === "away" ? probs.awayRawLogit : probs.homeRawLogit,
    normalizedLogit:
      side === "away" ? -probs.homeNormalizedLogit : probs.homeNormalizedLogit,
    calibrated: probs.calibrated,
    modelProb,
    opponentModelProb: side === "away" ? probs.homeProb : probs.awayProb,
    rawMarketProb: rawMktProb,
    fairMarketProb: fairMktProb,
    opponentFairMarketProb: side === "away" ? fairHome : fairAway,
    decimalOdds,
    edge,
    ev,
    confidence: modelConfidence(edge, quality.score, quality.max),
    dataQuality: quality.quality,
    qualityScore: quality.score,
    qualityMax: quality.max,
    valid: validationErrors.length === 0,
    validationErrors,
    flag,
    pitcherConfirmed,
    smallSample: (side === "away" ? probs.awayInputs : probs.homeInputs).smallSample,
    inputsComplete: probs.awayInputs.complete && probs.homeInputs.complete,
    inputs: side === "away" ? probs.awayInputs : probs.homeInputs,
    opponentInputs: side === "away" ? probs.homeInputs : probs.awayInputs,
  };
}

// ---------------------------------------------------------------------------
// Compute model edges
// ---------------------------------------------------------------------------

/** Human-readable reasons a side shows up in the model-edge layer. */
function edgeReasons(s: SideEvaluation): string[] {
  const reasons: string[] = [];
  const t = s.inputs;
  const o = s.opponentInputs;
  if (t.winRate > o.winRate + 0.03) reasons.push(`${(t.winRate * 100).toFixed(0)}% win rate`);
  if (t.runsPerGame > o.runsPerGame + 0.3) reasons.push(`${t.runsPerGame.toFixed(2)} R/G offense`);
  if (t.starterEra < o.starterEra - 0.3) reasons.push(`Starter ERA ${t.starterEra.toFixed(2)}`);
  if (t.fip < o.fip - 0.3) reasons.push(`FIP ${t.fip.toFixed(2)}`);
  if (t.k9 > o.k9 + 1) reasons.push(`K/9 ${t.k9.toFixed(1)}`);
  if (t.bb9 < o.bb9 - 0.4) reasons.push(`BB/9 ${t.bb9.toFixed(2)}`);
  if (t.hr9 < o.hr9 - 0.25) reasons.push(`HR/9 ${t.hr9.toFixed(2)}`);
  if (t.bullpenEra < o.bullpenEra - 0.3) reasons.push(`BP ERA ${t.bullpenEra.toFixed(2)}`);
  if (s.side === "home") reasons.push("Home field");
  if (!s.pitcherConfirmed) reasons.push("⚠ TBD pitcher(s)");
  if (s.smallSample || o.smallSample) reasons.push("⚠ Small sample — starter stats regressed");
  if (s.flag === "extreme") reasons.push("⚠ Extreme edge — verify data");
  else if (s.flag === "large") reasons.push("⚠ Large model-market disagreement");
  if (!s.valid) reasons.push("⚠ Invalid probabilities — flagged");
  return reasons;
}

/**
 * Ranking value for a Model Edge pick.
 *
 * Edge is the largest single contributor but is NOT allowed to dominate: EV,
 * confidence and data quality each shift the order, so the biggest edge on
 * thin data can rank below a slightly smaller edge on complete data. Edge and
 * EV are normalised to 0..1.5 so one freak number cannot swamp the rest.
 */
export function modelEdgeValueScore(e: ModelEdge): number {
  const edgeNorm = Math.max(0, Math.min(e.edge / EDGE_REFERENCE_PP, 1.5));
  const evNorm = Math.max(0, Math.min(e.ev / 15, 1.5));
  return (
    1.0 * edgeNorm +
    0.7 * evNorm +
    0.6 * CONFIDENCE_RANK_WEIGHT[e.confidence] +
    0.4 * QUALITY_RANK_WEIGHT[e.dataQuality]
  );
}

/**
 * MODEL EDGE PICKS — where the model disagrees with the FAIR market.
 *
 * Candidates need edge >= EDGE_C, then rank by modelEdgeValueScore (edge +
 * EV + confidence + data quality) — never by edge alone and never by odds
 * magnitude, so a +108 underdog can outrank a -300 favorite. Edges are shown
 * at their real size; unusually large ones are flagged, never capped.
 */
export function computeModelEdges(games: Game[]): ModelEdge[] {
  const edges: ModelEdge[] = [];

  for (const game of games) {
    const away = evaluateSide(game, "away");
    const home = evaluateSide(game, "home");
    if (!away || !home) continue;

    // No meaningful model data on either side (0-0 records, no trends) means
    // every "edge" is just 50% vs the market — noise, not signal.
    if (!away.inputsComplete && !home.inputsComplete) continue;

    for (const s of [away, home]) {
      edges.push({
        team: s.team,
        abbrev: s.abbrev,
        opponent: s.opponent,
        gameId: game.id,
        ml: s.ml,
        home: s.home,
        modelProb: round1(s.modelProb),
        rawMarketProb: round1(s.rawMarketProb),
        fairMarketProb: round1(s.fairMarketProb),
        edge: round1(s.edge),
        ev: round1(s.ev),
        confidence: s.confidence,
        dataQuality: s.dataQuality,
        qualityScore: s.qualityScore,
        qualityMax: s.qualityMax,
        valid: s.valid,
        validationErrors: s.validationErrors,
        flag: s.flag,
        reasons: edgeReasons(s),
        pitcherConfirmed: s.pitcherConfirmed,
      });
    }
  }

  return edges
    .filter(e => e.edge >= EDGE_C)
    .sort((a, b) => modelEdgeValueScore(b) - modelEdgeValueScore(a))
    .slice(0, 6);
}

/** Reasons shared by the pick cards (favorites and best value). */
function pickReasons(s: SideEvaluation): string[] {
  const reasons: string[] = [];
  reasons.push(`Edge ${s.edge >= 0 ? "+" : ""}${s.edge.toFixed(1)}%`);
  reasons.push(`EV ${s.ev >= 0 ? "+" : ""}${s.ev.toFixed(1)}%`);
  if (s.flag === "extreme") reasons.push("⚠ Extreme edge — verify data");
  else if (s.flag === "large") reasons.push("⚠ Large model-market disagreement");
  if (!s.valid) reasons.push("⚠ Invalid probabilities — flagged");
  if (s.modelProb > 60) reasons.push(`Model ${s.modelProb.toFixed(1)}%`);
  if (s.ml <= -150) reasons.push(`${formatOdds(s.ml)} favorite`);
  if (s.ml > 0) reasons.push(`${formatOdds(s.ml)} underdog`);
  if (s.dataQuality !== "HIGH") reasons.push(`Data quality: ${s.dataQuality}`);
  if (!s.pitcherConfirmed) reasons.push("⚠ TBD pitcher(s)");
  if (s.smallSample) reasons.push("⚠ Small sample — starter stats regressed");
  return reasons;
}

/**
 * Line-movement signal: how many cents the price moved toward this side.
 * Opening/current prices cannot identify who moved the line, so this is never
 * labelled "sharp money".
 */
function lineMovementBonus(game: Game, side: "away" | "home"): number {
  const open = side === "away" ? game.awayMLOpen : game.homeMLOpen;
  const current = side === "away" ? game.awayML : game.homeML;
  if (open == null || !isUsableOdds(current)) return 0;
  const move = current - open;
  if (move <= -LINE_MOVE_STRONG_CENTS) return 3;
  if (move <= -LINE_MOVE_MILD_CENTS) return 1;
  return 0;
}

function toTopPick(s: SideEvaluation, reasons: string[]): TopPick {
  return {
    team: s.team,
    opponent: s.opponent,
    ml: s.ml,
    impliedProb: round1(s.rawMarketProb), // deprecated alias, kept for compat
    rawMarketProb: round1(s.rawMarketProb),
    fairMarketProb: round1(s.fairMarketProb),
    modelProb: round1(s.modelProb),
    edge: round1(s.edge),
    ev: round1(s.ev),
    confidence: s.confidence,
    dataQuality: s.dataQuality,
    valid: s.valid,
    validationErrors: s.validationErrors,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Top Favorite Picks — strongest / highest-probability favorites
// ---------------------------------------------------------------------------

/**
 * TOP FAVORITE PICKS — the strongest favorites the model believes in.
 *
 * Deliberately NOT a value ranking: it answers "who does the model think is
 * most likely to win" — highest model probability among teams the book has at
 * negative odds. Value lives in computeModelEdges and analyzeBestValue.
 */
export function analyzeFavorites(games: Game[]): TopPick[] {
  const picks: TopPick[] = [];
  const seen = new Set<string>();

  for (const game of games) {
    for (const side of ["away", "home"] as const) {
      const s = evaluateSide(game, side);
      if (!s) continue;
      // A "favorite" is a team the book prices at negative American odds.
      if (s.ml >= 0) continue;
      if (s.modelProb < 55) continue;

      const reasons = pickReasons(s);
      if (s.ev < 0) reasons.push("⚠ Negative EV at this price");
      if (lineMovementBonus(game, side) >= 2) reasons.push("Line moved toward this side");

      picks.push(toTopPick(s, reasons));
    }
  }

  return picks
    .sort((a, b) => b.modelProb - a.modelProb)
    .filter(p => {
      if (seen.has(p.team)) return false;
      seen.add(p.team);
      return true;
    })
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// Best Value — strongest positive-EV opportunities at the posted prices
// ---------------------------------------------------------------------------

/**
 * BEST VALUE — where the posted price pays more than the model thinks it
 * should. Ranked by EV, and requires BOTH a positive edge and positive EV so a
 * pick cannot qualify on a number that is not actually available at the book.
 */
export function analyzeBestValue(games: Game[]): TopPick[] {
  const picks: TopPick[] = [];
  const seen = new Set<string>();

  for (const game of games) {
    for (const side of ["away", "home"] as const) {
      const s = evaluateSide(game, side);
      if (!s) continue;
      if (s.edge <= 0 || s.ev <= 0) continue;

      const reasons = pickReasons(s);
      if (lineMovementBonus(game, side) >= 2) reasons.push("Line moved toward this side");

      picks.push(toTopPick(s, reasons));
    }
  }

  return picks
    .sort((a, b) => b.ev - a.ev)
    .filter(p => {
      if (seen.has(p.team)) return false;
      seen.add(p.team);
      return true;
    })
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// K-Strikeout Props (unchanged — purely statistical, not model-based)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Over/Under Totals (unchanged — purely statistical, not model-based)
// ---------------------------------------------------------------------------

export function analyzeTotals(games: Game[]): TotalPick[] {
  const picks: (TotalPick & { score: number })[] = [];

  for (const game of games) {
    if (!game.overUnder) continue;

    let overVotes = 0;
    let underVotes = 0;
    let overReasons: string[] = [];
    let underReasons: string[] = [];

    // 1) Starting pitching signal (ERA regressed toward league average for
    //    small samples, same as the edge model — a 16-IP 0.56 ERA is not
    //    "elite pitching" yet).
    const eras = [
      shrinkStat(game.awayEra, game.awayIp, LEAGUE_AVG.starterEra, PRIOR_IP_ERA),
      shrinkStat(game.homeEra, game.homeIp, LEAGUE_AVG.starterEra, PRIOR_IP_ERA),
    ].filter((e): e is number => e != null);
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

// ---------------------------------------------------------------------------
// Parlay builder (updated to use ModelEdge with new fields)
// ---------------------------------------------------------------------------

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
