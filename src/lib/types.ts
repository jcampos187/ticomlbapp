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
  awayRunsPerGame: number | null;
  homeRunsPerGame: number | null;
  awayBullpenEra: number | null;
  homeBullpenEra: number | null;
  awayMLOpen: number | null;
  homeMLOpen: number | null;
  /** Whether both starting pitchers are confirmed (not TBD). */
  pitcherConfirmed?: boolean;
}

export interface TopPick {
  team: string;
  opponent: string;
  ml: number;
  /** Raw implied probability from odds (includes vig). Kept for backward compat. */
  impliedProb: number;
  /** De-vigged fair market probability (0–100). Sums to ~100% with the opposing side. */
  fairMarketProb: number;
  /** Model win probability, normalized so both sides sum to 100%. */
  modelProb: number;
  /** Edge = model probability − fair market probability (percentage points). */
  edge: number;
  /** Expected value = (modelProb × decimalOdds) − 1, as a percentage. */
  ev: number;
  reasons: string[];
}

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
  fairMarketProb: number; // % (0–100), de-vigged
  edge: number; // percentage points (model − fair market)
  ev: number; // expected value as percentage
  confidence: Confidence;
  reasons: string[];
  /** True if both pitchers are confirmed. False = TBD pitcher(s) present. */
  pitcherConfirmed: boolean;
}

export interface AnalysisResult {
  date: string;
  games: Game[];
  edges: ModelEdge[];
  topPicks: TopPick[];
  topKProps: KProp[];
  topTotals: TotalPick[];
  parlays: Parlay[];
}
