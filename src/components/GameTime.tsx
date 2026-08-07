"use client";

import { useEffect, useState } from "react";

export function GameTime({ startTime, status }: { startTime: string; status: string }) {
  const [now, setNow] = useState(() => Date.now());

  // Tick every 30s so the countdown stays fresh without constant re-renders.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const d = new Date(startTime);
  if (Number.isNaN(d.getTime())) return null;

  const timeLabel = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  // Live games: note when kickoff happened.
  if (status === "live") {
    return <span className="text-xs text-muted">🕐 {timeLabel} start</span>;
  }

  // Final games: show the time with no countdown.
  if (status === "final") {
    return <span className="text-xs text-muted">🕐 {timeLabel}</span>;
  }

  // Scheduled games: show the local start time plus a friendly countdown.
  const diffMs = d.getTime() - now;
  let countdown = "";
  if (diffMs > 0) {
    const mins = Math.max(1, Math.round(diffMs / 60000));
    if (mins < 60) countdown = `in ${mins}m`;
    else {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      countdown = `in ${h}h${m ? ` ${m}m` : ""}`;
    }
  }

  return (
    <span className="text-xs text-muted whitespace-nowrap">
      🕐 {timeLabel}
      {countdown && <span className="text-green-400/80 ml-1">· {countdown}</span>}
    </span>
  );
}
