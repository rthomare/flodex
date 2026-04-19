# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Status (2026-04-18):** Repo is pre-scaffold — only this file exists. The structure, interfaces, and flows below describe the *target* design, not code that lives on disk. Don't assume any path under `/apps` or `/packages` exists yet; verify before editing.

## Overview

This repository implements a **privacy-first, decentralized LLM execution network** with a modular trust model.

The system allows clients to send encrypted LLM requests to distributed nodes while experimenting with multiple execution backends:

- Mocked TEE (practical baseline)
- FHE (fully encrypted compute, experimental)
- MCP / capability-based execution (tool-focused model)
- Local execution (ground truth + fallback)

The goal of v0 is to prove:

- End-to-end encrypted request flow
- Agent loop with tool calls
- Pluggable execution environments
- Clear separation of trust boundaries

---

## Core Idea

We are building a protocol for executing AI tasks across untrusted environments with configurable trust guarantees.

---

## Monorepo Structure

> Target layout — not yet scaffolded. Check `ls` before assuming a path exists.

```text
/apps
  /client              → CLI client (requester)
  /node                → Node host (execution engine)

/packages
  /protocol            → Message formats + schemas
  /crypto              → Encryption, session keys, signatures
  /agent               → Agent loop + orchestration
  /tools               → Tool interface + implementations
  /models              → Model abstraction layer
  /routing             → Node selection + policies
  /execution           → Execution backends (CRITICAL)
  /types               → Shared types

/docs
  architecture.md
  protocol.md
  trust-models.md
```

---

## Execution Backends (Key Abstraction)

All compute happens through a unified interface:

```ts
interface ExecutionBackend {
  type: "mock-tee" | "fhe" | "mcp" | "local";

  execute(request: EncryptedRequest): Promise<EncryptedResponse>;

  getMetadata(): {
    trustLevel: "low" | "medium" | "high";
    latency: "low" | "medium" | "high";
    supportsTools: boolean;
  };
}
```

---

## Backend Types

### 1. Mock TEE (v0 default)

- Simulates enclave boundary
- Decrypts inside controlled module
- Fast and easy to build

Used for:

- baseline execution
- agent loop testing

---

### 2. FHE (experimental)

- Operates on encrypted data only
- Extremely slow (mock or stub initially)

Used for:

- research track
- verifying protocol compatibility

---

### 3. MCP / Capability Execution

- Node exposes tools via capability interface
- LLM orchestrates tool usage
- Data exposure controlled via tool boundaries

Used for:

- real-world integrations
- pragmatic privacy

---

### 4. Local

- Runs entirely on client
- No network exposure

Used for:

- sensitive tasks
- fallback

---

## Request Flow (Abstract)

```text
Client
  ↓ encrypt
Routing Layer
  ↓ select backend
Execution Backend
  ↓ compute
Encrypted Response
  ↓
Client decrypts
```

---

## Agent Execution Model

Split across environments:

| Step                | Location          |
| ------------------- | ----------------- |
| Planning            | Node (default)    |
| Sensitive tools     | Client            |
| Non-sensitive tools | Node (if allowed) |
| Final synthesis     | Client            |

---

## Tool Execution Model

```ts
type Tool = {
  name: string;
  sensitivity: "local" | "remote";
  execution: "client" | "node" | "mcp";
};
```

Rules:

- `local` → always runs on client
- `remote` → allowed on node
- `mcp` → capability-based execution

---

## Crypto Model (v0)

- Public/private keypair per client and node
- Ephemeral session key per request
- Payload encrypted before leaving client

```ts
type EncryptedRequest = {
  sessionId: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  backend: "mock-tee" | "fhe" | "mcp";
};
```

---

## Client Responsibilities

- key management
- request encryption
- backend selection (policy-driven)
- tool execution (local)
- response decryption

---

## Node Responsibilities

- expose execution backends
- process encrypted requests
- run model / tools depending on backend
- return encrypted responses

---

## Routing Strategy (v0)

Simple policy-based selection:

```ts
if (request.isSensitive) {
  use("local");
} else if (request.requiresStrongPrivacy) {
  use("mock-tee");
} else {
  use("mcp");
}
```

---

## v0 Scope

### Must Have

- [ ] CLI client
- [ ] Node with pluggable execution backends
- [ ] Mock TEE backend
- [ ] Basic encryption layer
- [ ] Simple agent loop
- [ ] Local tool execution

### Experimental

- [ ] FHE backend (stub/mock)
- [ ] MCP backend (basic capability model)

---

## Out of Scope (for now)

- Real TEEs (Nitro, SGX, etc.)
- Mixnets / onion routing
- Payments / incentives
- Multi-node consensus
- ZK proofs

---

## Design Principles

### 1. Backend Agnostic

Everything routes through execution backends.

### 2. Local-First Privacy

Assume all data is sensitive unless proven otherwise.

### 3. Composability

Crypto, routing, and execution are fully decoupled.

### 4. Replaceability

Every “mock” component should be swappable later.

---

## Milestones

### M1 — Encrypted Echo

Client ↔ node encrypted communication

### M2 — Backend Abstraction

ExecutionBackend interface implemented

### M3 — Agent Loop

Basic plan → execute → respond

### M4 — Tool Calls

Local tool execution via agent

### M5 — Multiple Backends

Mock TEE + MCP + FHE stub working

---

## Final Note

Do not overbuild the crypto or FHE early.

The goal is:

> Prove that a single agent request can flow through multiple trust models without breaking abstractions.

Everything else is iteration.
