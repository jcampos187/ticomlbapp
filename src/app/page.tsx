"use client";

import { useEffect, useState } from "react";
import type { AnalysisResult } from "@/lib/types";
import { formatOdds } from "@/lib/analysis";
import { GameTime } from "@/components/GameTime";
import { NflDashboard } from "@/components/NflDashboard";

/** Local YYYY-MM-DD computed in the viewer's own timezone. */
function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function OddsDisplay({ odds }: { odds: number }) {
  const cls = odds > 0 ? "odds-positive" : odds < 0 ? "odds-negative" : "";
  return <span className={`font-bold ${cls}`}>{formatOdds(odds)}</span>;
}

function LineMove({ current, open }: { current: number; open: number | null }) {
  // Movement = current - opening. Negative means the team got MORE favored
  // (e.g. -150 -> -170 = -20), positive means less favored.
  if (open == null || current === 0) return null;
  const move = current - open;
  if (Math.abs(move) < 5) return null;
  // Negative move = team got more favored (e.g. -150 -> -170). Green = sharp
  // money coming in on this team, red = money moving away.
  const cls = move < 0 ? "text-green-400" : "text-red-400";
  const arrow = move < 0 ? "▼" : "▲";
  return (
    <span className={`text-xs ${cls}`} title={`Opened at ${formatOdds(open)}`}>
      {arrow} {Math.abs(move)}
    </span>
  );
}

function StatBar({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm py-1">
      <span className="text-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function KBar({ k9 }: { k9: number | null }) {
  if (!k9) return null;
  const pct = Math.min((k9 / 12) * 100, 100);
  const color = k9 >= 9 ? "bg-green-500" : k9 >= 8 ? "bg-yellow-500" : "bg-blue-500";
  return (
    <div className="w-full bg-slate-700 rounded-full h-1.5 mt-1">
      <div className={`${color} h-1.5 rounded-full`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function GameCard({ game, index }: { game: AnalysisResult["games"][0]; index: number }) {
  const isFavAway = game.awayML < 0;
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div
      className="glass rounded-xl p-4 card-hover animate-in cursor-pointer"
      style={{ animationDelay: `${index * 50}ms` }}
      onClick={() => setShowDetails(!showDetails)}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <GameTime startTime={game.startTime} status={game.status} />
          <span className="text-xs bg-slate-700 px-2 py-0.5 rounded-full text-muted whitespace-nowrap">
            {game.status === "live" ? "● Live" : game.status}
          </span>
        </div>
        {game.overUnder > 0 && (
          <span className="text-xs text-muted">O/U {game.overUnder}</span>
        )}
      </div>

      {/* Away team */}
      <div className="flex items-center justify-between py-1.5">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold">
            {game.awayAbbrev}
          </span>
          <div>
            <span className="font-semibold">{game.awayTeam}</span>
            {game.awayRecord && (
              <span className="text-xs text-muted ml-2">({game.awayRecord})</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LineMove current={game.awayML} open={game.awayMLOpen} />
          <OddsDisplay odds={game.awayML} />
        </div>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-2 my-1">
        <div className="flex-1 h-px bg-slate-700" />
        <span className="text-xs text-muted">@</span>
        <div className="flex-1 h-px bg-slate-700" />
      </div>

      {/* Home team */}
      <div className="flex items-center justify-between py-1.5">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold">
            {game.homeAbbrev}
          </span>
          <div>
            <span className="font-semibold">{game.homeTeam}</span>
            {game.homeRecord && (
              <span className="text-xs text-muted ml-2">({game.homeRecord})</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LineMove current={game.homeML} open={game.homeMLOpen} />
          <OddsDisplay odds={game.homeML} />
        </div>
      </div>

      {/* Pitchers + team trends (expandable) */}
      {showDetails && (
        <div className="mt-3 pt-3 border-t border-slate-700 space-y-2 animate-in">
          <div className="text-xs font-semibold text-muted mb-1">Probable Pitchers</div>
          {[{
            name: game.awayPitcher, team: game.awayTeam, k9: game.awayK9, avgK: game.awayAvgK, abbrev: game.awayAbbrev
          }, {
            name: game.homePitcher, team: game.homeTeam, k9: game.homeK9, avgK: game.homeAvgK, abbrev: game.homeAbbrev
          }].map((p, i) => (
            <div key={i} className="flex items-center justify-between">
              <div>
                <span className="text-sm">{p.name || "TBD"}</span>
                <span className="text-xs text-muted ml-1">({p.team})</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                {p.k9 && <span>K/9: {p.k9.toFixed(1)}</span>}
                {p.avgK && <span>Avg: {p.avgK.toFixed(1)}</span>}
              </div>
            </div>
          ))}

          {/* Team scoring trends */}
          {[{
            team: game.awayTeam, rpg: game.awayRunsPerGame, bp: game.awayBullpenEra, abbrev: game.awayAbbrev
          }, {
            team: game.homeTeam, rpg: game.homeRunsPerGame, bp: game.homeBullpenEra, abbrev: game.homeAbbrev
          }].map((t, i) => (
            <div key={`t${i}`} className="flex items-center justify-between text-xs">
              <div>
                <span className="font-medium">{t.team}</span>
                <span className="text-muted ml-1">trends</span>
              </div>
              <div className="flex items-center gap-3">
                {t.rpg && <span>R/G: <b>{t.rpg.toFixed(2)}</b></span>}
                {t.bp && <span>BP ERA: <b>{t.bp.toFixed(2)}</b></span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* K bar indicators */}
      <div className="mt-2 flex gap-2">
        {game.awayK9 && <KBar k9={game.awayK9} />}
        {game.homeK9 && <KBar k9={game.homeK9} />}
      </div>
    </div>
  );
}

function PickCard({ pick, index }: { pick: AnalysisResult["topPicks"][0]; index: number }) {
  return (
    <div className="glass rounded-xl p-4 card-hover animate-in" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-medium">
          #{index + 1} Pick
        </span>
        <OddsDisplay odds={pick.ml} />
      </div>
      <div className="text-lg font-bold mb-1">{pick.team}</div>
      <div className="text-sm text-muted mb-2">vs {pick.opponent}</div>
      <div className="flex items-center gap-2 text-xs text-muted mb-2">
        <span className="bg-slate-700 px-2 py-0.5 rounded">{pick.impliedProb}% implied</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {pick.reasons.map((r, i) => (
          <span key={i} className="text-xs bg-slate-700/50 px-2 py-0.5 rounded-full text-slate-300">
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}

function KPropCard({ prop, index }: { prop: AnalysisResult["topKProps"][0]; index: number }) {
  return (
    <div className="glass rounded-xl p-4 card-hover animate-in" style={{ animationDelay: `${index * 100}ms` }}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="font-bold">{prop.pitcher}</div>
          <div className="text-xs text-muted">{prop.team} vs {prop.opponent}</div>
        </div>
        {prop.k9 && (
          <div className="text-right">
            <div className="text-lg font-bold text-green-400">{prop.k9.toFixed(1)}</div>
            <div className="text-xs text-muted">K/9</div>
          </div>
        )}
      </div>
      {prop.avgK && (
        <div className="flex items-center gap-3 text-xs text-muted mb-2">
          <span>Avg K/start: {prop.avgK.toFixed(1)}</span>
          {prop.over6_5Rate && <span>Over 6.5: {(prop.over6_5Rate * 100).toFixed(0)}%</span>}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {prop.reasons.map((r, i) => (
          <span key={i} className="text-xs bg-green-500/10 text-green-400 px-2 py-0.5 rounded-full">
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}

function TotalPickCard({ total, index }: { total: AnalysisResult["topTotals"][0]; index: number }) {
  const isOver = total.pick === "Over";
  return (
    <div className="glass rounded-xl p-4 card-hover animate-in" style={{ animationDelay: `${index * 90}ms` }}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isOver ? "bg-red-500/20 text-red-400" : "bg-blue-500/20 text-blue-400"}`}>
          {total.pick} {total.overUnder.toFixed(1)}
        </span>
        <span className="text-xs text-muted">{total.away} @ {total.home}</span>
      </div>
      <div className="text-lg font-bold mb-2">{total.away} vs {total.home}</div>
      <div className="flex flex-wrap gap-1">
        {total.reasons.map((r, i) => (
          <span key={i} className={`text-xs px-2 py-0.5 rounded-full text-slate-300 ${isOver ? "bg-red-500/10" : "bg-blue-500/10"}`}>
            {r}
          </span>
        ))}
      </div>
    </div>
  );
}

function ParlayCard({ parlay, index }: { parlay: AnalysisResult["parlays"][0]; index: number }) {
  return (
    <div className="glass rounded-xl p-5 card-hover animate-in border-l-4 border-l-green-500"
      style={{ animationDelay: `${index * 120}ms` }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold">{parlay.name}</h3>
        <span className="odds-positive text-lg font-bold">{formatOdds(parlay.odds)}</span>
      </div>
      <div className="space-y-1.5 mb-4">
        {parlay.legs.map((leg, i) => (
          <div key={i} className="flex items-center gap-2 text-sm">
            <span className="w-5 h-5 rounded-full bg-slate-700 flex items-center justify-center text-xs">{i + 1}</span>
            <span>{leg}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-slate-700">
        <span className="text-sm text-muted">$10 bet</span>
        <div className="text-right">
          <span className="text-green-400 font-bold text-lg">${parlay.payout.toFixed(2)}</span>
          <span className="text-muted text-sm ml-2">(+${parlay.profit.toFixed(2)})</span>
        </div>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="text-center mb-8 animate-in">
      <div className="inline-flex items-center gap-2 bg-blue-500/10 text-blue-400 text-xs px-3 py-1 rounded-full mb-3">
        <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
        Daily Analysis
      </div>
      <h1 className="text-3xl md:text-4xl font-bold mb-2">
        🏆 MLB Betting Analyzer
      </h1>
      <p className="text-muted">Automated picks · Strikeout props · Over/Under · Parlay builder</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 animate-in">
      <div className="w-12 h-12 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin mb-4" />
      <p className="text-muted animate-pulse">Fetching today's data...</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="glass rounded-xl p-8 text-center animate-in">
      <div className="text-4xl mb-3">⚠️</div>
      <h2 className="text-xl font-bold mb-2">Analysis Unavailable</h2>
      <p className="text-muted mb-4">{message}</p>
      <button
        onClick={() => window.location.reload()}
        className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg transition"
      >
        Try Again
      </button>
    </div>
  );
}

function SportTabs({ sport, onChange }: { sport: "mlb" | "nfl"; onChange: (s: "mlb" | "nfl") => void }) {
  return (
    <div className="flex justify-center mb-8 animate-in">
      <div className="inline-flex glass rounded-xl p-1 gap-1">
        <button
          onClick={() => onChange("mlb")}
          className={`px-6 py-2 rounded-lg text-sm font-semibold transition ${sport === "mlb" ? "bg-blue-600 text-white shadow" : "text-muted hover:text-white"}`}
        >
          ⚾ MLB
        </button>
        <button
          onClick={() => onChange("nfl")}
          className={`px-6 py-2 rounded-lg text-sm font-semibold transition ${sport === "nfl" ? "bg-green-600 text-white shadow" : "text-muted hover:text-white"}`}
        >
          🏈 NFL
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  // Server always renders MLB first; the saved tab is restored after hydration
  // so the server/client markup matches (avoids React hydration errors from
  // reading localStorage during the initial render).
  const [sport, setSport] = useState<"mlb" | "nfl">("mlb");

  useEffect(() => {
    const saved = localStorage.getItem("ticomlbapp-sport");
    if (saved === "nfl" || saved === "mlb") setSport(saved);
  }, []);

  const changeSport = (s: "mlb" | "nfl") => {
    setSport(s);
    localStorage.setItem("ticomlbapp-sport", s);
  };

  return (
    <>
      <SportTabs sport={sport} onChange={changeSport} />
      {sport === "mlb" ? <MlbDashboard /> : <NflDashboard />}
    </>
  );
}

function MlbDashboard() {
  const [data, setData] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "Today" from the viewer's perspective — passed to the API so the server
  // never guesses based on its own (UTC) clock, and so the response cache is
  // keyed per-date (a stale response can never serve the wrong day's games).
  const [date, setDate] = useState(() => localDateStr());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/analysis?date=${date}`)
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message || body?.error || `HTTP ${r.status}`);
        return body;
      })
      .then(d => {
        if (d.error) throw new Error(d.message || d.error);
        // Cache safety net: if a shared cache ever served a response computed
        // for a different date than requested (shouldn't happen now that the
        // cache is keyed per-date), re-request once.
        if (!cancelled && reload === 0 && d.date && d.date !== date) {
          setReload(1);
          return;
        }
        if (!cancelled) setData(d);
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, reload]);

  // If the app is left open across midnight, roll over to the new day's
  // slate automatically (re-fetches via the date state change above).
  useEffect(() => {
    const id = setInterval(() => {
      const today = localDateStr();
      setDate(prev => (today === prev ? prev : today));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Keep the previous day's dashboard visible while the new day's data loads
  // (e.g. the automatic rollover at midnight) instead of flashing a spinner.
  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!data || !data.games.length) return <ErrorState message="No MLB games scheduled today." />;

  return (
    <div className="space-y-8">
      <Header />

      {/* Date banner */}
      <div className="glass rounded-xl p-3 text-center text-sm text-muted">
        {data.date} · {data.games.length} games · Updated every 5 min
      </div>

      {/* Games grid */}
      <section>
        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
          📋 Today's Games
          <span className="text-xs text-muted font-normal">({data.games.length})</span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.games.map((game, i) => (
            <GameCard key={game.id} game={game} index={i} />
          ))}
        </div>
      </section>

      {/* Top Picks */}
      {data.topPicks.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            🏆 Top Favorite Picks
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.topPicks.map((pick, i) => (
              <PickCard key={i} pick={pick} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* K Props */}
      {data.topKProps.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            🔥 Strikeout Prop Candidates
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {data.topKProps.map((prop, i) => (
              <KPropCard key={i} prop={prop} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* Over/Under Totals */}
      {data.topTotals.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            📈 Over/Under Picks
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.topTotals.map((total, i) => (
              <TotalPickCard key={i} total={total} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* Parlays */}
      {data.parlays.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            🎲 $10 Parlay Combinations
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.parlays.map((parlay, i) => (
              <ParlayCard key={i} parlay={parlay} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="text-center text-xs text-muted pt-8 pb-4 border-t border-slate-800">
        <p>Data sourced from ESPN & MLB Stats API · Not financial advice · Gamble responsibly</p>
      </div>
    </div>
  );
}
