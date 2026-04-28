"use client";
import { useEffect, useRef, useState } from "react";
import type {
  NodeActivityReport,
  NodeRegistration,
  RequestRecord,
} from "@fldx/protocol";

/** Flattened tuple — (which node) + (what's happening there). */
export interface NodeActivityEntry {
  nodeUrl: string;
  record: RequestRecord;
}

/**
 * `lastOk` is the wall-clock of the last 200 from `/activity`; `firstSeen` is
 * when we first saw this node URL in the coordinator listing. Together they
 * let us optimistically show a freshly-registered node for a short window
 * before its first probe completes, then drop it if it never answers.
 */
interface Liveness {
  lastOk: number;
  firstSeen: number;
}

const ALIVE_GRACE_MS = 2500; // ~6 missed polls at 400ms cadence
const NEW_NODE_GRACE_MS = 1500;

/**
 * Polls `GET /activity` on every known node and returns:
 *   - `entries`: flat (nodeUrl, record) list across all alive nodes
 *   - `aliveUrls`: set of node URLs we've reached recently. The dashboard
 *     filters its node list through this so coord entries that are still
 *     waiting on heartbeat-timeout don't ghost on the canvas.
 */
export function useNodeActivity(
  nodes: NodeRegistration[],
  intervalMs = 400,
): { entries: NodeActivityEntry[]; aliveUrls: Set<string> } {
  const [entries, setEntries] = useState<NodeActivityEntry[]>([]);
  const [aliveUrls, setAliveUrls] = useState<Set<string>>(new Set());

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const livenessRef = useRef<Map<string, Liveness>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const current = nodesRef.current;
      const livenessMap = livenessRef.current;

      // Seed Liveness entries for any newly-known URLs.
      for (const n of current) {
        if (!livenessMap.has(n.url)) {
          livenessMap.set(n.url, { lastOk: 0, firstSeen: Date.now() });
        }
      }

      if (current.length === 0) {
        if (!cancelled) {
          setEntries((prev) => (prev.length === 0 ? prev : []));
          setAliveUrls((prev) => (prev.size === 0 ? prev : new Set()));
        }
        return;
      }

      const per = await Promise.all(
        current.map(async (n) => {
          try {
            const res = await fetch(`${n.url}/activity`, { cache: "no-store" });
            if (!res.ok) {
              return { url: n.url, ok: false, entries: [] as NodeActivityEntry[] };
            }
            const body = (await res.json()) as NodeActivityReport;
            return {
              url: n.url,
              ok: true,
              entries: body.requests.map((record) => ({ nodeUrl: n.url, record })),
            };
          } catch {
            return { url: n.url, ok: false, entries: [] as NodeActivityEntry[] };
          }
        }),
      );
      if (cancelled) return;

      const after = Date.now();
      for (const r of per) {
        if (r.ok) {
          const liv = livenessMap.get(r.url) ?? { lastOk: 0, firstSeen: after };
          liv.lastOk = after;
          livenessMap.set(r.url, liv);
        }
      }

      const currentUrls = new Set(current.map((n) => n.url));
      const alive = new Set<string>();
      for (const url of currentUrls) {
        const liv = livenessMap.get(url);
        if (!liv) continue;
        if (liv.lastOk > 0 && after - liv.lastOk <= ALIVE_GRACE_MS) {
          alive.add(url);
        } else if (
          liv.lastOk === 0 &&
          after - liv.firstSeen <= NEW_NODE_GRACE_MS
        ) {
          alive.add(url); // optimistic during initial probe window
        }
      }

      // GC liveness records for URLs no longer in the coord listing.
      for (const url of [...livenessMap.keys()]) {
        if (!currentUrls.has(url)) livenessMap.delete(url);
      }

      setAliveUrls((prev) => (eqSet(prev, alive) ? prev : alive));
      const next = per.flatMap((r) => r.entries);
      setEntries((prev) => (equalEntries(prev, next) ? prev : next));
    }

    poll();
    const id = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  return { entries, aliveUrls };
}

function eqSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
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
