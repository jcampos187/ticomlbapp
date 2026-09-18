import { NextResponse } from "next/server";
import {
  fetchNflContext,
  fetchNflScoreboard,
  fetchNflGameOdds,
  fetchNflRoster,
  fetchNflTeamLeaders,
  fetchNflPlayerStats,
  fetchNflTeamStats,
  selectPropCandidates,
  nflWeekLabel,
} from "@/lib/nfl";
import { mapWithConcurrency } from "@/lib/concurrency";
import { analyzeNflFavorites, analyzeNflAts, analyzeNflTotals, analyzeNflProps, buildNflParlays, computeNflModelEdges } from "@/lib/nflAnalysis";
import type { NflGame, NflPropCandidate, NflAnalysisResult } from "@/lib/nflTypes";

// The slate is resolved from ESPN at request time, so the route must never be
// prerendered. Response caching is handled explicitly by the Cache-Control
// header below.
export const dynamic = "force-dynamic";
export const revalidate = 300;

const ESPN_CONCURRENCY = 8;

/**
 * Cap on player-stat lookups per analysis run.
 *
 * With one QB, one RB and two receivers per team, a full 32-team week needs
 * 128. The cap was 72, which truncated the week before it was covered.
 */
const MAX_PLAYER_STATS = 128;

/** Role quotas for prop candidates — see selectPropCandidates. */
const PROP_CANDIDATE_LIMITS = { qbs: 1, rbs: 1, receivers: 2 };

export async function GET() {
  try {
    // 1. Resolve the current week + season from ESPN.
    const ctx = await fetchNflContext();

    // 2. Fetch the full week's slate.
    const rawGames = await fetchNflScoreboard(ctx.week);

    // 3. Fetch odds for every game in the week (parallel).
    const oddsResults = await Promise.all(
      rawGames.map(g => fetchNflGameOdds(g.id))
    );

    // 4. Determine which games have odds — only those get analyzed. Also
    //    gather the unique team ids that need roster/team-stat lookups.
    const gamesWithOdds = rawGames
      .map((g, i) => ({ game: g, odds: oddsResults[i] }))
      .filter(({ odds }) => odds && (odds.awayML || odds.homeML));

    const teamIds = [
      ...new Set(
        gamesWithOdds.flatMap(({ game }) => [game.awayTeamId, game.homeTeamId])
      ),
    ];

    // Season whose stats feed the projections. During preseason the current
    // season has no games yet, so use the prior regular season.
    const statsSeason =
      ctx.seasonType === 1 ? ctx.seasonYear - 1 : ctx.seasonYear;

    // 5. Rosters (names + positions) and season leaders (who is actually
    //    producing) for every team in the week.
    const [rosterResults, leaderResults] = await Promise.all([
      mapWithConcurrency(teamIds, ESPN_CONCURRENCY, async id => ({
        id,
        players: await fetchNflRoster(id),
      })),
      mapWithConcurrency(teamIds, ESPN_CONCURRENCY, async id => ({
        id,
        leaders: await fetchNflTeamLeaders(id, statsSeason, 2),
      })),
    ]);
    const rosterMap = new Map(rosterResults.map(r => [r.id, r.players]));
    const leaderMap = new Map(leaderResults.map(r => [r.id, r.leaders]));

    // 6. Pick candidates by PRODUCTION (see selectPropCandidates — roster
    //    order is alphabetical and picked backups), under a global cap.
    const statTargets: { teamId: number; player: NflPropCandidate }[] = [];

    for (const id of teamIds) {
      const players = selectPropCandidates(
        rosterMap.get(id) || [],
        leaderMap.get(id) ?? null,
        PROP_CANDIDATE_LIMITS,
      );
      for (const p of players) {
        statTargets.push({
          teamId: id,
          player: { playerId: p.id, name: p.name, position: p.position, teamAbbrev: "", statsSeason: 0, gamesPlayed: 0, passingYardsPerGame: null, passingTdsPerGame: null, rushingYardsPerGame: null, rushingTdsPerGame: null, receivingYardsPerGame: null, receivingTdsPerGame: null, receptionsPerGame: null },
        });
      }
      if (statTargets.length >= MAX_PLAYER_STATS) break;
    }

    // 7. Season stats for the selected candidates only.
    const statsResults = await mapWithConcurrency(
      statTargets,
      ESPN_CONCURRENCY,
      async ({ teamId, player }) => ({
        teamId,
        player,
        stats: await fetchNflPlayerStats(player.playerId, statsSeason, 2),
      }),
    );

    // 8. Fetch team season stats for scoring context (points per game).
    const teamStatsResults = await mapWithConcurrency(
      teamIds,
      ESPN_CONCURRENCY,
      async id => ({ id, stats: await fetchNflTeamStats(id, statsSeason, 2) }),
    );
    const teamStatsMap = new Map(teamStatsResults.map(r => [r.id, r.stats]));

    // 9. Assemble NflGame objects.
    const games: NflGame[] = [];
    const teamAbbrevById = new Map<number, string>();

    for (const { game, odds } of gamesWithOdds) {
      teamAbbrevById.set(game.awayTeamId, game.awayAbbrev);
      teamAbbrevById.set(game.homeTeamId, game.homeAbbrev);
    }

    for (const { game, odds } of gamesWithOdds) {
      if (!odds) continue;

      const awayStats = teamStatsMap.get(game.awayTeamId);
      const homeStats = teamStatsMap.get(game.homeTeamId);

      const buildProps = (teamId: number, abbrev: string): NflPropCandidate[] => {
        return statTargets
          .filter(t => t.teamId === teamId)
          .map(({ player }) => {
            const stat = statsResults.find(
              r => r.player.playerId === player.playerId && r.teamId === teamId
            )?.stats;
            return {
              playerId: player.playerId,
              name: player.name,
              position: player.position,
              teamAbbrev: abbrev,
              statsSeason,
              gamesPlayed: stat?.gamesPlayed ?? 0,
              passingYardsPerGame: stat?.passingYardsPerGame ?? null,
              passingTdsPerGame: stat?.passingTds ?? null,
              rushingYardsPerGame: stat?.rushingYardsPerGame ?? null,
              rushingTdsPerGame: stat?.rushingTds ?? null,
              receivingYardsPerGame: stat?.receivingYardsPerGame ?? null,
              receivingTdsPerGame: stat?.receivingTds ?? null,
              receptionsPerGame: stat?.receptionsPerGame ?? null,
            };
          });
      };

      games.push({
        id: game.id,
        startTime: game.startTime,
        status: game.status,
        awayTeam: game.awayName,
        homeTeam: game.homeName,
        awayAbbrev: game.awayAbbrev,
        homeAbbrev: game.homeAbbrev,
        awayRecord: game.awayRecord,
        homeRecord: game.homeRecord,
        awayML: odds.awayML,
        homeML: odds.homeML,
        overUnder: odds.overUnder,
        details: odds.details,
        awaySpread: odds.awaySpread,
        homeSpread: odds.homeSpread,
        awayMLOpen: odds.awayMLOpen,
        homeMLOpen: odds.homeMLOpen,
        awaySpreadOpen: odds.awaySpreadOpen,
        homeSpreadOpen: odds.homeSpreadOpen,
        provider: odds.provider,
        awayPpg: awayStats?.pointsPerGame ?? null,
        homePpg: homeStats?.pointsPerGame ?? null,
        awayDefPassYds: awayStats?.passYdsAllowedPerGame ?? null,
        awayDefRushYds: awayStats?.rushYdsAllowedPerGame ?? null,
        awayDefPassTds: awayStats?.passTdsAllowedPerGame ?? null,
        awayDefRushTds: awayStats?.rushTdsAllowedPerGame ?? null,
        awayDefRecTds: awayStats?.recTdsAllowedPerGame ?? null,
        awayDefRecYds: awayStats?.recYdsAllowedPerGame ?? null,
        awayDefRecRecs: awayStats?.recRecsAllowedPerGame ?? null,
        homeDefPassYds: homeStats?.passYdsAllowedPerGame ?? null,
        homeDefRushYds: homeStats?.rushYdsAllowedPerGame ?? null,
        homeDefPassTds: homeStats?.passTdsAllowedPerGame ?? null,
        homeDefRushTds: homeStats?.rushTdsAllowedPerGame ?? null,
        homeDefRecTds: homeStats?.recTdsAllowedPerGame ?? null,
        homeDefRecYds: homeStats?.recYdsAllowedPerGame ?? null,
        homeDefRecRecs: homeStats?.recRecsAllowedPerGame ?? null,
        awayProps: buildProps(game.awayTeamId, game.awayAbbrev),
        homeProps: buildProps(game.homeTeamId, game.homeAbbrev),
      });
    }

    // 10. Run analysis (only games with odds, and exclude final games).
    const analyzable = games.filter(g => g.status !== "final");
    const edges = computeNflModelEdges(analyzable);
    const topPicks = analyzeNflFavorites(analyzable);
    const topAts = analyzeNflAts(analyzable);
    const topTotals = analyzeNflTotals(analyzable);
    const topProps = analyzeNflProps(analyzable);
    const parlays = buildNflParlays(edges, topAts, topTotals);

    const result: NflAnalysisResult = {
      date: new Date().toISOString().slice(0, 10),
      week: ctx.week,
      weekLabel: nflWeekLabel(ctx.seasonType, ctx.week),
      seasonType: ctx.seasonType,
      seasonYear: ctx.seasonYear,
      games,
      edges,
      topPicks,
      topAts,
      topTotals,
      topProps,
      parlays,
    };

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("NFL analysis error:", error);
    return NextResponse.json(
      { error: "Failed to run NFL analysis", message: String(error) },
      { status: 500 }
    );
  }
}
