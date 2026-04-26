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

/// Token usage for a single agent-loop round trip. Real numbers from the
/// underlying provider — not the client-side `estimated_tokens` on the job
/// spec. Carried back over the wire so the client can compute accurate cost
/// per session and (later) build signed receipts for on-chain settlement.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub cache_read_input_tokens: Option<u32>,
}

impl Usage {
    /// Add another Usage in-place (used by the agent loop to sum provider
    /// calls across one round trip).
    pub fn add(&mut self, other: &Usage) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_creation_input_tokens = sum_opt(
            self.cache_creation_input_tokens,
            other.cache_creation_input_tokens,
        );
        self.cache_read_input_tokens = sum_opt(
            self.cache_read_input_tokens,
            other.cache_read_input_tokens,
        );
    }
}

fn sum_opt(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (None, None) => None,
        (Some(x), None) | (None, Some(x)) => Some(x),
        (Some(x), Some(y)) => Some(x.saturating_add(y)),
    }
}

/// Plaintext payload the node returns to the client.
/// Either a final answer, or a request for the client to execute a local tool.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(tag = "type")]
pub enum AgentResponse {
    #[serde(rename = "final", rename_all = "camelCase")]
    Final { content: String, usage: Usage },
    #[serde(rename = "toolCall", rename_all = "camelCase")]
    ToolCall {
        tool_use_id: String,
        name: String,
        #[ts(type = "unknown")]
        input: serde_json::Value,
        usage: Usage,
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

/// Domain separator for registration signatures.
pub const DOMAIN_REGISTER: &str = "flodex-v0-register";
/// Domain separator for heartbeat signatures.
pub const DOMAIN_HEARTBEAT: &str = "flodex-v0-heartbeat";

/// Node advertises itself to the coordinator. The identity_pubkey + signature
/// pair lets the coordinator verify the registrant owns the claimed identity;
/// future on-chain registries verify the same signature shape against the
/// same hash.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct NodeRegistration {
    /// secp256k1 compressed public key, hex-encoded (66 chars). The node's
    /// stable identity. Future on-chain analog: derive Ethereum address via
    /// keccak256.
    pub identity_pubkey: String,
    /// X25519 public key, base64-encoded. Used by clients for per-session
    /// ECDH; persisted alongside the identity key so it's stable too.
    pub public_key: String,
    pub url: String,
    pub backends: Vec<BackendType>,
    pub max_tokens: u32,
    pub pricing: Vec<BackendPrice>,
    /// 16 random bytes hex-encoded. Makes signature replay observable.
    pub nonce: String,
    /// 64-byte ECDSA signature (r||s), hex-encoded. Computed over
    /// [`canonical_register_bytes`]; verifiable with the identity_pubkey.
    pub signature: String,
}

/// Keepalive — the coordinator expires entries that stop heartbeating. Signed
/// so an attacker who knows a node's identity_pubkey can't keep a stale
/// registration alive on its behalf.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct NodeHeartbeat {
    pub identity_pubkey: String,
    pub nonce: String,
    pub signature: String,
}

#[derive(Serialize)]
struct RegisterCanonical<'a> {
    domain: &'static str,
    identity_pubkey: &'a str,
    public_key: &'a str,
    url: &'a str,
    backends: &'a [BackendType],
    max_tokens: u32,
    pricing: &'a [BackendPrice],
    nonce: &'a str,
}

#[derive(Serialize)]
struct HeartbeatCanonical<'a> {
    domain: &'static str,
    identity_pubkey: &'a str,
    nonce: &'a str,
}

/// Canonical bytes signed by the node when registering. Both the node and
/// the coordinator (and, later, the on-chain registry contract via the same
/// hash) must compute the same byte sequence.
pub fn canonical_register_bytes(reg: &NodeRegistration) -> Vec<u8> {
    serde_json::to_vec(&RegisterCanonical {
        domain: DOMAIN_REGISTER,
        identity_pubkey: &reg.identity_pubkey,
        public_key: &reg.public_key,
        url: &reg.url,
        backends: &reg.backends,
        max_tokens: reg.max_tokens,
        pricing: &reg.pricing,
        nonce: &reg.nonce,
    })
    .expect("serializing register canonical struct cannot fail")
}

/// Canonical bytes signed by the node on each heartbeat.
pub fn canonical_heartbeat_bytes(hb: &NodeHeartbeat) -> Vec<u8> {
    serde_json::to_vec(&HeartbeatCanonical {
        domain: DOMAIN_HEARTBEAT,
        identity_pubkey: &hb.identity_pubkey,
        nonce: &hb.nonce,
    })
    .expect("serializing heartbeat canonical struct cannot fail")
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
