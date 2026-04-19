#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/hashes/utils";
import { base64 } from "@scure/base";
import type {
  AgentResponse,
  AgentStep,
  BackendType,
  EncryptedRequest,
  EncryptedResponse,
  NodeInfo,
} from "@flodex/protocol";

const HKDF_INFO = new TextEncoder().encode("flodex-v0-session-key");

type GlobalOpts = {
  node: string;
  backend: BackendType;
};

type ClientToolResult = { content: string; isError: boolean };

const clientTools: Record<string, (input: unknown) => Promise<ClientToolResult>> = {
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
  .option("-n, --node <url>", "node URL", "http://127.0.0.1:7777")
  .option("-b, --backend <name>", "execution backend", "mock-tee");

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
    const info = await fetchNodeInfo(opts.node);
    const nodePub = base64.decode(info.publicKey);
    const sessionId = crypto.randomUUID();

    let step: AgentStep = { type: "prompt", prompt };

    while (true) {
      const response = await sendStep(opts.node, opts.backend, nodePub, sessionId, step);

      if (response.type === "final") {
        console.log(response.content);
        return;
      }

      console.error(
        `[tool call] ${response.name}(${JSON.stringify(response.input)})`,
      );
      const handler = clientTools[response.name];
      const result = handler
        ? await handler(response.input)
        : { content: `unknown client tool: ${response.name}`, isError: true };
      if (result.isError) {
        console.error(`[tool error] ${result.content}`);
      }
      step = {
        type: "toolResult",
        toolUseId: response.toolUseId,
        content: result.content,
        isError: result.isError,
      };
    }
  });

async function fetchNodeInfo(node: string): Promise<NodeInfo> {
  const res = await fetch(`${node}/info`);
  if (!res.ok) {
    throw new Error(`GET ${node}/info failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as NodeInfo;
}

async function sendStep(
  node: string,
  backend: BackendType,
  nodePub: Uint8Array,
  sessionId: string,
  step: AgentStep,
): Promise<AgentResponse> {
  const clientPriv = x25519.utils.randomPrivateKey();
  const clientPub = x25519.getPublicKey(clientPriv);
  const shared = x25519.getSharedSecret(clientPriv, nodePub);
  const key = hkdf(sha256, shared, new TextEncoder().encode(sessionId), HKDF_INFO, 32);

  const plaintext = new TextEncoder().encode(JSON.stringify(step));
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);

  const req: EncryptedRequest = {
    sessionId,
    clientPublicKey: base64.encode(clientPub),
    nonce: base64.encode(nonce),
    ciphertext: base64.encode(ciphertext),
    backend,
  };

  const res = await fetch(`${node}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(`POST ${node}/execute failed: ${res.status} ${await res.text()}`);
  }

  const enc = (await res.json()) as EncryptedResponse;
  const respNonce = base64.decode(enc.nonce);
  const respCipher = base64.decode(enc.ciphertext);
  const respPlain = xchacha20poly1305(key, respNonce).decrypt(respCipher);
  return JSON.parse(new TextDecoder().decode(respPlain)) as AgentResponse;
}

await program.parseAsync();
