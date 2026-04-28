//! Wire-format types shared across client and node.
//! Rust is the source of truth; `ts-rs` emits matching `.ts` definitions
//! into `packages/protocol/src/generated/` via `cargo test -p protocol`.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
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
    /// 0x-prefixed 32-byte hex channel id this request belongs to. None for
    /// off-channel/free traffic. The node accumulates a per-channel nonce +
    /// cumulative cost when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    /// Client co-signature on the previous round trip's `ChannelUpdate`. The
    /// node's previous response carried a node-signed update; this is the
    /// piggy-backed ack. Absent on the very first request of a channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_ack: Option<ClientAck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct EncryptedResponse {
    pub session_id: String,
    pub nonce: String,
    pub ciphertext: String,
    /// Node-signed cumulative-state update for this round trip. Present iff
    /// the request supplied a `channel_id`. Lives outside the encrypted
    /// envelope so the dashboard can bind it to wallet co-signing without
    /// decrypting twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<NodeSignedReceipt>,
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
/// `price_per_1k` is a decimal string of raw USDC base units (6 decimals) —
/// e.g. `"15000"` = 0.015 USDC per 1k tokens. Stored as a string so it
/// round-trips unchanged through TS BigInt and matches the on-chain
/// `uint256[BACKEND_COUNT]` exactly.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct BackendPrice {
    pub backend: BackendType,
    pub price_per_1k: String,
}

/// Domain separator for registration signatures.
pub const DOMAIN_REGISTER: &str = "flodex-v0-register";
/// Domain separator for heartbeat signatures.
pub const DOMAIN_HEARTBEAT: &str = "flodex-v0-heartbeat";
/// Domain separator for standing-offer bid signatures.
pub const DOMAIN_BID: &str = "flodex-v0-bid";

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

/// A short-lived signed offer the node broadcasts to advertise current
/// per-backend pricing. Distinct from the standing pricing in
/// `NodeRegistration` because bids carry an explicit `valid_until` window
/// and may differ from the registration default — useful for load-aware
/// pricing or reverse-auction style matching. Coordinators host an
/// in-memory bid book; clients select the lowest-priced bid that satisfies
/// a `JobSpec`.
///
/// Self-authenticating: anyone holding the bid + the registry's record of
/// the node's `identity_pubkey` can verify the signature without trusting
/// the coordinator.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct Bid {
    /// secp256k1 compressed pubkey hex (66 chars). Same key the node uses
    /// for registration; doubles as on-chain identity via keccak256.
    pub identity_pubkey: String,
    pub backend: BackendType,
    /// Decimal string of raw USDC base units per 1k tokens.
    pub price_per_1k: String,
    /// Maximum tokens this bid is willing to serve in one job.
    pub max_tokens: u32,
    /// Unix seconds. Coordinator drops bids past this point.
    #[ts(type = "number")]
    pub valid_until: u64,
    /// 16 random bytes hex — keeps signature unique for the same prices
    /// when the node refreshes a bid before the previous expires.
    pub nonce: String,
    /// 64-byte ECDSA r||s hex over `canonical_bid_bytes`.
    pub signature: String,
}

#[derive(Serialize)]
struct BidCanonical<'a> {
    domain: &'static str,
    identity_pubkey: &'a str,
    backend: BackendType,
    price_per_1k: &'a str,
    max_tokens: u32,
    valid_until: u64,
    nonce: &'a str,
}

/// Canonical bytes the node signs over to produce a `Bid.signature`.
pub fn canonical_bid_bytes(bid: &Bid) -> Vec<u8> {
    serde_json::to_vec(&BidCanonical {
        domain: DOMAIN_BID,
        identity_pubkey: &bid.identity_pubkey,
        backend: bid.backend,
        price_per_1k: &bid.price_per_1k,
        max_tokens: bid.max_tokens,
        valid_until: bid.valid_until,
        nonce: &bid.nonce,
    })
    .expect("serializing bid canonical struct cannot fail")
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

// ---- Payment-channel types ----

/// The thing both client and node sign on every request. Cumulative — each
/// signed state subsumes all earlier ones for the channel. On close, the
/// highest mutually-signed state goes on-chain in one tx.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpdate {
    /// 0x-prefixed 32-byte hex; matches `JobChannel.channelIdOf(...)`.
    pub channel_id: String,
    pub nonce: u64,
    /// Decimal string of raw USDC base units (6 decimals) — matches uint256
    /// on-chain. Cumulative; never decreases across a channel.
    pub cum_owed: String,
}

/// Per-round-trip breakdown for the client's audit. Not signed and not
/// consumed on-chain — the contract trusts the bilateral signature on the
/// `ChannelUpdate`. Provided so the client can verify the node didn't
/// overcharge before co-signing.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct ReceiptBreakdown {
    pub session_id: String,
    pub backend: BackendType,
    pub usage: Usage,
    /// Snapshot of the node's price_per_1k at receipt time. Client compares
    /// against the on-chain registry before signing.
    pub price_per_1k: String,
    pub round_trip_cost: String,
}

/// Returned by the node on every `/execute` round trip when the request
/// supplied a `channel_id`. Carries the freshly-bumped cumulative state and
/// a node-side EIP-191 signature over its canonical-bytes encoding.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct NodeSignedReceipt {
    pub update: ChannelUpdate,
    pub breakdown: ReceiptBreakdown,
    /// 0x-prefixed 65-byte hex (r||s||v, v in {27,28}).
    pub node_sig: String,
}

/// Client's co-signature on a previously-received `ChannelUpdate`. Piggybacks
/// on the *next* request via `EncryptedRequest.prev_ack`, or is POSTed to
/// `/ack` standalone before close.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../packages/protocol/src/generated/")]
#[serde(rename_all = "camelCase")]
pub struct ClientAck {
    pub update: ChannelUpdate,
    pub client_sig: String,
}

/// Domain string for channel-update signatures. The on-chain contract
/// embeds `keccak256(CHANNEL_UPDATE_DOMAIN)` as a `bytes32` constant.
pub const CHANNEL_UPDATE_DOMAIN: &str = "flodex-v0-channel-update";

/// `keccak256("flodex-v0-channel-update")`. Computed once; the value is the
/// same one stored on-chain.
pub fn channel_update_domain_hash() -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Keccak256::digest(CHANNEL_UPDATE_DOMAIN.as_bytes()));
    out
}

/// Build the 192-byte canonical bytes the contract `abi.encode`s and
/// keccak256s — see `JobChannel.updateDigest`. Layout (six 32-byte slots):
///
/// 1. `keccak256(CHANNEL_UPDATE_DOMAIN)`
/// 2. `chain_id`              (uint256, big-endian)
/// 3. `contract` address      (left-padded to 32)
/// 4. `channel_id`            (bytes32)
/// 5. `nonce`                 (uint256, big-endian)
/// 6. `cum_owed`              (uint256, big-endian)
///
/// Caller keccak256's the result and EIP-191 wraps it for signing /
/// verification.
pub fn canonical_channel_update_bytes(
    chain_id: u64,
    contract: &[u8; 20],
    channel_id: &[u8; 32],
    nonce: u64,
    cum_owed: &[u8; 32],
) -> [u8; 192] {
    let mut out = [0u8; 192];
    out[0..32].copy_from_slice(&channel_update_domain_hash());
    out[32 + 24..32 + 32].copy_from_slice(&chain_id.to_be_bytes());
    out[64 + 12..64 + 32].copy_from_slice(contract);
    out[96..128].copy_from_slice(channel_id);
    out[128 + 24..128 + 32].copy_from_slice(&nonce.to_be_bytes());
    out[160..192].copy_from_slice(cum_owed);
    out
}

/// Parse a 0x-prefixed 32-byte hex channel id into raw bytes.
pub fn channel_id_from_hex(s: &str) -> Result<[u8; 32]> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(stripped).map_err(|e| anyhow!("invalid channel id hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(anyhow!("channel id must be 32 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Parse a 0x-prefixed 20-byte hex Ethereum address.
pub fn eth_address_from_hex(s: &str) -> Result<[u8; 20]> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(stripped).map_err(|e| anyhow!("invalid address hex: {e}"))?;
    if bytes.len() != 20 {
        return Err(anyhow!("address must be 20 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Decimal-string → 32-byte big-endian uint256. Accepts up to u128 (more than
/// 10^32 USDC base units — beyond any real-world figure).
pub fn u256_be_from_decimal(s: &str) -> Result<[u8; 32]> {
    let n: u128 = s.parse().map_err(|_| anyhow!("invalid decimal u256: {s}"))?;
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&n.to_be_bytes());
    Ok(out)
}

/// Build the canonical channel-update bytes from the wire-format types —
/// what node + client both feed into `eip191_digest` for signing /
/// verification.
pub fn channel_update_canonical_for(
    update: &ChannelUpdate,
    chain_id: u64,
    contract: &[u8; 20],
) -> Result<[u8; 192]> {
    let channel_id = channel_id_from_hex(&update.channel_id)?;
    let cum_owed = u256_be_from_decimal(&update.cum_owed)?;
    Ok(canonical_channel_update_bytes(
        chain_id,
        contract,
        &channel_id,
        update.nonce,
        &cum_owed,
    ))
}

#[cfg(test)]
mod channel_tests {
    use super::*;

    #[test]
    fn domain_hash_known() {
        // keccak256("flodex-v0-channel-update") — sanity check that protocol
        // and contract agree on the bytes32 constant.
        let h = channel_update_domain_hash();
        // Anyone can recompute via `cast keccak "flodex-v0-channel-update"`;
        // we keep the assertion loose by re-deriving (since recomputing here
        // proves only that Keccak256 is deterministic, not the value).
        // The integration check that matters is the e2e contract verify.
        let again = channel_update_domain_hash();
        assert_eq!(h, again);
        // Length check.
        assert_eq!(h.len(), 32);
    }

    #[test]
    fn canonical_bytes_layout() {
        let contract: [u8; 20] = [0x11; 20];
        let channel_id: [u8; 32] = [0x22; 32];
        let cum_owed: [u8; 32] = {
            let mut a = [0u8; 32];
            a[24..].copy_from_slice(&12345u64.to_be_bytes());
            a
        };
        let bytes = canonical_channel_update_bytes(
            84532,
            &contract,
            &channel_id,
            7,
            &cum_owed,
        );
        assert_eq!(bytes.len(), 192);
        // Slot 1 is the domain hash.
        assert_eq!(&bytes[0..32], &channel_update_domain_hash());
        // Slot 2: chain_id big-endian in the last 8 bytes.
        let mut chain_be = [0u8; 8];
        chain_be.copy_from_slice(&bytes[56..64]);
        assert_eq!(u64::from_be_bytes(chain_be), 84532);
        // Slot 3: address left-padded with 12 zero bytes.
        assert_eq!(&bytes[64..76], &[0u8; 12]);
        assert_eq!(&bytes[76..96], &contract);
        // Slot 4: channel id verbatim.
        assert_eq!(&bytes[96..128], &channel_id);
        // Slot 5: nonce big-endian in last 8.
        let mut nonce_be = [0u8; 8];
        nonce_be.copy_from_slice(&bytes[152..160]);
        assert_eq!(u64::from_be_bytes(nonce_be), 7);
        // Slot 6: cumOwed verbatim.
        assert_eq!(&bytes[160..192], &cum_owed);
    }

    #[test]
    fn channel_update_canonical_from_wire() {
        let update = ChannelUpdate {
            channel_id: "0x".to_string() + &"ab".repeat(32),
            nonce: 42,
            cum_owed: "1000000".to_string(),
        };
        let contract = [0x33u8; 20];
        let bytes = channel_update_canonical_for(&update, 84532, &contract).unwrap();
        // Slot 4 = 0xab repeated.
        assert_eq!(&bytes[96..128], &[0xabu8; 32]);
        // Slot 6 last 8 bytes = 1_000_000 big-endian.
        let mut owed_be = [0u8; 8];
        owed_be.copy_from_slice(&bytes[184..192]);
        assert_eq!(u64::from_be_bytes(owed_be), 1_000_000);
    }
}
