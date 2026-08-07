import { NextResponse } from "next/server";
import { fetchScoreboard, fetchGameOdds, TEAM_MAP } from "@/lib/espn";
import { fetchTodaysPitchers, fetchPitcherStats, fetchTeamTrends } from "@/lib/mlb";
import { analyzeFavorites, analyzeKProps, analyzeTotals, buildParlays } from "@/lib/analysis";
import type { Game, AnalysisResult } from "@/lib/types";

export const revalidate = 300;

/** Server-local YYYY-MM-DD (MLB games are scheduled on US dates, so UTC could be off by a day in the evening). */
function localDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;
  // Reject impossible dates like 2026-02-31 that JS silently rolls over to
  // March 3 when parsing.
  return (
    d.getUTCFullYear() === Number(s.slice(0, 4)) &&
    d.getUTCMonth() + 1 === Number(s.slice(5, 7)) &&
    d.getUTCDate() === Number(s.slice(8, 10))
  );
}

export async function GET(request: Request) {
  try {
    // Prefer the date computed in the caller's own timezone (the web app
    // passes its local date). This also keys the response cache per-date, so
    // a stale response from yesterday can never be served for today. Falls
    // back to the server's local date for direct API calls.
    const requested = new URL(request.url).searchParams.get("date");
    const today = requested && isValidDate(requested) ? requested : localDate();

    // 1. Fetch scoreboard (games + basic info) + MLB schedule (pitchers)
    const [espnGames, teamPitchers] = await Promise.all([
      fetchScoreboard(today),
      fetchTodaysPitchers(today),
    ]);

    // 2. Fetch odds for each game
    const oddsPromises = espnGames.map(g => fetchGameOdds(g.id));
    const allOdds = await Promise.all(oddsPromises);

    // 3. Build game objects with odds + pitcher info (keyed by team abbreviation)
    const games: Game[] = [];
    const pitcherIds: number[] = [];

    for (let i = 0; i < espnGames.length; i++) {
      const eg = espnGames[i];
      const odds = allOdds[i];

      // Look up pitchers by team abbreviation from MLB schedule API
      const awayPitcher = teamPitchers[eg.awayAbbrev];
      const homePitcher = teamPitchers[eg.homeAbbrev];

      const awayPitcherName = awayPitcher?.name ?? "";
      const homePitcherName = homePitcher?.name ?? "";

      if (awayPitcher?.id) pitcherIds.push(awayPitcher.id);
      if (homePitcher?.id) pitcherIds.push(homePitcher.id);

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
        awayRunsPerGame: null,
        homeRunsPerGame: null,
        awayBullpenEra: null,
        homeBullpenEra: null,
        awayMLOpen: odds?.awayMLOpen ?? null,
        homeMLOpen: odds?.homeMLOpen ?? null,
      });
    }

    // 4. Fetch pitcher stats (limit to top 8 games = 16 pitchers)
    const uniqueIds = [...new Set(pitcherIds)].slice(0, 16);
    const statResults = await Promise.all(
      uniqueIds.map(id => fetchPitcherStats(id).then(stats => ({ id, stats })))
    );
    const statMap = new Map(statResults.map(r => [r.id, r.stats]));

    // Map stats back to games by matching team abbreviations
    for (const game of games) {
      const awayPitcher = teamPitchers[game.awayAbbrev];
      const homePitcher = teamPitchers[game.homeAbbrev];

      const awayStats = awayPitcher ? statMap.get(awayPitcher.id) : undefined;
      const homeStats = homePitcher ? statMap.get(homePitcher.id) : undefined;

      if (awayStats) {
        game.awayK9 = awayStats.k9;
        game.awayAvgK = awayStats.avgK;
        game.awayOver6_5 = awayStats.over6_5Rate;
        game.awayEra = awayStats.era;
      }
      if (homeStats) {
        game.homeK9 = homeStats.k9;
        game.homeAvgK = homeStats.avgK;
        game.homeOver6_5 = homeStats.over6_5Rate;
        game.homeEra = homeStats.era;
      }
    }

    // 5. Only analyze games with odds data; fetch team scoring trends
    //    (runs/game + bullpen ERA) for every team so the totals analysis
    //    has offensive/relief context.
    const gamesWithOdds = games.filter(g => g.awayML !== 0 || g.homeML !== 0);
    const teamNames = [...new Set(gamesWithOdds.flatMap(g => [g.awayTeam, g.homeTeam]))];
    const trendResults = await Promise.all(
      teamNames.map(name => fetchTeamTrends(name).then(trends => ({ name, trends })))
    );
    const teamTrendMap = new Map(trendResults.map(r => [r.name, r.trends]));

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

    // 6. Run analysis (only games with odds data)
    const topPicks = analyzeFavorites(gamesWithOdds);
    const topKProps = analyzeKProps(gamesWithOdds);
    const topTotals = analyzeTotals(gamesWithOdds);
    const parlays = buildParlays(gamesWithOdds, topPicks, topKProps, topTotals);

    const result: AnalysisResult = {
      date: today,
      games: gamesWithOdds,
      topPicks,
      topKProps,
      topTotals,
      parlays,
    };

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("Analysis error:", error);
    return NextResponse.json(
      { error: "Failed to run analysis", message: String(error) },
      { status: 500 }
    );
  }
}
