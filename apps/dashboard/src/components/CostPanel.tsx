"use client";
import type { SessionRecord } from "@/lib/events";
import { estimateCost } from "@/lib/events";

export default function CostPanel({ sessions }: { sessions: SessionRecord[] }) {
  const total = sessions.reduce((sum, s) => sum + estimateCost(s), 0);
  const byBackend = sessions.reduce<Record<string, { count: number; cost: number }>>(
    (acc, s) => {
      const key = s.backend;
      if (!acc[key]) acc[key] = { count: 0, cost: 0 };
      acc[key].count += 1;
      acc[key].cost += estimateCost(s);
      return acc;
    },
    {},
  );

  return (
    <div className="glass rounded-xl p-4 text-xs">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="uppercase tracking-widest text-holo-cyan">spend</span>
        <span className="text-holo-green font-semibold">
          ${total.toFixed(4)}
        </span>
      </div>
      <div className="mb-3 text-[10px] text-fg/40">
        estimate = est. tokens × node price/1K. replace with real token counts later.
      </div>
      <div className="space-y-1">
        {Object.entries(byBackend).map(([backend, agg]) => (
          <div
            key={backend}
            className="flex items-center justify-between border-b border-fg/5 py-1"
          >
            <span className="text-fg/70">{backend}</span>
            <span className="text-fg/60">
              {agg.count} × &nbsp; <span className="text-holo-green">${agg.cost.toFixed(4)}</span>
            </span>
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="text-fg/40">no requests yet</div>
        )}
      </div>
    </div>
  );
}
