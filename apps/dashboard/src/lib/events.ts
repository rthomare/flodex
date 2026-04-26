import type { BackendType, RequestStatus, Usage } from "@flodex/protocol";

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
  /**
   * Real token usage summed across every agent-loop round trip the dashboard
   * has observed for this session. Only tracked for `source=local` — remote
   * sessions don't report usage to observers (it'd leak workload size).
   */
  actualUsage: Usage | null;
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
    actualUsage: null,
  };
}

export function addUsage(a: Usage | null, b: Usage): Usage {
  if (!a) {
    return {
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationInputTokens: b.cacheCreationInputTokens ?? null,
      cacheReadInputTokens: b.cacheReadInputTokens ?? null,
    };
  }
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: sumOpt(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    cacheReadInputTokens: sumOpt(a.cacheReadInputTokens, b.cacheReadInputTokens),
  };
}

function sumOpt(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Total billable tokens (sums every category — cache reads/writes count too). */
export function totalTokens(u: Usage): number {
  return (
    u.inputTokens +
    u.outputTokens +
    (u.cacheCreationInputTokens ?? 0) +
    (u.cacheReadInputTokens ?? 0)
  );
}

/**
 * Real cost when we have observed usage; falls back to the user's pre-flight
 * estimate (est. tokens × pricePer1k) before any provider response lands.
 * Cache reads/writes get a single flat per-1K rate today — the on-chain
 * receipt format will need explicit weights, but that's a later step.
 */
export function sessionCost(s: SessionRecord): { value: number; real: boolean } {
  if (s.actualUsage) {
    return {
      value: (totalTokens(s.actualUsage) / 1000) * s.pricePer1k,
      real: true,
    };
  }
  return {
    value: (s.estimatedTokens / 1000) * s.pricePer1k,
    real: false,
  };
}

export function isInFlight(s: SessionRecord): boolean {
  return s.endedAt === null;
}
