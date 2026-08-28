import { NextResponse } from "next/server";
import { fetchCfbContext, fetchCfbScoreboard, fetchCfbTeamStats } from "@/lib/cfb";
import { analyzeCfbFavorites, analyzeCfbAts, analyzeCfbTotals, buildCfbParlays } from "@/lib/cfbAnalysis";
import type { CfbGame, CfbAnalysisResult } from "@/lib/cfbTypes";

export const revalidate = 300;

/** Cap on team-stat lookups per analysis run. */
const MAX_TEAM_STATS = 40;

export async function GET() {
  try {
    // 1. Resolve the current week + season from ESPN.
    const ctx = await fetchCfbContext();

    // 2. Fetch the full week's slate (odds are inline on the scoreboard).
    const rawGames = await fetchCfbScoreboard(ctx.week, ctx.seasonYear);

    // 3. Only keep games that have a spread (i.e. odds are posted).
    const gamesWithOdds = rawGames.filter(g => g.overUnder > 0 || g.awaySpread != null);

    // 4. Fetch team stats for scoring context (points per game).
    const teamIds = [
      ...new Set(gamesWithOdds.flatMap(g => [g.awayTeamId, g.homeTeamId])),
    ].slice(0, MAX_TEAM_STATS);

    const teamStatsResults = await Promise.all(
      teamIds.map(async id => ({ id, stats: await fetchCfbTeamStats(id, ctx.seasonYear) }))
    );
    const teamStatsMap = new Map(teamStatsResults.map(r => [r.id, r.stats]));

    // 5. Assemble CfbGame objects.
    const games: CfbGame[] = gamesWithOdds.map(raw => {
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
    });

    // 6. Run analysis (exclude final games).
    const analyzable = games.filter(g => g.status !== "final");
    const topPicks = analyzeCfbFavorites(analyzable);
    const topAts = analyzeCfbAts(analyzable);
    const topTotals = analyzeCfbTotals(analyzable);
    const parlays = buildCfbParlays(topPicks, topAts, topTotals);

    const result: CfbAnalysisResult = {
      date: new Date().toISOString().slice(0, 10),
      week: ctx.week,
      weekLabel: ctx.weekLabel,
      seasonType: ctx.seasonType,
      seasonYear: ctx.seasonYear,
      games,
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
