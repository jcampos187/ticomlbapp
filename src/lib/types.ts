export interface Game {
  id: string;
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

export interface AnalysisResult {
  date: string;
  games: Game[];
  topPicks: TopPick[];
  topKProps: KProp[];
  topTotals: TotalPick[];
  parlays: Parlay[];
}
