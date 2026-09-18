import { fetchScoreboard, fetchGameOdds, TEAM_MAP } from "./espn";
import {
  fetchTodaysPitchers,
  matchGameToMlbSchedule,
  fetchPitcherStats,
  fetchTeamTrends,
} from "./mlb";
import type { Game } from "./types";

/**
 * Cap on starter stat lookups per run.
 *
 * A normal 15-game slate needs 30 starters, so this covers a full slate. It was
 * 16, which silently left the last ~7 games of every slate with no starter data
 * at all — the model fell back to league averages for both sides, so the games
 * with the least information produced the least trustworthy picks with no
 * indication that anything was missing. Lookups run concurrently, so raising
 * the cap raises request count more than wall-clock time.
 */
const MAX_PITCHER_IDS = 32;

/**
 * Fetch and assemble the day's MLB games with odds, probable pitchers, pitcher
 * metrics and team trends attached.
 *
 * This lives outside the API route so the route, the live validation test and
 * any future caller all build games through exactly the same code path —
 * nothing can silently diverge from what production actually runs.
 *
 * Only games that carry a moneyline are returned: everything downstream
 * (model, edge, EV) needs a market to compare against.
 */
export async function buildMlbGames(date: string): Promise<Game[]> {
  // 1. Scoreboard (games + records) and MLB schedule (probable pitchers).
  const [espnGames, mlbScheduleGames] = await Promise.all([
    fetchScoreboard(date),
    fetchTodaysPitchers(date),
  ]);

  // 2. Odds for each game.
  const allOdds = await Promise.all(espnGames.map((g) => fetchGameOdds(g.id)));

  // 3. Match ESPN games to MLB schedule games. `usedPks` ensures a doubleheader
  //    gives each game its own probable pitchers instead of the same pair.
  const games: Game[] = [];
  const pitcherIds: number[] = [];
  const usedPks = new Set<number>();

  for (let i = 0; i < espnGames.length; i++) {
    const eg = espnGames[i];
    const odds = allOdds[i];

    const mlbGame = matchGameToMlbSchedule(
      eg.awayAbbrev,
      eg.homeAbbrev,
      eg.startTime,
      mlbScheduleGames,
      usedPks,
    );

    const awayPitcherName = mlbGame?.away?.name ?? "";
    const homePitcherName = mlbGame?.home?.name ?? "";

    if (mlbGame?.away?.id) pitcherIds.push(mlbGame.away.id);
    if (mlbGame?.home?.id) pitcherIds.push(mlbGame.home.id);

    const pitcherConfirmed =
      !!awayPitcherName && awayPitcherName !== "TBD" &&
      !!homePitcherName && homePitcherName !== "TBD";

    games.push({
      id: eg.id,
      startTime: eg.startTime,
      status: eg.status,
      awayTeam: TEAM_MAP[eg.awayAbbrev] || eg.awayName,
      homeTeam: TEAM_MAP[eg.homeAbbrev] || eg.homeName,
      awayAbbrev: eg.awayAbbrev,
      homeAbbrev: eg.homeAbbrev,
      awayRecord: eg.awayRecord,
      homeRecord: eg.homeRecord,
      awayML: odds?.awayML ?? 0,
      homeML: odds?.homeML ?? 0,
      overUnder: odds?.overUnder ?? 0,
      awayPitcher: awayPitcherName,
      homePitcher: homePitcherName,
      awayPitcherRecord: "",
      homePitcherRecord: "",
      awayK9: null,
      homeK9: null,
      awayAvgK: null,
      homeAvgK: null,
      awayOver6_5: null,
      homeOver6_5: null,
      awayEra: null,
      homeEra: null,
      awayIp: null,
      homeIp: null,
      awayRunsPerGame: null,
      homeRunsPerGame: null,
      awayBullpenEra: null,
      homeBullpenEra: null,
      awayMLOpen: odds?.awayMLOpen ?? null,
      homeMLOpen: odds?.homeMLOpen ?? null,
      pitcherConfirmed,
      awayPitcherMetrics: null,
      homePitcherMetrics: null,
    });
  }

  // 4. Starter stats for the first N unique pitchers.
  const uniqueIds = [...new Set(pitcherIds)].slice(0, MAX_PITCHER_IDS);
  const statResults = await Promise.all(
    uniqueIds.map((id) => fetchPitcherStats(id).then((stats) => ({ id, stats }))),
  );
  const statMap = new Map(statResults.map((r) => [r.id, r.stats]));

  // Re-match (the first pass consumed `usedPks`) to attach stats to games.
  const usedPksForStats = new Set<number>();
  for (let i = 0; i < espnGames.length; i++) {
    const eg = espnGames[i];
    const game = games[i];
    const mlbGame = matchGameToMlbSchedule(
      eg.awayAbbrev,
      eg.homeAbbrev,
      eg.startTime,
      mlbScheduleGames,
      usedPksForStats,
    );

    const awayStats = mlbGame?.away?.id ? statMap.get(mlbGame.away.id) : undefined;
    const homeStats = mlbGame?.home?.id ? statMap.get(mlbGame.home.id) : undefined;

    if (awayStats) {
      game.awayK9 = awayStats.k9;
      game.awayAvgK = awayStats.avgK;
      game.awayOver6_5 = awayStats.over6_5Rate;
      game.awayEra = awayStats.era;
      game.awayIp = awayStats.ip;
      game.awayPitcherMetrics = awayStats;
    }
    if (homeStats) {
      game.homeK9 = homeStats.k9;
      game.homeAvgK = homeStats.avgK;
      game.homeOver6_5 = homeStats.over6_5Rate;
      game.homeEra = homeStats.era;
      game.homeIp = homeStats.ip;
      game.homePitcherMetrics = homeStats;
    }
  }

  // 5. Keep games with a market, then attach team trends (runs/game +
  //    bullpen ERA) for the totals analysis.
  const gamesWithOdds = games.filter((g) => g.awayML !== 0 || g.homeML !== 0);
  const teamNames = [...new Set(gamesWithOdds.flatMap((g) => [g.awayTeam, g.homeTeam]))];
  const trendResults = await Promise.all(
    teamNames.map((name) => fetchTeamTrends(name).then((trends) => ({ name, trends }))),
  );
  const teamTrendMap = new Map(trendResults.map((r) => [r.name, r.trends]));

  for (const game of gamesWithOdds) {
    const awayTrends = teamTrendMap.get(game.awayTeam);
    const homeTrends = teamTrendMap.get(game.homeTeam);
    if (awayTrends) {
      game.awayRunsPerGame = awayTrends.runsPerGame;
      game.awayBullpenEra = awayTrends.bullpenEra;
    }
    if (homeTrends) {
      game.homeRunsPerGame = homeTrends.runsPerGame;
      game.homeBullpenEra = homeTrends.bullpenEra;
    }
  }

  return gamesWithOdds;
}
