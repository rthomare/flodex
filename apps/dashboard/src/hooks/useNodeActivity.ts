"use client";
import { useEffect, useRef, useState } from "react";
import type {
  NodeActivityReport,
  NodeRegistration,
  RequestRecord,
} from "@flodex/protocol";

/** Flattened tuple — (which node) + (what's happening there). */
export interface NodeActivityEntry {
  nodeUrl: string;
  record: RequestRecord;
}

/**
 * Polls `GET /activity` on every known node and returns a flat list of
 * {nodeUrl, record} entries. Includes recently-completed requests (the node
 * retains them briefly) so fast CLI requests aren't missed between polls.
 */
export function useNodeActivity(
  nodes: NodeRegistration[],
  intervalMs = 400,
): NodeActivityEntry[] {
  const [entries, setEntries] = useState<NodeActivityEntry[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const current = nodesRef.current;
      if (current.length === 0) {
        if (!cancelled) setEntries((prev) => (prev.length === 0 ? prev : []));
        return;
      }

      const per = await Promise.all(
        current.map(async (n) => {
          try {
            const res = await fetch(`${n.url}/activity`, { cache: "no-store" });
            if (!res.ok) return [];
            const body = (await res.json()) as NodeActivityReport;
            return body.requests.map((record) => ({ nodeUrl: n.url, record }));
          } catch {
            return [];
          }
        }),
      );
      if (cancelled) return;

      const next = per.flat();
      setEntries((prev) => (equalEntries(prev, next) ? prev : next));
    }

    poll();
    const id = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return entries;
}

function equalEntries(a: NodeActivityEntry[], b: NodeActivityEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ar = a[i];
    const br = b[i];
    if (
      ar.nodeUrl !== br.nodeUrl ||
      ar.record.sessionId !== br.record.sessionId ||
      ar.record.lastUpdateMs !== br.record.lastUpdateMs ||
      ar.record.status !== br.record.status ||
      ar.record.stepCount !== br.record.stepCount ||
      ar.record.endedAtMs !== br.record.endedAtMs
    )
      return false;
  }
  return true;
}
