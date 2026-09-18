export interface Game {
  id: string;
  startTime: string; // ISO UTC timestamp (e.g. "2026-08-07T19:10Z")
  status: "scheduled" | "live" | "final";
  awayTeam: string;
  homeTeam: string;
  awayAbbrev: string;
  homeAbbrev: string;
  awayRecord: string;
  homeRecord: string;
  awayML: number;
  homeML: number;
  overUnder: number;
  awayPitcher: string;
  homePitcher: string;
  awayPitcherRecord: string;
  homePitcherRecord: string;
  awayK9: number | null;
  homeK9: number | null;
  awayAvgK: number | null;
  homeAvgK: number | null;
  awayOver6_5: number | null;
  homeOver6_5: number | null;
  awayEra: number | null;
  homeEra: number | null;
  /** Season innings pitched for each starter — sample-size basis for regressing ERA/K9. */
  awayIp: number | null;
  homeIp: number | null;
  awayRunsPerGame: number | null;
  homeRunsPerGame: number | null;
  awayBullpenEra: number | null;
  homeBullpenEra: number | null;
  awayMLOpen: number | null;
  homeMLOpen: number | null;
  /** Whether both starting pitchers are confirmed (not TBD). */
  pitcherConfirmed?: boolean;
  /**
   * Independent starter metrics from the MLB Stats API (season to date).
   *
   * era, fip, k9, bb9 and hr9 all feed the win-probability model (shrunk by
   * `ip` and combined under a shared logit budget — see analysis.ts). whip and
   * the game-log fields are carried for display/props and future use, not the
   * win probability. See PitcherMetrics.
   */
  awayPitcherMetrics: PitcherMetrics | null;
  homePitcherMetrics: PitcherMetrics | null;
}

/**
 * Independent starting-pitcher metrics, all sourced from the MLB Stats API
 * season splits plus the pitcher's game log. Nothing here is estimated or
 * imputed: a metric is either a real league-published value, computed from
 * real counting stats (FIP), or null.
 *
 * `source` and `season` exist so the UI can show provenance instead of
 * presenting a number with no origin.
 */
export interface PitcherMetrics {
  era: number | null;
  k9: number | null;
  bb9: number | null;
  hr9: number | null;
  whip: number | null;
  /**
   * Fielding Independent Pitching, computed from real counting stats:
   *   FIP = (13*HR + 3*(BB+HBP) - 2*SO) / IP + 3.10
   * The 3.10 constant is the conventional league-average offset used in the
   * standard FIP formula (not a per-season fitted value); FIP is therefore
   * comparable across pitchers but not perfectly league-centred.
   */
  fip: number | null;
  /** Season innings pitched, in true innings (thirds converted: .1 = 1/3). */
  ip: number | null;
  starts: number;
  /** Average strikeouts per start, from the game log. null when unavailable. */
  avgK: number | null;
  /** Share of starts with 7+ strikeouts, from the game log. null when unavailable. */
  over6_5Rate: number | null;
  /** Where these numbers came from. */
  source: string;
  /** Season the stats were taken from. */
  season: number | null;
}

export interface TopPick {
  team: string;
  opponent: string;
  ml: number;
  /** @deprecated Use rawMarketProb. Raw implied probability from odds (vig included). */
  impliedProb: number;
  /**
   * RAW market probability (vig INCLUDED), from American odds alone:
   *   positive odds: 100 / (odds + 100)
   *   negative odds: |odds| / (|odds| + 100)
   * This is the sportsbook's own price. It is NOT fair value and is never
   * used for Edge.
   */
  rawMarketProb: number;
  /**
   * FAIR market probability (de-vigged): raw side / sum of both raw sides,
   * so the two sides sum to exactly 100%. This is what Edge is measured
   * against.
   */
  fairMarketProb: number;
  /** Model win probability, normalized so both sides sum to 100%. */
  modelProb: number;
  /** Model probability − FAIR market probability, in percentage points. */
  edge: number;
  /** (modelProb × decimalOdds) − 1 at the POSTED sportsbook price, as a percentage. */
  ev: number;
  /** Trust in the pick — data quality AND edge strength, never edge alone. */
  confidence: Confidence;
  /** How much of the model's required input data was actually available. */
  dataQuality: DataQuality;
  /** False when probability validation failed; the numbers must not be trusted. */
  valid: boolean;
  validationErrors: string[];
  reasons: string[];
}

/**
 * How trustworthy the underlying data for a prediction is.
 *
 * Derived from concrete availability checks (confirmed starters, sample
 * size, team records, R/G, bullpen ERA, K/9, probability validation) — not
 * from how big the edge happens to be.
 */
export type DataQuality = "HIGH" | "MEDIUM" | "LOW";

/**
 * How unusual a model-vs-market disagreement is. Used to prompt a manual
 * look — it never suppresses or caps the edge itself.
 */
export type EdgeFlag = "large" | "extreme";

export interface KProp {
  pitcher: string;
  team: string;
  opponent: string;
  k9: number | null;
  avgK: number | null;
  over6_5Rate: number | null;
  reasons: string[];
}

export interface TotalPick {
  away: string;
  home: string;
  overUnder: number;
  pick: "Over" | "Under";
  reasons: string[];
}

export interface Parlay {
  name: string;
  legs: string[];
  odds: number;
  bet: number;
  payout: number;
  profit: number;
}

/** Confidence grade for model edges. "A" = large edge + complete data. */
export type Confidence = "A" | "B" | "C" | "D";

/**
 * Model-vs-market edge for one team in one game.
 *
 * - modelProb: normalised logistic win-probability (both sides sum to 100%).
 * - fairMarketProb: de-vigged market implied probability (both sides sum to 100%).
 * - edge: modelProb − fairMarketProb (percentage points).
 * - ev: (modelProb × decimalOdds) − 1, as a percentage — uses actual sportsbook odds.
 */
export interface ModelEdge {
  team: string;
  abbrev: string;
  opponent: string;
  /** Game id — lets parlay builders avoid two legs from the same game. */
  gameId: string;
  ml: number;
  home: boolean;
  modelProb: number; // % (0–100), normalised across both sides
  /** Raw vig-included implied probability from the posted odds. */
  rawMarketProb: number; // % (0–100), includes vig
  /** De-vigged fair market probability. Edge is measured against THIS. */
  fairMarketProb: number; // % (0–100), de-vigged
  /** Model − FAIR market, in percentage points. */
  edge: number;
  /** (modelProb × decimalOdds) − 1 at the posted price, as a percentage. */
  ev: number;
  confidence: Confidence;
  /** Data-quality grade feeding `confidence`. */
  dataQuality: DataQuality;
  /** Quality checks passed / total, so the grade is auditable. */
  qualityScore: number;
  qualityMax: number;
  /** False when probability validation failed. */
  valid: boolean;
  validationErrors: string[];
  /** Non-null when the model disagrees unusually strongly with the market. */
  flag: EdgeFlag | null;
  reasons: string[];
  /** True if both pitchers are confirmed. False = TBD pitcher(s) present. */
  pitcherConfirmed: boolean;
}

export interface AnalysisResult {
  date: string;
  games: Game[];
  /** Model/market value: ranks by edge + EV + confidence + data quality. */
  edges: ModelEdge[];
  /** Strongest/highest-probability favorites — a separate concept from value. */
  topPicks: TopPick[];
  /** Strongest positive-EV opportunities at the posted prices. */
  bestValue: TopPick[];
  topKProps: KProp[];
  topTotals: TotalPick[];
  parlays: Parlay[];
}
