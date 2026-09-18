# 🏆 MLB Betting Analyzer — Web App

A free, automated MLB betting analysis web app. Gets picks, strikeout props, and parlay combinations — **zero-cost, no paid APIs**.

## Data Sources (All Free)

| Source | Data | Cost |
|--------|------|------|
| [ESPN API](https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard) | Games, teams, records | Free |
| [ESPN Odds API](https://sports.core.api.espn.com/) | Moneyline odds, totals (DraftKings) | Free |
| [MLB Stats API](https://statsapi.mlb.com/) | Pitcher stats (ERA, K/9, BB/9, HR/9, WHIP, FIP, game logs) | Free |

## Quick Start

```bash
cd mlb-betting-app
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Deploy to Vercel (Free)

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import your GitHub repo
4. Set root directory to `mlb-betting-app`
5. Deploy — that's it!

No environment variables needed. Everything runs on free APIs.

## How It Works

1. **API Route** (`/api/analysis`) fetches live data from ESPN + MLB APIs
2. **Analysis engine** identifies favorite picks, K prop candidates, parlay combos
3. **Frontend** displays a beautiful dark-themed dashboard
4. Auto-updates every 5 minutes via ISR caching

## Calculation Definitions

The dashboard uses these terms in a specific, non-interchangeable way.

| Term | Meaning |
|------|---------|
| **Model probability** | The model's win probability. The two sides are normalised so they sum to exactly 100%. Computed only from baseball inputs (records, runs/game, starter ERA, FIP, K/9, BB/9 & HR/9, bullpen ERA) — **never from odds**. |
| **Market (raw)** | Vig-included implied probability of the posted moneyline: `100/(odds+100)` for positive odds, `\|odds\|/(\|odds\|+100)` for negative. `+108 → 48.08%`. The two sides sum to **more** than 100%. |
| **Fair market** | De-vigged market probability: `raw_side / (raw_away + raw_home)`. The two sides sum to exactly 100%. This is what Edge is measured against. |
| **Edge** | `model_probability − fair_market_probability`, in percentage points. Never measured against the raw price. |
| **EV** | `model_probability × decimal_odds − 1` at the **posted** price — the return you would actually get. Never uses fair-market odds. |
| **Confidence** | A–D grade from a 50/50 blend of edge strength and data quality (8 availability checks, including whether FIP/BB/9/HR/9 were published). A large edge alone does **not** earn an A, and a big edge on thin data is capped at B. |
| **Line movement** | Change from opening to current price. Opening/current prices cannot identify who moved the line, so this is never labelled "sharp money". |
| **K/Start** | Average strikeouts per start, from the pitcher's game log. This is **not** ERA (it used to be mislabelled "Avg"). |

Large edges are **flagged, never capped**: `≥ 10pp` → "large model-market disagreement", `≥ 15pp` → "extreme edge — verify data".

Pitcher stats are regressed toward league average by sample size (empirical Bayes, with a per-stat innings prior — ~100 IP for ERA, ~80 for FIP, ~60 for K/9, ~55 for BB/9, ~130 for HR/9), so a 16-inning 0.56 ERA or a fluke 1.0 BB/9 cannot manufacture a fake edge.

**Starter quality is a five-metric package** (ERA, FIP, K/9, BB/9, HR/9). ERA and FIP measure the same run-prevention quantity on the same scale, so FIP carries a slightly smaller coefficient than ERA rather than stacking on top of it, and K/9, BB/9 and HR/9 — the components of FIP — get small individual weights. The whole package is summed under a **shared logit budget equal to the ceiling the old ERA+K/9 pair could reach**, so the metrics can never stack without limit. The budget bounds the ceiling, not the average: a five-metric read can legitimately move a probability more than the old two-metric one, which is the point of adding real information.

> ℹ️ **The feature set changed, so the calibration in `src/lib/calibration.json` was re-fitted to match.** It is stamped `featureSet: 2` and is near-identity (`A ≈ 1.02`, `B ≈ 0`) — a fit that changes almost nothing, because the model is already close to calibrated. Re-run `npm run backtest` after any change to the model's inputs; the debug view's calibration chart shows whether the shipped fit still matches the shipped model (see below).
>
> `scripts/backtest-model.mjs` reproduces the production model, including the five-metric starter package and the empirical-Bayes shrinkage, and `tests/calculations.test.ts` asserts the two files share the same coefficients, caps, priors and feature-set version — so the fit cannot silently describe a model that no longer exists.

### Pick categories (kept deliberately separate)

- **Model Edge Picks** — model/market value. Ranked by edge + EV + confidence + data quality, so a `+108` underdog can outrank a `-300` favorite.
- **Top Favorite Picks** — strongest/highest-probability favorites. Ranked by model probability alone.
- **Best Value** — strongest positive-EV opportunities at the posted prices. Ranked by EV.

### Why the CFB / NFL model sections are empty early in the season

The CFB and NFL models have only two inputs: win rate and points per game. A
record is not used until a team has played 4 games, so before week 4-5 the
win-rate term falls back to the league average **on both sides** and the model
collapses to a single scoring term — and PPG is not opponent-adjusted.

On real slates that produced `UT Martin +4000 · model 46.7% · edge +44.3pp ·
EV +1815%` (CFB week 3) and `Giants +295 · model 82.7% · edge +58.4pp`
(NFL week 2). Those are the absence of a model, not opportunities, so every
model-driven section (Model Edge Picks **and** Top Moneyline Picks) fails closed
until at least one side clears the 4-game floor. The schedule, spread (ATS) and
totals sections do not use the model and stay populated throughout.

The durable fix is a model change, not a UI one: give CFB/NFL an
opponent-adjusted scoring-margin feature and per-feature logit caps like MLB's,
then re-fit `calibration-cfb.json` / `calibration-nfl.json` with
`npm run backtest -- --sport cfb|nfl`.

A per-feature cap alone does NOT fix it, which is worth knowing before trying:
the failure is that an unadjusted season average is compared against a sharp
price for an opponent it never played, so the wrong sign survives any cap.

### Spread, totals and props stay populated

These sections do not use the win-probability model, so they work all season:

- **CFB picks are filtered to today's games, with a labelled week fallback.** A
  CFB day is often thin (a Friday has a handful of games; the week's best spread
  picks are on Saturday), so filtering every section to today's teams could
  render the tab as a schedule and nothing else. Sections now show the week's
  picks when today's slate has none, with a note saying so.
- **CFB scoring context covers the whole week.** The team-stat cap was 40, which
  left only 20 of ~75 games with both teams' points-per-game; it is now 160,
  fetched 8 at a time.
- **NFL prop candidates are chosen by production, not roster order.** ESPN's
  roster is alphabetical, so the previous "first three players by position"
  picked three *quarterbacks* per team — usually backups with no stats — and
  never a running back or receiver. Candidates now come from the core API's
  season leaders (who has actually accumulated yards and touchdowns), with
  roster order only as a fallback when leaders are unavailable.
- **NFL props need 2 games, not 4.** At four, no player qualified until week 5;
  at one, a single game produced lines like `Rushing TDs Over 3.0`. Two is the
  minimum at which a rate means anything, and thinner samples are flagged on the
  card.
- **NFL parlays fall back to spreads.** Every parlay needed two moneyline legs
  from the edge layer, so the whole Parlays section disappeared early in the
  season; a 3-ATS combination fills it (mirroring CFB).

## Tests

```bash
npm test          # unit tests + live 10-game validation
npx vitest run tests/calculations.test.ts   # unit tests only (offline)
```

The live validation test fetches real ESPN + MLB data and checks the probability,
edge, EV and odds-conversion invariants across current games. It skips itself
(rather than failing) when the upstream APIs are unreachable.

### Debug view

Append `?debug=1` to the URL (or use the footer toggle) to see every
intermediate value: raw model score, normalised logit, model probability, raw
and fair market, edge, decimal odds, EV, confidence and data quality. It also
prints each side's shrunk starter package (ERA, FIP, K/9, BB/9, HR/9 and how
many of the five metrics were published) so every pitcher-driven move in the
probability is traceable to its inputs.

It also renders a **calibration / reliability chart** so a stale fit cannot go
unnoticed:

- **Staleness badge.** The model stamps its feature-set version
  (`MODEL_FEATURE_SET` in `analysis.ts`); the backtest stamps the version it
  fitted on into `calibration.json`. A mismatch — or a file with no stamp at
  all, which cannot be shown to match — renders a red *Stale* badge with both
  versions.
- **No-op callout.** When `A ≈ 1` and `B ≈ 0` the calibration is reported as
  changing nothing, so a fit that is present but inert is not mistaken for a
  working one.
- **Reliability diagram.** Predicted probability (x) vs observed win rate (y)
  per 5% bucket, with the diagonal as perfect calibration. Each bucket is a
  blue circle at its raw position and an amber square after calibration; the
  circle's size is the number of games behind it. Red gap segments mean the
  model was over-confident in that bucket, green means under-confident. A
  weighted `mean |observed − predicted|` line reports the raw → calibrated gap.

The buckets come from the backtest (`npm run backtest`), which persists them
into the calibration file. The shipped file carries them, so the chart renders
today; a file written before the field existed shows an explanatory empty state
rather than an empty plot. The backtest reproduces the production model exactly
(same coefficients, caps, priors and feature-set version — enforced by tests),
so a fresh fit is stamped with the version the app expects and is not flagged
stale.

## Tech Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Vitest (calculations + live validation)
- Deployed on Vercel (free tier)
