/**
 * Opponent-adjusted scoring margin (an SRS-style rating).
 *
 * The CFB and NFL models used a team's raw net scoring margin (points scored
 * minus points allowed, per game). That number is not comparable across teams:
 * a 30-point margin over an FCS tune-up counts exactly the same as one over a
 * contender, so early-season slates made weak teams look like world-beaters and
 * produced "edges" that were really just an unadjusted average meeting a sharp
 * price. This module fixes that by solving for each team's rating
 * simultaneously:
 *
 *     rating_i = avg_margin_i + avg(rating of i's opponents)
 *
 * A team is only as good as its results say *relative to the teams it actually
 * played*, so beating up on weak opponents no longer manufactures margin. The
 * ratings are centred on zero, which keeps the model's league-average margin at
 * exactly 0 — an unknown or unplayed team is still assumed average.
 *
 * The fixed point is found by iteration (Gauss–Seidel-style Jacobi with
 * re-centring). Re-centring each pass is what makes it converge: the opponent
 * averaging matrix has an eigenvalue of 1 (constants are a fixed point of the
 * homogeneous system), so without removing the mean the iterates drift by a
 * constant rather than settling.
 *
 * This is the single source of truth for the *algorithm* used by both the app
 * and scripts/backtest-model.mjs. The backtest cannot import TypeScript, so it
 * mirrors the loop; tests/calculations.test.ts asserts the shared constants, so
 * the two cannot silently drift apart.
 */

/** One completed game. Scores are the final points each side scored. */
export interface SrsGame {
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
}

/** A completed game that also carries the date it was played (YYYY-MM-DD). */
export interface DatedSrsGame extends SrsGame {
  date: string;
}

/**
 * Opponent-adjusted margins built ONLY from games played strictly before
 * `beforeDate`.
 *
 * This is the point-in-time contract the backtest depends on: a rating that
 * included the game being predicted — or any game played the same day, whose
 * final score is not knowable at kick-off — would be look-ahead. That is not
 * hypothetical. The previous football fit read each team's FULL-SEASON scoring
 * stats to "predict" mid-season games, which inflated its accuracy and made the
 * model look considerably better than it was (see the README).
 */
export function computeMarginsAsOf(
  games: DatedSrsGame[],
  beforeDate: string,
): Map<number, number> {
  return computeOpponentAdjustedMargins(games.filter((g) => g.date < beforeDate));
}

/**
 * Number of fixed-point passes.
 *
 * MUST equal SRS_ITERATIONS in scripts/backtest-model.mjs. Twenty passes is far
 * more than a season-long schedule graph needs to settle (ratings are stable to
 * <0.01 points well before ten), and it is cheap: the graph has ~1k edges.
 */
export const SRS_ITERATIONS = 20;

/**
 * Empirical-Bayes prior (in games) used to shrink each rating toward league
 * average by its sample size: `rating × games / (games + SRS_PRIOR_GAMES)`.
 *
 * MUST equal SRS_PRIOR_GAMES in scripts/backtest-model.mjs.
 *
 * Without this the solver has a small-sample blow-up that matters most in
 * college football, where a large share of teams play exactly ONE game (FCS
 * schools taking a single body-bag paycheck). A one-game team's rating is just
 * its one result plus its opponent's rating, so a 60-point loss pins a rating
 * near -70 instead of near 0. Because the ratings are centred, 77 such teams
 * do not cancel — they drag the zero point and inflate every other team, which
 * is how a 4-0 team ended up rated ~+54 (real SRS runs about ±25) and printed a
 * 40pp edge. Shrinking by sample size tames both the isolated teams and the
 * inflated ones.
 *
 * Measured on the 2025 season (point-in-time), shrinking helped monotonically
 * up to a plateau: CFB Brier 0.1920 → 0.1871 and NFL 0.2206 → 0.2181 at 10,
 * improving the early AND late thirds of the season (so it is not merely an
 * early-season crutch). 10 sits in the middle of the plateau (8–12 are within
 * 0.0003 for both sports), and one shared prior is used because the optimum is
 * the same for both.
 */
export const SRS_PRIOR_GAMES = 10;

/**
 * Compute a zero-centred opponent-adjusted margin for every team in `games`.
 *
 * Teams that appear in no game simply do not appear in the result; callers
 * should read a missing team as league-average (0), never as "no margin
 * allowed". Returns an empty map when there are no games.
 */
export function computeOpponentAdjustedMargins(
  games: SrsGame[],
): Map<number, number> {
  const gamesPlayed = new Map<number, number>();
  const marginTotal = new Map<number, number>();
  // oppCounts[t] = Map<opponentId, number of games played against that opponent>
  const oppCounts = new Map<number, Map<number, number>>();

  const bump = (map: Map<number, Map<number, number>>, a: number, b: number) => {
    let inner = map.get(a);
    if (!inner) {
      inner = new Map();
      map.set(a, inner);
    }
    inner.set(b, (inner.get(b) || 0) + 1);
  };

  for (const game of games) {
    // Skip malformed rows rather than poisoning the solve with NaN.
    if (
      !Number.isFinite(game.homeTeamId) ||
      !Number.isFinite(game.awayTeamId) ||
      !Number.isFinite(game.homeScore) ||
      !Number.isFinite(game.awayScore)
    ) {
      continue;
    }

    const homeMargin = game.homeScore - game.awayScore;
    gamesPlayed.set(game.homeTeamId, (gamesPlayed.get(game.homeTeamId) || 0) + 1);
    gamesPlayed.set(game.awayTeamId, (gamesPlayed.get(game.awayTeamId) || 0) + 1);
    marginTotal.set(game.homeTeamId, (marginTotal.get(game.homeTeamId) || 0) + homeMargin);
    marginTotal.set(game.awayTeamId, (marginTotal.get(game.awayTeamId) || 0) - homeMargin);
    bump(oppCounts, game.homeTeamId, game.awayTeamId);
    bump(oppCounts, game.awayTeamId, game.homeTeamId);
  }

  const ids = [...gamesPlayed.keys()];
  const ratings = new Map<number, number>();
  if (ids.length === 0) return ratings;

  // Average margin per game is the starting point (rating_0 = d).
  const avgMargin = new Map<number, number>();
  for (const id of ids) {
    const g = gamesPlayed.get(id)!;
    avgMargin.set(id, g > 0 ? marginTotal.get(id)! / g : 0);
    ratings.set(id, 0);
  }

  for (let pass = 0; pass < SRS_ITERATIONS; pass++) {
    const next = new Map<number, number>();
    for (const id of ids) {
      const g = gamesPlayed.get(id)!;
      if (g <= 0) {
        next.set(id, 0);
        continue;
      }
      let oppSum = 0;
      for (const [opp, count] of oppCounts.get(id)!) {
        oppSum += count * (ratings.get(opp) || 0);
      }
      next.set(id, avgMargin.get(id)! + oppSum / g);
    }

    // Re-centre on the teams that have actually played, so the results stay
    // comparable to the model's zero league-average and the iteration settles.
    let sum = 0;
    let n = 0;
    for (const id of ids) {
      if (gamesPlayed.get(id)! > 0) {
        sum += next.get(id)!;
        n++;
      }
    }
    const mean = n > 0 ? sum / n : 0;
    for (const id of ids) {
      ratings.set(id, gamesPlayed.get(id)! > 0 ? next.get(id)! - mean : 0);
    }
  }

  // Shrink each rating toward league average (0) by its sample size, then
  // re-centre. See SRS_PRIOR_GAMES for why this is not optional in CFB.
  if (SRS_PRIOR_GAMES > 0) {
    let sum = 0;
    let n = 0;
    for (const id of ids) {
      const g = gamesPlayed.get(id)!;
      const shrunk = g > 0 ? ratings.get(id)! * (g / (g + SRS_PRIOR_GAMES)) : 0;
      ratings.set(id, shrunk);
      if (g > 0) {
        sum += shrunk;
        n++;
      }
    }
    const mean = n > 0 ? sum / n : 0;
    for (const id of ids) {
      ratings.set(id, gamesPlayed.get(id)! > 0 ? ratings.get(id)! - mean : 0);
    }
  }

  return ratings;
}
