"use client";
import { useEffect, useMemo, useState } from "react";
import { base64 } from "@scure/base";
import {
  matchJob,
  runAgentLoop,
  type ToolHandlerMap,
} from "@flodex/client-lib";
import type { BackendType, NodeRegistration } from "@flodex/protocol";
import { useNodes } from "@/hooks/useNodes";
import {
  useNodeActivity,
  type NodeActivityEntry,
} from "@/hooks/useNodeActivity";
import { useTheme } from "@/hooks/useTheme";
import { makeLocalSession, type SessionRecord } from "@/lib/events";
import NodeGraph, { type ActiveRequest } from "./NodeGraph";
import RequestForm from "./RequestForm";
import Timeline from "./Timeline";
import CostPanel from "./CostPanel";
import SessionDetail from "./SessionDetail";

// In-browser tool handlers. Local-fs tools don't work from a browser tab,
// so we surface a clear error back to the node and carry on.
const browserTools: ToolHandlerMap = {
  async read_local_file() {
    return {
      content:
        "read_local_file is unavailable from the dashboard — run this prompt via the CLI.",
      isError: true,
    };
  },
};

export default function Dashboard() {
  const [coordinatorUrl, setCoordinatorUrl] = useState("http://127.0.0.1:8000");
  const { theme, toggle: toggleTheme } = useTheme();
  const { nodes, error: nodesError } = useNodes(coordinatorUrl);
  const activityEntries = useNodeActivity(nodes);

  const [localSessions, setLocalSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedPubKey, setSelectedPubKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const sessions = useMemo(
    () => mergeSessions(localSessions, activityEntries),
    [localSessions, activityEntries],
  );

  const activeRequests = useMemo<ActiveRequest[]>(
    () => sessionsToActiveRequests(sessions, now),
    [sessions, now],
  );

  const selectedSession = useMemo(
    () => sessions.find((s) => s.sessionId === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const selectedNode = useMemo<NodeRegistration | null>(
    () => nodes.find((n) => n.publicKey === selectedPubKey) ?? null,
    [nodes, selectedPubKey],
  );

  function patchLocal(sessionId: string, fn: (s: SessionRecord) => SessionRecord) {
    setLocalSessions((prev) =>
      prev.map((s) => (s.sessionId === sessionId ? fn(s) : s)),
    );
  }

  async function handleSend(args: {
    backend: BackendType;
    prompt: string;
    estimatedTokens: number;
    maxPricePer1k: number;
  }) {
    const sessionId = crypto.randomUUID();
    const record = makeLocalSession({
      sessionId,
      backend: args.backend,
      prompt: args.prompt,
      estimatedTokens: args.estimatedTokens,
      pricePer1k: 0,
    });
    record.status = "matching";
    setLocalSessions((prev) => [record, ...prev]);
    setSelectedSessionId(sessionId);
    setSending(true);

    try {
      const match = await matchJob(coordinatorUrl, {
        backend: args.backend,
        estimatedTokens: args.estimatedTokens,
        maxPricePer1k: args.maxPricePer1k,
      });

      const matchedNode = nodes.find((n) => n.publicKey === match.publicKey);
      const pricePer1k =
        matchedNode?.pricing.find((p) => p.backend === args.backend)?.pricePer1k ??
        0;

      patchLocal(sessionId, (s) => ({
        ...s,
        status: "running",
        nodeUrl: match.url,
        pricePer1k,
      }));

      const nodePub = base64.decode(match.publicKey);
      await runAgentLoop({
        nodeUrl: match.url,
        nodePub,
        backend: args.backend,
        sessionId,
        prompt: args.prompt,
        tools: browserTools,
        onEvent: (ev) => {
          const t = Date.now();
          if (ev.kind === "toolCallStart") {
            patchLocal(sessionId, (s) => ({
              ...s,
              status: "waiting-tool",
              lastToolName: ev.name,
              lastUpdate: t,
              toolCalls: [
                ...s.toolCalls,
                { name: ev.name, startedAt: t, endedAt: null, isError: false },
              ],
            }));
          } else if (ev.kind === "toolCallEnd") {
            patchLocal(sessionId, (s) => ({
              ...s,
              status: "running",
              lastUpdate: t,
              toolCalls: s.toolCalls.map((tc, i, arr) =>
                i === arr.length - 1
                  ? { ...tc, endedAt: t, isError: ev.isError }
                  : tc,
              ),
            }));
          } else if (ev.kind === "final") {
            patchLocal(sessionId, (s) => ({
              ...s,
              status: "final",
              finalContent: ev.content,
              endedAt: t,
              lastUpdate: t,
            }));
          } else if (ev.kind === "error") {
            patchLocal(sessionId, (s) => ({
              ...s,
              status: "error",
              errorMessage: ev.message,
              endedAt: t,
              lastUpdate: t,
            }));
          } else if (ev.kind === "response") {
            patchLocal(sessionId, (s) => ({
              ...s,
              stepCount: s.stepCount + 1,
              lastUpdate: t,
            }));
          }
        },
      });
    } catch (e) {
      patchLocal(sessionId, (s) => ({
        ...s,
        status: "error",
        errorMessage: e instanceof Error ? e.message : String(e),
        endedAt: Date.now(),
      }));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="flex h-screen flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-holo-cyan">
            flodex
          </div>
          <div className="text-sm text-fg/70">
            {nodes.length} node{nodes.length === 1 ? "" : "s"} registered
            {nodesError && <span className="ml-2 text-holo-red">· {nodesError}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-fg/50">coordinator</label>
          <input
            value={coordinatorUrl}
            onChange={(e) => setCoordinatorUrl(e.target.value)}
            className="w-64 rounded px-2 py-1"
          />
          <button
            type="button"
            onClick={toggleTheme}
            title={`switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="rounded border border-holo-cyan/40 bg-track px-2 py-1 text-[10px] uppercase tracking-widest text-holo-cyan transition hover:bg-holo-cyan/10"
          >
            {theme === "dark" ? "☾ dark" : "☀ light"}
          </button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-12 gap-3 overflow-hidden">
        <aside className="col-span-3 flex flex-col gap-3 overflow-y-auto">
          <RequestForm nodes={nodes} onSend={handleSend} disabled={sending} />
          {selectedNode && (
            <NodeDetail
              node={selectedNode}
              onClose={() => setSelectedPubKey(null)}
            />
          )}
        </aside>

        <section className="col-span-6 min-h-0">
          <NodeGraph
            nodes={nodes}
            activeRequests={activeRequests}
            selectedPubKey={selectedPubKey}
            onSelect={setSelectedPubKey}
            theme={theme}
          />
        </section>

        <aside className="col-span-3 flex flex-col gap-3 overflow-hidden">
          <CostPanel sessions={sessions} />
          <SessionDetail session={selectedSession} />
        </aside>
      </div>

      <div className="h-12">
        <Timeline
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
        />
      </div>
    </main>
  );
}

function NodeDetail({
  node,
  onClose,
}: {
  node: NodeRegistration;
  onClose: () => void;
}) {
  return (
    <div className="glass rounded-xl p-4 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="uppercase tracking-widest text-holo-cyan">node</span>
        <button
          type="button"
          onClick={onClose}
          className="text-fg/40 hover:text-white"
        >
          ×
        </button>
      </div>
      <Row label="pubkey" value={`${node.publicKey.slice(0, 12)}…`} />
      <Row label="url" value={node.url} />
      <Row label="backends" value={node.backends.join(", ")} />
      <Row label="max tokens" value={node.maxTokens.toLocaleString()} />
      <div className="mt-2 border-t border-fg/10 pt-2">
        <div className="mb-1 text-fg/50">pricing ($/1K)</div>
        {node.pricing.map((p) => (
          <Row key={p.backend} label={p.backend} value={p.pricePer1k.toFixed(4)} />
        ))}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-fg/50">{label}</span>
      <span className="text-fg/80">{value}</span>
    </div>
  );
}

/**
 * Merge local dashboard-initiated sessions with node-reported activity
 * entries. Local sessions take precedence (they have prompt + response text);
 * remote entries fill in sessions we didn't initiate.
 */
function mergeSessions(
  local: SessionRecord[],
  activity: NodeActivityEntry[],
): SessionRecord[] {
  const bySession = new Map<string, SessionRecord>();
  for (const s of local) bySession.set(s.sessionId, s);

  for (const { nodeUrl, record } of activity) {
    const existing = bySession.get(record.sessionId);
    if (existing) {
      // Merge node's authoritative timing + status into our local session
      bySession.set(record.sessionId, {
        ...existing,
        nodeUrl: existing.nodeUrl ?? nodeUrl,
        stepCount: Math.max(existing.stepCount, record.stepCount),
        lastToolName: record.lastToolName ?? existing.lastToolName,
        lastUpdate: Math.max(existing.lastUpdate, record.lastUpdateMs),
        endedAt:
          record.endedAtMs !== null
            ? (existing.endedAt ?? record.endedAtMs)
            : existing.endedAt,
      });
    } else {
      bySession.set(record.sessionId, {
        sessionId: record.sessionId,
        source: "remote",
        backend: record.backend,
        nodeUrl,
        startedAt: record.startedAtMs,
        endedAt: record.endedAtMs,
        lastUpdate: record.lastUpdateMs,
        status: record.status,
        stepCount: record.stepCount,
        toolCalls: [],
        lastToolName: record.lastToolName ?? undefined,
        estimatedTokens: 0,
        pricePer1k: 0,
      });
    }
  }

  return Array.from(bySession.values()).sort((a, b) => b.startedAt - a.startedAt);
}

function sessionsToActiveRequests(
  sessions: SessionRecord[],
  now: number,
): ActiveRequest[] {
  const out: ActiveRequest[] = [];
  for (const s of sessions) {
    if (!s.nodeUrl) continue;
    // Render a ball if in-flight OR if completed within the last 1.5s
    // (so the ball snaps to the node + fades instead of vanishing).
    const endedRecently = s.endedAt !== null && now - s.endedAt < 1500;
    if (s.endedAt !== null && !endedRecently) continue;
    out.push({
      nodeUrl: s.nodeUrl,
      sessionId: s.sessionId,
      backend: s.backend,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      lastToolName: s.lastToolName,
      source: s.source,
    });
  }
  return out;
}
