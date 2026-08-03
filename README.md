# 🏆 MLB Betting Analyzer — Web App

A free, automated MLB betting analysis web app. Gets picks, strikeout props, and parlay combinations — **zero-cost, no paid APIs**.

## Data Sources (All Free)

| Source | Data | Cost |
|--------|------|------|
| [ESPN API](https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard) | Games, teams, records | Free |
| [ESPN Odds API](https://sports.core.api.espn.com/) | Moneyline odds, totals (DraftKings) | Free |
| [MLB Stats API](https://statsapi.mlb.com/) | Pitcher stats (K/9, ERA, game logs) | Free |

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

## Tech Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Deployed on Vercel (free tier)
