import type { BackendType, RequestStatus } from "@flodex/protocol";

/**
 * Unified session record used across the dashboard. Two sources:
 *   - `local`: session the dashboard initiated. We know the prompt + response.
 *   - `remote`: session reported by a node's /activity — CLI, another client,
 *     etc. Only metadata is available; we never see the plaintext.
 */
export interface SessionRecord {
  sessionId: string;
  source: "local" | "remote";
  backend: BackendType;
  nodeUrl: string | null;
  /** Dashboard-side wall-clock start (local) or node-reported start (remote). */
  startedAt: number;
  endedAt: number | null;
  lastUpdate: number;
  status: RequestStatus | "matching" | "pending";
  stepCount: number;
  toolCalls: Array<{
    name: string;
    startedAt: number;
    endedAt: number | null;
    isError: boolean;
  }>;
  lastToolName?: string;
  /** Only present for `source=local`. */
  prompt?: string;
  /** Only present for `source=local`. */
  finalContent?: string;
  errorMessage?: string;
  estimatedTokens: number;
  pricePer1k: number;
}

export function makeLocalSession(args: {
  sessionId: string;
  backend: BackendType;
  prompt: string;
  estimatedTokens: number;
  pricePer1k: number;
}): SessionRecord {
  const now = Date.now();
  return {
    sessionId: args.sessionId,
    source: "local",
    backend: args.backend,
    prompt: args.prompt,
    nodeUrl: null,
    startedAt: now,
    endedAt: null,
    lastUpdate: now,
    status: "pending",
    stepCount: 0,
    toolCalls: [],
    estimatedTokens: args.estimatedTokens,
    pricePer1k: args.pricePer1k,
  };
}

export function estimateCost(s: SessionRecord): number {
  return (s.estimatedTokens / 1000) * s.pricePer1k;
}

export function isInFlight(s: SessionRecord): boolean {
  return s.endedAt === null;
}
