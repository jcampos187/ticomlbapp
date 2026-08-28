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
  impliedProb: number;
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

export interface CfbWeekInfo {
  week: number;
  weekLabel: string;
  seasonType: number; // 2 regular, 3 postseason
  seasonYear: number;
}

export interface CfbAnalysisResult {
  date: string;
  week: number;
  weekLabel: string;
  seasonType: number;
  seasonYear: number;
  games: CfbGame[];
  topPicks: CfbTopPick[];
  topAts: CfbAtsPick[];
  topTotals: CfbTotalPick[];
  parlays: CfbParlay[];
}
