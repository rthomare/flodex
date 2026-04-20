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
import { makeSession, type SessionRecord } from "@/lib/events";
import NodeGraph from "./NodeGraph";
import RequestForm from "./RequestForm";
import Timeline from "./Timeline";
import CostPanel from "./CostPanel";

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
  const [coordinatorUrl, setCoordinatorUrl] = useState(
    "http://127.0.0.1:8000",
  );
  const { nodes, error: nodesError } = useNodes(coordinatorUrl);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedPubKey, setSelectedPubKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);

  // Tick for timeline bars to track "still running" sessions.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const activeNodeUrls = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.nodeUrl && (s.status === "running" || s.status === "waiting-tool")) {
        set.add(s.nodeUrl);
      }
    }
    return set;
  }, [sessions]);

  const selectedNode = useMemo<NodeRegistration | null>(
    () => nodes.find((n) => n.publicKey === selectedPubKey) ?? null,
    [nodes, selectedPubKey],
  );

  function patch(sessionId: string, fn: (s: SessionRecord) => SessionRecord) {
    setSessions((prev) =>
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
    const record = makeSession({
      sessionId,
      backend: args.backend,
      prompt: args.prompt,
      estimatedTokens: args.estimatedTokens,
      pricePer1k: 0,
    });
    record.status = "matching";
    setSessions((prev) => [record, ...prev]);
    setSending(true);

    try {
      const match = await matchJob(coordinatorUrl, {
        backend: args.backend,
        estimatedTokens: args.estimatedTokens,
        maxPricePer1k: args.maxPricePer1k,
      });

      const matchedNode = nodes.find((n) => n.publicKey === match.publicKey);
      const pricePer1k =
        matchedNode?.pricing.find((p) => p.backend === args.backend)?.pricePer1k ?? 0;

      patch(sessionId, (s) => ({
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
          if (ev.kind === "toolCallStart") {
            patch(sessionId, (s) => ({
              ...s,
              status: "waiting-tool",
              toolCalls: [
                ...s.toolCalls,
                {
                  name: ev.name,
                  startedAt: Date.now(),
                  endedAt: null,
                  isError: false,
                },
              ],
            }));
          } else if (ev.kind === "toolCallEnd") {
            patch(sessionId, (s) => ({
              ...s,
              status: "running",
              toolCalls: s.toolCalls.map((tc, i, arr) =>
                i === arr.length - 1
                  ? { ...tc, endedAt: Date.now(), isError: ev.isError }
                  : tc,
              ),
            }));
          } else if (ev.kind === "final") {
            patch(sessionId, (s) => ({
              ...s,
              status: "final",
              finalContent: ev.content,
              endedAt: Date.now(),
            }));
          } else if (ev.kind === "error") {
            patch(sessionId, (s) => ({
              ...s,
              status: "error",
              errorMessage: ev.message,
              endedAt: Date.now(),
            }));
          }
        },
      });
    } catch (e) {
      patch(sessionId, (s) => ({
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
          <div className="text-sm text-white/70">
            {nodes.length} node{nodes.length === 1 ? "" : "s"} registered
            {nodesError && (
              <span className="ml-2 text-holo-red">· {nodesError}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-white/50">coordinator</label>
          <input
            value={coordinatorUrl}
            onChange={(e) => setCoordinatorUrl(e.target.value)}
            className="w-64 rounded px-2 py-1"
          />
        </div>
      </header>

      <div className="grid flex-1 grid-cols-12 gap-3 overflow-hidden">
        <aside className="col-span-3 flex flex-col gap-3 overflow-y-auto">
          <RequestForm nodes={nodes} onSend={handleSend} disabled={sending} />
          {selectedNode && (
            <NodeDetail node={selectedNode} onClose={() => setSelectedPubKey(null)} />
          )}
        </aside>

        <section className="col-span-6 min-h-0">
          <NodeGraph
            nodes={nodes}
            activeNodeUrls={activeNodeUrls}
            selectedPubKey={selectedPubKey}
            onSelect={setSelectedPubKey}
          />
        </section>

        <aside className="col-span-3 flex flex-col gap-3 overflow-hidden">
          <CostPanel sessions={sessions} />
          <LatestFinal sessions={sessions} />
        </aside>
      </div>

      <div className="h-56">
        <Timeline sessions={sessions} now={now} />
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
          className="text-white/40 hover:text-white"
        >
          ×
        </button>
      </div>
      <Row label="pubkey" value={`${node.publicKey.slice(0, 12)}…`} />
      <Row label="url" value={node.url} />
      <Row label="backends" value={node.backends.join(", ")} />
      <Row label="max tokens" value={node.maxTokens.toLocaleString()} />
      <div className="mt-2 border-t border-white/10 pt-2">
        <div className="mb-1 text-white/50">pricing ($/1K)</div>
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
      <span className="text-white/50">{label}</span>
      <span className="text-white/80">{value}</span>
    </div>
  );
}

function LatestFinal({ sessions }: { sessions: SessionRecord[] }) {
  const latestFinal = sessions.find((s) => s.status === "final");
  if (!latestFinal) {
    return (
      <div className="glass rounded-xl p-4 text-xs text-white/40">
        latest response — none yet
      </div>
    );
  }
  return (
    <div className="glass flex-1 overflow-y-auto rounded-xl p-4 text-xs">
      <div className="mb-2 flex items-center justify-between uppercase tracking-widest text-holo-cyan">
        <span>latest response</span>
        <span className="text-[10px] text-white/40 normal-case tracking-normal">
          {latestFinal.backend}
        </span>
      </div>
      <div className="mb-2 text-white/50">→ {latestFinal.prompt}</div>
      <div className="whitespace-pre-wrap text-white/90">
        {latestFinal.finalContent}
      </div>
    </div>
  );
}
