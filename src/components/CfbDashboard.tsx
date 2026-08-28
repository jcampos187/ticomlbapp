"use client";

import { useEffect, useState } from "react";
import type { CfbAnalysisResult } from "@/lib/cfbTypes";
import { formatOdds } from "@/lib/analysis";
import { GameTime } from "@/components/GameTime";

function OddsDisplay({ odds }: { odds: number }) {
  if (!odds) return <span className="text-muted">—</span>;
  const cls = odds > 0 ? "odds-positive" : odds < 0 ? "odds-negative" : "";
  return <span className={`font-bold ${cls}`}>{formatOdds(odds)}</span>;
}

function SpreadDisplay({ line }: { line: string | null }) {
  if (!line) return <span className="text-muted">—</span>;
  return <span className="font-bold text-slate-200">{line}</span>;
}

function LineMove({ current, open }: { current: number; open: number | null }) {
  if (open == null || current === 0) return null;
  const move = current - open;
  if (Math.abs(move) < 5) return null;
  const cls = move < 0 ? "text-green-400" : "text-red-400";
  const arrow = move < 0 ? "▼" : "▲";
  return (
    <span className={`text-xs ${cls}`} title={`Opened at ${formatOdds(open)}`}>
      {arrow} {Math.abs(move)}
    </span>
  );
}

function SpreadMove({ current, open }: { current: number | null; open: number | null }) {
  if (current == null || open == null) return null;
  const move = current - open;
  if (Math.abs(move) < 1) return null;
  const cls = move < 0 ? "text-green-400" : "text-red-400";
  const arrow = move < 0 ? "▼" : "▲";
  return (
    <span className={`text-xs ${cls}`} title={`Opened at ${open}`}>
      {arrow} {Math.abs(move).toFixed(1)}
    </span>
  );
}

/** Group games by local calendar day, ordered by start time. */
function groupByDay(games: CfbAnalysisResult["games"]): { day: string; label: string; games: CfbAnalysisResult["games"] }[] {
  const groups = new Map<string, CfbAnalysisResult["games"]>();
  const sorted = [...games].sort((a, b) => a.startTime.localeCompare(b.startTime));

  for (const game of sorted) {
    const d = new Date(game.startTime);
    if (Number.isNaN(d.getTime())) continue;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(game);
  }

  return [...groups.entries()].map(([day, games]) => ({
    day,
    label: new Date(`${day}T12:00:00`).toLocaleDateString([], {
      weekday: "long",
      month: "short",
      day: "numeric",
    }),
    games,
  }));
}

/** Compute the spread movement for the favorite side. Returns null if no movement data. */
function spreadMovement(game: CfbAnalysisResult["games"][0]): { open: number; current: number; move: number; favTeam: string; favSide: "away" | "home" } | null {
  if (game.awaySpread == null || game.homeSpread == null) return null;
  if (game.awaySpreadOpen == null || game.homeSpreadOpen == null) return null;
  // The favorite is the side with the more-negative spread.
  const favIsAway = game.awaySpread < game.homeSpread;
  const open = favIsAway ? game.awaySpreadOpen : game.homeSpreadOpen;
  const current = favIsAway ? game.awaySpread : game.homeSpread;
  if (open == null || current == null) return null;
  const move = current - open; // negative = line moved toward the favorite
  const favTeam = favIsAway ? game.awayTeam : game.homeTeam;
  const favSide = favIsAway ? "away" : "home";
  return { open, current, move, favTeam, favSide };
}

function LineMovementAlerts({ games }: { games: CfbAnalysisResult["games"] }) {
  const alerts = games
    .filter(g => g.status !== "final")
    .map(g => ({ game: g, movement: spreadMovement(g) }))
    .filter((a): a is { game: CfbAnalysisResult["games"][0]; movement: NonNullable<ReturnType<typeof spreadMovement>> } =>
      a.movement != null && Math.abs(a.movement.move) >= 3
    )
    .sort((a, b) => Math.abs(b.movement.move) - Math.abs(a.movement.move));

  if (alerts.length === 0) return null;

  return (
    <section>
      <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
        🔔 Line Movement Alerts
        <span className="text-xs text-muted font-normal">(spread moved 3+ pts)</span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {alerts.map(({ game, movement }, i) => {
          const movedTowardFav = movement.move < 0; // more negative = sharper on fav
          const arrow = movedTowardFav ? "▼" : "▲";
          const color = movedTowardFav ? "text-green-400" : "text-red-400";
          const label = movedTowardFav ? "Sharp money" : "Money moving away";
          const absMove = Math.abs(movement.move);
          const severity = absMove >= 5 ? "border-red-500" : absMove >= 4 ? "border-amber-500" : "border-yellow-500";
          return (
            <div
              key={game.id}
              className={`glass rounded-xl p-4 card-hover animate-in border-l-4 ${severity}`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-medium">⚡ {absMove.toFixed(1)} pt move</span>
                <span className={`text-xs font-bold ${color}`}>{arrow} {label}</span>
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-sm">{movement.favTeam}</span>
                <span className="text-xs text-muted">Favored side</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">
                  {game.awayAbbrev} @ {game.homeAbbrev}
                </span>
                <span className="text-sm font-mono">
                  <span className="text-muted line-through mr-1">{movement.open}</span>
                  <span className="text-white">→ {movement.current}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CfbGameCard({ game, index }: { game: CfbAnalysisResult["games"][0]; index: number }) {
  const [showDetails, setShowDetails] = useState(false);
  const statusBadge =
    game.status === "live" ? (
      <span className="text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full whitespace-nowrap">● Live</span>
    ) : game.status === "final" ? (
      <span className="text-xs bg-slate-700 px-2 py-0.5 rounded-full text-muted whitespace-nowrap">Final</span>
    ) : (
      <span className="text-xs bg-slate-700 px-2 py-0.5 rounded-full text-muted whitespace-nowrap">Scheduled</span>
    );

  return (
    <div
      className="glass rounded-xl p-4 card-hover animate-in cursor-pointer"
      style={{ animationDelay: `${index * 50}ms` }}
      onClick={() => setShowDetails(!showDetails)}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <GameTime startTime={game.startTime} status={game.status} />
          {statusBadge}
        </div>
        {game.overUnder > 0 && (
          <span className="text-xs text-muted whitespace-nowrap">O/U {game.overUnder.toFixed(1)}</span>
        )}
      </div>

      {/* Away team */}
      <div className="flex items-center justify-between py-1.5">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold shrink-0">
            {game.awayAbbrev}
          </span>
          <div className="min-w-0">
            <span className="font-semibold">{game.awayTeam}</span>
            {game.awayRecord && (
              <span className="text-xs text-muted ml-2">({game.awayRecord})</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SpreadMove current={game.awaySpread} open={game.awaySpreadOpen} />
          <SpreadDisplay line={game.awaySpread != null ? `${game.awaySpread > 0 ? "+" : ""}${game.awaySpread}` : null} />
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
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold shrink-0">
            {game.homeAbbrev}
          </span>
          <div className="min-w-0">
            <span className="font-semibold">{game.homeTeam}</span>
            {game.homeRecord && (
              <span className="text-xs text-muted ml-2">({game.homeRecord})</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SpreadMove current={game.homeSpread} open={game.homeSpreadOpen} />
          <LineMove current={game.homeML} open={game.homeMLOpen} />
          <OddsDisplay odds={game.homeML} />
        </div>
      </div>

      {/* Expandable details */}
      {showDetails && (
        <div className="mt-3 pt-3 border-t border-slate-700 space-y-2 animate-in">
          {game.details && (
            <div className="text-xs text-muted">
              Spread: <b className="text-slate-200">{game.details}</b>
              {game.overUnder > 0 && (
                <> · Total: <b className="text-slate-200">{game.overUnder.toFixed(1)}</b></>
              )}
            </div>
          )}
          <div className="flex gap-4 text-xs text-muted">
            {game.awayPpg != null && <span>{game.awayAbbrev} PPG: <b className="text-slate-200">{game.awayPpg.toFixed(1)}</b></span>}
            {game.homePpg != null && <span>{game.homeAbbrev} PPG: <b className="text-slate-200">{game.homePpg.toFixed(1)}</b></span>}
          </div>
        </div>
      )}
    </div>
  );
}

function CfbPickCard({ pick, index }: { pick: CfbAnalysisResult["topPicks"][0]; index: number }) {
  return (
    <div className="glass rounded-xl p-4 card-hover animate-in" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-medium">#{index + 1} Pick</span>
        <OddsDisplay odds={pick.ml} />
      </div>
      <div className="text-lg font-bold mb-1">{pick.team}</div>
      <div className="text-sm text-muted mb-2">vs {pick.opponent}</div>
      <div className="flex items-center gap-2 text-xs text-muted mb-2">
        <span className="bg-slate-700 px-2 py-0.5 rounded">{pick.impliedProb}% implied</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {pick.reasons.map((r, i) => (
          <span key={i} className="text-xs bg-slate-700/50 px-2 py-0.5 rounded-full text-slate-300">{r}</span>
        ))}
      </div>
    </div>
  );
}

function AtsCard({ pick, index }: { pick: CfbAnalysisResult["topAts"][0]; index: number }) {
  return (
    <div className="glass rounded-xl p-4 card-hover animate-in" style={{ animationDelay: `${index * 80}ms` }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full font-medium">#{index + 1} ATS</span>
        <SpreadDisplay line={pick.line} />
      </div>
      <div className="text-lg font-bold mb-1">{pick.team}</div>
      <div className="text-sm text-muted mb-2">vs {pick.opponent}</div>
      <div className="flex flex-wrap gap-1">
        {pick.reasons.map((r, i) => (
          <span key={i} className="text-xs bg-purple-500/10 text-purple-300 px-2 py-0.5 rounded-full">{r}</span>
        ))}
      </div>
    </div>
  );
}

function TotalCard({ total, index }: { total: CfbAnalysisResult["topTotals"][0]; index: number }) {
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
          <span key={i} className={`text-xs px-2 py-0.5 rounded-full text-slate-300 ${isOver ? "bg-red-500/10" : "bg-blue-500/10"}`}>{r}</span>
        ))}
      </div>
    </div>
  );
}

function ParlayCard({ parlay, index }: { parlay: CfbAnalysisResult["parlays"][0]; index: number }) {
  return (
    <div className="glass rounded-xl p-5 card-hover animate-in border-l-4 border-l-green-500" style={{ animationDelay: `${index * 120}ms` }}>
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

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 animate-in">
      <div className="w-12 h-12 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin mb-4" />
      <p className="text-muted animate-pulse">Fetching this week's CFB data...</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="glass rounded-xl p-8 text-center animate-in">
      <div className="text-4xl mb-3">⚠️</div>
      <h2 className="text-xl font-bold mb-2">CFB Analysis Unavailable</h2>
      <p className="text-muted mb-4">{message}</p>
      <button
        onClick={() => window.location.reload()}
        className="bg-orange-600 hover:bg-orange-700 text-white px-6 py-2 rounded-lg transition"
      >
        Try Again
      </button>
    </div>
  );
}

export function CfbDashboard() {
  const [data, setData] = useState<CfbAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/cfb-analysis")
      .then(async r => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body?.message || body?.error || `HTTP ${r.status}`);
        return body;
      })
      .then(d => {
        if (d.error) throw new Error(d.message || d.error);
        if (!cancelled) setData(d);
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!data) return <ErrorState message="No data returned." />;

  const isOffseason = data.games.length === 0;
  const dayGroups = groupByDay(data.games);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="text-center mb-8 animate-in">
        <div className="inline-flex items-center gap-2 bg-orange-500/10 text-orange-400 text-xs px-3 py-1 rounded-full mb-3">
          <span className="w-2 h-2 bg-orange-400 rounded-full animate-pulse" />
          {data.weekLabel}
        </div>
        <h1 className="text-3xl md:text-4xl font-bold mb-2">🏈 College Football Analyzer</h1>
        <p className="text-muted">Moneyline · Spread · Over/Under · Parlays</p>
      </div>

      {/* Week banner */}
      <div className="glass rounded-xl p-3 text-center text-sm text-muted">
        {data.weekLabel} · {data.seasonYear} season · {data.games.length} games · Updated every 5 min
      </div>

      {isOffseason && (
        <div className="glass rounded-xl p-10 text-center animate-in">
          <div className="text-4xl mb-3">🗓️</div>
          <h2 className="text-xl font-bold mb-2">No CFB games this week</h2>
          <p className="text-muted">The college football season hasn't started yet. Check back when games resume.</p>
        </div>
      )}

      {/* Games grouped by day */}
      {dayGroups.map(group => (
        <section key={group.day}>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            📋 {group.label}
            <span className="text-xs text-muted font-normal">({group.games.length})</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {group.games.map((game, i) => (
              <CfbGameCard key={game.id} game={game} index={i} />
            ))}
          </div>
        </section>
      ))}

      {/* Line Movement Alerts */}
      <LineMovementAlerts games={data.games} />

      {/* Top Moneyline Picks */}
      {data.topPicks.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">🏆 Top Moneyline Picks</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.topPicks.map((pick, i) => <CfbPickCard key={i} pick={pick} index={i} />)}
          </div>
        </section>
      )}

      {/* Against the Spread */}
      {data.topAts.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">📊 Against the Spread</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.topAts.map((pick, i) => <AtsCard key={i} pick={pick} index={i} />)}
          </div>
        </section>
      )}

      {/* Over/Under */}
      {data.topTotals.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">📈 Over/Under Picks</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.topTotals.map((total, i) => <TotalCard key={i} total={total} index={i} />)}
          </div>
        </section>
      )}

      {/* Parlays */}
      {data.parlays.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">🎲 $10 Parlay Combinations</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.parlays.map((parlay, i) => <ParlayCard key={i} parlay={parlay} index={i} />)}
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="text-center text-xs text-muted pt-8 pb-4 border-t border-slate-800">
        <p>Data sourced from ESPN (free) · Not financial advice · Gamble responsibly</p>
      </div>
    </div>
  );
}
