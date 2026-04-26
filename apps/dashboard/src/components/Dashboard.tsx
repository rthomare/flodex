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
import { addUsage, makeLocalSession, type SessionRecord } from "@/lib/events";
import NodeGraph, { type ActiveRequest } from "./NodeGraph";
import RequestForm from "./RequestForm";
import Timeline from "./Timeline";
import CostPanel from "./CostPanel";
import SessionDetail from "./SessionDetail";
import OnChainStatus from "./OnChainStatus";
import { DEFAULT_CHAIN_ID } from "@/lib/chain";

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

// Default coordinator URL: the demo network's hosted coordinator. Override
// via `NEXT_PUBLIC_COORDINATOR_URL` at build time, or just edit the field in
// the dashboard header for ad-hoc local-coordinator testing.
const DEFAULT_COORDINATOR_URL =
  process.env.NEXT_PUBLIC_COORDINATOR_URL ?? "https://flodex-dry-sun-2419.fly.dev";

export default function Dashboard() {
  const [coordinatorUrl, setCoordinatorUrl] = useState(DEFAULT_COORDINATOR_URL);
  const { theme, toggle: toggleTheme } = useTheme();
  const { nodes: rawNodes, error: nodesError } = useNodes(coordinatorUrl);
  const { entries: activityEntries, aliveUrls } = useNodeActivity(rawNodes);
  // Coordinator entries linger up to ~30s after a node dies (heartbeat
  // timeout). Filter through the activity hook's own liveness probe so dead
  // nodes drop off the canvas in ~2.5s instead.
  const nodes = useMemo(
    () => rawNodes.filter((n) => aliveUrls.has(n.url)),
    [rawNodes, aliveUrls],
  );

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
            const usage = ev.response.usage;
            patchLocal(sessionId, (s) => ({
              ...s,
              stepCount: s.stepCount + 1,
              lastUpdate: t,
              actualUsage: addUsage(s.actualUsage, usage),
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
    <main className="relative h-screen w-screen overflow-hidden">
      {/* Full-viewport graph canvas — sits behind every panel. */}
      <div className="absolute inset-0">
        <NodeGraph
          nodes={nodes}
          activeRequests={activeRequests}
          selectedPubKey={selectedPubKey}
          onSelect={setSelectedPubKey}
          theme={theme}
        />
      </div>

      {/* Header strip overlay. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center justify-between p-4">
        <div className="pointer-events-auto">
          <div className="text-xs uppercase tracking-widest text-holo-cyan">
            flodex
          </div>
          <div className="text-sm text-fg/70">
            {nodes.length} node{nodes.length === 1 ? "" : "s"} registered
            {nodesError && <span className="ml-2 text-holo-red">· {nodesError}</span>}
          </div>
        </div>
        <div className="pointer-events-auto flex items-center gap-2 text-xs">
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

      {/* Left rail — request form + selected node detail. */}
      <aside className="pointer-events-auto absolute bottom-20 left-4 top-20 z-10 flex w-80 flex-col gap-3 overflow-y-auto">
        <RequestForm nodes={nodes} onSend={handleSend} disabled={sending} />
        {selectedNode && (
          <NodeDetail
            node={selectedNode}
            onClose={() => setSelectedPubKey(null)}
          />
        )}
      </aside>

      {/* Right rail — on-chain status, cost, selected session. */}
      <aside className="pointer-events-auto absolute bottom-20 right-4 top-20 z-10 flex w-80 flex-col gap-3 overflow-y-auto">
        <OnChainStatus chainId={DEFAULT_CHAIN_ID} />
        <CostPanel sessions={sessions} />
        <SessionDetail session={selectedSession} />
      </aside>

      {/* Bottom timeline overlay. */}
      <div className="pointer-events-auto absolute inset-x-0 bottom-0 z-10 h-16 px-4 pb-3">
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
        actualUsage: null,
      });
    }
  }

  return Array.from(bySession.values()).sort((a, b) => b.startedAt - a.startedAt);
}

function sessionsToActiveRequests(
  sessions: SessionRecord[],
  now: number,
): ActiveRequest[] {
  const FADE_MS = 1500;
  const out: ActiveRequest[] = [];
  for (const s of sessions) {
    if (!s.nodeUrl) continue;

    // 1) Forward request (client → node).
    const endedRecently = s.endedAt !== null && now - s.endedAt < FADE_MS;
    if (s.endedAt === null || endedRecently) {
      out.push({
        nodeUrl: s.nodeUrl,
        sessionId: s.sessionId,
        backend: s.backend,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        status: s.status,
        lastToolName: s.lastToolName,
        source: s.source,
        kind: "request",
        label: s.backend,
      });
    }

    // 2) Tool calls (node → client). For dashboard-initiated sessions we
    // have explicit start/end timestamps in `toolCalls[]`. For remote (CLI)
    // sessions we only see the node's `waiting-tool` status flag, so we
    // synthesize an in-flight entry for the duration the status is set.
    if (s.source === "local") {
      for (const tc of s.toolCalls) {
        const tcEnded = tc.endedAt !== null && now - tc.endedAt < FADE_MS;
        if (tc.endedAt === null || tcEnded) {
          out.push({
            nodeUrl: s.nodeUrl,
            sessionId: s.sessionId,
            backend: s.backend,
            startedAt: tc.startedAt,
            endedAt: tc.endedAt,
            status: tc.isError ? "error" : "running",
            lastToolName: tc.name,
            source: s.source,
            kind: "tool-call",
            label: `tool: ${tc.name}`,
          });
        }
      }
    } else if (s.status === "waiting-tool" && s.lastToolName) {
      out.push({
        nodeUrl: s.nodeUrl,
        sessionId: s.sessionId,
        backend: s.backend,
        startedAt: s.lastUpdate,
        endedAt: null,
        status: "running",
        lastToolName: s.lastToolName,
        source: s.source,
        kind: "tool-call",
        label: `tool: ${s.lastToolName}`,
      });
    }
  }
  return out;
}
