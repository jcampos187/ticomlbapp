import type { CfbWeekInfo } from "./cfbTypes";

const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";
const TEAM_STATS_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams";

// NOTE: Do NOT set a custom User-Agent header. ESPN's edge (Akamai)
// fingerprint-checks the UA and returns 403 for any custom value.
async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { next: { revalidate: 300 } });
  if (!resp.ok) throw new Error(`ESPN CFB API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ─── Week resolution ────────────────────────────────────────────────

/**
 * Figure out the current CFB week by matching today's date against the
 * season calendar's week entries. Falls back to week 1 if nothing matches
 * (e.g. off-season).
 */
function resolveCurrentWeek(data: any): CfbWeekInfo {
  const league = data.leagues?.[0];
  const seasonYear = data.season?.year ?? league?.season?.year ?? new Date().getFullYear();
  const seasonType = league?.season?.type?.type ?? data.season?.type ?? 2;
  const defaultWeek = data.week?.number ?? 1;

  // The calendar array has season types; find the active one.
  const calendar = league?.calendar || [];
  const now = new Date();

  for (const season of calendar) {
    const start = new Date(season.startDate);
    const end = new Date(season.endDate);
    if (now >= start && now <= end) {
      // Found the active season type — now find the specific week entry.
      for (const entry of season.entries || []) {
        const eStart = new Date(entry.startDate);
        const eEnd = new Date(entry.endDate);
        if (now >= eStart && now <= eEnd) {
          const weekNum = parseInt(entry.value, 10) || defaultWeek;
          const label = seasonType === 3
            ? entry.label  // "Bowls" / "CFP"
            : `Week ${weekNum}`;
          return { week: weekNum, weekLabel: label, seasonType, seasonYear };
        }
      }
      // Inside the season but between weeks — use the closest week.
      break;
    }
  }

  return {
    week: defaultWeek,
    weekLabel: seasonType === 3 ? "Postseason" : `Week ${defaultWeek}`,
    seasonType,
    seasonYear,
  };
}

// ─── Scoreboard (games + inline odds) ───────────────────────────────

export interface RawCfbGame {
  id: string;
  startTime: string;
  status: "scheduled" | "live" | "final";
  awayAbbrev: string;
  awayName: string;
  homeAbbrev: string;
  homeName: string;
  awayRecord: string;
  homeRecord: string;
  awayTeamId: number;
  homeTeamId: number;
  awayConference: string | null;
  homeConference: string | null;
  // Odds (inline from scoreboard)
  awayML: number;
  homeML: number;
  overUnder: number;
  details: string;
  awaySpread: number | null;
  homeSpread: number | null;
  awayMLOpen: number | null;
  homeMLOpen: number | null;
  awaySpreadOpen: number | null;
  homeSpreadOpen: number | null;
  provider: string;
}

function parseSpread(value: string | undefined | null): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

function parseAmericanOdds(obj: any): number | null {
  if (!obj) return null;
  // ESPN CFB puts odds as a string like "-110" or "OFF"
  const raw = obj.odds ?? obj.american ?? null;
  if (!raw || raw === "OFF") return null;
  const n = parseInt(String(raw), 10);
  return Number.isNaN(n) ? null : n;
}

export async function fetchCfbContext(): Promise<CfbWeekInfo> {
  const data = await fetchJson(SCOREBOARD_URL);
  return resolveCurrentWeek(data);
}

/**
 * Fetch the scoreboard for a specific week. ESPN defaults to the current
 * week when no params are given; we pass ?week=N explicitly.
 */
export async function fetchCfbScoreboard(week: number, seasonYear: number): Promise<RawCfbGame[]> {
  const data = await fetchJson(`${SCOREBOARD_URL}?week=${week}&seasontype=2&season=${seasonYear}`);
  const games: RawCfbGame[] = [];

  for (const event of data.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const competitors = comp.competitors || [];
    const away = competitors.find((c: any) => c.homeAway === "away");
    const home = competitors.find((c: any) => c.homeAway === "home");
    if (!away || !home) continue;

    const state = event.status?.type?.state || "";

    // Parse inline odds — ESPN embeds them directly on the competition
    const oddsArr = comp.odds || [];
    const odds = oddsArr[0] || {};

    // Spread
    const homeSpreadClose = odds.pointSpread?.home?.close?.line;
    const awaySpreadClose = odds.pointSpread?.away?.close?.line;
    const homeSpreadOpen = odds.pointSpread?.home?.open?.line;
    const awaySpreadOpen = odds.pointSpread?.away?.open?.line;

    // Moneyline — often "OFF" in CFB
    const mlHome = parseAmericanOdds(odds.moneyline?.home?.close);
    const mlAway = parseAmericanOdds(odds.moneyline?.away?.close);
    const mlHomeOpen = parseAmericanOdds(odds.moneyline?.home?.open);
    const mlAwayOpen = parseAmericanOdds(odds.moneyline?.away?.open);

    // Total
    const ou = odds.overUnder ?? 0;

    // Detail string like "USC -38.5"
    const details = odds.details || "";

    games.push({
      id: comp.id,
      startTime: event.date || "",
      status: state === "in" ? "live" : state === "post" ? "final" : "scheduled",
      awayAbbrev: away.team?.abbreviation || "",
      awayName: away.team?.shortDisplayName || away.team?.displayName || "",
      homeAbbrev: home.team?.abbreviation || "",
      homeName: home.team?.shortDisplayName || home.team?.displayName || "",
      awayRecord: away.records?.[0]?.summary || "",
      homeRecord: home.records?.[0]?.summary || "",
      awayTeamId: Number(away.team?.id),
      homeTeamId: Number(home.team?.id),
      awayConference: away.team?.conferenceId || null,
      homeConference: home.team?.conferenceId || null,
      awayML: mlAway ?? 0,
      homeML: mlHome ?? 0,
      overUnder: ou,
      details,
      awaySpread: parseSpread(awaySpreadClose),
      homeSpread: parseSpread(homeSpreadClose),
      awayMLOpen: mlAwayOpen,
      homeMLOpen: mlHomeOpen,
      awaySpreadOpen: parseSpread(awaySpreadOpen),
      homeSpreadOpen: parseSpread(homeSpreadOpen),
      provider: odds.provider?.name || "DraftKings",
    });
  }

  return games;
}

// ─── Team season stats (points per game for totals context) ─────────

export interface TeamSeasonStats {
  pointsPerGame: number | null;
}

export async function fetchCfbTeamStats(teamId: number, year: number): Promise<TeamSeasonStats | null> {
  try {
    const url = `${TEAM_STATS_BASE}/${teamId}/statistics?season=${year}`;
    const data = await fetchJson(url);
    const results = data?.results || {};
    const ownCats = results.stats?.categories || [];

    const find = (catName: string, statName: string): number | null => {
      const cat = ownCats.find((c: any) => c.name === catName);
      const stat = cat?.stats?.find((s: any) => s.name === statName);
      if (stat?.value == null) return null;
      const n = Number(stat.value);
      return Number.isNaN(n) ? null : n;
    };

    return { pointsPerGame: find("scoring", "totalPointsPerGame") };
  } catch {
    return null;
  }
}
