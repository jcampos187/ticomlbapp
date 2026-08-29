import { TEAM_MAP } from "./espn";

const MLB_API = "https://statsapi.mlb.com/api/v1";
const USER_AGENT = "Mozilla/5.0 (compatible; MLBBot/1.0)";

// MLB schedule API team names are full names like "Washington Nationals".
// Reverse the ESPN abbreviation map so we can key pitchers by abbreviation:
// "washington nationals" -> WSH.
const TEAM_NAME_TO_ABBR: Record<string, string> = {};
for (const [abbr, name] of Object.entries(TEAM_MAP)) {
  // "ATH" is listed after "OAK" in TEAM_MAP, so Athletics resolves to ATH
  // (matching ESPN's scoreboard abbreviation).
  TEAM_NAME_TO_ABBR[name.toLowerCase()] = abbr;
}

function mlbTeamToAbbr(teamName: string | undefined): string {
  const lower = (teamName || "").toLowerCase();
  if (TEAM_NAME_TO_ABBR[lower]) return TEAM_NAME_TO_ABBR[lower];
  for (const [name, abbr] of Object.entries(TEAM_NAME_TO_ABBR)) {
    if (lower.endsWith(name)) return abbr;
  }
  return "";
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    next: { revalidate: 3600 },
  });
  if (!resp.ok) return null;
  return resp.json();
}

export interface PitcherInfo {
  name: string;
  id: number;
  team: string;
}

export interface TeamTrends {
  runsPerGame: number | null;
  bullpenEra: number | null;
}

// {mlb_full_name_lower: team_id} — cached after the first call
let TEAM_ID_CACHE: Record<string, number> | null = null;

async function fetchTeamIdMap(): Promise<Record<string, number>> {
  if (TEAM_ID_CACHE) return TEAM_ID_CACHE;
  const data = await fetchJson(`${MLB_API}/teams?sportId=1&season=2026`);
  const map: Record<string, number> = {};
  for (const t of data?.teams || []) {
    const full = (t.name || "").toLowerCase();
    if (full) map[full] = t.id;
  }
  TEAM_ID_CACHE = map;
  return map;
}

/** Resolve a short team name like 'White Sox' to an MLB team id. */
async function resolveTeamId(teamName: string): Promise<number | null> {
  const map = await fetchTeamIdMap();
  const target = teamName.trim().toLowerCase();
  if (!target) return null;
  if (map[target]) return map[target];
  for (const [full, id] of Object.entries(map)) {
    if (full.endsWith(target) && full !== target) return id;
  }
  return null;
}

/**
 * Fetch a team's offensive (runs per game) and bullpen (relief) ERA trends
 * from the MLB Stats API. Free, no key required.
 */
export async function fetchTeamTrends(teamName: string): Promise<TeamTrends> {
  const result: TeamTrends = { runsPerGame: null, bullpenEra: null };
  const teamId = await resolveTeamId(teamName);
  if (!teamId) return result;

  // Fetch hitting + bullpen in parallel for speed
  const [hitting, bullpen] = await Promise.all([
    fetchJson(
      `${MLB_API}/teams/${teamId}/stats?stats=season&group=hitting&season=2026&gameType=R`
    ),
    // Bullpen ERA: relief pitchers via statSplits + sitCodes=rp
    fetchJson(
      `${MLB_API}/teams/${teamId}/stats?stats=statSplits&group=pitching&season=2026&gameType=R&sportIds=1&sitCodes=rp`
    ),
  ]);

  const hitSplit = hitting?.stats?.[0]?.splits?.[0]?.stat;
  if (hitSplit?.runs && hitSplit?.gamesPlayed) {
    result.runsPerGame = Math.round((hitSplit.runs / hitSplit.gamesPlayed) * 100) / 100;
  }

  const bpSplit = bullpen?.stats?.[0]?.splits?.[0]?.stat;
  if (bpSplit?.era) {
    result.bullpenEra = parseFloat(bpSplit.era);
  }

  return result;
}

/**
 * Fetch today's MLB schedule and return pitcher info.
 *
 * Keys are `${gamePk}_${teamAbbrev}` so doubleheaders (two games between
 * the same teams) don't overwrite each other. Each entry also carries the
 * game's start time and team abbreviations so the caller can match them to
 * ESPN scoreboard games.
 */
export interface PitcherGame {
  gamePk: number;
  startTime: string; // ISO UTC from MLB schedule
  awayAbbrev: string;
  homeAbbrev: string;
  away: PitcherInfo | null;
  home: PitcherInfo | null;
}

export async function fetchTodaysPitchers(date: string): Promise<PitcherGame[]> {
  const url = `${MLB_API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher`;
  const data = await fetchJson(url);
  const games: PitcherGame[] = [];

  if (!data) return games;

  for (const dateGroup of data.dates || []) {
    for (const game of dateGroup.games || []) {
      const awayTeamData = game.teams?.away;
      const homeTeamData = game.teams?.home;
      const awayAbbrev = mlbTeamToAbbr(awayTeamData?.team?.name);
      const homeAbbrev = mlbTeamToAbbr(homeTeamData?.team?.name);

      const extractPitcher = (teamData: any): PitcherInfo | null => {
        const pitcher = teamData?.probablePitcher;
        const abbrev = mlbTeamToAbbr(teamData?.team?.name);
        if (pitcher?.id && pitcher?.fullName && abbrev) {
          return { name: pitcher.fullName, id: pitcher.id, team: abbrev };
        }
        return null;
      };

      games.push({
        gamePk: game.gamePk,
        startTime: game.gameDate || "",
        awayAbbrev,
        homeAbbrev,
        away: extractPitcher(awayTeamData),
        home: extractPitcher(homeTeamData),
      });
    }
  }

  return games;
}

/**
 * Match an ESPN game to an MLB schedule game by teams + closest start time.
 * Returns the matching PitcherGame or null if no match found.
 */
export function matchGameToMlbSchedule(
  espnAway: string,
  espnHome: string,
  espnStart: string,
  mlbGames: PitcherGame[],
  usedPks: Set<number>,
): PitcherGame | null {
  const espnTime = new Date(espnStart).getTime();
  let best: PitcherGame | null = null;
  let bestDiff = Infinity;

  for (const mg of mlbGames) {
    if (usedPks.has(mg.gamePk)) continue;
    // Match by team abbreviations (order matters: away vs home)
    if (mg.awayAbbrev !== espnAway || mg.homeAbbrev !== espnHome) continue;
    const diff = Math.abs(new Date(mg.startTime).getTime() - espnTime);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = mg;
    }
  }

  // Only accept matches within 3 hours (doubleheaders are ~3h apart)
  if (best && bestDiff <= 3 * 60 * 60 * 1000) {
    usedPks.add(best.gamePk);
    return best;
  }
  return null;
}

export async function fetchPitcherStats(playerId: number): Promise<{
  k9: number | null;
  era: number | null;
  whip: number | null;
  avgK: number | null;
  over6_5Rate: number | null;
  starts: number;
  gameLogs: number[];
}> {
  const result = {
    k9: null as number | null,
    era: null as number | null,
    whip: null as number | null,
    avgK: null as number | null,
    over6_5Rate: null as number | null,
    starts: 0,
    gameLogs: [] as number[],
  };

  for (const season of [2026, 2025]) {
    const url = `${MLB_API}/people/${playerId}/stats?stats=season&group=pitching&season=${season}&gameType=R`;
    const data = await fetchJson(url);
    if (data?.stats?.[0]?.splits?.[0]) {
      const s = data.stats[0].splits[0].stat;
      result.k9 = parseFloat(s.strikeoutsPer9Inn) || null;
      result.era = parseFloat(s.era) || null;
      result.whip = parseFloat(s.whip) || null;
      result.starts = parseInt(s.gamesStarted) || 0;
      break;
    }
  }

  for (const season of [2026, 2025]) {
    const url = `${MLB_API}/people/${playerId}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R`;
    const data = await fetchJson(url);
    const logs = data?.stats?.[0]?.splits || [];
    // NOTE: the gameLog endpoint uses "strikeOuts" (capital O), not
    // "strikeouts" like the season endpoint. Only count starts so relief
    // appearances don't skew per-start K metrics, and keep 0-K starts so
    // averages aren't inflated.
    const kCounts = logs
      .filter((l: any) => parseInt(l.stat?.gamesStarted) >= 1)
      .map((l: any) => parseInt(l.stat?.strikeOuts) || 0);

    if (kCounts.length > 0) {
      result.gameLogs = kCounts.slice(-10);
      result.avgK = kCounts.reduce((a: number, b: number) => a + b, 0) / kCounts.length;
      result.over6_5Rate = kCounts.filter((k: number) => k >= 7).length / kCounts.length;
      break;
    }
  }

  if (result.avgK === null && result.k9 !== null) {
    result.avgK = (result.k9 / 9) * 5.2;
  }

  return result;
}
