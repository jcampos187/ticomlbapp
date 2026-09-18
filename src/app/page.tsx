"use client";

import { useEffect, useState } from "react";
import type { AnalysisResult } from "@/lib/types";
import { formatOdds, evaluateSide, calibrationReport, SMALL_SAMPLE_IP } from "@/lib/analysis";
import type { CalibrationReport } from "@/lib/analysis";
import { GameTime } from "@/components/GameTime";
import { NflDashboard } from "@/components/NflDashboard";
import { CfbDashboard } from "@/components/CfbDashboard";

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
  // Negative move = team got more favored (e.g. -150 -> -170). Green = the
  // line moved toward this team, red = it moved away. Opening/current prices
  // alone can't say WHO moved the line, so this is never called sharp money.
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

/**
 * Compact model-vs-market line under each team in a game card:
 *   Model 50.6% · Mkt 48.1% (fair 46.0%) · Edge +4.6% · EV +5.2%
 *
 *   Model  = normalised model probability (both sides sum to exactly 100%)
 *   Mkt    = RAW vig-included implied probability from the posted moneyline
 *   fair   = DE-VIGGED market probability, so the two sides sum to 100%
 *   Edge   = Model − FAIR market, in percentage points
 *   EV     = Model × decimal odds − 1, at the price actually on offer
 *
 * Every value comes from evaluateSide(), the same function the API uses, so
 * the dashboard can never disagree with the server.
 */
function EdgeRow({ game, side }: { game: AnalysisResult["games"][0]; side: "away" | "home" }) {
  const s = evaluateSide(game, side);
  if (!s) return null;

  // Validation failure: flag the row instead of showing numbers that don't add up.
  if (!s.valid) {
    return (
      <div className="text-xs text-amber-400 mt-0.5" title={s.validationErrors.join("; ")}>
        ⚠ Invalid probabilities — flagged for review, not displayed
      </div>
    );
  }

  const edgeCls = s.edge >= 3 ? "text-green-400" : s.edge <= -3 ? "text-red-400" : "text-muted";
  const evCls = s.ev >= 0 ? "text-green-400" : "text-red-400";
  return (
    <div className="flex items-center justify-between text-xs text-muted mt-0.5">
      <span>
        Model <b className="text-slate-300">{s.modelProb.toFixed(1)}%</b>
        <span className="mx-1">·</span>
        Mkt <b className="text-slate-300">{s.rawMarketProb.toFixed(1)}%</b>
        <span className="ml-1 text-slate-500">(fair {s.fairMarketProb.toFixed(1)}%)</span>
      </span>
      <span className="flex items-center gap-2">
        <span className={`font-bold ${edgeCls}`}>
          Edge {s.edge >= 0 ? "+" : ""}{s.edge.toFixed(1)}%
        </span>
        <span className={`font-bold ${evCls}`}>
          EV {s.ev >= 0 ? "+" : ""}{s.ev.toFixed(1)}%
        </span>
      </span>
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

/** Compute the moneyline movement for the favorite side. Returns null if no movement data. */
function mlMovement(game: AnalysisResult["games"][0]): { open: number; current: number; move: number; favTeam: string } | null {
  if (!game.awayML || !game.homeML) return null;
  if (game.awayMLOpen == null || game.homeMLOpen == null) return null;
  const favIsAway = game.awayML < 0;
  const open = favIsAway ? game.awayMLOpen : game.homeMLOpen;
  const current = favIsAway ? game.awayML : game.homeML;
  if (!open || !current) return null;
  const move = current - open; // negative = line moved toward the favorite
  const favTeam = favIsAway ? game.awayTeam : game.homeTeam;
  return { open, current, move, favTeam };
}

function MlbLineMovementAlerts({ games }: { games: AnalysisResult["games"] }) {
  const alerts = games
    .filter(g => g.status !== "final")
    .map(g => ({ game: g, movement: mlMovement(g) }))
    .filter((a): a is { game: AnalysisResult["games"][0]; movement: NonNullable<ReturnType<typeof mlMovement>> } =>
      a.movement != null && Math.abs(a.movement.move) >= 30
    )
    .sort((a, b) => Math.abs(b.movement.move) - Math.abs(a.movement.move));

  if (alerts.length === 0) return null;

  return (
    <section>
      <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
        🔔 Line Movement Alerts
        <span className="text-xs text-muted font-normal">(ML moved 30+ cents)</span>
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {alerts.map(({ game, movement }, i) => {
          const movedTowardFav = movement.move < 0;
          const arrow = movedTowardFav ? "▼" : "▲";
          const color = movedTowardFav ? "text-green-400" : "text-red-400";
          // Opening/current prices only — this is LINE MOVEMENT, not proof of
          // who caused it, so it is not labelled "sharp money".
          const label = movedTowardFav ? "Line moved toward" : "Line moved away";
          const absMove = Math.abs(movement.move);
          const severity = absMove >= 60 ? "border-red-500" : absMove >= 45 ? "border-amber-500" : "border-yellow-500";
          return (
            <div
              key={game.id}
              className={`glass rounded-xl p-4 card-hover animate-in border-l-4 ${severity}`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full font-medium">⚡ {absMove}¢ move</span>
                <span className={`text-xs font-bold ${color}`}>{arrow} {label}</span>
              </div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-sm">{movement.favTeam}</span>
                <span className="text-xs text-muted">Favorite</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">
                  {game.awayAbbrev} @ {game.homeAbbrev}
                </span>
                <span className="text-sm font-mono">
                  <span className="text-muted line-through mr-1">{formatOdds(movement.open)}</span>
                  <span className="text-white">→ {formatOdds(movement.current)}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
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
      <EdgeRow game={game} side="away" />

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
      <EdgeRow game={game} side="home" />

      {/* Pitchers + team trends (expandable) */}
      {showDetails && (
        <div className="mt-3 pt-3 border-t border-slate-700 space-y-2 animate-in">
          <div className="text-xs font-semibold text-muted mb-1">
            Probable Pitchers
            <span className="font-normal ml-1">· MLB Stats API, season to date</span>
          </div>
          {[{
            name: game.awayPitcher,
            team: game.awayTeam,
            m: game.awayPitcherMetrics,
            k9: game.awayK9,
            avgK: game.awayAvgK,
            ip: game.awayIp,
          }, {
            name: game.homePitcher,
            team: game.homeTeam,
            m: game.homePitcherMetrics,
            k9: game.homeK9,
            avgK: game.homeAvgK,
            ip: game.homeIp,
          }].map((p, i) => (
            <div key={i} className="text-xs">
              <div>
                <span className="text-sm">{p.name || "TBD"}</span>
                <span className="text-xs text-muted ml-1">({p.team})</span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted mt-0.5">
                <span title="Earned run average — regressed toward league average by innings, then fed to the win-probability model">ERA: <b className="text-slate-300">{p.m?.era != null ? p.m.era.toFixed(2) : "—"}</b></span>
                <span title="Fielding Independent Pitching — defence- and sequencing-independent, a win-probability model input">FIP: <b className="text-slate-300">{p.m?.fip != null ? p.m.fip.toFixed(2) : "—"}</b></span>
                <span title="Strikeouts per 9 innings">K/9: <b className="text-slate-300">{p.k9 != null ? p.k9.toFixed(1) : "—"}</b></span>
                <span title="Walks per 9 innings — a win-probability model input">BB/9: <b className="text-slate-300">{p.m?.bb9 != null ? p.m.bb9.toFixed(2) : "—"}</b></span>
                <span title="Home runs per 9 innings — a win-probability model input">HR/9: <b className="text-slate-300">{p.m?.hr9 != null ? p.m.hr9.toFixed(2) : "—"}</b></span>
                <span>WHIP: <b className="text-slate-300">{p.m?.whip != null ? p.m.whip.toFixed(2) : "—"}</b></span>
                <span title="Average strikeouts per start, taken from the game log (not ERA)">
                  K/Start: <b className="text-slate-300">{p.avgK != null ? p.avgK.toFixed(1) : "—"}</b>
                </span>
                <span>IP: <b className="text-slate-300">{p.ip != null ? p.ip.toFixed(1) : "—"}</b></span>
              </div>
            </div>
          ))}
          {(!game.pitcherConfirmed ||
            (game.awayIp != null && game.awayIp < SMALL_SAMPLE_IP) ||
            (game.homeIp != null && game.homeIp < SMALL_SAMPLE_IP)) && (
            <div className="text-xs text-amber-400">
              {!game.pitcherConfirmed
                ? "⚠ TBD pitcher — stats missing, confidence reduced"
                : "⚠ Small sample — starter stats regressed toward league average"}
            </div>
          )}

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

const CONFIDENCE_CLS: Record<string, string> = {
  A: "bg-green-500/20 text-green-400",
  B: "bg-blue-500/20 text-blue-400",
  C: "bg-amber-500/20 text-amber-400",
  D: "bg-slate-700 text-muted",
};

const QUALITY_CLS: Record<string, string> = {
  HIGH: "bg-slate-700 text-slate-300",
  MEDIUM: "bg-slate-700 text-slate-400",
  LOW: "bg-red-500/20 text-red-400",
};

function ModelEdgeCard({ edge, index }: { edge: AnalysisResult["edges"][0]; index: number }) {
  const borderColor = edge.flag ? "border-l-amber-500" : "border-l-green-500";
  return (
    <div
      className={`glass rounded-xl p-4 card-hover animate-in border-l-4 ${borderColor}`}
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full font-medium">
          #{index + 1} Edge
        </span>
        <span className="flex items-center gap-1">
          <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${CONFIDENCE_CLS[edge.confidence]}`}>
            Confidence: {edge.confidence}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${QUALITY_CLS[edge.dataQuality]}`}
            title={`Data quality: ${edge.qualityScore}/${edge.qualityMax} checks passed`}
          >
            Data: {edge.dataQuality}
          </span>
        </span>
      </div>
      <div className="text-lg font-bold mb-1">
        {edge.team} ML <span className="text-sm font-normal text-muted">{formatOdds(edge.ml)}</span>
      </div>
      <div className="text-sm text-muted mb-3">vs {edge.opponent}</div>
      {edge.valid ? (
        <div className="space-y-1.5 text-sm mb-3">
          <StatBar label="Model probability" value={`${edge.modelProb.toFixed(1)}%`} />
          <StatBar label="Market (raw, vig)" value={`${edge.rawMarketProb.toFixed(1)}%`} />
          <StatBar label="Fair market (de-vigged)" value={`${edge.fairMarketProb.toFixed(1)}%`} />
          <div className="flex justify-between text-sm py-1 border-t border-slate-700">
            <span className="text-muted">Edge (model − fair)</span>
            <span className="font-bold text-green-400">
              {edge.edge >= 0 ? "+" : ""}{edge.edge.toFixed(1)}%
            </span>
          </div>
          <div className="flex justify-between text-sm py-1">
            <span className="text-muted">EV (at {formatOdds(edge.ml)})</span>
            <span className={`font-bold ${edge.ev >= 0 ? "text-green-400" : "text-red-400"}`}>
              {edge.ev >= 0 ? "+" : ""}{edge.ev.toFixed(1)}%
            </span>
          </div>
        </div>
      ) : (
        <div className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded mb-2">
          ⚠ Invalid probabilities — flagged, not displayed
        </div>
      )}
      {edge.flag === "extreme" && (
        <div className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded mb-2 font-medium">
          ⚠ Extreme edge — verify data
        </div>
      )}
      {edge.flag === "large" && (
        <div className="text-xs bg-amber-500/20 text-amber-400 px-2 py-1 rounded mb-2 font-medium">
          ⚠ Large model-market disagreement
        </div>
      )}
      {!edge.pitcherConfirmed && (
        <div className="text-xs bg-amber-500/20 text-amber-400 px-2 py-1 rounded mb-2">
          ⚠ TBD pitcher(s) — reduced confidence
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {edge.reasons.map((r, i) => (
          <span key={i} className="text-xs bg-slate-700/50 px-2 py-0.5 rounded-full text-slate-300">
            {r}
          </span>
        ))}
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
      <div className="flex items-center gap-1 mb-2">
        <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${CONFIDENCE_CLS[pick.confidence]}`}>
          {pick.confidence}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${QUALITY_CLS[pick.dataQuality]}`}>
          Data: {pick.dataQuality}
        </span>
      </div>
      {pick.valid ? (
        <div className="space-y-1 text-xs mb-2">
          <div className="flex justify-between">
            <span className="text-muted">Model</span>
            <span className="font-medium text-slate-300">{pick.modelProb.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Market (raw, vig)</span>
            <span className="font-medium text-slate-300">{pick.rawMarketProb.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Fair market (de-vigged)</span>
            <span className="font-medium text-slate-300">{pick.fairMarketProb.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between border-t border-slate-700 pt-1">
            <span className="text-muted">Edge (model − fair)</span>
            <span className="font-bold text-green-400">
              {pick.edge >= 0 ? "+" : ""}{pick.edge.toFixed(1)}%
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">EV (at {formatOdds(pick.ml)})</span>
            <span className={`font-bold ${pick.ev >= 0 ? "text-green-400" : "text-red-400"}`}>
              {pick.ev >= 0 ? "+" : ""}{pick.ev.toFixed(1)}%
            </span>
          </div>
        </div>
      ) : (
        <div className="text-xs bg-red-500/20 text-red-400 px-2 py-1 rounded mb-2">
          ⚠ Invalid probabilities — flagged, not displayed
        </div>
      )}
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

/**
 * Reliability diagram for the debug view.
 *
 * Plots the model's predicted probability (x) against the observed win rate
 * (y) per probability bucket. The dashed diagonal is perfect calibration: a
 * point above it means the model was under-confident in that bucket, below it
 * over-confident. Each bucket has a blue circle at its RAW position and, unless
 * the fit is a no-op, an amber square at its post-calibration position — the
 * horizontal distance between the two is exactly what the loaded calibration
 * is doing.
 *
 * This is what makes a stale calibration visible: the feature-set version and
 * fit date are shown against the model's current version, and a near-identity
 * fit (A ≈ 1, B ≈ 0) is called out explicitly as changing nothing.
 */
function ReliabilityChart({ report }: { report: CalibrationReport }) {
  const buckets = report.reliability;
  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(4));

  // Both axes measure the same quantity, so they share a domain and the
  // diagonal stays a true 45° line. The window is fitted to the buckets so a
  // tight cluster of probabilities is still readable.
  let lo = 0;
  let hi = 100;
  if (buckets.length > 0) {
    const values = buckets.flatMap(b => [b.rawProb, b.calibratedProb, b.actual, 50]);
    lo = Math.max(0, Math.floor((Math.min(...values) - 5) / 5) * 5);
    hi = Math.min(100, Math.ceil((Math.max(...values) + 5) / 5) * 5);
    if (hi - lo < 20) hi = Math.min(100, lo + 20);
  }

  const W = 460;
  const H = 300;
  const left = 52;
  const right = W - 14;
  const top = 14;
  const bottom = H - 40;
  const x = (p: number) => left + ((p - lo) / (hi - lo)) * (right - left);
  const y = (p: number) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);

  const step = hi - lo <= 40 ? 5 : 10;
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += step) ticks.push(t);

  const weightedGap = (key: "rawProb" | "calibratedProb"): number | null => {
    const total = buckets.reduce((s, b) => s + b.count, 0);
    if (total === 0) return null;
    return buckets.reduce((s, b) => s + Math.abs(b.actual - b[key]) * b.count, 0) / total;
  };
  const rawGap = weightedGap("rawProb");
  const calGap = weightedGap("calibratedProb");

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 className="font-bold text-sm">📐 Calibration / reliability</h3>
        {report.stale ? (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 font-semibold">
            ⚠ Stale — fitted on feature set {report.fittedFeatureSet ?? "unrecorded"}, model now uses {report.currentFeatureSet}
          </span>
        ) : (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 font-semibold">
            ✓ Feature set {report.currentFeatureSet} matches
          </span>
        )}
      </div>

      <div className="text-[11px] text-muted mb-3 space-y-0.5">
        <div>
          Platt scaling A={report.A.toFixed(6)}, B={report.B.toFixed(6)}
          {report.fittedAt ? ` · fitted ${report.fittedAt.slice(0, 10)}` : " · fit date unrecorded"}
          {report.trainingGames != null ? ` · ${report.trainingGames} games` : ""}
          {report.trainingSamples != null ? ` (${report.trainingSamples} samples)` : ""}
        </div>
        {report.identity && (
          <div className="text-amber-400">
            A ≈ 1 and B ≈ 0 — this calibration is effectively a no-op: it leaves every probability unchanged.
          </div>
        )}
        {report.stale && (
          <div className="text-red-400">
            The fit predates the model&apos;s current inputs, so its parameters describe a model that no
            longer exists. Re-run <code className="font-mono">npm run backtest</code> to re-fit.
          </div>
        )}
        {report.metrics && (
          <div>
            Brier {fmt(report.metrics.brierBefore)} → {fmt(report.metrics.brierAfter)} · log-loss{" "}
            {fmt(report.metrics.logLossBefore)} → {fmt(report.metrics.logLossAfter)}
          </div>
        )}
      </div>

      {buckets.length === 0 ? (
        <div className="text-xs text-muted border border-dashed border-slate-700 rounded-lg p-4">
          No reliability data in this calibration file — it was saved before the field existed, or no
          bucket had enough games. Re-run <code className="font-mono">npm run backtest</code> to
          generate the buckets this chart plots.
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            style={{ maxHeight: 340 }}
            role="img"
            aria-label="Reliability diagram: predicted probability versus observed win rate"
          >
            <rect x={left} y={top} width={right - left} height={bottom - top} fill="rgba(15,23,42,0.5)" rx={4} />
            {ticks.map(t => (
              <g key={t}>
                <line x1={x(t)} y1={top} x2={x(t)} y2={bottom} stroke="rgba(148,163,184,0.12)" strokeWidth={1} />
                <line x1={left} y1={y(t)} x2={right} y2={y(t)} stroke="rgba(148,163,184,0.12)" strokeWidth={1} />
                <text x={x(t)} y={bottom + 14} textAnchor="middle" fontSize={10} fill="#94a3b8">
                  {t}%
                </text>
                <text x={left - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#94a3b8">
                  {t}%
                </text>
              </g>
            ))}
            {/* Perfect calibration */}
            <line
              x1={x(lo)}
              y1={y(lo)}
              x2={x(hi)}
              y2={y(hi)}
              stroke="#64748b"
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            {buckets.map(b => {
              const r = Math.min(12, 3 + Math.sqrt(b.count));
              return (
                <g key={b.bucket}>
                  <line
                    x1={x(b.rawProb)}
                    y1={y(b.rawProb)}
                    x2={x(b.rawProb)}
                    y2={y(b.actual)}
                    stroke={b.actual < b.rawProb ? "#f87171" : "#4ade80"}
                    strokeWidth={1.5}
                    opacity={0.7}
                  />
                  {!report.identity && (
                    <rect
                      x={x(b.calibratedProb) - 3}
                      y={y(b.actual) - 3}
                      width={6}
                      height={6}
                      fill="#fbbf24"
                      opacity={0.9}
                    />
                  )}
                  <circle
                    cx={x(b.rawProb)}
                    cy={y(b.actual)}
                    r={r}
                    fill="#60a5fa"
                    fillOpacity={0.55}
                    stroke="#93c5fd"
                    strokeWidth={1}
                  />
                  <text
                    x={x(b.rawProb)}
                    y={y(b.actual) - r - 3}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#cbd5e1"
                  >
                    {b.count}
                  </text>
                </g>
              );
            })}
            <text x={(left + right) / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#94a3b8">
              Predicted probability
            </text>
            <text
              x={12}
              y={(top + bottom) / 2}
              textAnchor="middle"
              fontSize={10}
              fill="#94a3b8"
              transform={`rotate(-90 12 ${(top + bottom) / 2})`}
            >
              Observed win rate
            </text>
          </svg>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted mt-1">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-400/60 border border-blue-300 inline-block" />
              model (raw), size = games
            </span>
            {!report.identity && (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 bg-amber-400 inline-block" /> after calibration
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="w-4 border-t-2 border-dashed border-slate-500 inline-block" /> perfect calibration
            </span>
            <span>gap segments: red = over-confident, green = under-confident</span>
          </div>
          {rawGap != null && calGap != null && (
            <div className="text-[11px] text-muted mt-2">
              Mean |observed − predicted|: <span className="text-slate-200">{rawGap.toFixed(2)}pp</span> raw{" → "}
              <span className={calGap < rawGap - 0.005 ? "text-green-400" : "text-slate-200"}>
                {calGap.toFixed(2)}pp
              </span>{" "}
              calibrated
              {Math.abs(rawGap - calGap) < 0.005 ? " (calibration changes nothing)" : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Development-only calculation debug view.
 *
 * Hidden from normal users: enable it with `?debug=1` or the footer toggle.
 * It shows every intermediate the model produces so any number on the page
 * can be traced back to the inputs that generated it.
 */
function DebugPanel({ data }: { data: AnalysisResult }) {
  const cal = calibrationReport();
  return (
    <section>
      <h2 className="text-xl font-bold mb-2 flex items-center gap-2">
        🔬 Calculation Debug
        <span className="text-xs text-muted font-normal">(raw model score → displayed value)</span>
      </h2>
      <div className="text-xs text-muted mb-4 space-y-0.5">
        <div>
          Mkt = raw vig-included implied probability · Fair = de-vigged · Edge = model − fair · EV = model × decimal odds − 1 at the posted price.
        </div>
      </div>
      <ReliabilityChart report={cal} />
      <div className="space-y-4">
        {data.games.map((game) => {
          const sides = [evaluateSide(game, "away"), evaluateSide(game, "home")];
          return (
            <div key={game.id} className="glass rounded-xl p-4">
              <div className="font-bold mb-2 text-sm">
                {game.awayTeam} @ {game.homeTeam}
                <span className="text-muted font-normal ml-2">
                  {game.pitcherConfirmed ? "pitchers confirmed" : "⚠ TBD pitcher(s)"}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {sides.map((s, i) =>
                  s ? (
                    <div key={i} className="text-xs font-mono space-y-0.5 overflow-x-auto">
                      <div className="font-sans font-semibold">
                        {s.team} ML {formatOdds(s.ml)}
                      </div>
                      <div>raw model score:   {s.rawModelLogit.toFixed(4)}</div>
                      <div>normalized logit:  {s.normalizedLogit.toFixed(4)} (calibrated: {String(s.calibrated)})</div>
                      <div>model probability: {s.modelProb.toFixed(2)}%</div>
                      <div>raw market:        {s.rawMarketProb.toFixed(2)}%</div>
                      <div>fair market:       {s.fairMarketProb.toFixed(2)}%</div>
                      <div>edge:              {s.edge >= 0 ? "+" : ""}{s.edge.toFixed(2)} pp</div>
                      <div>decimal odds:      {s.decimalOdds.toFixed(4)}</div>
                      <div>EV:                {s.ev >= 0 ? "+" : ""}{s.ev.toFixed(2)}%</div>
                      <div>confidence:        {s.confidence}</div>
                      <div>data quality:      {s.dataQuality} ({s.qualityScore}/{s.qualityMax})</div>
                      <div className="pt-1 text-slate-400">
                        — starter package (shrunk, {s.inputs.starterMetrics}/5 metrics) —
                      </div>
                      <div>ERA {s.inputs.starterEra.toFixed(2)} · FIP {s.inputs.fip.toFixed(2)} (opponent {s.opponentInputs.starterEra.toFixed(2)} / {s.opponentInputs.fip.toFixed(2)})</div>
                      <div>K/9 {s.inputs.k9.toFixed(1)} · BB/9 {s.inputs.bb9.toFixed(2)} · HR/9 {s.inputs.hr9.toFixed(2)}</div>
                      <div>valid:             {String(s.valid)}</div>
                      {s.validationErrors.length > 0 && (
                        <div className="text-red-400">errors: {s.validationErrors.join("; ")}</div>
                      )}
                    </div>
                  ) : (
                    <div key={i} className="text-xs text-muted">no market for this side</div>
                  ),
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
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

function SportTabs({ sport, onChange }: { sport: "mlb" | "nfl" | "cfb"; onChange: (s: "mlb" | "nfl" | "cfb") => void }) {
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
        <button
          onClick={() => onChange("cfb")}
          className={`px-6 py-2 rounded-lg text-sm font-semibold transition ${sport === "cfb" ? "bg-orange-600 text-white shadow" : "text-muted hover:text-white"}`}
        >
          🏈 CFB
        </button>
      </div>
    </div>
  );
}

export default function Home() {
  // Server always renders MLB first; the saved tab is restored after hydration
  // so the server/client markup matches (avoids React hydration errors from
  // reading localStorage during the initial render).
  const [sport, setSport] = useState<"mlb" | "nfl" | "cfb">("mlb");

  useEffect(() => {
    const saved = localStorage.getItem("ticomlbapp-sport");
    if (saved === "nfl" || saved === "mlb" || saved === "cfb") setSport(saved);
  }, []);

  const changeSport = (s: "mlb" | "nfl" | "cfb") => {
    setSport(s);
    localStorage.setItem("ticomlbapp-sport", s);
  };

  return (
    <>
      <SportTabs sport={sport} onChange={changeSport} />
      {sport === "mlb" ? <MlbDashboard /> : sport === "nfl" ? <NflDashboard /> : <CfbDashboard />}
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
  // Calculation debug view — off unless explicitly enabled.
  const [debug, setDebug] = useState(false);

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

  // Debug view can be enabled straight from the URL (`?debug=1`).
  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).get("debug") === "1");
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

      {/* Line Movement Alerts */}
      <MlbLineMovementAlerts games={data.games} />

      {/* Model Edge Picks */}
      {data.edges && data.edges.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            🎯 Model Edge Picks
            <span className="text-xs text-muted font-normal">
              (ranked by edge + EV + confidence + data quality · Edge = model − fair market)
            </span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.edges.map((edge, i) => (
              <ModelEdgeCard key={`${edge.team}-${edge.opponent}`} edge={edge} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* Top Picks */}
      {data.topPicks.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            🏆 Top Favorite Picks
            <span className="text-xs text-muted font-normal">
              (highest model probability among favorites · value lives in Best Value)
            </span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.topPicks.map((pick, i) => (
              <PickCard key={i} pick={pick} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* Best Value */}
      {data.bestValue && data.bestValue.length > 0 && (
        <section>
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            💰 Best Value
            <span className="text-xs text-muted font-normal">
              (strongest positive EV at the posted price)
            </span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.bestValue.map((pick, i) => (
              <PickCard key={`bv-${i}`} pick={pick} index={i} />
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

      {/* Debug view — off by default */}
      {debug && <DebugPanel data={data} />}

      {/* Footer */}
      <div className="text-center text-xs text-muted pt-8 pb-4 border-t border-slate-800">
        <p>Data sourced from ESPN & MLB Stats API · Not financial advice · Gamble responsibly</p>
        <button
          onClick={() => setDebug(d => !d)}
          className="mt-2 text-slate-600 hover:text-slate-400 transition"
        >
          {debug ? "Hide calculation debug" : "Calculation debug"}
        </button>
      </div>
    </div>
  );
}
