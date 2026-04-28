# CLAUDE.md

Guidance for Claude Code sessions working in this repo. Prefer this over
reconstruction from git history. See `README.md` for the user-facing overview.

---

## Vision

Flodex is a privacy-first, decentralized LLM execution network. Clients send
end-to-end encrypted requests; nodes run an agent loop against a pluggable
execution backend; a thin coordinator helps clients discover nodes without
becoming a centralized routing point. The thesis is that encrypted transport +
replaceable trust tiers (mock TEE, local LLM, FHE, real TEE) lets an AI task
flow through different privacy/cost regimes without leaking abstractions or
content. The economic layer (USDC stake + escrow) lives on Base.

---

## Current state

**Working end-to-end:**

- X25519 + HKDF-SHA256 + XChaCha20-Poly1305 transport encryption.
- **secp256k1 identity** persisted at `~/.flodex/node/identity.json`. ECDSA-
  signed `NodeRegistration` + `NodeHeartbeat`, verified by the coordinator.
- `ExecutionBackend` trait + `ChatProvider` trait + Anthropic ↔ OpenAI
  translation. Two live backends: `mock-tee` (Claude Opus 4.7) and `local`
  (sandboxed llama-server, GGUF from HF).
- Agent loop with cross-boundary client-side tools; session state preserved
  across tool round trips.
- **Real per-round-trip token Usage** (input/output/cache) carried on every
  `AgentResponse` and accumulated per session; dashboard shows real spend
  with an "(est)" fallback before the first response lands.
- Coordinator endpoints: `/nodes/register`, `/nodes/heartbeat`, `/nodes`,
  `/jobs/match` (first-match).
- macOS sandbox (`sandbox-exec`, `deny network-outbound`) around llama-server.
- Tools: `current_time` (node), `web_fetch` (node), `read_local_file` (client).
- TS CLI + Next.js dashboard (d3-force graph, on-chain status panel via viem,
  cost panel, timeline).
- **On-chain layer (Base Sepolia)**: `NodeRegistry` deployed; `JobChannel`
  (payment-channel escrow) implemented + Foundry-tested (29 tests across
  registry + channel) but **not yet redeployed** — old `JobEscrow` was
  removed in the channel rewrite. `MockUSDC` for local Anvil.
- **Batched-receipt protocol**: per-(client, node) channels; node signs
  cumulative `ChannelUpdate` (EIP-191) on every round trip; client
  co-signs via the dashboard's wallet; on `cooperativeClose` the highest
  bilaterally-signed state settles in one tx (1k requests → 1 settle).
- **Dashboard wallet UX**: RainbowKit + wagmi connect button, `useChannel`
  hook (open / sign-receipt / cooperative-close), `ChannelPanel` UI.
  `runAgentLoop` accepts a `channelId` and surfaces receipts via
  `onEvent({kind: "receipt"})`. Dashboard passes `signAck` so every
  receipt is auto-signed as it arrives (bad-debt bounded to one round
  trip; trade-off is one wallet popup per receipt until session keys
  land).
- **Auto-register at node startup**: hand-rolled JSON-RPC + RLP +
  EIP-1559 tx signing in `apps/node/src/eth/` (no alloy/ethers, stays
  on Rust 1.74). When `FLODEX_CHAIN_ID` selects a chain with a registry,
  startup runs `isActive` → if absent, `USDC.approve` + `register`. Falls
  back gracefully on RPC error (cast-send escape hatch still documented).
- **Bidding (standing offers)**: `Bid` protocol type signed via the same
  SHA-256 + 64-byte ECDSA scheme as registrations. Coordinator hosts a
  per-(node, backend) bid book at `POST/GET /bids` with TTL eviction.
  `/jobs/match` prefers the lowest active bid, falls back to registration
  pricing. Node spawns `bid_loop` posting every 60s (180s validity).
- **Demo network**: coordinator hosted on Fly.io. Local dashboard works
  against the hosted coordinator.

**Stubs / placeholders / not started:**

- `BackendType::Fhe`, `BackendType::Mcp` — no implementation.
- Linux / Windows sandbox — unsandboxed with a warning.
- No real TEE attestation, FHE compute, or zkML.
- **`JobChannel` redeploy pending.** New contract is implemented + tested
  (29 forge tests pass) but the deployed Sepolia address is still null.
  Operator runs `forge script Deploy.s.sol` (instructions in README) and
  pastes the resulting address into both `packages/chains/src/index.ts`
  and `apps/node/src/chains.rs`. Until then the dashboard's wallet flow
  has nothing to point at; off-chain routing still works.
- **Session-key receipts.** Today the dashboard auto-signs every receipt
  via the wallet, so each round trip pops MetaMask. Real seamless UX
  needs session keys (in-browser key, on-chain authorization). Punted to
  v0.1 — design discussed but no contract change yet.
- **Public dashboard deploy**: scaffolded (`vercel.json`, `.vercelignore`,
  env-configurable URL) but not pushed (Vercel rate limits last attempt).
- LocalStorage persistence for dashboard event log.
- Tier-aware client routing.

---

## Demo network

- Coordinator: `https://flodex-dry-sun-2419.fly.dev` (Fly.io, auto-stops idle,
  ~1.5s cold start; healthcheck on `GET /nodes`).
- Base Sepolia (chain id `84532`):
  - `NodeRegistry` `0xf52b8f75eed06E61801D5251022FD052aa97A51C`
  - `JobChannel`   _TBD — redeploy pending after the channel rewrite_
  - USDC (Circle)  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
  - Owner          `0xc18ee1690606e2BaE6252B502446d5697B694367`
- Min stake: 100 USDC. Channel challenge window: 1 hour. Channel reclaim
  timeout: 24 hours.

Addresses pinned in `packages/chains/src/index.ts` (TS) and
`apps/node/src/chains.rs` (Rust). **Both must stay in sync.**

---

## Architecture (load-bearing)

### Trust boundary

- **Client** holds its own keys; picks backend + node; runs local tools.
- **Coordinator** sees specs (`JobSpec`), never request bodies.
- **Node** decrypts inside an `ExecutionBackend` boundary (a Rust struct
  today; real TEE / FHE later). New trust tiers land as new backends.

### Identity

Two persisted keypairs per node, single file at
`~/.flodex/node/identity.json` (override via `FLODEX_NODE_IDENTITY_PATH`,
0600 perms on Unix):

- **secp256k1** — signing identity. Used for off-chain registration /
  heartbeat signatures (SHA-256 prehash + 64-byte ECDSA r||s) AND on-chain
  identity (the same key derives the node's Ethereum address; receipts
  signed with keccak256 + EIP-191 + 65-byte sig with `v` for `ecrecover`).
- **X25519** — static ECDH transport key. Clients derive a per-session
  symmetric key against this.

### Encryption (per request)

Client ephemeral X25519 → ECDH with node static pub → HKDF-SHA256 (salt =
sessionId, info = `"flodex-v0-session-key"`) → XChaCha20-Poly1305, 24-byte
random nonce. Node re-derives with the same session id.

### Agent loop

Internal to the node. Session state lives on the node keyed by `sessionId`.
Each `/execute` round trip:

1. Append the incoming `AgentStep` to the session.
2. Call `ChatProvider.complete(...)`. Loop on internal node-side tool
   dispatches; **accumulate `Usage` across every internal call**.
3. Return `AgentResponse::Final{content, usage}` on `end_turn`, or
   `AgentResponse::ToolCall{..., usage}` on a client-side tool. Each response
   carries the round-trip's accumulated Usage.

Thinking blocks and tool_use blocks are preserved verbatim in session
history so multi-turn sessions can in principle straddle providers.

### ChatProvider abstraction

Providers consume + return Anthropic-shaped content blocks (our internal
lingua franca). `AnthropicProvider` is passthrough; `OpenAiProvider`
translates at the seam.

### Backend abstraction

```rust
#[async_trait]
trait ExecutionBackend {
    fn backend_type(&self) -> BackendType;
    fn metadata(&self) -> BackendMetadata;
    async fn step(&self, session_id: &str, input: AgentStep) -> Result<AgentResponse>;
    async fn complete(&self, req: ChatRequest) -> Result<ChatResult>; // Claude Code proxy bypass
}
```

`MockTeeBackend` and `LocalLlmBackend` share an internal `AgentRuntime`
(loop + sessions map); they differ only in label and metadata.

### On-chain layer

- **NodeRegistry**: `register/update/unregister/slash` with USDC stake. The
  caller's address (msg.sender) IS the identity. Pricing as `uint256[4]`
  indexed by `Backend` enum mirroring Rust `BackendType`. Backend support as
  a `uint8` bitmap.
- **JobChannel**: long-lived per-(client, node) payment channels.
  `openChannel` locks a USDC deposit; off-chain receipts accumulate;
  `cooperativeClose` (both sigs) settles instantly using the highest
  bilaterally-signed `cumOwed`; `challengeClose` + `submitChallenge` +
  `finalize` handle disputes; `reclaim` is the client safety valve.
  Bilateral sigs mean the contract trusts the on-wire `cumOwed` literally
  — no on-chain pricing math.
- Receipt format: `keccak256(abi.encode(CHANNEL_UPDATE_DOMAIN, chainid,
  address(this), channelId, nonce, cumOwed))`, EIP-191 wrapped, 65-byte
  `r||s||v` signature recovered via OZ ECDSA.
- Domain separator: `flodex-v0-channel-update` (the contract embeds
  `keccak256(...)` as a `bytes32` constant — Rust + TS use the same hash
  via `protocol::channel_update_domain_hash()`).
- Pricing on the wire: `BackendPrice.price_per_1k` is a decimal **string**
  of raw USDC base units (6 decimals) — matches `uint256` exactly. Old f64
  type is gone.

---

## Layout

```
apps/
  client/        TS CLI — uses @flodex/client-lib
  coordinator/   Rust axum registry (Dockerfile for Fly)
  dashboard/     Next.js + d3-force + viem (on-chain status panel)
  node/          Rust axum node — backends + agent loop + identity persistence
  proxy/         Anthropic-compat proxy for Claude Code (bypasses agent loop)
contracts/
  src/           NodeRegistry.sol + JobChannel.sol
  test/          Forge tests + MockUSDC
  script/        Deploy.s.sol
  lib/           forge-std + openzeppelin-contracts (vendored, gitignored)
crates/
  agent/         ChatProvider, AgentLoop, tool registry
  crypto/        X25519/ChaCha + secp256k1 identity (k256) + verify helper
  execution/     ExecutionBackend trait + MockTee + LocalLlm
  local_llm/     HF model fetch, sandboxed llama-server, OpenAI-compat client
  protocol/      Wire types (Rust source of truth) + canonical signing payloads
packages/
  chains/        Per-chain addresses (USDC, registry, channel), TS consumers
  flodex-client/ Shared TS transport (CLI + dashboard)
  protocol/      Re-exports ts-rs–generated types
fly.toml         Fly.io config for hosted coordinator
vercel.json      Vercel config for dashboard deploy (workspace-root build)
```

---

## Invariants / do-not-break

- **`crates/protocol` is the source of truth for wire types.** Don't
  hand-edit `packages/protocol/src/generated/*.ts`. Run `cargo test -p
  protocol` (or `bun run gen:types`) after editing Rust types.
- **ts-rs 7.1 quirk**: `rename_all = "camelCase"` at the enum level emits
  lowercase variant tags, not camelCase. Use explicit `#[serde(rename = "...")]`
  per variant + `rename_all = "camelCase"` per variant. See `AgentStep` /
  `AgentResponse`.
- **Coordinator must never see request bodies.** Specs only. A gateway that
  proxies `/execute` is a non-goal — it defeats the privacy thesis.
- **Agent loop is internal to the backend.** Clients see only `AgentStep` /
  `AgentResponse`. Don't expose the provider API at the wire boundary.
- **Preserve `response.content` verbatim** when appending assistant turns to
  session history (thinking + tool_use blocks required by the API).
- **Identity = secp256k1.** Same key signs off-chain registrations AND
  derives the node's Ethereum address. Don't introduce a separate on-chain
  identity.
- **Registrations + heartbeats are signed.** Use
  `protocol::canonical_register_bytes` / `canonical_heartbeat_bytes` to
  compute the prehash payload. Coordinator rejects 401 on invalid sig.
- **Receipt signatures use keccak256 + EIP-191** (different envelope than
  off-chain SHA-256), same secp256k1 key. `ecrecover` must yield the node's
  address.
- **`packages/chains/src/index.ts` and `apps/node/src/chains.rs` mirror each
  other.** Update both when redeploying contracts.
- **Rust 1.74 compat.** Pinned transitive deps: `indexmap 2.7`, `url 2.5.2`,
  `getrandom 0.4.1`, `ts-rs 7.1`, `reqwest 0.11`, `base64ct <1.7` (k256
  transitive). Drop the base64ct pin when Rust gets bumped to ≥1.85.
- **Don't mock what we plan to replace in a day.** We skipped a mock LLM and
  went straight to Claude + llama-server. Same principle for FHE.
- **CORS is permissive** on coordinator + node — fine for the demo network,
  not for any deployment that isn't explicitly demo-tier.

---

## Remaining directions (priority-ordered)

1. **Node calls `registry.register()` on-chain.** Either bump Rust to 1.81+
   for alloy or use ethers-rs on 1.74. Plumb USDC approve + register at
   startup if `FLODEX_CHAIN_ID` is set. Identity is already correct — just
   wire the call.
2. **Dashboard opens real escrow sessions.** Wallet connect (RainbowKit /
   WalletConnect) + USDC approve + `escrow.openSession()` before sending
   the encrypted request; `escrow.settle()` afterward with the node's
   signed receipt.
3. **Multi-receipt streaming settlement.** Today's `settle` is one-shot.
   Revise to accept incremental settlements as agent loops progress
   (on-chain spent counter + per-receipt deltas).
4. **Tier-aware client routing.** Cheap sub-tasks → local backend, frontier
   work → mock-tee. Per-turn task classification metadata.
5. **Public dashboard deploy.** Vercel rate-limited last attempt;
   Cloudflare Pages or Netlify are equivalent and the scaffolding works.
6. **Linux sandbox** for llama-server (seccomp-bpf or `systemd-run --user
   PrivateNetwork=yes IPAddressDeny=any IPAddressAllow=127.0.0.0/8`).
7. **Bidding / RFQ layer** if price dispersion becomes worth chasing.
   Reverse-auction first.
8. **FHE research track.** Toy encrypted linear layer via TFHE-rs behind
   `BackendType::Fhe`.
9. **MCP backend.** Node exposes declared capabilities as tools.

---

## Design principles

1. **Backend-agnostic.** Every compute route goes through `ExecutionBackend`.
   New trust tiers = new backends, not transport changes.
2. **Local-first privacy.** Assume data is sensitive. Client-side tool
   execution exists to keep sensitive data off the node.
3. **Composability.** Crypto, routing, execution, tools, on-chain — each
   decoupled.
4. **Replaceability.** Every "mock" or stub should be swappable without
   touching callers.

---

## Out of scope for v0

Real TEEs (Nitro/SGX), mixnets / onion routing, payments at scale,
multi-node consensus, ZK proofs at production scale, gateway-style request
routing.

---

## Quick reference

```bash
# Build everything
cargo build && bun install

# Regenerate TS bindings after editing crates/protocol
bun run gen:types

# Local dev
cargo run -p coordinator         # :8000
cargo run -p node                # :7777 (needs ANTHROPIC_API_KEY or FLODEX_LLAMA_MODEL)
bun run dash                     # :3000
bun run apps/client/src/index.ts --coordinator http://127.0.0.1:8000 -b mock-tee send "…"

# Demo network: register a local node against the hosted coordinator
FLODEX_COORDINATOR=https://flodex-dry-sun-2419.fly.dev cargo run -p node

# Tests
cargo test                       # Rust workspace
bun x tsc --noEmit               # from apps/client or apps/dashboard
forge test                       # from contracts/

# Contract deploy (already done; addresses in packages/chains/src/index.ts)
cd contracts && forge script script/Deploy.s.sol:Deploy \
  --rpc-url $RPC --broadcast --legacy

# Fly + Vercel — single-shot deploy from latest main
bun run deploy                   # both targets (also: --fly-only / --vercel-only / --skip-pull)
fly deploy                       # manual: just the coordinator
vercel --prod                    # manual: just the dashboard

# CI mirror: .github/workflows/deploy.yml runs the same two deploys on push
# to main / manual dispatch. Needs repo secrets FLY_API_TOKEN, VERCEL_TOKEN,
# VERCEL_ORG_ID, VERCEL_PROJECT_ID.
```

Env vars and backend config: see `README.md` → Environment variables.
