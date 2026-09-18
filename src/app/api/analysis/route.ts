import { NextResponse } from "next/server";
import { buildMlbGames } from "@/lib/buildGames";
import {
  analyzeFavorites,
  analyzeBestValue,
  analyzeKProps,
  analyzeTotals,
  buildParlays,
  computeModelEdges,
} from "@/lib/analysis";
import type { AnalysisResult } from "@/lib/types";

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

    // Fetch + assemble games (odds, probable pitchers, pitcher metrics,
    // team trends). Only games with a market are returned.
    const games = await buildMlbGames(today);

    // Three deliberately separate concepts:
    //   edges     = model/market value (edge + EV + confidence + data quality)
    //   topPicks  = strongest/highest-probability favorites
    //   bestValue = strongest positive-EV opportunities at the posted prices
    const edges = computeModelEdges(games);
    const topPicks = analyzeFavorites(games);
    const bestValue = analyzeBestValue(games);
    const topKProps = analyzeKProps(games);
    const topTotals = analyzeTotals(games);
    const parlays = buildParlays(edges, topKProps, topTotals);

    const result: AnalysisResult = {
      date: today,
      games,
      edges,
      topPicks,
      bestValue,
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
