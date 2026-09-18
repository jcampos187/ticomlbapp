import { describe, expect, it } from "vitest";
import { buildMlbGames } from "@/lib/buildGames";
import {
  americanToDecimal,
  computeNormModelProbs,
  evaluateSide,
  fairMarketProbability,
  rawMarketProbability,
} from "@/lib/analysis";

/**
 * End-to-end validation on REAL data (ESPN scoreboard + odds, MLB Stats API
 * pitchers/trends) for up to 10 current games.
 *
 * This runs the exact same buildMlbGames() path the API route uses, so it
 * validates production behaviour rather than a copy of it.
 *
 * Network-dependent: if the upstream APIs can't be reached the test is
 * skipped rather than failed, so `npm test` still works offline.
 */

function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const TARGET_GAMES = 10;

describe("live MLB validation (real data)", () => {
  it(
    `validates calculations across ${TARGET_GAMES} current games`,
    async () => {
      const date = process.env.MLB_VALIDATION_DATE || localDateStr();

      let games;
      try {
        games = await buildMlbGames(date);
      } catch (err) {
        console.warn(`  ⚠ Skipping live validation — data fetch failed: ${String(err)}`);
        return;
      }
      if (!games.length) {
        console.warn(`  ⚠ Skipping live validation — no games with odds for ${date}`);
        return;
      }

      const sample = games.slice(0, TARGET_GAMES);

      const header =
        "  #  Matchup                        Side   ML     Model   Raw    Fair   Edge    EV     Conf Qual Valid";
      console.log(`\n  Live validation — ${date} — ${sample.length} of ${games.length} games`);
      console.log(header);
      console.log("  " + "─".repeat(header.length));

      let checkedSides = 0;

      for (let i = 0; i < sample.length; i++) {
        const game = sample[i];
        const probs = computeNormModelProbs(game);
        expect(probs, `${game.awayTeam} @ ${game.homeTeam}: model probabilities`).not.toBeNull();

        // 1. Model probabilities must sum to exactly 100%.
        expect(probs!.awayProb + probs!.homeProb).toBe(100);

        const fairAway = fairMarketProbability(game.awayML, game.homeML, "away")!;
        const fairHome = fairMarketProbability(game.awayML, game.homeML, "home")!;
        // 3. Fair market probabilities must sum to 100%.
        expect(fairAway + fairHome).toBeCloseTo(100, 8);

        for (const side of ["away", "home"] as const) {
          const s = evaluateSide(game, side);
          expect(s, `${game.awayTeam}/${side} evaluation`).not.toBeNull();
          checkedSides++;

          // 6. Odds conversion correct.
          expect(s!.decimalOdds).toBeCloseTo(americanToDecimal(s!.ml), 12);

          // 2. Raw market probability computed from the odds formula.
          expect(s!.rawMarketProb).toBeCloseTo(rawMarketProbability(s!.ml), 12);

          // 4. Edge = model probability − fair market probability.
          expect(s!.edge).toBeCloseTo(s!.modelProb - s!.fairMarketProb, 10);

          // 5. EV = model probability × decimal odds − 1.
          expect(s!.ev / 100).toBeCloseTo(
            (s!.modelProb / 100) * s!.decimalOdds - 1,
            10,
          );

          // 7. No NaN anywhere.
          for (const [name, v] of Object.entries({
            modelProb: s!.modelProb,
            rawMarketProb: s!.rawMarketProb,
            fairMarketProb: s!.fairMarketProb,
            edge: s!.edge,
            ev: s!.ev,
            decimalOdds: s!.decimalOdds,
            rawModelLogit: s!.rawModelLogit,
          })) {
            expect(Number.isFinite(v), `${game.awayTeam}/${side} ${name}=${v}`).toBe(true);
          }

          // 8. Missing stats are never silently turned into 0 — they fall back
          //    to the league baseline (or stay null), never to zero.
          if (game.awayK9 == null || game.homeK9 == null) {
            expect(s!.inputs.k9).not.toBe(0);
            expect(s!.inputs.k9).toBeGreaterThan(0);
          }
          if (game.awayEra == null || game.homeEra == null) {
            expect(s!.inputs.starterEra).not.toBe(0);
          }

          // 9 & 10. No probability above 100 or below 0.
          expect(s!.modelProb).toBeGreaterThanOrEqual(0);
          expect(s!.modelProb).toBeLessThanOrEqual(100);
          expect(s!.fairMarketProb).toBeGreaterThan(0);
          expect(s!.fairMarketProb).toBeLessThan(100);

          // Every real game must pass its own probability validation.
          expect(s!.valid, `${game.awayTeam}/${side} validation: ${s!.validationErrors.join("; ")}`).toBe(true);

          console.log(
            "  " +
              String(i + 1).padStart(2) +
              "  " +
              `${game.awayAbbrev} @ ${game.homeAbbrev}`.padEnd(28) +
              "  " +
              side.padEnd(5) +
              "  " +
              String(s!.ml).padStart(5) +
              "  " +
              `${s!.modelProb.toFixed(1)}%`.padStart(6) +
              "  " +
              `${s!.rawMarketProb.toFixed(1)}%`.padStart(5) +
              "  " +
              `${s!.fairMarketProb.toFixed(1)}%`.padStart(5) +
              "  " +
              `${s!.edge >= 0 ? "+" : ""}${s!.edge.toFixed(1)}`.padStart(6) +
              "  " +
              `${s!.ev >= 0 ? "+" : ""}${s!.ev.toFixed(1)}%`.padStart(6) +
              "  " +
              String(s!.confidence).padStart(4) +
              "  " +
              String(s!.dataQuality).padStart(4) +
              "  " +
              String(s!.valid),
          );
        }
      }

      console.log(`\n  Checked ${checkedSides} sides across ${sample.length} games — all invariants held.\n`);
      expect(checkedSides).toBe(sample.length * 2);
    },
    180_000,
  );
});
