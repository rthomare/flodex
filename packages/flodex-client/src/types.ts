import type { AgentResponse, BackendType } from "@flodex/protocol";

export type ToolHandler = (
  input: unknown,
) => Promise<{ content: string; isError: boolean }>;

export type ToolHandlerMap = Record<string, ToolHandler | undefined>;

/**
 * Structured events emitted during an agent loop — used by the dashboard for
 * live visualization (edges, timeline bars, cost tallies) and by the CLI for
 * stderr logging.
 */
export type AgentEvent =
  | { kind: "matched"; nodeUrl: string; backend: BackendType; sessionId: string }
  | { kind: "requestStart"; sessionId: string; attempt: number }
  | { kind: "response"; sessionId: string; response: AgentResponse }
  | { kind: "toolCallStart"; sessionId: string; name: string; input: unknown }
  | { kind: "toolCallEnd"; sessionId: string; name: string; isError: boolean }
  | { kind: "final"; sessionId: string; content: string }
  | { kind: "error"; sessionId: string; message: string };

export type AgentEventHandler = (event: AgentEvent) => void;
