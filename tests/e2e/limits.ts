#!/usr/bin/env bun
/**
 * Two scenarios on the same anvil + coordinator + node setup:
 *
 *   A. Multi-step session — two prompts in a single sessionId, exercising
 *      cumulative receipts (nonce 1 then 2; cum_owed monotonically growing).
 *      Co-sign the latest receipt and cooperativeClose with it.
 *
 *   B. DoS protection — open a separate channel with a deposit smaller than
 *      one round trip's cost. The first request still goes through (the
 *      contract caps payout at deposit), but the *second* must be rejected
 *      with HTTP 402 before the node touches the LLM. That's the cap the
 *      node enforces against a client that would otherwise extract free
 *      compute by ignoring its own deposit.
 *
 * Run from repo root: `bun run --cwd tests/e2e limits` (or `bun limits.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
  parseEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { base64 } from "@scure/base";
import { sendStep, postAck } from "@flodex/client-lib";
import type { ClientAck, NodeSignedReceipt } from "@flodex/protocol";

// ---------- constants ----------

const ANVIL_PORT = 8545;
const COORD_PORT = 8765;
const NODE_PORT = 7755;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const COORD_URL = `http://127.0.0.1:${COORD_PORT}`;
const NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
const CHAIN_ID = 31337;

const DEPLOYER = {
  privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`,
};
// Use TWO clients: one for the healthy multi-step channel, one for the DoS
// channel. Different msg.sender → different channelId → independent state.
const CLIENT_A = {
  privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`,
};
const CLIENT_B = {
  privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
  address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as `0x${string}`,
};

const USDC_ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`;
const REGISTRY_ADDR = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`;
const CHANNEL_ADDR = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as `0x${string}`;

const MIN_STAKE = 100_000_000n;
const NODE_STAKE = 200_000_000n;
const HEALTHY_DEPOSIT = 10_000_000n; // 10 USDC, plenty for 2 prompts
const TINY_DEPOSIT = 100n; // 0.0001 USDC — smaller than one prompt's cost

// ---------- minimal ABIs ----------

const usdcAbi = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
]);

const channelAbi = parseAbi([
  "function channelIdOf(address client, address node, uint64 channelNonce) external pure returns (bytes32)",
  "function openChannel(address node, uint64 channelNonce, uint256 deposit) external returns (bytes32)",
  "function cooperativeClose(bytes32 channelId, uint64 nonce, uint256 cumOwed, bytes clientSig, bytes nodeSig) external",
  "function channels(bytes32 channelId) external view returns (address client, address node, uint256 deposit, uint256 latestCumOwed, uint64 latestNonce, uint64 challengeDeadline, uint64 openedAt, uint8 status)",
]);

const registryAbi = parseAbi([
  "function isActive(address node) external view returns (bool)",
  "function nodeList(uint256) external view returns (address)",
]);

// ---------- crypto helpers ----------

const CHANNEL_UPDATE_DOMAIN_HASH = keccak_256(
  new TextEncoder().encode("flodex-v0-channel-update"),
);

function ethAddressFromCompressedPub(pubHex: string): `0x${string}` {
  const stripped = pubHex.startsWith("0x") ? pubHex.slice(2) : pubHex;
  const point = secp256k1.ProjectivePoint.fromHex(stripped);
  const uncompressed = point.toRawBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  return ("0x" + Buffer.from(hash.slice(12)).toString("hex")) as `0x${string}`;
}

function compressedPubFromPrivate(privHex: string): string {
  const stripped = privHex.startsWith("0x") ? privHex.slice(2) : privHex;
  return Buffer.from(secp256k1.getPublicKey(stripped, true)).toString("hex");
}

function buildCanonicalUpdate(
  channelId: `0x${string}`,
  nonce: bigint,
  cumOwed: bigint,
): Uint8Array {
  const buf = new Uint8Array(192);
  buf.set(CHANNEL_UPDATE_DOMAIN_HASH, 0);
  buf.set(u256BeBytes(BigInt(CHAIN_ID)), 32);
  buf.set(hexToBytes(CHANNEL_ADDR.slice(2)), 64 + 12);
  buf.set(hexToBytes(channelId.slice(2)), 96);
  buf.set(u256BeBytes(nonce), 128);
  buf.set(u256BeBytes(cumOwed), 160);
  return buf;
}

function u256BeBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ---------- process management ----------

const procs: ChildProcess[] = [];
function track(p: ChildProcess): ChildProcess {
  procs.push(p);
  return p;
}
function killAll(): void {
  for (const p of procs) {
    if (!p.killed) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
  }
}
process.on("exit", killAll);
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});

// ---------- helpers ----------

const log = (...a: unknown[]) => console.log("→", ...a);

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const interval = opts.intervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r) return r as T;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}: ${lastErr ?? "<no error>"}`);
}

const publicClient = createPublicClient({
  chain: {
    id: CHAIN_ID,
    name: "anvil",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [ANVIL_RPC] } },
  },
  transport: http(ANVIL_RPC),
});
const deployerWallet = createWalletClient({
  account: privateKeyToAccount(DEPLOYER.privateKey),
  chain: publicClient.chain,
  transport: http(ANVIL_RPC),
});
const walletA = createWalletClient({
  account: privateKeyToAccount(CLIENT_A.privateKey),
  chain: publicClient.chain,
  transport: http(ANVIL_RPC),
});
const walletB = createWalletClient({
  account: privateKeyToAccount(CLIENT_B.privateKey),
  chain: publicClient.chain,
  transport: http(ANVIL_RPC),
});

// ---------- main ----------

async function main(): Promise<void> {
  log("starting anvil");
  track(
    spawn(
      "anvil",
      ["--host", "127.0.0.1", "--port", String(ANVIL_PORT), "--chain-id", String(CHAIN_ID), "--silent"],
      { stdio: ["ignore", "ignore", "inherit"] },
    ),
  );
  await waitFor("anvil RPC", async () => (await publicClient.getChainId()) === CHAIN_ID, {
    timeoutMs: 15_000,
  });

  log("deploying contracts");
  await runForgeDeploy();

  const identity = generateIdentity();
  log("node eth address:", identity.ethAddress);

  log("funding node + clients");
  await anvilSetBalance(identity.ethAddress, parseEther("10"));
  await mintUsdc(identity.ethAddress, NODE_STAKE);
  await mintUsdc(CLIENT_A.address, 50_000_000n);
  await mintUsdc(CLIENT_B.address, 50_000_000n);

  log("starting coordinator");
  track(
    spawn("cargo", ["run", "-q", "-p", "coordinator"], {
      cwd: repoRoot(),
      env: { ...process.env, FLODEX_COORDINATOR_ADDR: `127.0.0.1:${COORD_PORT}` },
      stdio: ["ignore", "inherit", "inherit"],
    }),
  );
  await waitFor(
    "coordinator",
    async () => {
      try {
        return (await fetch(`${COORD_URL}/nodes`)).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 60_000 },
  );

  log("starting node");
  track(
    spawn("cargo", ["run", "-q", "-p", "node"], {
      cwd: repoRoot(),
      env: buildNodeEnv(identity.path),
      stdio: ["ignore", "inherit", "inherit"],
    }),
  );
  await waitFor(
    "node /info",
    async () => {
      try {
        return (await fetch(`${NODE_URL}/info`)).ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 90_000, intervalMs: 1000 },
  );
  await waitFor(
    "registry.isActive(node)",
    async () =>
      (await publicClient.readContract({
        address: REGISTRY_ADDR,
        abi: registryAbi,
        functionName: "isActive",
        args: [identity.ethAddress],
      })) as boolean,
    { timeoutMs: 120_000, intervalMs: 1500 },
  );

  const info = (await (await fetch(`${NODE_URL}/info`)).json()) as {
    publicKey: string;
    backends: string[];
  };
  const nodePub = base64.decode(info.publicKey);
  const backend = info.backends[0] as "mock-tee" | "local";
  if (!backend) throw new Error("node has no enabled backends");
  log("backend:", backend);

  // ====================================================================
  // Scenario A — multi-step session
  // ====================================================================
  await scenarioMultiStep(nodePub, backend, identity.ethAddress);

  // ====================================================================
  // Scenario B — DoS protection
  // ====================================================================
  await scenarioDos(nodePub, backend, identity.ethAddress);

  console.log("\n✅ both limit scenarios passed");
  killAll();
  process.exit(0);
}

// ====================================================================
// Scenario A
// ====================================================================
async function scenarioMultiStep(
  nodePub: Uint8Array,
  backend: "mock-tee" | "local",
  nodeAddress: `0x${string}`,
): Promise<void> {
  console.log("\n═══ A. multi-step session ═══");

  log("approve + openChannel (10 USDC)");
  await approveUsdc(walletA, CHANNEL_ADDR, 2n ** 256n - 1n);
  const channelId = await openChannel(walletA, CLIENT_A.address, nodeAddress, 0n, HEALTHY_DEPOSIT);

  const sessionId = crypto.randomUUID();

  log("prompt #1");
  const r1 = await sendStep({
    nodeUrl: NODE_URL,
    backend,
    nodePub,
    sessionId,
    step: { type: "prompt", prompt: "say hi" },
    channelId,
  });
  if (!r1.receipt) throw new Error("scenarioA: missing receipt #1");
  if (BigInt(r1.receipt.update.nonce) !== 1n) {
    throw new Error(`scenarioA: receipt #1 nonce=${r1.receipt.update.nonce}, want 1`);
  }
  log("  receipt #1:", { nonce: r1.receipt.update.nonce, cumOwed: r1.receipt.update.cumOwed });

  log("prompt #2 (same session)");
  const r2 = await sendStep({
    nodeUrl: NODE_URL,
    backend,
    nodePub,
    sessionId,
    step: { type: "prompt", prompt: "now say bye" },
    channelId,
  });
  if (!r2.receipt) throw new Error("scenarioA: missing receipt #2");
  if (BigInt(r2.receipt.update.nonce) !== 2n) {
    throw new Error(`scenarioA: receipt #2 nonce=${r2.receipt.update.nonce}, want 2`);
  }
  if (BigInt(r2.receipt.update.cumOwed) <= BigInt(r1.receipt.update.cumOwed)) {
    throw new Error(
      `scenarioA: cum_owed didn't grow: ${r1.receipt.update.cumOwed} → ${r2.receipt.update.cumOwed}`,
    );
  }
  log("  receipt #2:", { nonce: r2.receipt.update.nonce, cumOwed: r2.receipt.update.cumOwed });
  log("  cum_owed monotonic ✓ (",
      r1.receipt.update.cumOwed, "→", r2.receipt.update.cumOwed, ")");

  // Sign the LATEST receipt; the contract takes whichever nonce we submit.
  const ack = await signReceipt(walletA, r2.receipt);
  await postAck(NODE_URL, ack);

  const balBefore = {
    client: await readUsdc(CLIENT_A.address),
    node: await readUsdc(nodeAddress),
  };
  await cooperativeClose(channelId, r2.receipt, ack);
  const balAfter = {
    client: await readUsdc(CLIENT_A.address),
    node: await readUsdc(nodeAddress),
  };
  const cumOwed = BigInt(r2.receipt.update.cumOwed);
  const expectedNodeGain = cumOwed;
  const expectedClientGain = HEALTHY_DEPOSIT - cumOwed;
  if (balAfter.node - balBefore.node !== expectedNodeGain) {
    throw new Error(`A: node delta wrong (${balAfter.node - balBefore.node} ≠ ${expectedNodeGain})`);
  }
  if (balAfter.client - balBefore.client !== expectedClientGain) {
    throw new Error(
      `A: client delta wrong (${balAfter.client - balBefore.client} ≠ ${expectedClientGain})`,
    );
  }
  log("USDC moved correctly ✓ — node +", cumOwed.toString(), ", client +",
      (HEALTHY_DEPOSIT - cumOwed).toString());
}

// ====================================================================
// Scenario B
// ====================================================================
async function scenarioDos(
  nodePub: Uint8Array,
  backend: "mock-tee" | "local",
  nodeAddress: `0x${string}`,
): Promise<void> {
  console.log("\n═══ B. DoS protection ═══");

  log(`approve + openChannel (${TINY_DEPOSIT} base units = 0.0001 USDC — under one round trip)`);
  await approveUsdc(walletB, CHANNEL_ADDR, 2n ** 256n - 1n);
  const channelId = await openChannel(walletB, CLIENT_B.address, nodeAddress, 0n, TINY_DEPOSIT);

  const sessionId = crypto.randomUUID();

  log("prompt #1 (expected to slip through; node only checks BEFORE the LLM call)");
  let firstReceipt: NodeSignedReceipt | null = null;
  try {
    const r = await sendStep({
      nodeUrl: NODE_URL,
      backend,
      nodePub,
      sessionId,
      step: { type: "prompt", prompt: "hi" },
      channelId,
    });
    firstReceipt = r.receipt ?? null;
    log("  served — receipt:", {
      nonce: r.receipt?.update.nonce,
      cumOwed: r.receipt?.update.cumOwed,
    });
    if (!firstReceipt) throw new Error("first request returned no receipt");
    if (BigInt(firstReceipt.update.cumOwed) <= TINY_DEPOSIT) {
      log(`  WARNING: cum_owed (${firstReceipt.update.cumOwed}) didn't exceed deposit (${TINY_DEPOSIT}) — backend cost too low to test the cap`);
    }
  } catch (e) {
    // Also acceptable: node refused immediately if the implementation tightens
    // the gate to pre-charge a worst-case estimate.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("402")) {
      throw new Error(`B: first request failed but not with 402: ${msg}`);
    }
    log("  refused immediately (402) — also fine");
  }

  log("prompt #2 (cum_owed should now exceed deposit → expect 402)");
  let blocked = false;
  try {
    const r = await sendStep({
      nodeUrl: NODE_URL,
      backend,
      nodePub,
      sessionId,
      step: { type: "prompt", prompt: "again" },
      channelId,
    });
    log("  UNEXPECTED success — receipt:", r.receipt?.update);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("402")) {
      throw new Error(`B: second request failed but not with 402:\n  ${msg}`);
    }
    if (!/exhausted|exceed|deposit/i.test(msg)) {
      log(`  WARNING: 402 but message doesn't reference the cap: ${msg}`);
    }
    blocked = true;
    log("  blocked with 402 ✓");
  }
  if (!blocked) {
    throw new Error("B: second request was supposed to be blocked but got through");
  }

  // Sanity: channel still works for cooperativeClose with the first receipt
  // (contract caps payout at deposit anyway).
  if (firstReceipt) {
    const ack = await signReceipt(walletB, firstReceipt);
    await postAck(NODE_URL, ack);
    const balBefore = {
      client: await readUsdc(CLIENT_B.address),
      node: await readUsdc(nodeAddress),
    };
    await cooperativeClose(channelId, firstReceipt, ack);
    const balAfter = {
      client: await readUsdc(CLIENT_B.address),
      node: await readUsdc(nodeAddress),
    };
    // Node gets min(cumOwed, deposit) = TINY_DEPOSIT. Client gets nothing back.
    const nodeDelta = balAfter.node - balBefore.node;
    if (nodeDelta !== TINY_DEPOSIT) {
      throw new Error(`B: node should be paid the full (capped) deposit ${TINY_DEPOSIT}, got ${nodeDelta}`);
    }
    log(`closed: node paid ${nodeDelta} (capped at deposit) ✓`);
  }
}

// ---------- supporting impls ----------

function repoRoot(): string {
  return new URL("../..", import.meta.url).pathname;
}

function buildNodeEnv(identityPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLODEX_NODE_ADDR: `127.0.0.1:${NODE_PORT}`,
    FLODEX_NODE_URL: NODE_URL,
    FLODEX_COORDINATOR: COORD_URL,
    FLODEX_CHAIN_ID: String(CHAIN_ID),
    FLODEX_RPC_URL: ANVIL_RPC,
    FLODEX_NODE_IDENTITY_PATH: identityPath,
    FLODEX_NODE_STAKE: String(NODE_STAKE),
    FLODEX_NODE_PRICE_MOCK_TEE: "0.001",
    FLODEX_NODE_PRICE_LOCAL: "0.001",
    FLODEX_SANDBOX: "0",
  };
  if (process.env.ANTHROPIC_API_KEY) {
    env.FLODEX_NODE_MODEL = process.env.FLODEX_NODE_MODEL ?? "claude-haiku-4-5";
  } else {
    env.FLODEX_LLAMA_MODEL =
      process.env.FLODEX_LLAMA_MODEL ??
      "hf://bartowski/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf";
  }
  return env;
}

interface Identity {
  privateKey: Hex;
  compressedPub: string;
  ethAddress: `0x${string}`;
  path: string;
}

function generateIdentity(): Identity {
  const idSeed = secp256k1.utils.randomPrivateKey();
  const ecdhSeed = crypto.getRandomValues(new Uint8Array(32));
  const idHex = Buffer.from(idSeed).toString("hex");
  const ecdhHex = Buffer.from(ecdhSeed).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "flodex-e2e-"));
  const path = join(dir, "identity.json");
  writeFileSync(path, JSON.stringify({ ecdh_seed: ecdhHex, identity_seed: idHex }, null, 2));
  const compressedPub = compressedPubFromPrivate(idHex);
  return {
    privateKey: ("0x" + idHex) as Hex,
    compressedPub,
    ethAddress: ethAddressFromCompressedPub(compressedPub),
    path,
  };
}

async function runForgeDeploy(): Promise<void> {
  await runOnce(
    "forge",
    [
      "script",
      "script/Deploy.s.sol:Deploy",
      "--rpc-url",
      ANVIL_RPC,
      "--broadcast",
      "--legacy",
      "--silent",
      "--skip-simulation",
    ],
    {
      cwd: join(repoRoot(), "contracts"),
      env: {
        ...process.env,
        PRIVATE_KEY: DEPLOYER.privateKey,
        MIN_STAKE: String(MIN_STAKE),
        CHALLENGE_WINDOW: "3600",
        CHANNEL_RECLAIM_TIMEOUT: "86400",
      },
    },
  );
}

function runOnce(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function anvilSetBalance(addr: `0x${string}`, wei: bigint): Promise<void> {
  const r = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [addr, "0x" + wei.toString(16)],
    }),
  });
  const j = (await r.json()) as { error?: { message?: string } };
  if (j.error) throw new Error(`anvil_setBalance: ${j.error.message}`);
}

async function mintUsdc(to: `0x${string}`, amount: bigint): Promise<void> {
  const hash = await deployerWallet.sendTransaction({
    to: USDC_ADDR,
    data: encodeFunctionData({ abi: usdcAbi, functionName: "mint", args: [to, amount] }),
  });
  await publicClient.waitForTransactionReceipt({ hash });
}
async function readUsdc(addr: `0x${string}`): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC_ADDR,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [addr],
  })) as bigint;
}

async function approveUsdc(
  wallet: typeof walletA,
  spender: `0x${string}`,
  amount: bigint,
): Promise<void> {
  const hash = await wallet.sendTransaction({
    to: USDC_ADDR,
    data: encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [spender, amount] }),
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function openChannel(
  wallet: typeof walletA,
  client: `0x${string}`,
  node: `0x${string}`,
  nonce: bigint,
  deposit: bigint,
): Promise<`0x${string}`> {
  const id = (await publicClient.readContract({
    address: CHANNEL_ADDR,
    abi: channelAbi,
    functionName: "channelIdOf",
    args: [client, node, nonce],
  })) as `0x${string}`;
  const hash = await wallet.sendTransaction({
    to: CHANNEL_ADDR,
    data: encodeFunctionData({
      abi: channelAbi,
      functionName: "openChannel",
      args: [node, nonce, deposit],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return id;
}

async function signReceipt(
  wallet: typeof walletA,
  receipt: NodeSignedReceipt,
): Promise<ClientAck> {
  const canonical = buildCanonicalUpdate(
    receipt.update.channelId as `0x${string}`,
    BigInt(receipt.update.nonce),
    BigInt(receipt.update.cumOwed),
  );
  const inner = keccak_256(canonical);
  const sig = await wallet.signMessage({
    message: { raw: ("0x" + Buffer.from(inner).toString("hex")) as `0x${string}` },
  });
  return { update: receipt.update, clientSig: sig };
}

async function cooperativeClose(
  channelId: `0x${string}`,
  receipt: NodeSignedReceipt,
  ack: ClientAck,
): Promise<void> {
  const hash = await deployerWallet.sendTransaction({
    to: CHANNEL_ADDR,
    data: encodeFunctionData({
      abi: channelAbi,
      functionName: "cooperativeClose",
      args: [
        channelId,
        BigInt(receipt.update.nonce),
        BigInt(receipt.update.cumOwed),
        ack.clientSig as `0x${string}`,
        receipt.nodeSig as `0x${string}`,
      ],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

main().catch((e) => {
  console.error("\n❌ limits failed:", e);
  killAll();
  process.exit(1);
});
