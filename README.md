# flodex

A privacy-first, decentralized LLM execution network. Clients send end-to-end
encrypted requests to nodes; nodes run an agent loop against a pluggable
execution backend (hosted Claude, local Llama, research-stage FHE/zkML later);
a thin coordinator helps clients discover nodes without becoming a central
routing point.

> **Status: pre-alpha v0.** Encryption, agent loop, tool use, local LLM
> inference, and node discovery work end-to-end. Backends beyond `mock-tee`
> (Claude-backed) and `local` (llama.cpp-backed) are stubs. No real TEE, FHE,
> or zkML is implemented. Sandboxing of the local LLM subprocess is macOS-only
> today — Linux and Windows run unsandboxed with a warning. v0 is meant to
> prove the protocol composes; it is not production.

See `CLAUDE.md` for the full design brief, target architecture, and v0 scope.

---

## Demo network

A live demo network runs on Base Sepolia + Fly.io. You can run a node against
it from your laptop in a few minutes (see [Onboarding](#onboarding)).

| Component         | Where                                                             |
| ----------------- | ----------------------------------------------------------------- |
| Coordinator       | `https://flodex-dry-sun-2419.fly.dev`                             |
| NodeRegistry      | [`0xf52b8f75…7A51C`](https://sepolia.basescan.org/address/0xf52b8f75eed06E61801D5251022FD052aa97A51C) on Base Sepolia |
| JobEscrow         | [`0xEb577b58…D4894`](https://sepolia.basescan.org/address/0xEb577b58913Ad50C3203fFdD21a4EB28C46D4894) on Base Sepolia |
| Stake/payment token | Circle testnet USDC (`0x036C…CF7e`)                              |

The off-chain coordinator and the on-chain registry coexist: nodes register
off-chain to participate in the dashboard's discovery layer, and on-chain
once the node opts into the escrow flow (not yet wired). On-chain identity
is the secp256k1 keypair the node persists at `~/.flodex/node/identity.json`,
same key in both places.

---

## Onboarding

### Run a node against the demo network

```bash
# 1. Build the node binary
cargo build --release -p node

# 2. Pick a backend. Either `mock-tee` (set ANTHROPIC_API_KEY) or `local`
#    (set FLODEX_LLAMA_MODEL — see "Backends" below).

# 3. Register against the hosted coordinator
ANTHROPIC_API_KEY=sk-ant-... \
FLODEX_COORDINATOR=https://flodex-dry-sun-2419.fly.dev \
FLODEX_NODE_PRICE_MOCK_TEE=0.005 \
./target/release/flodex-node
```

The first run generates a persistent identity at
`~/.flodex/node/identity.json`. Same identity (same secp256k1 pubkey) every
restart. Heartbeats every 10s. Watch the coordinator log it joining at
`curl https://flodex-dry-sun-2419.fly.dev/nodes`.

### Send a request through the demo network

```bash
bun install
bun run apps/client/src/index.ts \
  --coordinator https://flodex-dry-sun-2419.fly.dev \
  -b mock-tee \
  send "What time is it? And summarize https://example.com."
```

The client matches against any registered node (yours, or someone else's
volunteered for the demo). End-to-end encrypted to whichever node it picks.

### Get testnet funds (for the on-chain layer)

The contracts only matter once you start opening real escrow sessions —
which isn't wired into the CLI yet. When that lands you'll need:

| Asset              | Faucet                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| Base Sepolia ETH   | https://www.alchemy.com/faucets/base-sepolia                              |
| Base Sepolia USDC  | https://faucet.circle.com (pick "Base Sepolia")                           |

Same wallet for both. ~0.05 Sepolia ETH covers gas for register + several
sessions; 100 USDC covers the registry's minimum stake.

---

## Architecture at a glance

```
                         ┌──────────────┐
                         │  Coordinator │  (optional, thin registry)
                         │   /nodes     │
                         │ /jobs/match  │
                         └──────▲───────┘
           register / heartbeat │  ▲  POST /jobs/match
                                │  │
 ┌──────────┐                   │  │                   ┌──────────┐
 │  Node A  │ ──────────────────┘  │                   │  Node B  │
 │  Claude  │                      │                   │ llama    │
 └─────▲────┘                      │                   └─────▲────┘
       │    encrypted request (X25519 + XChaCha20-Poly1305)  │
       └───────────────────────────┼───────────────────────  │
                                   │                         │
                             ┌─────┴────┐                    │
                             │  Client  │────────────────────┘
                             │ CLI / UI │
                             └──────────┘
```

**Trust model:**

- The **client** holds its own keys and picks which node/backend to trust.
- The **coordinator** sees job specs (backend type, token estimate, price
  ceiling) but **never sees request bodies** — encrypted payloads flow
  client → node directly.
- The **node** decrypts inside an "execution backend" boundary
  (today a Rust struct; a real TEE or FHE runtime later) and runs the agent
  loop.

---

## Quickstart (localhost, one terminal per process)

**Fastest path — tmux:**

```bash
# One-time: fill out .env with at least ANTHROPIC_API_KEY and/or FLODEX_LLAMA_MODEL
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
echo "FLODEX_LLAMA_MODEL=hf://bartowski/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf" >> .env

# Start everything in one tmux session
bun run dev
# or: ./scripts/dev.sh

# Tear down
bun run dev:kill
```

That spins up 5 named windows (`Ctrl-b 0–4` to switch): coordinator, mock-tee
node, local node, dashboard, and a client shell with example commands. If a
required env var is missing, the corresponding window prints a hint instead of
failing silently.

**Manual — one terminal per process** (install prereqs first — see
`Prerequisites` below):

```bash
# 1. Set your Anthropic API key for the Claude-backed backend
export ANTHROPIC_API_KEY=sk-ant-...

# Terminal 1 — coordinator
cargo run -p coordinator                             # http://127.0.0.1:8000

# Terminal 2 — node wired to Claude
FLODEX_COORDINATOR=http://127.0.0.1:8000 \
FLODEX_NODE_PRICE_MOCK_TEE=0.005 \
cargo run -p node                                    # http://127.0.0.1:7777

# Terminal 3 — client CLI (routed via coordinator)
bun install
bun run apps/client/src/index.ts \
  --coordinator http://127.0.0.1:8000 \
  -b mock-tee \
  send "What time is it? And summarize https://example.com."

# Terminal 4 — dashboard (optional)
bun run dash                                         # http://localhost:3000
```

Add a second node with a local LLM:

```bash
# Terminal 5 — local-LLM node (requires llama-server)
FLODEX_COORDINATOR=http://127.0.0.1:8000 \
FLODEX_NODE_ADDR=127.0.0.1:7778 \
FLODEX_NODE_PRICE_LOCAL=0 \
FLODEX_LLAMA_MODEL=hf://unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf \
cargo run -p node
```

The coordinator now knows about two nodes; the dashboard shows both on the
force-directed graph and lights up whichever one handles each request.

---

## Prerequisites

| Tool      | Minimum               | Notes                                                                    |
| --------- | --------------------- | ------------------------------------------------------------------------ |
| Rust      | 1.74                  | Newer is fine; some deps are pinned to 1.74-compatible versions          |
| Bun       | 1.1+                  | JS runtime + package manager                                             |
| llama.cpp | recent `llama-server` | Only needed for the `local` backend (`brew install llama.cpp`)           |
| macOS     | —                     | Sandbox (`sandbox-exec`) works on macOS; Linux/Windows unsandboxed (yet) |

Optional:

- **Anthropic API key** for the `mock-tee` backend (Claude Opus 4.7 by default).
- **HuggingFace token** (`HF_TOKEN`) only if pulling gated GGUF models.

---

## Components

### Apps

| App                | Purpose                                                              | Language   |
| ------------------ | -------------------------------------------------------------------- | ---------- |
| `apps/node`        | Axum HTTP server — `/info`, `/execute`; decrypts and runs agent loop | Rust       |
| `apps/coordinator` | Axum HTTP server — node registry + `/jobs/match`                     | Rust       |
| `apps/client`      | CLI that encrypts prompts, optionally discovers nodes                | TypeScript |
| `apps/dashboard`   | Next.js + d3-force visualization for client-perspective debugging    | TypeScript |

### Rust crates

| Crate              | Purpose                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `crates/protocol`  | Wire-format types (source of truth). `ts-rs` emits matching TS.                                                    |
| `crates/crypto`    | X25519 ECDH + HKDF-SHA256 + XChaCha20-Poly1305                                                                     |
| `crates/agent`     | `ChatProvider` trait, Anthropic client, tool registry, agent loop                                                  |
| `crates/execution` | `ExecutionBackend` trait + `MockTeeBackend` + `LocalLlmBackend`                                                    |
| `crates/local_llm` | HF model downloader, sandboxed `llama-server` supervisor, OpenAI-compat client with Anthropic ↔ OpenAI translation |

### TypeScript packages

| Package                  | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `packages/protocol`      | Re-exports TS bindings generated from the Rust `protocol` crate             |
| `packages/flodex-client` | Shared encryption + agent-loop transport used by both the CLI and dashboard |

---

## Backends

Selected per request via the `backend` field on the encrypted envelope.

| Backend   | ID         | Status                          | Enabled by                                          |
| --------- | ---------- | ------------------------------- | --------------------------------------------------- |
| MockTEE   | `mock-tee` | **Works** — Claude-backed today | Set `ANTHROPIC_API_KEY`                             |
| Local LLM | `local`    | **Works** — llama.cpp-backed    | Set `FLODEX_LLAMA_MODEL` (+ install `llama-server`) |
| FHE       | `fhe`      | Stub only                       | — (planned research track)                          |
| MCP       | `mcp`      | Stub only                       | — (planned)                                         |

A single node can host multiple backends at once; the coordinator advertises
which ones each node supports.

### Model specs for the local backend

`FLODEX_LLAMA_MODEL` accepts:

- `hf://owner/repo/filename.gguf` — fetched from HuggingFace Hub,
  cached under `~/.cache/flodex/models/` (or `$FLODEX_CACHE`).
- `file:///absolute/path/to/model.gguf` — local file.
- `/abs/path/to/model.gguf` — bare absolute path.

Pick a model whose size fits your RAM/VRAM and that's tool-trained if you want
tool use (Qwen 2.5 3B+, Llama 3.1 8B+, Phi-4, etc.). Sub-1B models often flunk
tool calling.

### Sandbox (local backend)

Node spawns `llama-server` as a child process inside an OS sandbox:

| OS      | Status                       | How                                                   |
| ------- | ---------------------------- | ----------------------------------------------------- |
| macOS   | **network-outbound blocked** | `sandbox-exec` with a `deny network-outbound` profile |
| Linux   | Unsandboxed (with warning)   | Follow-up: seccomp-bpf or `systemd-run` scopes        |
| Windows | Unsandboxed                  | Follow-up                                             |

`FLODEX_SANDBOX=0` bypasses the wrapper (debug escape hatch).

---

## Tool set

Tools are Anthropic-shaped (`{name, description, input_schema}`) internally. The
agent crate translates to OpenAI function-call shape for the local backend
transparently.

| Tool              | Side   | Description                                                                                                                                                  |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `current_time`    | Node   | Returns current UTC time as ISO 8601                                                                                                                         |
| `web_fetch`       | Node   | GETs an http(s) URL, returns up to ~100KB of body text. Loopback hosts blocked.                                                                              |
| `read_local_file` | Client | Reads a file on the client's filesystem. Proves the cross-boundary privacy flow — the prompt decrypts _on the node_, but _sensitive local data stays local_. |

When a model calls a client-side tool, the node pauses the loop and asks the
client to execute it; the client returns the result in the next encrypted
request, scoped to the same session id.

The **dashboard** cannot execute `read_local_file` (no browser filesystem); it
returns an explanatory error back to the node.

---

## Agent loop

Each session is a list of Anthropic-shaped messages held in-memory on the node,
keyed by `sessionId`. One `/execute` call = one outer-loop iteration from the
client's perspective:

```
client → prompt           → node
                              ↓
                          agent loop (internal):
                            call ChatProvider (Claude or llama-server)
                            if stop_reason == end_turn:   → return final
                            if tool_use is node-side:     → execute, continue
                            if tool_use is client-side:   → return ToolCall
client ← Final | ToolCall ← node

(if ToolCall:)
client → ToolResult       → node
                              ↓
                          continue loop with tool result appended
                              ↓
client ← Final | ToolCall ← node
```

Thinking blocks and `tool_use` blocks are preserved verbatim in the session
message history — the same conversation can straddle providers on different
turns (though the cache cost-model assumes you don't).

---

## Encryption

Per request:

1. Client generates an ephemeral X25519 keypair.
2. Shared secret = ECDH(client_priv, node_pub).
3. Symmetric key = HKDF-SHA256(shared, salt = sessionId, info = "flodex-v0-session-key").
4. Plaintext (JSON-encoded `AgentStep`) encrypted with XChaCha20-Poly1305;
   24-byte random nonce.
5. Encrypted payload + client pub + nonce + session id sent to
   `POST /execute` on the node.

Node:

1. Derives the same symmetric key using its static secret.
2. Decrypts, runs the agent step, re-encrypts with a fresh nonce.

The node persists both keypairs (X25519 ECDH + secp256k1 identity) at
`~/.flodex/node/identity.json` (override via `FLODEX_NODE_IDENTITY_PATH`) so
node identity is stable across restarts. Registrations and heartbeats are
ECDSA-signed; the coordinator verifies the signature before storing or
refreshing the entry.

---

## Coordinator

Thin axum server that helps the client _discover_ a node. Privacy-preserving by
design: sees job specs only, never request bodies.

| Endpoint           | Method | Purpose                                                                                               |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------- |
| `/nodes/register`  | POST   | Node advertises its pubkey, URL, backends, capacity, pricing                                          |
| `/nodes/heartbeat` | POST   | Keepalive — entries expire after 30s without one                                                      |
| `/nodes`           | GET    | Current registry snapshot (used by the dashboard for its node graph)                                  |
| `/jobs/match`      | POST   | Client POSTs a `JobSpec` (backend + estimated tokens + max price/1K); first matching node is returned |

Matching policy is first-match today — easy to swap for cheapest-first or
round-robin. Bidding/auction layers cleanly on top (RFQ round-trip before
assignment) when you need it.

---

## Dashboard

Next.js 15 + React 19 + Tailwind 3 + d3-force + Canvas 2D. Client-perspective
debug view — no backend, all state is in-browser. Aesthetic borrowed from
[agent-flow](https://github.com/anthropics/agent-flow): holographic cyan +
amber + green on void black, glassmorphic panels, monospace, animated edge
particles.

Panels:

- **Graph (center).** Force-directed; purple "client" hub; cyan nodes around
  it; edges light up green with a particle when a request routes through.
  Click a node to inspect its pricing and backends.
- **Request form (top-left).** Backend, prompt, est. tokens, max $/1K.
- **Cost (top-right).** Running total + per-backend breakdown.
- **Latest response (right).** Pretty-printed final answer.
- **Timeline (bottom).** Gantt bars per session; amber ticks = tool calls.

See the dashboard README section in `apps/dashboard/` for per-panel details.

---

## Environment variables

### Node

| Var                          | Default                    | Purpose                                       |
| ---------------------------- | -------------------------- | --------------------------------------------- |
| `ANTHROPIC_API_KEY`          | —                          | Enables the `mock-tee` backend                |
| `FLODEX_NODE_MODEL`          | `claude-opus-4-7`          | Anthropic model used by `mock-tee`            |
| `FLODEX_LLAMA_MODEL`         | —                          | Enables the `local` backend (HF/file spec)    |
| `FLODEX_CACHE`               | `~/.cache/flodex/models`   | Model-download cache                          |
| `FLODEX_SANDBOX`             | on                         | Set to `0` to bypass the llama-server sandbox |
| `FLODEX_NODE_ADDR`           | `127.0.0.1:7777`           | Bind address                                  |
| `FLODEX_NODE_URL`            | `http://$FLODEX_NODE_ADDR` | URL advertised to the coordinator             |
| `FLODEX_NODE_MAX_TOKENS`     | `100000`                   | Capacity advertised                           |
| `FLODEX_NODE_PRICE_MOCK_TEE` | `0.0`                      | Price per 1K tokens for mock-tee              |
| `FLODEX_NODE_PRICE_LOCAL`    | `0.0`                      | Price per 1K tokens for local                 |
| `FLODEX_COORDINATOR`         | —                          | If set, node registers + heartbeats here      |
| `HF_TOKEN`                   | —                          | Optional HuggingFace auth token               |

### Coordinator

| Var                       | Default          | Purpose      |
| ------------------------- | ---------------- | ------------ |
| `FLODEX_COORDINATOR_ADDR` | `127.0.0.1:8000` | Bind address |

### Client CLI

Flags: `-n/--node`, `-b/--backend`, `--coordinator`, `--max-tokens`, `--max-price`.

---

## Workspace layout

```
.
├── Cargo.toml                 # Rust workspace root
├── package.json               # Bun workspaces root
├── CLAUDE.md                  # Design brief + target architecture
├── README.md                  # This file
├── fly.toml                   # Fly.io config for the hosted coordinator
├── apps/
│   ├── client/                # TS CLI
│   ├── coordinator/           # Rust axum registry (+ Dockerfile for Fly)
│   ├── dashboard/             # Next.js visualization
│   ├── node/                  # Rust axum node
│   └── proxy/                 # Anthropic-compatible proxy for Claude Code
├── crates/
│   ├── agent/                 # Agent loop + ChatProvider + Anthropic client
│   ├── crypto/                # X25519 ECDH + XChaCha20-Poly1305 + secp256k1 identity
│   ├── execution/             # Backend trait + MockTee + LocalLlm
│   ├── local_llm/             # HF download + llama-server supervisor + OpenAI-compat
│   └── protocol/              # Shared wire types (Rust source of truth) + canonical signing payloads
├── contracts/
│   ├── src/                   # NodeRegistry.sol + JobEscrow.sol
│   ├── test/                  # Forge tests + MockUSDC
│   └── script/                # Deploy.s.sol
└── packages/
    ├── chains/                # Per-chain addresses (USDC, registry, escrow) shared by TS consumers
    ├── flodex-client/         # Shared TS transport (CLI + dashboard)
    └── protocol/              # Re-exports ts-rs-generated types
```

---

## Development

```bash
# Build everything
cargo build
bun install

# Regenerate TS bindings after editing Rust `protocol` crate
bun run gen:types

# Run tests
cargo test
bun run --cwd apps/client typecheck
bun run --cwd apps/dashboard typecheck

# Dashboard
bun run dash                        # dev server on :3000
bun x next build --cwd apps/dashboard

# Individual crates
cargo run -p coordinator
cargo run -p node
cargo test -p crypto
cargo test -p protocol              # also regenerates TS bindings
```

The Rust workspace pins a few transitive deps (`indexmap`, `url`, `getrandom`)
to versions compatible with rustc 1.74. If you bump Rust, you can likely drop
those pins in `Cargo.lock`.

---

## Deploy

Two deploy targets, one script. From the repo root:

```bash
bun run deploy           # both targets (default branch: main, remote: origin)
bun run deploy --fly-only
bun run deploy --vercel-only
bun run deploy --skip-pull   # ship the current working tree as-is
```

What it does:

1. Aborts if the working tree is dirty (unless `--skip-pull`).
2. `git fetch` + checkout + fast-forward `main` from `origin`.
3. `flyctl deploy --config fly.toml` — coordinator → `flodex-dry-sun-2419.fly.dev`.
4. `vercel --prod --yes` — dashboard.

Override the branch/remote via `FLODEX_DEPLOY_BRANCH` / `FLODEX_DEPLOY_REMOTE`.

**Prerequisites** (one-time):

- `flyctl` on PATH and either `flyctl auth login` or `FLY_API_TOKEN` in env
  ([install](https://fly.io/docs/hands-on/install-flyctl/)).
- `vercel` on PATH and either `vercel login` or `VERCEL_TOKEN` in env
  (`bun add -g vercel`). First-time setup also needs `vercel link` from the
  repo root so `.vercel/project.json` is populated.

### GitHub Actions

`.github/workflows/deploy.yml` runs the same two deploys on every push to
`main` and on manual dispatch (Actions tab → "deploy" → "Run workflow",
optionally scoping to `fly`, `vercel`, or `both`).

Required repo secrets:

| Secret              | Where to get it                                                      |
| ------------------- | -------------------------------------------------------------------- |
| `FLY_API_TOKEN`     | `flyctl auth token`                                                  |
| `VERCEL_TOKEN`      | https://vercel.com/account/tokens                                    |
| `VERCEL_ORG_ID`     | `.vercel/project.json` after `vercel link` (or vercel.com → settings)|
| `VERCEL_PROJECT_ID` | same                                                                 |

The two deploys run as parallel jobs; either can fail independently without
blocking the other.

---

## Security notes for v0

- **macOS sandbox is narrow** — only blocks outbound network from the
  llama-server child. Read-only FS + no-exec would be stricter; tracked.
- **No Linux/Windows sandbox yet** — `llama-server` runs with the node
  operator's permissions. Don't point it at a model you don't trust.
- **`CorsLayer::permissive()` on both axum servers** — fine for the demo
  network so dashboards from arbitrary origins can poll, but a real
  deployment should narrow this.
- **Heartbeats are not rate-limited** on the coordinator; signed but cheap to
  spam. Add per-identity caps before scaling.
- **No replay protection** on encrypted requests beyond nonce uniqueness per
  session. Sessions are keyed only on `sessionId` (a UUID the client chooses).
- **`web_fetch` has minimal SSRF protection** — blocks obvious loopback hosts,
  but a curious DNS name resolving to a private IP bypasses it. Acceptable for
  dev; harden before opening exposure.
- **Identity-file permissions** are best-effort 0600 on Unix only. Windows
  users should secure the file manually.

---

## Roadmap (M1 – M5 from `CLAUDE.md`)

| Milestone               | Status     | Notes                                                          |
| ----------------------- | ---------- | -------------------------------------------------------------- |
| M1: Encrypted echo      | ✅         | Client↔node X25519 + XChaCha20-Poly1305                        |
| M2: Backend abstraction | ✅         | `ExecutionBackend` trait + `ChatProvider` trait                |
| M3: Agent loop          | ✅         | Plan → execute → respond, with thinking blocks preserved       |
| M4: Tool calls          | ✅         | Node-side + client-side tool execution, cross-boundary session |
| M5: Multiple backends   | 🟡 partial | MockTEE + Local done; FHE + MCP remain stubs                   |

**Beyond M5**

- ✅ Real token usage piped into `AgentEvent` (replaces cost estimate)
- ✅ Persisted node keypairs + signed coordinator registrations
- ✅ NodeRegistry + JobEscrow contracts on Base Sepolia
- ✅ Hosted demo coordinator on Fly + dashboard wired to read on-chain state
- Node calls `registry.register()` on-chain (alloy integration; needs Rust 1.81+ MSRV bump)
- Client opens real escrow sessions before sending requests (wallet connect + USDC approve flow)
- Harden Linux/Windows sandboxing of `llama-server`
- LocalStorage persistence for the dashboard event log
- Tier-aware client-side routing (cheap sub-tasks → local, hard sub-tasks → frontier)
- Commit-reveal or RFQ-style bidding on the coordinator
- FHE backend via TFHE-rs (toy encrypted layer first; not end-to-end inference)
- zkLLM research track (small-model inference proofs)

---

## License

TBD.
