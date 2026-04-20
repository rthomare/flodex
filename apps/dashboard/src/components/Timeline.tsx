"use client";
import type { SessionRecord } from "@/lib/events";

export default function Timeline({
  sessions,
  now,
}: {
  sessions: SessionRecord[];
  now: number;
}) {
  if (sessions.length === 0) {
    return (
      <div className="glass h-full rounded-xl p-4 text-xs text-white/40">
        timeline — no requests yet
      </div>
    );
  }

  const start = Math.min(...sessions.map((s) => s.startedAt));
  const end = Math.max(
    ...sessions.map((s) => s.endedAt ?? now),
    start + 1000,
  );
  const span = Math.max(end - start, 1);

  const lane = (timestamp: number) => ((timestamp - start) / span) * 100;

  return (
    <div className="glass flex h-full flex-col rounded-xl p-4">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-widest text-holo-cyan">
        <span>timeline</span>
        <span className="text-[10px] normal-case tracking-normal text-white/40">
          {((span) / 1000).toFixed(1)}s span
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.map((s) => {
          const barStart = lane(s.startedAt);
          const barEnd = lane(s.endedAt ?? now);
          const barWidth = Math.max(barEnd - barStart, 0.5);
          const color =
            s.status === "error"
              ? "bg-holo-red/60 border-holo-red"
              : s.status === "final"
              ? "bg-holo-green/30 border-holo-green"
              : "bg-holo-cyan/20 border-holo-cyan";
          return (
            <div key={s.sessionId} className="mb-3">
              <div className="mb-1 flex items-center justify-between text-[10px] text-white/50">
                <span className="truncate">
                  <span className="text-holo-cyan">{s.backend}</span> · {s.prompt.slice(0, 80)}
                </span>
                <span>{s.status}</span>
              </div>
              <div className="relative h-5 rounded bg-black/40">
                <div
                  className={`absolute h-full rounded border ${color}`}
                  style={{ left: `${barStart}%`, width: `${barWidth}%` }}
                />
                {s.toolCalls.map((tc, i) => {
                  const x = lane(tc.startedAt);
                  return (
                    <div
                      key={i}
                      title={`${tc.name}${tc.isError ? " (error)" : ""}`}
                      className={`absolute top-1/2 -translate-y-1/2 h-3 w-1 ${
                        tc.isError ? "bg-holo-red" : "bg-holo-amber"
                      }`}
                      style={{ left: `${x}%` }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
