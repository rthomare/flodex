#!/usr/bin/env bun
/**
 * End-to-end test of the full payment-channel flow.
 *
 * Spawns a local anvil chain, deploys MockUSDC + NodeRegistry + JobChannel,
 * pre-funds a node operator + a client wallet, brings up the coordinator
 * and a single node (which auto-registers on-chain), then drives a synthetic
 * client through:
 *
 *   openChannel → encrypted /execute (real LLM) → verify receipt sig
 *     → co-sign update → cooperativeClose → assert USDC balances moved
 *
 * Defaults to the local llama-server backend with a tiny Qwen 0.5B model
 * (free, ~400MB first-run download). Set ANTHROPIC_API_KEY in the env to
 * use the cheaper mock-tee path with `claude-haiku-4-5` instead.
 *
 * Run: `bun run --cwd tests/e2e test`  (or from this dir: `bun channel-flow.ts`)
 *
 * Prereqs in PATH: anvil, forge, cargo, cast.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { base64 } from "@scure/base";
import { sendStep, postAck } from "@flodex/client-lib";
import type { ClientAck } from "@flodex/protocol";

// ---------- constants ----------

const ANVIL_PORT = 8545;
const COORD_PORT = 8765;
const NODE_PORT = 7755;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const COORD_URL = `http://127.0.0.1:${COORD_PORT}`;
const NODE_URL = `http://127.0.0.1:${NODE_PORT}`;
const CHAIN_ID = 31337;

// Anvil's first 3 default accounts (deterministic from the default mnemonic).
const DEPLOYER = {
  privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`,
};
const CLIENT = {
  privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`,
};

// Deterministic addresses produced by Deploy.s.sol from DEPLOYER as account 0
// on a fresh anvil. Order: MockUSDC (nonce 0) → NodeRegistry (nonce 1) →
// JobChannel (nonce 2).
const USDC_ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as `0x${string}`;
const REGISTRY_ADDR = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as `0x${string}`;
const CHANNEL_ADDR = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as `0x${string}`;

const MIN_STAKE = 100_000_000n; // 100 USDC (6 decimals)
const NODE_STAKE = 200_000_000n; // 200 USDC, > MIN_STAKE
const CLIENT_FUND = 50_000_000n; // 50 USDC for the channel
const CHANNEL_DEPOSIT = 10_000_000n; // 10 USDC

// ---------- ABIs (minimal subsets) ----------

const usdcAbi = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
]);

const registryAbi = parseAbi([
  "function isActive(address node) external view returns (bool)",
  "function nodes(address node) external view returns (string url, bytes32 ecdhPubkey, uint8 backendBitmap, uint64 maxTokens, uint256[4] pricePer1k, uint256 stake, bool active)",
]);

const channelAbi = parseAbi([
  "function channelIdOf(address client, address node, uint64 channelNonce) external pure returns (bytes32)",
  "function openChannel(address node, uint64 channelNonce, uint256 deposit) external returns (bytes32)",
  "function cooperativeClose(bytes32 channelId, uint64 nonce, uint256 cumOwed, bytes clientSig, bytes nodeSig) external",
  "function channels(bytes32 channelId) external view returns (address client, address node, uint256 deposit, uint256 latestCumOwed, uint64 latestNonce, uint64 challengeDeadline, uint64 openedAt, uint8 status)",
]);

// ---------- pure crypto helpers (mirroring crates/protocol + crates/crypto) ----------

const CHANNEL_UPDATE_DOMAIN = keccak_256(
  new TextEncoder().encode("flodex-v0-channel-update"),
);

function ethAddressFromCompressedPub(pubHex: string): `0x${string}` {
  const stripped = pubHex.startsWith("0x") ? pubHex.slice(2) : pubHex;
  const point = secp256k1.ProjectivePoint.fromHex(stripped);
  const uncompressed = point.toRawBytes(false); // 65 bytes, 0x04 prefix
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
  buf.set(CHANNEL_UPDATE_DOMAIN, 0);
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
  if (hex.length % 2) throw new Error("hex must be even-length");
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  throw new Error(
    `timed out waiting for ${label} after ${opts.timeoutMs}ms` +
      (lastErr ? ` (last error: ${lastErr})` : ""),
  );
}

function log(...args: unknown[]): void {
  console.log("→", ...args);
}

// ---------- viem clients ----------

const publicClient = createPublicClient({
  chain: { id: CHAIN_ID, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL_RPC] } } },
  transport: http(ANVIL_RPC),
});

const deployerWallet = createWalletClient({
  account: privateKeyToAccount(DEPLOYER.privateKey),
  chain: publicClient.chain,
  transport: http(ANVIL_RPC),
});

const clientWallet = createWalletClient({
  account: privateKeyToAccount(CLIENT.privateKey),
  chain: publicClient.chain,
  transport: http(ANVIL_RPC),
});

// ---------- main ----------

async function main(): Promise<void> {
  // 1. Spawn anvil
  log("starting anvil");
  const anvil = track(
    spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(ANVIL_PORT),
        "--chain-id",
        String(CHAIN_ID),
        "--silent",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    ),
  );
  await waitFor(
    "anvil RPC",
    async () => {
      try {
        const id = await publicClient.getChainId();
        return id === CHAIN_ID;
      } catch {
        return false;
      }
    },
    { timeoutMs: 15_000 },
  );
  log("anvil ready");

  // 2. Deploy contracts via the existing forge script.
  log("deploying contracts");
  await runForgeDeploy();
  await sanityCheckDeployment();

  // 3. Generate the node identity (so we know its eth address up-front) and
  //    pre-fund it before the node spawns.
  const identity = generateIdentity();
  log("node eth address:", identity.ethAddress);

  log("funding node + client with ETH (gas) + USDC");
  // Anvil cheatcode: directly set balance, instant.
  await anvilSetBalance(identity.ethAddress, parseEther("10"));
  await mintUsdc(identity.ethAddress, NODE_STAKE);
  await mintUsdc(CLIENT.address, CLIENT_FUND);

  // 4. Coordinator + node.
  log("starting coordinator");
  const coord = track(
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
        const r = await fetch(`${COORD_URL}/nodes`);
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 60_000 },
  );

  log("starting node (auto-register on-chain)");
  const nodeEnv = buildNodeEnv(identity.path);
  const node = track(
    spawn("cargo", ["run", "-q", "-p", "node"], {
      cwd: repoRoot(),
      env: nodeEnv,
      stdio: ["ignore", "inherit", "inherit"],
    }),
  );
  await waitFor(
    "node /info",
    async () => {
      try {
        const r = await fetch(`${NODE_URL}/info`);
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 90_000, intervalMs: 1000 },
  );
  log("waiting for node to appear active in registry");
  await waitFor(
    "registry.isActive(node)",
    async () => {
      const active = (await publicClient.readContract({
        address: REGISTRY_ADDR,
        abi: registryAbi,
        functionName: "isActive",
        args: [identity.ethAddress],
      })) as boolean;
      return active;
    },
    { timeoutMs: 120_000, intervalMs: 1500 },
  );

  // 5. Resolve the node's actual X25519 ECDH key (advertised via /info).
  const info = (await (await fetch(`${NODE_URL}/info`)).json()) as {
    publicKey: string;
    backends: string[];
  };
  const nodePub = base64.decode(info.publicKey);
  const backend = info.backends[0] as "mock-tee" | "local";
  if (!backend) throw new Error("node has no enabled backends");
  log("backend in use:", backend);

  // 6. Open channel.
  log("client: USDC.approve(channel, MAX) + JobChannel.openChannel(...)");
  const channelId = await openChannel();
  await waitFor(
    "channel Open status",
    async () => {
      const c = await readChannel(channelId);
      return c.status === 1;
    },
    { timeoutMs: 10_000 },
  );

  const balBefore = {
    client: await readUsdc(CLIENT.address),
    node: await readUsdc(identity.ethAddress),
  };
  log("balances before:", { client: balBefore.client.toString(), node: balBefore.node.toString() });

  // 7. Send a single short prompt with the channel id attached.
  log("sending encrypted prompt over /execute");
  const sessionId = crypto.randomUUID();
  const result = await sendStep({
    nodeUrl: NODE_URL,
    backend,
    nodePub,
    sessionId,
    step: { type: "prompt", prompt: "say hi in one word" },
    channelId,
  });
  if (!result.receipt) throw new Error("expected a receipt; got none");
  log("response:", result.response.type === "final" ? result.response.content : `tool: ${result.response.name}`);
  log("receipt:", {
    nonce: result.receipt.update.nonce,
    cumOwed: result.receipt.update.cumOwed,
    sessionId: result.receipt.breakdown.sessionId,
  });

  // 8. Verify the node's signature recovers to the registered node address.
  const canonical = buildCanonicalUpdate(
    channelId,
    BigInt(result.receipt.update.nonce),
    BigInt(result.receipt.update.cumOwed),
  );
  const recovered = await recoverEip191(canonical, result.receipt.nodeSig as `0x${string}`);
  if (recovered.toLowerCase() !== identity.ethAddress.toLowerCase()) {
    throw new Error(
      `node sig recovers to ${recovered} but registered address is ${identity.ethAddress}`,
    );
  }
  log("node sig recovers to expected address ✓");

  // 9. Co-sign the update (the dashboard would do this via wagmi).
  //    The contract verifies `MessageHashUtils.toEthSignedMessageHash(keccak256(canonical))`,
  //    so we have to hash the canonical bytes first and sign the 32-byte
  //    digest. Passing the raw 192-byte payload to signMessage produces
  //    `EIP-191(\n192 + canonical)` — wrong length prefix, doesn't match.
  const inner = keccak_256(canonical);
  const clientSig = await clientWallet.signMessage({
    message: { raw: ("0x" + Buffer.from(inner).toString("hex")) as `0x${string}` },
  });
  const ack: ClientAck = {
    update: result.receipt.update,
    clientSig,
  };

  // 10. Post the ack so the node has it on file (the piggyback path doesn't
  //     fire here because we only sent one request).
  log("POST /ack");
  await postAck(NODE_URL, ack);

  // 11. cooperativeClose.
  log("cooperativeClose");
  const closeHash = await deployerWallet.sendTransaction({
    to: CHANNEL_ADDR,
    data: encodeFunctionData({
      abi: channelAbi,
      functionName: "cooperativeClose",
      args: [
        channelId,
        BigInt(result.receipt.update.nonce),
        BigInt(result.receipt.update.cumOwed),
        clientSig,
        result.receipt.nodeSig as `0x${string}`,
      ],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: closeHash });

  // 12. Assert balances moved.
  // `balBefore` was captured *after* `openChannel` had already locked the
  // deposit, so the client's expected gain on close is the refund
  // (deposit − cumOwed) rather than −cumOwed.
  const balAfter = {
    client: await readUsdc(CLIENT.address),
    node: await readUsdc(identity.ethAddress),
  };
  const cumOwed = BigInt(result.receipt.update.cumOwed);
  const expectedNodeGain = cumOwed;
  const expectedClientGain = CHANNEL_DEPOSIT - cumOwed;

  const nodeDelta = balAfter.node - balBefore.node;
  const clientDelta = balAfter.client - balBefore.client;
  if (nodeDelta !== expectedNodeGain) {
    throw new Error(`node delta ${nodeDelta} ≠ expected ${expectedNodeGain}`);
  }
  if (clientDelta !== expectedClientGain) {
    throw new Error(`client delta ${clientDelta} ≠ expected ${expectedClientGain}`);
  }
  log("USDC moved correctly ✓", { nodeDelta: nodeDelta.toString(), clientDelta: clientDelta.toString() });

  // 13. Channel should be Closed on-chain.
  const finalState = await readChannel(channelId);
  if (finalState.status !== 3) {
    throw new Error(`channel status ${finalState.status} ≠ Closed (3)`);
  }
  log("channel status=Closed ✓");

  console.log("\n✅ e2e channel flow passed");
  killAll();
  process.exit(0);
}

// ---------- supporting impls ----------

function repoRoot(): string {
  // tests/e2e/ → ../../
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
    // Cheap pricing so cumOwed stays small enough not to need >10 USDC of
    // deposit even with longer-than-expected responses.
    FLODEX_NODE_PRICE_MOCK_TEE: "0.001",
    FLODEX_NODE_PRICE_LOCAL: "0.001",
    // Disable the macOS sandbox for the local backend so a missing
    // sandbox-exec doesn't bring the test down.
    FLODEX_SANDBOX: "0",
  };
  // Pick a backend: prefer mock-tee with the cheap Haiku model when an
  // Anthropic key is set; otherwise fall back to a tiny local Qwen.
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
  // Random secp256k1 secret + random X25519 secret.
  const idSeed = secp256k1.utils.randomPrivateKey();
  const ecdhSeed = crypto.getRandomValues(new Uint8Array(32));
  const idHex = Buffer.from(idSeed).toString("hex");
  const ecdhHex = Buffer.from(ecdhSeed).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "flodex-e2e-"));
  const path = join(dir, "identity.json");
  writeFileSync(
    path,
    JSON.stringify({ ecdh_seed: ecdhHex, identity_seed: idHex }, null, 2),
  );
  const compressedPub = compressedPubFromPrivate(idHex);
  return {
    privateKey: ("0x" + idHex) as Hex,
    compressedPub,
    ethAddress: ethAddressFromCompressedPub(compressedPub),
    path,
  };
}

async function runForgeDeploy(): Promise<void> {
  const args = [
    "script",
    "script/Deploy.s.sol:Deploy",
    "--rpc-url",
    ANVIL_RPC,
    "--broadcast",
    "--legacy",
    "--silent",
    "--skip-simulation",
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PRIVATE_KEY: DEPLOYER.privateKey,
    MIN_STAKE: String(MIN_STAKE),
    CHALLENGE_WINDOW: "3600",
    CHANNEL_RECLAIM_TIMEOUT: "86400",
  };
  await runOnce("forge", args, { cwd: join(repoRoot(), "contracts"), env });
}

function runOnce(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

async function sanityCheckDeployment(): Promise<void> {
  const code = await publicClient.getBytecode({ address: CHANNEL_ADDR });
  if (!code || code === "0x") {
    throw new Error(
      `JobChannel not at expected address ${CHANNEL_ADDR}. ` +
        `Did anvil start fresh? Did Deploy.s.sol run from account 0?`,
    );
  }
}

async function anvilSetBalance(addr: `0x${string}`, wei: bigint): Promise<void> {
  // anvil_setBalance is the Hardhat-compat cheatcode for instant funding.
  const res = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [addr, "0x" + wei.toString(16)],
    }),
  });
  const j = (await res.json()) as { error?: { message?: string } };
  if (j.error) throw new Error(`anvil_setBalance: ${j.error.message ?? "unknown"}`);
}

async function mintUsdc(to: `0x${string}`, amount: bigint): Promise<void> {
  const hash = await deployerWallet.sendTransaction({
    to: USDC_ADDR,
    data: encodeFunctionData({
      abi: usdcAbi,
      functionName: "mint",
      args: [to, amount],
    }),
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

async function openChannel(): Promise<`0x${string}`> {
  // approve
  const approveHash = await clientWallet.sendTransaction({
    to: USDC_ADDR,
    data: encodeFunctionData({
      abi: usdcAbi,
      functionName: "approve",
      args: [CHANNEL_ADDR, 2n ** 256n - 1n],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const nodeAddrForChannel = await waitForNodeAddress();
  const channelId = (await publicClient.readContract({
    address: CHANNEL_ADDR,
    abi: channelAbi,
    functionName: "channelIdOf",
    args: [CLIENT.address, nodeAddrForChannel, 0n],
  })) as `0x${string}`;

  const openHash = await clientWallet.sendTransaction({
    to: CHANNEL_ADDR,
    data: encodeFunctionData({
      abi: channelAbi,
      functionName: "openChannel",
      args: [nodeAddrForChannel, 0n, CHANNEL_DEPOSIT],
    }),
  });
  await publicClient.waitForTransactionReceipt({ hash: openHash });
  return channelId;
}

let cachedNodeAddress: `0x${string}` | null = null;
async function waitForNodeAddress(): Promise<`0x${string}`> {
  if (cachedNodeAddress) return cachedNodeAddress;
  // Read from the registry's nodeList: there's only one node.
  const reg = (await publicClient.readContract({
    address: REGISTRY_ADDR,
    abi: parseAbi(["function nodeList(uint256) external view returns (address)"]),
    functionName: "nodeList",
    args: [0n],
  })) as `0x${string}`;
  cachedNodeAddress = reg;
  return reg;
}

interface ChannelView {
  client: `0x${string}`;
  node: `0x${string}`;
  deposit: bigint;
  latestCumOwed: bigint;
  latestNonce: bigint;
  challengeDeadline: bigint;
  openedAt: bigint;
  status: number;
}

async function readChannel(id: `0x${string}`): Promise<ChannelView> {
  const r = (await publicClient.readContract({
    address: CHANNEL_ADDR,
    abi: channelAbi,
    functionName: "channels",
    args: [id],
  })) as unknown as [
    `0x${string}`,
    `0x${string}`,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    number,
  ];
  return {
    client: r[0],
    node: r[1],
    deposit: r[2],
    latestCumOwed: r[3],
    latestNonce: r[4],
    challengeDeadline: r[5],
    openedAt: r[6],
    status: r[7],
  };
}

async function recoverEip191(
  message: Uint8Array,
  sigHex: `0x${string}`,
): Promise<`0x${string}`> {
  // EIP-191: keccak256("\x19Ethereum Signed Message:\n32" || keccak256(message))
  const inner = keccak_256(message);
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");
  const buf = new Uint8Array(prefix.length + 32);
  buf.set(prefix, 0);
  buf.set(inner, prefix.length);
  const digest = keccak_256(buf);
  const sig = sigHex.slice(2);
  const r = sig.slice(0, 64);
  const s = sig.slice(64, 128);
  const v = parseInt(sig.slice(128, 130), 16);
  const recoveryByte = (v - 27) & 1;
  const sigBytes = hexToBytes(r + s);
  const sigObj = secp256k1.Signature.fromCompact(sigBytes).addRecoveryBit(recoveryByte);
  const recovered = sigObj.recoverPublicKey(digest);
  const uncompressed = recovered.toRawBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  return ("0x" + Buffer.from(hash.slice(12)).toString("hex")) as `0x${string}`;
}

main().catch((e) => {
  console.error("\n❌ e2e failed:", e);
  killAll();
  process.exit(1);
});
