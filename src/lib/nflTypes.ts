export type NflGameStatus = "scheduled" | "live" | "final";

export interface NflPropCandidate {
  playerId: number;
  name: string;
  position: string; // QB | RB | WR | TE
  teamAbbrev: string;
  statsSeason: number; // season year the stats come from (fallback = prior season)
  gamesPlayed: number;
  passingYardsPerGame: number | null;
  passingTdsPerGame: number | null;
  rushingYardsPerGame: number | null;
  rushingTdsPerGame: number | null;
  receivingYardsPerGame: number | null;
  receivingTdsPerGame: number | null;
}

export interface NflGame {
  id: string;
  startTime: string; // ISO UTC
  status: NflGameStatus;
  awayTeam: string;
  homeTeam: string;
  awayAbbrev: string;
  homeAbbrev: string;
  awayRecord: string;
  homeRecord: string;
  // Odds (0/null when no odds posted — e.g. preseason)
  awayML: number;
  homeML: number;
  overUnder: number;
  details: string; // e.g. "CAR -1.5"
  awaySpread: number | null; // negative = away is favored
  homeSpread: number | null; // positive = home is underdog
  awayMLOpen: number | null;
  homeMLOpen: number | null;
  awaySpreadOpen: number | null;
  homeSpreadOpen: number | null;
  provider: string;
  // Team scoring context (points per game)
  awayPpg: number | null;
  homePpg: number | null;
  // Prop candidates for each side
  awayProps: NflPropCandidate[];
  homeProps: NflPropCandidate[];
}

export interface NflTopPick {
  team: string;
  opponent: string;
  ml: number;
  impliedProb: number;
  reasons: string[];
}

export interface NflAtsPick {
  team: string;
  opponent: string;
  line: string; // e.g. "CAR -1.5"
  spread: number; // signed line from the picked team's perspective
  reasons: string[];
}

export interface NflTotalPick {
  away: string;
  home: string;
  overUnder: number;
  pick: "Over" | "Under";
  reasons: string[];
}

export interface NflPropPick {
  player: string;
  position: string;
  team: string;
  opponent: string;
  market: string; // e.g. "Passing Yards"
  projectedLine: number;
  direction: "Over" | "Under";
  playerAvg: number | null;
  statsSeason: number;
  reasons: string[];
}

export interface NflParlay {
  name: string;
  legs: string[];
  odds: number;
  bet: number;
  payout: number;
  profit: number;
}

export interface NflAnalysisResult {
  date: string;
  week: number;
  weekLabel: string; // "Preseason Week 1" | "Week 3" | "Playoffs"
  seasonType: number; // 1 preseason, 2 regular, 3 postseason
  seasonYear: number;
  games: NflGame[];
  topPicks: NflTopPick[];
  topAts: NflAtsPick[];
  topTotals: NflTotalPick[];
  topProps: NflPropPick[];
  parlays: NflParlay[];
}
