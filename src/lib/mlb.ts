import { TEAM_MAP } from "./espn";
import type { PitcherMetrics } from "./types";

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

/** Parse a numeric API field, returning null instead of NaN/0-for-missing. */
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse MLB's `inningsPitched`, which uses baseball notation where the
 * fractional digit is thirds: "123.1" = 123 1/3 innings, "123.2" = 123 2/3.
 *
 * `parseFloat("123.1")` would silently return 123.1, understating IP by up to
 * 0.2 innings. That matters here because IP is the sample-size weight for the
 * empirical-Bayes ERA/K9 shrinkage and the denominator of FIP.
 */
export function parseInningsPitched(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(\d+)(?:\.([0-2]))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const third = m[2] ? Number(m[2]) : 0;
  return whole + third / 3;
}

/** Conventional FIP offset (league-average ERA constant in the standard formula). */
const FIP_CONSTANT = 3.1;

/** Per-nine rate from a counting stat, or null when it can't be computed. */
function per9(count: number | null, ip: number | null): number | null {
  if (count == null || ip == null || ip <= 0) return null;
  return (count / ip) * 9;
}

/**
 * Fetch a starter's season metrics (plus game log) from the MLB Stats API.
 *
 * Everything returned is either a real published value, computed from real
 * counting stats, or null. Nothing is estimated: when a pitcher has no game
 * log there is no per-start strikeout average, and we report null rather
 * than inventing one.
 */
export async function fetchPitcherStats(
  playerId: number,
): Promise<PitcherMetrics & { gameLogs: number[] }> {
  const result: PitcherMetrics & { gameLogs: number[] } = {
    era: null,
    k9: null,
    bb9: null,
    hr9: null,
    whip: null,
    fip: null,
    ip: null,
    starts: 0,
    avgK: null,
    over6_5Rate: null,
    source: "MLB Stats API (season splits + game log)",
    season: null,
    gameLogs: [],
  };

  for (const season of [2026, 2025]) {
    const url = `${MLB_API}/people/${playerId}/stats?stats=season&group=pitching&season=${season}&gameType=R`;
    const data = await fetchJson(url);
    const s = data?.stats?.[0]?.splits?.[0]?.stat;
    if (!s) continue;

    const ip = parseInningsPitched(s.inningsPitched);
    const hr = numOrNull(s.homeRuns);
    const bb = numOrNull(s.baseOnBalls);
    const hbp = numOrNull(s.hitByPitch);
    const so = numOrNull(s.strikeOuts);

    result.season = season;
    result.k9 = numOrNull(s.strikeoutsPer9Inn);
    result.era = numOrNull(s.era);
    result.whip = numOrNull(s.whip);
    result.starts = parseInt(s.gamesStarted) || 0;
    result.ip = ip;
    result.bb9 = numOrNull(s.walksPer9Inn) ?? per9(bb, ip);
    result.hr9 = numOrNull(s.homeRunsPer9) ?? per9(hr, ip);

    // FIP from real counting stats only: (13*HR + 3*(BB+HBP) - 2*SO)/IP + C
    result.fip =
      ip != null && ip > 0 && hr != null && bb != null && so != null
        ? (13 * hr + 3 * (bb + (hbp ?? 0)) - 2 * so) / ip + FIP_CONSTANT
        : null;
    break;
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

  // NOTE: there used to be a fabricated fallback here — avgK = (k9/9)*5.2 —
  // for pitchers with no game log. That presented an invented per-start
  // average as if it were measured, so it has been removed. No game log
  // means avgK stays null and the UI shows nothing for K/Start.

  return result;
}
