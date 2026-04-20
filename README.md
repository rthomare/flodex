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

Install prereqs (see `Prerequisites` below), then:

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
FLODEX_LLAMA_MODEL=hf://bartowski/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf \
cargo run -p node
```

The coordinator now knows about two nodes; the dashboard shows both on the
force-directed graph and lights up whichever one handles each request.

---

## Prerequisites

| Tool       | Minimum                 | Notes                                                          |
| ---------- | ----------------------- | -------------------------------------------------------------- |
| Rust       | 1.74                    | Newer is fine; some deps are pinned to 1.74-compatible versions |
| Bun        | 1.1+                    | JS runtime + package manager                                   |
| llama.cpp  | recent `llama-server`   | Only needed for the `local` backend (`brew install llama.cpp`) |
| macOS      | —                       | Sandbox (`sandbox-exec`) works on macOS; Linux/Windows unsandboxed (yet) |

Optional:
- **Anthropic API key** for the `mock-tee` backend (Claude Opus 4.7 by default).
- **HuggingFace token** (`HF_TOKEN`) only if pulling gated GGUF models.

---

## Components

### Apps

| App                          | Purpose                                                  | Language   |
| ---------------------------- | -------------------------------------------------------- | ---------- |
| `apps/node`                  | Axum HTTP server — `/info`, `/execute`; decrypts and runs agent loop | Rust       |
| `apps/coordinator`           | Axum HTTP server — node registry + `/jobs/match`         | Rust       |
| `apps/client`                | CLI that encrypts prompts, optionally discovers nodes    | TypeScript |
| `apps/dashboard`             | Next.js + d3-force visualization for client-perspective debugging | TypeScript |

### Rust crates

| Crate                 | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `crates/protocol`     | Wire-format types (source of truth). `ts-rs` emits matching TS.      |
| `crates/crypto`       | X25519 ECDH + HKDF-SHA256 + XChaCha20-Poly1305                       |
| `crates/agent`        | `ChatProvider` trait, Anthropic client, tool registry, agent loop    |
| `crates/execution`    | `ExecutionBackend` trait + `MockTeeBackend` + `LocalLlmBackend`      |
| `crates/local_llm`    | HF model downloader, sandboxed `llama-server` supervisor, OpenAI-compat client with Anthropic ↔ OpenAI translation |

### TypeScript packages

| Package                        | Purpose                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `packages/protocol`            | Re-exports TS bindings generated from the Rust `protocol` crate    |
| `packages/flodex-client`       | Shared encryption + agent-loop transport used by both the CLI and dashboard |

---

## Backends

Selected per request via the `backend` field on the encrypted envelope.

| Backend     | ID          | Status                              | Enabled by                                                |
| ----------- | ----------- | ----------------------------------- | --------------------------------------------------------- |
| MockTEE     | `mock-tee`  | **Works** — Claude-backed today     | Set `ANTHROPIC_API_KEY`                                   |
| Local LLM   | `local`     | **Works** — llama.cpp-backed        | Set `FLODEX_LLAMA_MODEL` (+ install `llama-server`)       |
| FHE         | `fhe`       | Stub only                           | — (planned research track)                                |
| MCP         | `mcp`       | Stub only                           | — (planned)                                               |

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

| OS       | Status                        | How                                               |
| -------- | ----------------------------- | ------------------------------------------------- |
| macOS    | **network-outbound blocked**  | `sandbox-exec` with a `deny network-outbound` profile |
| Linux    | Unsandboxed (with warning)    | Follow-up: seccomp-bpf or `systemd-run` scopes    |
| Windows  | Unsandboxed                   | Follow-up                                         |

`FLODEX_SANDBOX=0` bypasses the wrapper (debug escape hatch).

---

## Tool set

Tools are Anthropic-shaped (`{name, description, input_schema}`) internally. The
agent crate translates to OpenAI function-call shape for the local backend
transparently.

| Tool               | Side    | Description                                                      |
| ------------------ | ------- | ---------------------------------------------------------------- |
| `current_time`     | Node    | Returns current UTC time as ISO 8601                             |
| `web_fetch`        | Node    | GETs an http(s) URL, returns up to ~100KB of body text. Loopback hosts blocked. |
| `read_local_file`  | Client  | Reads a file on the client's filesystem. Proves the cross-boundary privacy flow — the prompt decrypts *on the node*, but *sensitive local data stays local*. |

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

The node's keypair is ephemeral per process run in v0 — persist it when you
need stable node identity across restarts.

---

## Coordinator

Thin axum server that helps the client *discover* a node. Privacy-preserving by
design: sees job specs only, never request bodies.

| Endpoint               | Method | Purpose                                                                 |
| ---------------------- | ------ | ----------------------------------------------------------------------- |
| `/nodes/register`      | POST   | Node advertises its pubkey, URL, backends, capacity, pricing            |
| `/nodes/heartbeat`     | POST   | Keepalive — entries expire after 30s without one                        |
| `/nodes`               | GET    | Current registry snapshot (used by the dashboard for its node graph)    |
| `/jobs/match`          | POST   | Client POSTs a `JobSpec` (backend + estimated tokens + max price/1K); first matching node is returned |

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
| Var                                        | Default                        | Purpose                                              |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY`                        | —                              | Enables the `mock-tee` backend                       |
| `FLODEX_NODE_MODEL`                        | `claude-opus-4-7`              | Anthropic model used by `mock-tee`                   |
| `FLODEX_LLAMA_MODEL`                       | —                              | Enables the `local` backend (HF/file spec)           |
| `FLODEX_CACHE`                             | `~/.cache/flodex/models`       | Model-download cache                                 |
| `FLODEX_SANDBOX`                           | on                             | Set to `0` to bypass the llama-server sandbox        |
| `FLODEX_NODE_ADDR`                         | `127.0.0.1:7777`               | Bind address                                         |
| `FLODEX_NODE_URL`                          | `http://$FLODEX_NODE_ADDR`     | URL advertised to the coordinator                    |
| `FLODEX_NODE_MAX_TOKENS`                   | `100000`                       | Capacity advertised                                  |
| `FLODEX_NODE_PRICE_MOCK_TEE`               | `0.0`                          | Price per 1K tokens for mock-tee                     |
| `FLODEX_NODE_PRICE_LOCAL`                  | `0.0`                          | Price per 1K tokens for local                        |
| `FLODEX_COORDINATOR`                       | —                              | If set, node registers + heartbeats here             |
| `HF_TOKEN`                                 | —                              | Optional HuggingFace auth token                      |

### Coordinator
| Var                         | Default             | Purpose      |
| --------------------------- | ------------------- | ------------ |
| `FLODEX_COORDINATOR_ADDR`   | `127.0.0.1:8000`    | Bind address |

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
├── apps/
│   ├── client/                # TS CLI
│   ├── coordinator/           # Rust axum registry
│   ├── dashboard/             # Next.js visualization
│   └── node/                  # Rust axum node
├── crates/
│   ├── agent/                 # Agent loop + ChatProvider + Anthropic client
│   ├── crypto/                # X25519 + XChaCha20-Poly1305
│   ├── execution/             # Backend trait + MockTee + LocalLlm
│   ├── local_llm/             # HF download + llama-server supervisor + OpenAI-compat
│   └── protocol/              # Shared wire types (Rust source of truth)
└── packages/
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

## Security notes for v0

- **Node keypair is ephemeral** — regenerated every process start. Fine for
  local dev; persist to disk before relying on stable node identity.
- **macOS sandbox is narrow** — only blocks outbound network from the
  llama-server child. Read-only FS + no-exec would be stricter; tracked.
- **No Linux/Windows sandbox yet** — `llama-server` runs with the node
  operator's permissions. Don't point it at a model you don't trust.
- **`CorsLayer::permissive()` on both axum servers** — fine for localhost
  dev, definitely not for exposed deployments.
- **Coordinator has no auth** — anyone who can reach it can register a node or
  claim a job. Add HMAC-signed registrations / a signature chain before opening
  it up.
- **No replay protection** on encrypted requests beyond nonce uniqueness per
  session. Sessions are keyed only on `sessionId` (a UUID the client chooses).
- **`web_fetch` has minimal SSRF protection** — blocks obvious loopback hosts,
  but a curious DNS name resolving to a private IP bypasses it. Acceptable for
  dev; harden before opening exposure.

---

## Roadmap (M1 – M5 from `CLAUDE.md`)

| Milestone | Status    | Notes                                                             |
| --------- | --------- | ----------------------------------------------------------------- |
| M1: Encrypted echo        | ✅        | Client↔node X25519 + XChaCha20-Poly1305                           |
| M2: Backend abstraction   | ✅        | `ExecutionBackend` trait + `ChatProvider` trait                   |
| M3: Agent loop            | ✅        | Plan → execute → respond, with thinking blocks preserved         |
| M4: Tool calls            | ✅        | Node-side + client-side tool execution, cross-boundary session   |
| M5: Multiple backends     | 🟡 partial | MockTEE + Local done; FHE + MCP remain stubs                     |

**Beyond M5**
- Harden Linux/Windows sandboxing of `llama-server`
- Real token usage piped into `AgentEvent` (replace cost estimate)
- LocalStorage persistence for the dashboard event log
- Tier-aware client-side routing (cheap sub-tasks → local, hard sub-tasks → frontier)
- Commit-reveal or RFQ-style bidding on the coordinator
- FHE backend via TFHE-rs (toy encrypted layer first; not end-to-end inference)
- zkLLM research track (small-model inference proofs)
- Persisted node keypairs + signed coordinator registrations

---

## License

TBD.
