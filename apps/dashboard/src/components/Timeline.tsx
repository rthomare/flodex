"use client";
import { useEffect, useState } from "react";
import type { SessionRecord } from "@/lib/events";

function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60).toString().padStart(2, "0")}s`;
}

function statusTint(status: SessionRecord["status"]): string {
  switch (status) {
    case "error":
      return "bg-holo-red/40 border-holo-red";
    case "final":
      return "bg-holo-green/30 border-holo-green";
    case "waiting-tool":
      return "bg-holo-amber/30 border-holo-amber";
    case "matching":
    case "pending":
      return "bg-holo-cyan/10 border-holo-cyan/40";
    default:
      return "bg-holo-cyan/20 border-holo-cyan";
  }
}

export default function Timeline({
  sessions,
  selectedSessionId,
  onSelect,
}: {
  sessions: SessionRecord[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
}) {
  // Local RAF clock so in-flight segments grow at 60fps. Dashboard's 200ms
  // tick produced visible stair-stepping — we only need to tick while
  // something is actually running.
  const hasInFlight = sessions.some((s) => s.endedAt === null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasInFlight) {
      setNow(Date.now());
      return;
    }
    let raf = 0;
    const tick = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hasInFlight]);

  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const durations = sorted.map((s) => Math.max((s.endedAt ?? now) - s.startedAt, 1));
  const total = durations.reduce((a, b) => a + b, 0) || 1;

  const span =
    sorted.length === 0
      ? 0
      : Math.max(...sorted.map((s) => s.endedAt ?? now)) - sorted[0].startedAt;

  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-fg/40">
        <span className="text-holo-cyan">requests</span>
        <span>
          {(span / 1000).toFixed(1)}s span · {sessions.length} session
          {sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex h-full w-full overflow-hidden rounded bg-track">
        {sorted.length === 0 ? (
          <div className="flex w-full items-center justify-center text-[10px] text-fg/30">
            no requests yet
          </div>
        ) : (
          sorted.map((s, i) => {
            const selected = s.sessionId === selectedSessionId;
            const pct = (durations[i] / total) * 100;
            return (
              <button
                key={s.sessionId}
                type="button"
                onClick={() => onSelect(selected ? null : s.sessionId)}
                title={`${s.sessionId.slice(0, 8)}… · ${s.backend} · ${s.status} · ${humanDuration(durations[i])}`}
                className={`relative h-full overflow-hidden border-r border-fg/30 text-left transition ${statusTint(
                  s.status,
                )} ${
                  selected
                    ? "ring-2 ring-holo-cyan ring-inset brightness-125"
                    : "hover:brightness-125"
                }`}
                style={{ width: `${pct}%`, minWidth: 6 }}
              >
                <span className="block truncate px-1.5 text-[10px] leading-[20px] text-fg/85">
                  {s.source === "local" ? "◆" : "○"} {s.sessionId.slice(0, 6)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
