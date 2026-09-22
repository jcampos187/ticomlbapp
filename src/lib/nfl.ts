import { mapWithConcurrency } from "./concurrency";
import type { SrsGame } from "./srs";

const SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const CORE_BASE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
const ROSTER_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams";

// NOTE: Do NOT set a custom User-Agent header here. ESPN's edge (Akamai)
// fingerprint-checks the UA against the HTTP client and returns 403 for any
// custom value. The runtime's default UA is allowed. (Same rule as MLB.)
async function fetchJson(url: string, revalidate = 300): Promise<any> {
  const resp = await fetch(url, {
    next: { revalidate },
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

// ─── Season results (the opponent-adjustment graph) ─────────────────

/** First day of an NFL season sweep — Week 1 is early September. */
const NFL_SEASON_START = "09-01";

/** Cap on days swept. Bounds a malformed season year into known requests. */
const MAX_SEASON_DAYS = 200;

/** Concurrent season-scoreboard fetches. */
const SEASON_GRAPH_CONCURRENCY = 8;

/** Every day (YYYYMMDD) from start to end inclusive, capped at `maxDays`. */
function eachDay(start: string, end: string, maxDays: number): string[] {
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || last < first) return [];

  const days: string[] = [];
  for (const d = new Date(first); d <= last && days.length < maxDays; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return days;
}

/**
 * Every completed NFL game of the season, as the raw material for the
 * opponent-adjusted margin (see `computeOpponentAdjustedMargins`).
 *
 * The week query (`?week=N`) returns the slate but no scores, so like CFB this
 * sweeps one day at a time. Completed days are immutable and cached for a day,
 * so the sweep is paid once warm; unfinished games are skipped because a rating
 * built from future results would be look-ahead.
 */
export async function fetchNflSeasonResults(seasonYear: number): Promise<SrsGame[]> {
  const today = new Date().toISOString().slice(0, 10);
  const start = `${seasonYear}-${NFL_SEASON_START}`;
  const days = eachDay(start, today, MAX_SEASON_DAYS);
  if (days.length === 0) return [];

  const settled = await mapWithConcurrency(days, SEASON_GRAPH_CONCURRENCY, async day => {
    const isToday = day === today.replace(/-/g, "");
    try {
      const data = await fetchJson(
        `${SCOREBOARD_URL}?dates=${day}&seasontype=2&season=${seasonYear}`,
        isToday ? 300 : 86400,
      );
      return (data.events || []) as any[];
    } catch {
      // One unreadable day must not take the whole analysis down.
      return [];
    }
  });

  const games: SrsGame[] = [];
  for (const events of settled) {
    for (const event of events) {
      if (event.status?.type?.state !== "post") continue;
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const away = comp.competitors?.find((c: any) => c.homeAway === "away");
      const home = comp.competitors?.find((c: any) => c.homeAway === "home");
      if (!away || !home) continue;

      const awayTeamId = Number(away.team?.id);
      const homeTeamId = Number(home.team?.id);
      const awayScore = Number(away.score);
      const homeScore = Number(home.score);
      if (!Number.isFinite(awayTeamId) || !Number.isFinite(homeTeamId)) continue;
      if (!Number.isFinite(awayScore) || !Number.isFinite(homeScore)) continue;

      games.push({ homeTeamId, awayTeamId, homeScore, awayScore });
    }
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

/** Athlete ids that have actually produced for a team this season, by role. */
export interface NflTeamLeaders {
  qbs: number[];
  rbs: number[];
  receivers: number[];
}

/**
 * Identify which players have ACTUALLY produced for a team this season.
 *
 * The roster endpoint lists players alphabetically by name, not by depth
 * chart — Buffalo's offense group reads Josh Allen, Kyle Allen, then the
 * practice squad — so "the first quarterback on the roster" is as likely to be
 * a backup as the starter. Building prop candidates from roster order is what
 * left the props section completely empty: it fetched season stats for three
 * quarterbacks per team (usually backups with no stats) and never once looked
 * at a running back or a receiver.
 *
 * This endpoint reports who has accumulated yards and touchdowns, so
 * candidates can be chosen by production instead of by surname. Returns empty
 * lists (never throws) when ESPN has nothing — callers fall back to roster
 * order so a failure degrades rather than emptying the section.
 */
export async function fetchNflTeamLeaders(
  teamId: number,
  year: number,
  seasonType: number,
): Promise<NflTeamLeaders> {
  try {
    const url = `${CORE_BASE}/seasons/${year}/types/${seasonType}/teams/${teamId}/leaders`;
    const data = await fetchJson(url);
    const categories = data?.categories || [];

    const idsFor = (categoryName: string): number[] => {
      const cat = categories.find((c: any) => c.name === categoryName);
      return (cat?.leaders || [])
        .map((l: any) => Number(/\/athletes\/(\d+)/.exec(l?.athlete?.$ref || "")?.[1]))
        .filter((n: number) => Number.isFinite(n) && n > 0);
    };

    const uniq = (ids: number[]) => [...new Set(ids)];

    return {
      // Passing production identifies the QB who is actually playing.
      qbs: uniq([...idsFor("passingYards"), ...idsFor("passingTouchdowns")]),
      rbs: uniq([...idsFor("rushingYards"), ...idsFor("rushingTouchdowns")]),
      // Receiving production covers WR and TE alike.
      receivers: uniq([
        ...idsFor("receivingYards"),
        ...idsFor("receivingTouchdowns"),
        ...idsFor("receptions"),
      ]),
    };
  } catch {
    return { qbs: [], rbs: [], receivers: [] };
  }
}

/** How many players to consider per role when choosing prop candidates. */
export interface PropCandidateLimits {
  qbs: number;
  rbs: number;
  receivers: number;
}

/**
 * Choose which players get season-stat lookups, and therefore which can become
 * prop picks.
 *
 * Candidates come from the athletes the leaders endpoint says are producing,
 * by role. Roster order is deliberately NOT the primary source: it is
 * alphabetical, so taking the first players from it picked three quarterbacks
 * per team and never a running back or receiver, and most of those
 * quarterbacks were backups with no stats — which is why the props section was
 * empty. Roster order is only the fallback, so a missing leaders response
 * degrades coverage instead of emptying the section.
 */
export function selectPropCandidates(
  roster: SkillPlayer[],
  leaders: NflTeamLeaders | null,
  limits: PropCandidateLimits,
): SkillPlayer[] {
  const byId = new Map(roster.map(p => [p.id, p]));
  const chosen: SkillPlayer[] = [];
  const taken = new Set<number>();

  const take = (ids: number[] | undefined, positions: string[], limit: number) => {
    const fromLeaders = (ids ?? [])
      .map(id => byId.get(id))
      .filter((p): p is SkillPlayer =>
        !!p && !taken.has(p.id) && positions.includes(p.position),
      )
      .slice(0, limit);

    if (fromLeaders.length > 0) {
      for (const p of fromLeaders) {
        taken.add(p.id);
        chosen.push(p);
      }
      return;
    }

    // No usable leader ids for this role — the leaders call failed, or the team
    // has no production recorded there yet. Roster order is worse than
    // production but better than nothing, and it is never used to *supplement*
    // a role that leaders already answered (that would re-introduce the
    // alphabetical-backup picks this function exists to avoid).
    let n = 0;
    for (const p of roster) {
      if (n >= limit) break;
      if (taken.has(p.id) || !positions.includes(p.position)) continue;
      taken.add(p.id);
      chosen.push(p);
      n++;
    }
  };

  take(leaders?.qbs, ["QB"], limits.qbs);
  take(leaders?.rbs, ["RB"], limits.rbs);
  // Receiving production covers WR and TE alike.
  take(leaders?.receivers, ["WR", "TE"], limits.receivers);

  return chosen;
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
  /** Receptions per game (derived from `receptions` / gamesPlayed). */
  receptionsPerGame: number | null;
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
    const receptions = find("receiving", "receptions");

    return {
      gamesPlayed,
      passingYardsPerGame: find("passing", "netPassingYardsPerGame"),
      passingTds: passingTds != null && gamesPlayed > 0 ? passingTds / gamesPlayed : null,
      rushingYardsPerGame: find("rushing", "rushingYardsPerGame"),
      rushingTds: rushingTds != null && gamesPlayed > 0 ? rushingTds / gamesPlayed : null,
      receivingYardsPerGame: find("receiving", "receivingYardsPerGame"),
      receivingTds: receivingTds != null && gamesPlayed > 0 ? receivingTds / gamesPlayed : null,
      receptions,
      receptionsPerGame: receptions != null && gamesPlayed > 0 ? receptions / gamesPlayed : null,
    };
  } catch {
    return null;
  }
}

/**
 * How many games of prior-season evidence to fold into a thin current sample.
 * The prior behaves like this many observed games (empirical Bayes): with
 * PRIOR_SEASON_WEIGHT_GAMES games of history, a player with 1 game this season
 * keeps 1/7 of the weight on that game, so one 300-yard outburst can't define
 * a projection while a real breakout still moves it.
 */
export const PRIOR_SEASON_WEIGHT_GAMES = 6;

/**
 * Minimum games for the prior season to count as a prior at all. A 2-game
 * cameo last year is no steadier evidence than the 1 game we're trying to
 * stabilise, so below this the current sample is used unchanged.
 */
export const MIN_PRIOR_GAMES = 4;

/**
 * Blend a thin current-season sample with the prior season's per-game rates.
 *
 * Props were dark for the first weeks of the season (nobody had MIN_GAMES
 * games yet), and the alternative — projecting off one game — is what produced
 * `D'Andre Swift Rushing TDs Over 3.0`. Leaning on last season is the honest
 * middle: real per-game rates from a full season, weighted down by how little
 * this season says so far.
 *
 * `gamesPlayed` is deliberately left as the CURRENT season's count so the
 * projection still reports (and warns about) a thin sample.
 */
export function blendPlayerStats(
  current: PlayerSeasonStats,
  prior: PlayerSeasonStats | null
): { stats: PlayerSeasonStats; blended: boolean } {
  if (!prior || prior.gamesPlayed < MIN_PRIOR_GAMES || current.gamesPlayed <= 0) {
    return { stats: current, blended: false };
  }

  const weight = current.gamesPlayed + PRIOR_SEASON_WEIGHT_GAMES;
  const mix = (cur: number | null, pri: number | null): number | null => {
    if (cur == null) return pri;
    if (pri == null) return cur;
    return (cur * current.gamesPlayed + pri * PRIOR_SEASON_WEIGHT_GAMES) / weight;
  };

  return {
    blended: true,
    stats: {
      gamesPlayed: current.gamesPlayed,
      passingYardsPerGame: mix(current.passingYardsPerGame, prior.passingYardsPerGame),
      passingTds: mix(current.passingTds, prior.passingTds),
      rushingYardsPerGame: mix(current.rushingYardsPerGame, prior.rushingYardsPerGame),
      rushingTds: mix(current.rushingTds, prior.rushingTds),
      receivingYardsPerGame: mix(current.receivingYardsPerGame, prior.receivingYardsPerGame),
      receivingTds: mix(current.receivingTds, prior.receivingTds),
      // A season total isn't meaningfully blendable; the per-game rate is.
      receptions: current.receptions ?? prior.receptions,
      receptionsPerGame: mix(current.receptionsPerGame, prior.receptionsPerGame),
    },
  };
}

export interface TeamSeasonStats {
  /** Own points scored per game (for totals analysis). */
  pointsPerGame: number | null;
  /** What this team's defense allows — per game — via the site API's
   * `results.opponent` split (verified populated; the core API's
   * `defensive.yardsAllowed` is hardcoded 0). */
  passYdsAllowedPerGame: number | null;
  rushYdsAllowedPerGame: number | null;
  /** TDs the defense allows per game, by scoring type. */
  passTdsAllowedPerGame: number | null;
  rushTdsAllowedPerGame: number | null;
  recTdsAllowedPerGame: number | null;
  /** Receiving yards this defense allows per game (for WR/TE receiving props). */
  recYdsAllowedPerGame: number | null;
  /** Receptions this defense allows per game (for WR/TE/RB receptions props). */
  recRecsAllowedPerGame: number | null;
  /** Points this defense allows per game — the defensive half of scoring
   *  margin for the model edge (offense-only PPG can't see a defense). */
  pointsAllowedPerGame: number | null;
}

/**
 * Season team stats from the SITE API (`/teams/{id}/statistics`). The core
 * API's defensive category returns `yardsAllowed`/`pointsAllowed` as hardcoded
 * 0, but the site API exposes a `results.opponent` split with real per-game
 * opponent totals (what the team's defense allows) — the reliable defensive
 * context used for prop projections.
 */
export async function fetchNflTeamStats(
  teamId: number,
  year: number,
  _seasonType: number
): Promise<TeamSeasonStats | null> {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/statistics?season=${year}`;
    const data = await fetchJson(url);
    const results = data?.results || {};

    // Own stats: { categories: [...] }
    const ownCats = results.stats?.categories || [];
    const own = (catName: string, statName: string): number | null => {
      const cat = ownCats.find((c: any) => c.name === catName);
      const stat = cat?.stats?.find((s: any) => s.name === statName);
      if (stat?.value == null) return null;
      const n = Number(stat.value);
      return Number.isNaN(n) ? null : n;
    };

    // Opponent stats: [ { name, stats: [...] } ] — what opponents did
    // against this team (i.e. what this defense allows).
    const oppCats = results.opponent || [];
    const opp = (catName: string, statName: string): number | null => {
      const cat = oppCats.find((c: any) => c.name === catName);
      const stat = cat?.stats?.find((s: any) => s.name === statName);
      const v = stat?.perGameValue ?? stat?.value;
      if (v == null) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    };

    return {
      pointsPerGame: own("scoring", "totalPointsPerGame"),
      pointsAllowedPerGame: opp("scoring", "totalPointsPerGame"),
      passYdsAllowedPerGame: opp("passing", "netPassingYards"),
      rushYdsAllowedPerGame: opp("rushing", "rushingYards"),
      passTdsAllowedPerGame: opp("passing", "passingTouchdowns"),
      rushTdsAllowedPerGame: opp("rushing", "rushingTouchdowns"),
      recTdsAllowedPerGame: opp("receiving", "receivingTouchdowns"),
      recYdsAllowedPerGame: opp("receiving", "receivingYards"),
      recRecsAllowedPerGame: opp("receiving", "receptions"),
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
