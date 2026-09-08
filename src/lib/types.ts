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
}

export interface TopPick {
  team: string;
  opponent: string;
  ml: number;
  impliedProb: number;
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

export type Confidence = "A" | "B" | "C" | "D";

/**
 * Model-vs-market edge for one team in one game. The model probability
 * comes from a logistic win-probability model (records, R/G, starter ERA /
 * K/9, bullpen ERA, home field); the market probability is the raw implied
 * probability of the moneyline. Edge = model - market in percentage points.
 */
export interface ModelEdge {
  team: string;
  abbrev: string;
  opponent: string;
  /** Game id — lets parlay builders avoid two legs from the same game. */
  gameId: string;
  ml: number;
  home: boolean;
  modelProb: number; // % (0-100)
  marketProb: number; // % (0-100)
  edge: number; // percentage points (model - market)
  confidence: Confidence;
  reasons: string[];
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
