//! Wire-format types shared across client and node.
//! Rust is the source of truth; `ts-rs` emits matching `.ts` definitions
//! into `packages/protocol/src/generated/` via `cargo test -p protocol`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "kebab-case")]
pub enum BackendType {
    MockTee,
    Fhe,
    Mcp,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct EncryptedRequest {
    pub session_id: String,
    /// Base64-encoded 32-byte X25519 public key of the client (ephemeral per request).
    pub client_public_key: String,
    /// Base64-encoded 24-byte XChaCha20-Poly1305 nonce.
    pub nonce: String,
    /// Base64-encoded ciphertext (plaintext is JSON-encoded `AgentStep`).
    pub ciphertext: String,
    pub backend: BackendType,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct EncryptedResponse {
    pub session_id: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub public_key: String,
    pub backends: Vec<BackendType>,
}

/// Lifecycle status of a single conversation / session on the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "kebab-case")]
pub enum RequestStatus {
    Running,
    WaitingTool,
    Final,
    Error,
}

/// Per-session record the node keeps so observers (dashboards) can visualize
/// who's doing what. Completed records linger in the log for a short window so
/// fast requests aren't missed by polling dashboards.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct RequestRecord {
    pub session_id: String,
    pub backend: BackendType,
    // ts-rs maps i64 to `bigint` by default, but serde emits these as plain
    // JSON numbers — override so TS sees `number` and matches runtime.
    #[ts(type = "number")]
    pub started_at_ms: i64,
    #[ts(type = "number")]
    pub last_update_ms: i64,
    /// None while in-flight. Set when the request reaches Final or Error.
    #[ts(type = "number | null")]
    pub ended_at_ms: Option<i64>,
    pub status: RequestStatus,
    /// Number of `/execute` round trips seen for this session so far.
    pub step_count: u32,
    pub last_tool_name: Option<String>,
}

/// Published by `GET /activity`. Contains all in-flight sessions plus recently
/// completed ones (retained briefly so fast requests stay visible to pollers).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct NodeActivityReport {
    pub requests: Vec<RequestRecord>,
}

/// Plaintext payload the client sends to the node (encrypted on the wire).
/// Either an initial prompt, or the result of a previously-requested client-side tool call.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(tag = "type")]
pub enum AgentStep {
    #[serde(rename = "prompt")]
    Prompt { prompt: String },
    #[serde(rename = "toolResult", rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// Plaintext payload the node returns to the client.
/// Either a final answer, or a request for the client to execute a local tool.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(tag = "type")]
pub enum AgentResponse {
    #[serde(rename = "final")]
    Final { content: String },
    #[serde(rename = "toolCall", rename_all = "camelCase")]
    ToolCall {
        tool_use_id: String,
        name: String,
        #[ts(type = "unknown")]
        input: serde_json::Value,
    },
}

// ---- Coordinator / discovery types ----

/// Price a node will accept per 1K tokens for a given backend.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct BackendPrice {
    pub backend: BackendType,
    pub price_per_1k: f64,
}

/// Node advertises itself to the coordinator.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct NodeRegistration {
    pub public_key: String,
    pub url: String,
    pub backends: Vec<BackendType>,
    pub max_tokens: u32,
    pub pricing: Vec<BackendPrice>,
}

/// Keepalive — the coordinator expires entries that stop heartbeating.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct NodeHeartbeat {
    pub public_key: String,
}

/// Client's request for a node that fits these constraints.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct JobSpec {
    pub backend: BackendType,
    pub estimated_tokens: u32,
    pub max_price_per_1k: f64,
}

/// Coordinator's answer — the node the client should talk to.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct JobMatch {
    pub url: String,
    pub public_key: String,
}
