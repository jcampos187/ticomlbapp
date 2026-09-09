export type CfbGameStatus = "scheduled" | "live" | "final";

export interface CfbGame {
  id: string;
  startTime: string; // ISO UTC
  status: CfbGameStatus;
  awayTeam: string;
  homeTeam: string;
  awayAbbrev: string;
  homeAbbrev: string;
  awayRecord: string;
  homeRecord: string;
  // Odds (spread + O/U are always present; ML is often OFF in CFB)
  awayML: number;
  homeML: number;
  overUnder: number;
  details: string; // e.g. "USC -38.5"
  awaySpread: number | null;
  homeSpread: number | null;
  awayMLOpen: number | null;
  homeMLOpen: number | null;
  awaySpreadOpen: number | null;
  homeSpreadOpen: number | null;
  provider: string;
  // Team scoring context
  awayPpg: number | null;
  homePpg: number | null;
  // Conference info
  awayConference: string | null;
  homeConference: string | null;
}

export interface CfbTopPick {
  team: string;
  opponent: string;
  ml: number;
  /** Raw implied probability from odds (includes vig). Kept for backward compat. */
  impliedProb: number;
  /** De-vigged fair market probability (0–100). */
  fairMarketProb: number;
  /** Model win probability, normalized so both sides sum to 100%. */
  modelProb: number;
  /** Edge = model probability − fair market probability (percentage points). */
  edge: number;
  /** Expected value = (modelProb × decimalOdds) − 1, as a percentage. */
  ev: number;
  reasons: string[];
}

export interface CfbAtsPick {
  team: string;
  opponent: string;
  line: string; // e.g. "USC -38.5"
  spread: number;
  reasons: string[];
}

export interface CfbTotalPick {
  away: string;
  home: string;
  overUnder: number;
  pick: "Over" | "Under";
  reasons: string[];
}

export interface CfbParlay {
  name: string;
  legs: string[];
  odds: number;
  bet: number;
  payout: number;
  profit: number;
}

/**
 * Model-vs-market edge for one team in one game (CFB flavor). The model
 * probability comes from a logistic win-probability model (win rate, PPG,
 * home field); the market probability is the raw implied probability of the
 * moneyline. Edge = model - market in percentage points. CFB moneylines are
 * often OFF, so edges only appear for games with a posted ML.
 */
export interface CfbModelEdge {
  team: string;
  abbrev: string;
  opponent: string;
  /** Game id — lets parlay builders avoid two legs from the same game. */
  gameId: string;
  ml: number;
  home: boolean;
  modelProb: number; // % (0-100), normalised
  fairMarketProb: number; // % (0-100), de-vigged
  edge: number; // percentage points (model − fair market)
  ev: number; // expected value as percentage
  confidence: "A" | "B" | "C" | "D";
  reasons: string[];
  pitcherConfirmed: boolean;
}

export interface CfbWeekInfo {
  week: number;
  weekLabel: string;
  seasonType: number; // 2 regular, 3 postseason
  seasonYear: number;
  /** Inclusive date range (YYYY-MM-DD) for the week — used to fetch the
   *  full slate via ESPN's `dates` param (the `week` param caps at 25 games). */
  weekStart?: string;
  weekEnd?: string;
}

export interface CfbAnalysisResult {
  date: string;
  week: number;
  weekLabel: string;
  seasonType: number;
  seasonYear: number;
  games: CfbGame[];
  edges: CfbModelEdge[];
  topPicks: CfbTopPick[];
  topAts: CfbAtsPick[];
  topTotals: CfbTotalPick[];
  parlays: CfbParlay[];
}
