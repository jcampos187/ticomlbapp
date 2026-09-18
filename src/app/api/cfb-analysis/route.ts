import { NextResponse } from "next/server";
import { fetchCfbContext, fetchCfbScoreboard, fetchCfbTeamStats } from "@/lib/cfb";
import { analyzeCfbFavorites, analyzeCfbAts, analyzeCfbTotals, buildCfbParlays, computeCfbModelEdges } from "@/lib/cfbAnalysis";
import type { CfbGame, CfbAnalysisResult } from "@/lib/cfbTypes";

export const revalidate = 300;

/**
 * Cap on team-stat lookups per analysis run.
 *
 * A full CFB week is ~75 games, so ~150 teams need a scoring lookup. The cap
 * was 40, which left only 20 games with BOTH teams' PPG — every other game fell
 * back to the league average and, under the edge gate, produced nothing at all.
 */
const MAX_TEAM_STATS = 160;

/** Max ESPN requests in flight at once — this week needs ~150 lookups. */
const TEAM_STATS_CONCURRENCY = 8;

/**
 * Map over items with at most `limit` promises in flight.
 *
 * ESPN's edge throttles bursts, and a blanket Promise.all over ~150 lookups
 * fires them all at once; the failures would be swallowed by the per-team
 * catch and silently reappear as missing PPG.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function GET(request: Request) {
  try {
    // Reading the request URL keeps this route dynamic (server-rendered on
    // demand, like the MLB and NFL routes) instead of prerendering it at build
    // time. A build-time prerender bakes in whichever week was current when the
    // build ran, and turns a failed upstream fetch into a cached static 500.
    new URL(request.url);

    // 1. Resolve the current week + season from ESPN.
    const ctx = await fetchCfbContext();

    // 2. Fetch the full week's slate (odds are inline on the scoreboard).
    //    ESPN's `week` param caps at 25 games, so we query by date range.
    const rawGames = await fetchCfbScoreboard(ctx.week, ctx.seasonYear, ctx.weekStart, ctx.weekEnd);

    // 3. Analysis needs odds; the schedule below shows every game.
    const gamesWithOdds = rawGames.filter(g => g.overUnder > 0 || g.awaySpread != null);

    // 4. Fetch team stats for scoring context (points per game).
    const teamIds = [
      ...new Set(gamesWithOdds.flatMap(g => [g.awayTeamId, g.homeTeamId])),
    ].slice(0, MAX_TEAM_STATS);

    const teamStatsResults = await mapWithConcurrency(
      teamIds,
      TEAM_STATS_CONCURRENCY,
      async id => ({ id, stats: await fetchCfbTeamStats(id, ctx.seasonYear) }),
    );
    const teamStatsMap = new Map(teamStatsResults.map(r => [r.id, r.stats]));

    // 5. Assemble CfbGame objects.
    const buildGame = (raw: (typeof rawGames)[number]): CfbGame => {
      const awayStats = teamStatsMap.get(raw.awayTeamId);
      const homeStats = teamStatsMap.get(raw.homeTeamId);

      return {
        id: raw.id,
        startTime: raw.startTime,
        status: raw.status,
        awayTeam: raw.awayName,
        homeTeam: raw.homeName,
        awayAbbrev: raw.awayAbbrev,
        homeAbbrev: raw.homeAbbrev,
        awayRecord: raw.awayRecord,
        homeRecord: raw.homeRecord,
        awayML: raw.awayML,
        homeML: raw.homeML,
        overUnder: raw.overUnder,
        details: raw.details,
        awaySpread: raw.awaySpread,
        homeSpread: raw.homeSpread,
        awayMLOpen: raw.awayMLOpen,
        homeMLOpen: raw.homeMLOpen,
        awaySpreadOpen: raw.awaySpreadOpen,
        homeSpreadOpen: raw.homeSpreadOpen,
        provider: raw.provider,
        awayPpg: awayStats?.pointsPerGame ?? null,
        homePpg: homeStats?.pointsPerGame ?? null,
        awayConference: raw.awayConference,
        homeConference: raw.homeConference,
      };
    };

    // 6. Show every game in the schedule (incl. games ESPN has no odds for);
    //    picks are computed only from games with odds, excluding finals.
    const games: CfbGame[] = rawGames.map(buildGame);
    const analyzable = gamesWithOdds.map(buildGame).filter(g => g.status !== "final");
    const edges = computeCfbModelEdges(analyzable);
    const topPicks = analyzeCfbFavorites(analyzable);
    const topAts = analyzeCfbAts(analyzable);
    const topTotals = analyzeCfbTotals(analyzable);
    const parlays = buildCfbParlays(edges, topAts, topTotals);

    const result: CfbAnalysisResult = {
      date: new Date().toISOString().slice(0, 10),
      week: ctx.week,
      weekLabel: ctx.weekLabel,
      seasonType: ctx.seasonType,
      seasonYear: ctx.seasonYear,
      games,
      edges,
      topPicks,
      topAts,
      topTotals,
      parlays,
    };

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("CFB analysis error:", error);
    return NextResponse.json(
      { error: "Failed to run CFB analysis", message: String(error) },
      { status: 500 }
    );
  }
}
