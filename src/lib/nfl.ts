const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const CORE_BASE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const ROSTER_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams";

// NOTE: Do NOT set a custom User-Agent header here. ESPN's edge (Akamai)
// fingerprint-checks the UA against the HTTP client and returns 403 for any
// custom value. The runtime's default UA is allowed. (Same rule as MLB.)
async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    next: { revalidate: 300 },
  });
  if (!resp.ok) throw new Error(`ESPN NFL API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

/** Season/league metadata pulled from the default scoreboard response. */
export interface NflContext {
  week: number;
  seasonYear: number;
  seasonType: number; // 1 preseason, 2 regular, 3 postseason
}

export interface RawNflGame {
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
}

/**
 * Resolve the current NFL week + season from ESPN's default scoreboard
 * (which always reflects the current week).
 */
export async function fetchNflContext(): Promise<NflContext> {
  const data = await fetchJson(SCOREBOARD_URL);
  const league = data.leagues?.[0];
  return {
    week: data.week?.number ?? 1,
    seasonYear: data.season?.year ?? league?.season?.year ?? new Date().getFullYear(),
    seasonType: league?.season?.type?.type ?? data.season?.type ?? 1,
  };
}

/**
 * Fetch the full slate for a given week (verified: `?week=1` returns all 16
 * games). ESPN defaults the week param to the current season.
 */
export async function fetchNflScoreboard(week: number): Promise<RawNflGame[]> {
  const data = await fetchJson(`${SCOREBOARD_URL}?week=${week}`);
  const games: RawNflGame[] = [];

  for (const event of data.events || []) {
    const comp = event.competitions?.[0];
    if (!comp) continue;

    const competitors = comp.competitors || [];
    const away = competitors.find((c: any) => c.homeAway === "away");
    const home = competitors.find((c: any) => c.homeAway === "home");
    if (!away || !home) continue;

    const state = event.status?.type?.state || "";

    games.push({
      id: comp.id,
      startTime: event.date || "",
      status: state === "in" ? "live" : state === "post" ? "final" : "scheduled",
      awayAbbrev: away.team.abbreviation,
      awayName: away.team.shortDisplayName || away.team.displayName,
      homeAbbrev: home.team.abbreviation,
      homeName: home.team.shortDisplayName || home.team.displayName,
      awayRecord: away.records?.[0]?.summary || "",
      homeRecord: home.records?.[0]?.summary || "",
      awayTeamId: Number(away.team.id),
      homeTeamId: Number(home.team.id),
    });
  }

  return games;
}

/** Parse an American line from ESPN's { american, ... } objects. */
function parseAmericanLine(line: any): number | null {
  if (!line) return null;
  const raw = line.american ?? line.alternateDisplayValue ?? null;
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

/** Parse a point-spread string like "-1.5" / "+3.5" into a float. */
function parseSpread(value: string | undefined | null): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

export interface NflOdds {
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

/** Fetch DraftKings odds for a single game (ML, spread, O/U + movement). */
export async function fetchNflGameOdds(eventId: string): Promise<NflOdds | null> {
  try {
    const url = `${CORE_BASE}/events/${eventId}/competitions/${eventId}/odds`;
    const data = await fetchJson(url);
    const item = data.items?.[0];
    if (!item) return null;

    const away = item.awayTeamOdds || {};
    const home = item.homeTeamOdds || {};

    return {
      awayML: away.moneyLine ?? 0,
      homeML: home.moneyLine ?? 0,
      overUnder: item.overUnder ?? 0,
      details: item.details || "",
      // current pointSpread is the side's signed line (negative = favorite)
      awaySpread: parseSpread(
        away.current?.pointSpread?.american ?? away.close?.pointSpread?.american ?? away.open?.pointSpread?.american
      ),
      homeSpread: parseSpread(
        home.current?.pointSpread?.american ?? home.close?.pointSpread?.american ?? home.open?.pointSpread?.american
      ),
      awayMLOpen: parseAmericanLine(away.open?.moneyLine),
      homeMLOpen: parseAmericanLine(home.open?.moneyLine),
      awaySpreadOpen: parseSpread(away.open?.pointSpread?.american),
      homeSpreadOpen: parseSpread(home.open?.pointSpread?.american),
      provider: item.provider?.name || "DraftKings",
    };
  } catch {
    return null;
  }
}

export interface SkillPlayer {
  id: number;
  name: string;
  position: string; // QB | RB | WR | TE
}

/** Fetch a team's skill-position players (QB/RB/WR/TE) from its roster. */
export async function fetchNflRoster(teamId: number): Promise<SkillPlayer[]> {
  try {
    const data = await fetchJson(`${ROSTER_URL}/${teamId}/roster`);
    const players: SkillPlayer[] = [];
    const wanted = new Set(["QB", "RB", "WR", "TE"]);

    for (const group of data.athletes || []) {
      for (const item of group.items || []) {
        const pos = item.position?.abbreviation;
        if (wanted.has(pos)) {
          players.push({
            id: Number(item.id),
            name: item.displayName || item.fullName,
            position: pos,
          });
        }
      }
    }
    return players;
  } catch {
    return [];
  }
}

export interface PlayerSeasonStats {
  gamesPlayed: number;
  passingYardsPerGame: number | null;
  passingTds: number | null;
  rushingYardsPerGame: number | null;
  rushingTds: number | null;
  receivingYardsPerGame: number | null;
  receivingTds: number | null;
  receptions: number | null;
}

/**
 * Season player stats from the season-scoped core endpoint. NOTE: the unscoped
 * `/athletes/{id}/statistics` path returns CAREER totals — always use
 * `seasons/{year}/types/{type}` for current-season numbers.
 */
export async function fetchNflPlayerStats(
  athleteId: number,
  year: number,
  seasonType: number
): Promise<PlayerSeasonStats | null> {
  try {
    const url = `${CORE_BASE}/seasons/${year}/types/${seasonType}/athletes/${athleteId}/statistics`;
    const data = await fetchJson(url);
    const categories = data.splits?.categories || [];

    const find = (catName: string, statName: string): number | null => {
      const cat = categories.find((c: any) => c.name === catName);
      const stat = cat?.stats?.find((s: any) => s.name === statName);
      if (stat?.value == null) return null;
      const n = Number(stat.value);
      return Number.isNaN(n) ? null : n;
    };

    const gamesPlayed = find("general", "gamesPlayed") ?? 0;
    const passingTds = find("passing", "passingTouchdowns");
    const rushingTds = find("rushing", "rushingTouchdowns");
    const receivingTds = find("receiving", "receivingTouchdowns");

    return {
      gamesPlayed,
      passingYardsPerGame: find("passing", "netPassingYardsPerGame"),
      passingTds: passingTds != null && gamesPlayed > 0 ? passingTds / gamesPlayed : null,
      rushingYardsPerGame: find("rushing", "rushingYardsPerGame"),
      rushingTds: rushingTds != null && gamesPlayed > 0 ? rushingTds / gamesPlayed : null,
      receivingYardsPerGame: find("receiving", "receivingYardsPerGame"),
      receivingTds: receivingTds != null && gamesPlayed > 0 ? receivingTds / gamesPlayed : null,
      receptions: find("receiving", "receptions"),
    };
  } catch {
    return null;
  }
}

export interface TeamSeasonStats {
  pointsPerGame: number | null;
  passingYardsPerGame: number | null;
  rushingYardsPerGame: number | null;
  receivingYardsPerGame: number | null;
  yardsAllowed: number | null;
  pointsAllowed: number | null;
}

/** Season team stats. Defensive yards/points allowed are unreliable on ESPN's
 * team endpoint (return 0), so callers should treat those as best-effort. */
export async function fetchNflTeamStats(
  teamId: number,
  year: number,
  seasonType: number
): Promise<TeamSeasonStats | null> {
  try {
    const url = `${CORE_BASE}/seasons/${year}/types/${seasonType}/teams/${teamId}/statistics`;
    const data = await fetchJson(url);
    const categories = data.splits?.categories || [];

    const find = (catName: string, statName: string): number | null => {
      const cat = categories.find((c: any) => c.name === catName);
      const stat = cat?.stats?.find((s: any) => s.name === statName);
      if (stat?.value == null) return null;
      const n = Number(stat.value);
      return Number.isNaN(n) ? null : n;
    };

    return {
      pointsPerGame: find("scoring", "totalPointsPerGame"),
      passingYardsPerGame: find("passing", "netPassingYardsPerGame"),
      rushingYardsPerGame: find("rushing", "rushingYardsPerGame"),
      receivingYardsPerGame: find("receiving", "receivingYardsPerGame"),
      yardsAllowed: find("defensive", "yardsAllowed"),
      pointsAllowed: find("defensive", "pointsAllowed"),
    };
  } catch {
    return null;
  }
}

/** Human label for the week, e.g. "Preseason Week 1" / "Week 3" / "Playoffs". */
export function nflWeekLabel(seasonType: number, week: number): string {
  if (seasonType === 1) return `Preseason Week ${week}`;
  if (seasonType === 3) return week > 1 ? `Playoffs — Round ${week - 1}` : "Playoffs — Wild Card";
  return `Week ${week}`;
}
