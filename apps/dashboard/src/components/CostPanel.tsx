"use client";
import type { SessionRecord } from "@/lib/events";
import { sessionCost } from "@/lib/events";

export default function CostPanel({ sessions }: { sessions: SessionRecord[] }) {
  let total = 0;
  let totalReal = 0;
  let realCount = 0;
  const byBackend: Record<string, { count: number; cost: number; real: boolean }> = {};

  for (const s of sessions) {
    const { value, real } = sessionCost(s);
    total += value;
    if (real) {
      totalReal += value;
      realCount += 1;
    }
    const key = s.backend;
    if (!byBackend[key]) byBackend[key] = { count: 0, cost: 0, real: true };
    byBackend[key].count += 1;
    byBackend[key].cost += value;
    if (!real) byBackend[key].real = false;
  }

  const allReal = sessions.length > 0 && realCount === sessions.length;

  return (
    <div className="glass rounded-xl p-4 text-xs">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="uppercase tracking-widest text-holo-cyan">spend</span>
        <span className="text-holo-green font-semibold">
          ${total.toFixed(4)}
        </span>
      </div>
      <div className="mb-3 text-[10px] text-fg/40">
        {sessions.length === 0
          ? "no requests yet"
          : allReal
            ? "real token usage × node price/1K"
            : `${realCount}/${sessions.length} sessions on real tokens — others estimated until first response`}
      </div>
      <div className="space-y-1">
        {Object.entries(byBackend).map(([backend, agg]) => (
          <div
            key={backend}
            className="flex items-center justify-between border-b border-fg/5 py-1"
          >
            <span className="text-fg/70">{backend}</span>
            <span className="text-fg/60">
              {agg.count} ×&nbsp;
              <span className="text-holo-green">${agg.cost.toFixed(4)}</span>
              {!agg.real && <span className="ml-1 text-fg/40">(est)</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
