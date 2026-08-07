import { NextResponse } from "next/server";
import {
  fetchNflContext,
  fetchNflScoreboard,
  fetchNflGameOdds,
  fetchNflRoster,
  fetchNflPlayerStats,
  fetchNflTeamStats,
  nflWeekLabel,
} from "@/lib/nfl";
import { analyzeNflFavorites, analyzeNflAts, analyzeNflTotals, analyzeNflProps, buildNflParlays } from "@/lib/nflAnalysis";
import type { NflGame, NflPropCandidate, NflAnalysisResult } from "@/lib/nflTypes";

export const revalidate = 300;

/** Cap on player-stat lookups per analysis run (mirrors MLB's 16-pitcher cap). */
const MAX_PLAYER_STATS = 72;
/** Skill players to consider per team (QB first, then RB, then WR/TE). */
const PLAYERS_PER_TEAM = 3;

export async function GET(request: Request) {
  try {
    // Reading the request URL keeps this route dynamic (server-rendered on
    // demand like the MLB route) rather than statically prerendered at build
    // time, so the weekly slate is always fresh on first load.
    new URL(request.url);

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

    // 5. Fetch rosters (skill players) for each team, in parallel.
    const rosterResults = await Promise.all(
      teamIds.map(async id => ({ id, players: await fetchNflRoster(id) }))
    );
    const rosterMap = new Map(rosterResults.map(r => [r.id, r.players]));

    // 6. Pick a capped set of players to fetch stats for (QB > RB > WR/TE,
    //    max PLAYERS_PER_TEAM per team, global cap MAX_PLAYER_STATS).
    const rank = (pos: string) => (pos === "QB" ? 0 : pos === "RB" ? 1 : pos === "WR" ? 2 : 3);
    const statTargets: { teamId: number; player: NflPropCandidate }[] = [];

    for (const id of teamIds) {
      const players = (rosterMap.get(id) || [])
        .sort((a, b) => rank(a.position) - rank(b.position))
        .slice(0, PLAYERS_PER_TEAM);
      for (const p of players) {
        statTargets.push({
          teamId: id,
          player: { playerId: p.id, name: p.name, position: p.position, teamAbbrev: "", statsSeason: 0, gamesPlayed: 0, passingYardsPerGame: null, passingTdsPerGame: null, rushingYardsPerGame: null, rushingTdsPerGame: null, receivingYardsPerGame: null, receivingTdsPerGame: null },
        });
      }
      if (statTargets.length >= MAX_PLAYER_STATS) break;
    }

    // 7. Fetch season stats. During preseason use the prior regular season;
    //    during regular/postseason use the current season.
    const statsSeason =
      ctx.seasonType === 1 ? ctx.seasonYear - 1 : ctx.seasonYear;

    const statsResults = await Promise.all(
      statTargets.map(async ({ teamId, player }) => ({
        teamId,
        player,
        stats: await fetchNflPlayerStats(player.playerId, statsSeason, 2),
      }))
    );

    // 8. Fetch team season stats for scoring context (points per game).
    const teamStatsResults = await Promise.all(
      teamIds.map(async id => ({ id, stats: await fetchNflTeamStats(id, statsSeason, 2) }))
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
        homeDefPassYds: homeStats?.passYdsAllowedPerGame ?? null,
        homeDefRushYds: homeStats?.rushYdsAllowedPerGame ?? null,
        homeDefPassTds: homeStats?.passTdsAllowedPerGame ?? null,
        homeDefRushTds: homeStats?.rushTdsAllowedPerGame ?? null,
        homeDefRecTds: homeStats?.recTdsAllowedPerGame ?? null,
        homeDefRecYds: homeStats?.recYdsAllowedPerGame ?? null,
        awayProps: buildProps(game.awayTeamId, game.awayAbbrev),
        homeProps: buildProps(game.homeTeamId, game.homeAbbrev),
      });
    }

    // 10. Run analysis (only games with odds, and exclude final games).
    const analyzable = games.filter(g => g.status !== "final");
    const topPicks = analyzeNflFavorites(analyzable);
    const topAts = analyzeNflAts(analyzable);
    const topTotals = analyzeNflTotals(analyzable);
    const topProps = analyzeNflProps(analyzable);
    const parlays = buildNflParlays(topPicks, topAts, topTotals);

    const result: NflAnalysisResult = {
      date: new Date().toISOString().slice(0, 10),
      week: ctx.week,
      weekLabel: nflWeekLabel(ctx.seasonType, ctx.week),
      seasonType: ctx.seasonType,
      seasonYear: ctx.seasonYear,
      games,
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
