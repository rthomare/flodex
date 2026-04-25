"use client";
import type { SessionRecord } from "@/lib/events";

function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60).toString().padStart(2, "0")}s`;
}

export default function SessionDetail({
  session,
}: {
  session: SessionRecord | null;
}) {
  if (!session) {
    return (
      <div className="glass rounded-xl p-4 text-xs text-fg/40">
        session detail — click a request below to inspect
      </div>
    );
  }

  const duration =
    (session.endedAt ?? Date.now()) - session.startedAt;

  return (
    <div className="glass flex-1 overflow-y-auto rounded-xl p-4 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="uppercase tracking-widest text-holo-cyan">session</span>
        <span className="text-[10px] text-fg/40">
          {session.source === "local" ? "dashboard" : "remote"}
        </span>
      </div>

      <Row label="id" value={`${session.sessionId.slice(0, 16)}…`} />
      <Row label="backend" value={session.backend} />
      <Row label="status" value={String(session.status)} />
      <Row label="duration" value={humanDuration(duration)} />
      <Row label="steps" value={String(session.stepCount)} />
      {session.nodeUrl && <Row label="node" value={session.nodeUrl} />}
      {session.lastToolName && (
        <Row label="last tool" value={session.lastToolName} />
      )}
      {session.pricePer1k > 0 && (
        <Row
          label="est. cost"
          value={`$${((session.estimatedTokens / 1000) * session.pricePer1k).toFixed(4)}`}
        />
      )}

      {session.toolCalls.length > 0 && (
        <div className="mt-3 border-t border-fg/10 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-fg/50">
            tool calls
          </div>
          {session.toolCalls.map((tc, i) => (
            <div key={i} className="flex justify-between py-0.5">
              <span className={tc.isError ? "text-holo-red" : "text-holo-amber"}>
                {tc.name}
              </span>
              <span className="text-fg/50 tabular-nums">
                {tc.endedAt
                  ? humanDuration(tc.endedAt - tc.startedAt)
                  : "…"}
              </span>
            </div>
          ))}
        </div>
      )}

      {session.source === "local" && session.prompt && (
        <div className="mt-3 border-t border-fg/10 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-fg/50">
            prompt
          </div>
          <div className="whitespace-pre-wrap text-fg/80">{session.prompt}</div>
        </div>
      )}

      {session.source === "local" && session.finalContent && (
        <div className="mt-3 border-t border-fg/10 pt-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-fg/50">
            response
          </div>
          <div className="whitespace-pre-wrap text-fg/90">
            {session.finalContent}
          </div>
        </div>
      )}

      {session.source === "remote" && (
        <div className="mt-3 rounded bg-fg/5 p-2 text-[10px] leading-relaxed text-fg/50">
          Remote session — the prompt and response are encrypted between the
          client and the node and are not visible to the dashboard. Metadata
          only.
        </div>
      )}

      {session.errorMessage && (
        <div className="mt-3 rounded border border-holo-red/40 bg-holo-red/10 p-2 text-holo-red">
          {session.errorMessage}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-fg/50">{label}</span>
      <span className="truncate text-fg/80">{value}</span>
    </div>
  );
}
