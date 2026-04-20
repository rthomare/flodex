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
content.

---

## Current state

**Working end-to-end:**
- X25519 + HKDF-SHA256 + XChaCha20-Poly1305 encryption (client → node, per-session key)
- `ExecutionBackend` trait + `ChatProvider` trait + Anthropic ↔ OpenAI translation
- Agent loop with internal node-side tool execution + cross-boundary client-side tool execution (session state preserved across tool round-trips)
- Two live backends: `mock-tee` (Claude Opus 4.7) and `local` (llama-server via llama.cpp, GGUF model pulled from HuggingFace)
- Coordinator: `/nodes/register`, `/nodes/heartbeat`, `/nodes`, `/jobs/match` (first-match)
- macOS sandbox (`sandbox-exec`, `deny network-outbound`) around `llama-server`
- Tools: `current_time` (node), `web_fetch` (node), `read_local_file` (client)
- TS CLI + Next.js dashboard (d3-force graph, request form, timeline, cost panel)

**Stubs / placeholders:**
- `BackendType::Fhe`, `BackendType::Mcp` — no implementation yet
- Linux / Windows sandbox — currently unsandboxed with a warning
- No real TEE attestation, no FHE compute, no zkML

**Not started:**
- Real-token usage plumbed through events (cost is currently `estimated_tokens × price/1K`)
- LocalStorage persistence for dashboard events
- Tier-aware routing (client decomposes agentic sub-tasks by cost tier)
- Bidding / RFQ / commit-reveal marketplace on the coordinator
- Persisted node keypairs; signed coordinator registrations

---

## Architecture (load-bearing)

### Trust boundary
- **Client**: holds its own keypair; picks backend + node; runs local tools.
- **Coordinator**: sees job **specs** (backend, est. tokens, max price), never request bodies.
- **Node**: decrypts inside an `ExecutionBackend` boundary. The boundary is a Rust struct today; real TEE / FHE later. This is the critical abstraction — new trust tiers land as new backends.

### Encryption (per request)
Client ephemeral X25519 → ECDH with node static pub → HKDF (salt = `sessionId`, info = `"flodex-v0-session-key"`) → XChaCha20-Poly1305 with a fresh 24-byte nonce. Node re-derives with the same session id; the session id ties a conversation together across multiple round trips.

### Agent loop
Internal to the node. Message history lives on the node keyed by `sessionId`. Structure:
- On each `/execute`, append the incoming `AgentStep` (prompt or tool result) to the session.
- Call `ChatProvider.complete(…)`.
- On `stop_reason == tool_use`: if the tool is node-side, execute in-process and loop; if client-side, return `AgentResponse::ToolCall` and the client re-enters with a `ToolResult`.
- On `stop_reason == end_turn`: return `AgentResponse::Final`.
- Thinking blocks and tool_use blocks are preserved **verbatim** in session history so sessions can (in principle) straddle providers.

### ChatProvider abstraction
Providers consume Anthropic-shaped content blocks (our lingua franca) and return the same. Anthropic provider is passthrough. OpenAI-compat provider translates to/from OpenAI's flat text + `tool_calls` shape at the seam.

### Backend abstraction
```rust
#[async_trait]
trait ExecutionBackend {
    fn backend_type(&self) -> BackendType;
    fn metadata(&self) -> BackendMetadata;
    async fn step(&self, session_id: &str, input: AgentStep) -> Result<AgentResponse>;
}
```
`MockTeeBackend` and `LocalLlmBackend` share an `AgentRuntime` (agent loop + sessions map) internally; they differ only in the label + metadata.

---

## Layout

```
apps/
  client/       TS CLI — uses @flodex/client-lib
  coordinator/  Rust axum registry
  dashboard/    Next.js 15 + Tailwind + d3-force (holographic aesthetic)
  node/         Rust axum node — owns backends + agent loop
crates/
  agent/        ChatProvider, AgentLoop, tool registry, Anthropic client
  crypto/       X25519 + XChaCha20-Poly1305
  execution/    ExecutionBackend trait + MockTee + LocalLlm
  local_llm/    hf://file:// model fetch, sandboxed llama-server supervisor, OpenAI-compat client
  protocol/     Rust source of truth for wire types; `cargo test -p protocol` regenerates TS
packages/
  flodex-client/  Shared TS transport (CLI + dashboard)
  protocol/       Re-exports ts-rs–generated types
```

---

## Invariants / do-not-break

- **`crates/protocol` is the source of truth.** Don't hand-edit `packages/protocol/src/generated/*.ts`. After changing Rust types, run `cargo test -p protocol` (or `bun run gen:types`) to regenerate.
- **ts-rs 7.1 quirk:** `rename_all = "camelCase"` at the enum level produces lowercase variant tags, not camelCase. Use explicit `#[serde(rename = "...")]` on each variant + `rename_all = "camelCase"` per variant to get predictable shapes. See `AgentStep` / `AgentResponse` for the pattern.
- **Coordinator must never see request bodies.** It handles specs (`JobSpec`) only. A gateway that proxies `/execute` is a non-goal — it defeats the privacy thesis.
- **Agent loop is internal to the backend.** Clients only see `AgentStep`/`AgentResponse`. Don't expose the provider API at the wire boundary.
- **Rust 1.74 compat.** A few transitive deps are pinned (`indexmap 2.7`, `url 2.5.2`, `getrandom 0.4.1`, `ts-rs 7.1`, `reqwest 0.11`). Bump Rust if you want newer; don't sneak in edition-2024 deps without that.
- **Preserve `response.content` verbatim** when appending assistant turns to session history — thinking blocks and tool_use blocks are required by the API on subsequent turns.
- **Don't mock what we plan to replace in a day.** Prior decision: we skipped a mock LLM and went straight to real Claude + real llama-server. Same principle applies to FHE when we get there — implement on a tiny component first, don't fake it.
- **CORS is permissive for localhost dev.** Don't leave that exposed.

---

## Remaining directions (priority-ordered)

1. **Token-accurate cost.** Pipe `usage.input_tokens` / `output_tokens` through `AgentEvent` so the dashboard shows real spend instead of estimates. Small change in `crates/agent::provider.rs` + flow through to the dashboard.
2. **Tier-aware routing on the client.** The biggest real-world cost lever for agentic workloads. Decompose the outer loop so cheap sub-tasks (classification, tool dispatch) route to the local backend and frontier work routes to mock-tee. Requires per-turn task classification metadata.
3. **Linux sandbox** for `llama-server` (seccomp-bpf blocking `connect` to non-loopback, or `systemd-run --user PrivateNetwork=yes IPAddressDeny=any IPAddressAllow=127.0.0.0/8`). macOS is done.
4. **Persisted node keypairs** + signed `NodeRegistration` so the coordinator can verify registrations and clients can pin node identity.
5. **LocalStorage persistence** for the dashboard event log (survives refresh). Small.
6. **Bidding / RFQ layer** on the coordinator if price dispersion becomes a thing worth chasing. Start with a reverse-auction (client broadcasts spec to a chosen set, nodes quote, client picks).
7. **FHE research track.** Toy encrypted linear layer via TFHE-rs behind `BackendType::Fhe`, just to prove the protocol composes. Not end-to-end LLM inference — that's multi-month.
8. **MCP backend.** Node exposes declared capabilities as tools Claude can call; privacy boundary is at the capability level.

---

## Design principles

1. **Backend-agnostic.** Every compute route goes through `ExecutionBackend`. Adding a trust tier is adding a backend, not touching transport or the agent loop.
2. **Local-first privacy.** Assume data is sensitive. Client-side tool execution exists to keep sensitive data off the node.
3. **Composability.** Crypto, routing, execution, tools — each decoupled.
4. **Replaceability.** Every "mock" or stub should be swappable without touching callers.

---

## Out of scope for v0

Real TEEs (Nitro/SGX), mixnets / onion routing, payments / incentives, multi-node consensus, ZK proofs at production scale, gateway-style request routing.

---

## Quick reference

```bash
# Build everything
cargo build && bun install

# Regenerate TS bindings after editing crates/protocol
bun run gen:types

# Processes
cargo run -p coordinator         # :8000
cargo run -p node                # :7777 (needs ANTHROPIC_API_KEY or FLODEX_LLAMA_MODEL)
bun run dash                     # :3000
bun run apps/client/src/index.ts --coordinator http://127.0.0.1:8000 -b mock-tee send "…"

# Tests
cargo test
bun x tsc --noEmit               # from apps/client or apps/dashboard
```

Env vars and backend config: see `README.md` → Environment variables.
