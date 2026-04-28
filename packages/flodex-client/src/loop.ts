import type {
  AgentResponse,
  AgentStep,
  BackendType,
  ClientAck,
  NodeSignedReceipt,
} from "@flodex/protocol";
import { sendStep, type SendStepResult } from "./transport.ts";
import type { AgentEventHandler, ToolHandler, ToolHandlerMap } from "./types.ts";

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
  /** When set, every request carries this channel id; receipts come back. */
  channelId?: `0x${string}`;
  /** Optional ack signer. Called on each receipt; returned ack is queued
   *  for the next request's `prev_ack`. Without it, the node receives no
   *  acks until the dashboard posts one explicitly via `postAck`. */
  signAck?: (receipt: NodeSignedReceipt) => Promise<ClientAck>;
}): Promise<string> {
  const { nodeUrl, nodePub, backend, sessionId, prompt, tools, onEvent, channelId, signAck } =
    args;

  let step: AgentStep = { type: "prompt", prompt };
  let attempt = 0;
  let prevAck: ClientAck | undefined;

  while (true) {
    attempt += 1;
    onEvent?.({ kind: "requestStart", sessionId, attempt });

    let response: AgentResponse;
    let receipt: NodeSignedReceipt | undefined;
    try {
      const result: SendStepResult = await sendStep({
        nodeUrl,
        backend,
        nodePub,
        sessionId,
        step,
        channelId,
        prevAck,
      });
      response = result.response;
      receipt = result.receipt;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onEvent?.({ kind: "error", sessionId, message });
      throw e;
    }

    onEvent?.({ kind: "response", sessionId, response });

    if (receipt) {
      let ack: ClientAck | undefined;
      if (signAck) {
        try {
          ack = await signAck(receipt);
          prevAck = ack;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          onEvent?.({ kind: "error", sessionId, message: `signAck: ${message}` });
        }
      }
      onEvent?.({ kind: "receipt", sessionId, receipt, ack });
    }

    if (response.type === "final") {
      onEvent?.({ kind: "final", sessionId, content: response.content });
      return response.content;
    }

    // toolCall
    const handler: ToolHandler | undefined = tools[response.name];
    onEvent?.({
      kind: "toolCallStart",
      sessionId,
      name: response.name,
      input: response.input,
    });

    const result: { content: string; isError: boolean } = handler
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
