#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { base64 } from "@scure/base";
import {
  fetchNodeInfo,
  matchJob,
  runAgentLoop,
  type ToolHandlerMap,
} from "@flodex/client-lib";
import type { BackendType, JobSpec } from "@flodex/protocol";

type GlobalOpts = {
  node: string;
  backend: BackendType;
  coordinator?: string;
  maxTokens: string;
  maxPrice: string;
};

const clientTools: ToolHandlerMap = {
  async read_local_file(input) {
    const path = (input as { path?: unknown })?.path;
    if (typeof path !== "string") {
      return { content: "read_local_file: `path` must be a string", isError: true };
    }
    try {
      return { content: readFileSync(path, "utf8"), isError: false };
    } catch (e) {
      return { content: `read_local_file(${path}): ${String(e)}`, isError: true };
    }
  },
};

const program = new Command()
  .name("flodex")
  .description("flodex client CLI")
  .option("-n, --node <url>", "node URL (ignored if --coordinator is set)", "http://127.0.0.1:7777")
  .option("-b, --backend <name>", "execution backend", "mock-tee")
  .option("--coordinator <url>", "coordinator URL for node discovery")
  .option("--max-tokens <n>", "estimated tokens for the job", "4000")
  .option("--max-price <n>", "max price per 1K tokens", "1.0");

program
  .command("info")
  .description("fetch node public key and supported backends")
  .action(async () => {
    const opts = program.opts<GlobalOpts>();
    const info = await fetchNodeInfo(opts.node);
    console.log(JSON.stringify(info, null, 2));
  });

program
  .command("send <prompt>")
  .description("send an encrypted prompt through the agent loop")
  .action(async (prompt: string) => {
    const opts = program.opts<GlobalOpts>();
    const target = await resolveNode(opts);
    console.error(`[target] ${target.url}`);

    const nodePub = base64.decode(target.publicKey);
    const sessionId = crypto.randomUUID();

    const result = await runAgentLoop({
      nodeUrl: target.url,
      nodePub,
      backend: opts.backend,
      sessionId,
      prompt,
      tools: clientTools,
      onEvent: (ev) => {
        if (ev.kind === "toolCallStart") {
          console.error(`[tool call] ${ev.name}(${JSON.stringify(ev.input)})`);
        } else if (ev.kind === "toolCallEnd" && ev.isError) {
          console.error(`[tool error] ${ev.name}`);
        }
      },
    });
    console.log(result);
  });

async function resolveNode(
  opts: GlobalOpts,
): Promise<{ url: string; publicKey: string }> {
  if (!opts.coordinator) {
    const info = await fetchNodeInfo(opts.node);
    return { url: opts.node, publicKey: info.publicKey };
  }
  const spec: JobSpec = {
    backend: opts.backend,
    estimatedTokens: Number.parseInt(opts.maxTokens, 10),
    maxPricePer1k: Number.parseFloat(opts.maxPrice),
  };
  const match = await matchJob(opts.coordinator, spec);
  return { url: match.url, publicKey: match.publicKey };
}

await program.parseAsync();
