"use client";
import { useEffect, useState } from "react";
import type { NodeRegistration } from "@flodex/protocol";

/** Poll coordinator /nodes every `intervalMs` milliseconds. */
export function useNodes(coordinatorUrl: string, intervalMs = 2000) {
  const [nodes, setNodes] = useState<NodeRegistration[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${coordinatorUrl}/nodes`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as NodeRegistration[];
        if (!cancelled) {
          setNodes(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }

    poll();
    const id = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [coordinatorUrl, intervalMs]);

  return { nodes, error };
}
