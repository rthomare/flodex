import type { AgentStep, BackendType } from "@flodex/protocol";
import { sendStep } from "./transport.ts";
import type { AgentEventHandler, ToolHandlerMap } from "./types.ts";

/**
 * Drives the client-side outer loop: send prompt → receive AgentResponse →
 * if it's a tool call, run the handler and loop back with a ToolResult →
 * stop when a final answer arrives.
 *
 * Emits structured events for UIs that want to visualize the flow.
 */
export async function runAgentLoop(args: {
  nodeUrl: string;
  nodePub: Uint8Array;
  backend: BackendType;
  sessionId: string;
  prompt: string;
  tools: ToolHandlerMap;
  onEvent?: AgentEventHandler;
}): Promise<string> {
  const { nodeUrl, nodePub, backend, sessionId, prompt, tools, onEvent } = args;

  let step: AgentStep = { type: "prompt", prompt };
  let attempt = 0;

  while (true) {
    attempt += 1;
    onEvent?.({ kind: "requestStart", sessionId, attempt });

    let response;
    try {
      response = await sendStep(nodeUrl, backend, nodePub, sessionId, step);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onEvent?.({ kind: "error", sessionId, message });
      throw e;
    }

    onEvent?.({ kind: "response", sessionId, response });

    if (response.type === "final") {
      onEvent?.({ kind: "final", sessionId, content: response.content });
      return response.content;
    }

    // toolCall
    const handler = tools[response.name];
    onEvent?.({
      kind: "toolCallStart",
      sessionId,
      name: response.name,
      input: response.input,
    });

    const result = handler
      ? await handler(response.input)
      : {
          content: `unknown client tool: ${response.name}`,
          isError: true,
        };

    onEvent?.({
      kind: "toolCallEnd",
      sessionId,
      name: response.name,
      isError: result.isError,
    });

    step = {
      type: "toolResult",
      toolUseId: response.toolUseId,
      content: result.content,
      isError: result.isError,
    };
  }
}
