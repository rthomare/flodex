import type { BackendType } from "@flodex/protocol";

/**
 * Per-session state we accumulate in the browser as the agent loop runs.
 * Drives the timeline (durations), cost panel (tokens), and node graph
 * (which edges are currently lit up).
 */
export interface SessionRecord {
  sessionId: string;
  backend: BackendType;
  prompt: string;
  nodeUrl: string | null;
  startedAt: number;
  endedAt: number | null;
  status: "pending" | "matching" | "running" | "waiting-tool" | "final" | "error";
  toolCalls: Array<{
    name: string;
    startedAt: number;
    endedAt: number | null;
    isError: boolean;
  }>;
  finalContent?: string;
  errorMessage?: string;
  estimatedTokens: number;
  pricePer1k: number;
}

export function makeSession(args: {
  sessionId: string;
  backend: BackendType;
  prompt: string;
  estimatedTokens: number;
  pricePer1k: number;
}): SessionRecord {
  return {
    sessionId: args.sessionId,
    backend: args.backend,
    prompt: args.prompt,
    nodeUrl: null,
    startedAt: Date.now(),
    endedAt: null,
    status: "pending",
    toolCalls: [],
    estimatedTokens: args.estimatedTokens,
    pricePer1k: args.pricePer1k,
  };
}

export function estimateCost(s: SessionRecord): number {
  return (s.estimatedTokens / 1000) * s.pricePer1k;
}
