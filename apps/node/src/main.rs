mod chains;
mod eth;
mod identity;

use agent::{
    AgentLoop, AnthropicClient, AnthropicProvider, ChatProvider, ChatRequest, CurrentTimeTool,
    DEFAULT_MODEL, Tool, WebFetchTool, read_local_file_def,
};
use anyhow::{anyhow, Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crypto::{
    decrypt, derive_key, encrypt, random_nonce_hex, recover_eip191, NodeIdentity, NodeKeys,
    EIP191_SIG_SIZE, ETH_ADDRESS_SIZE,
};
use execution::{ExecutionBackend, LocalLlmBackend, MockTeeBackend};
use local_llm::{default_cache_dir, resolve, LlamaServer, ModelSpec, OpenAiProvider};
use protocol::{
    canonical_bid_bytes, canonical_heartbeat_bytes, canonical_register_bytes, channel_id_from_hex,
    channel_update_canonical_for, AgentResponse, AgentStep, BackendPrice, BackendType, Bid,
    ChannelUpdate, ClientAck, EncryptedRequest, EncryptedResponse, NodeActivityReport,
    NodeHeartbeat, NodeInfo, NodeRegistration, NodeSignedReceipt, ReceiptBreakdown, RequestRecord,
    RequestStatus, Usage,
};
use crate::chains::ChainConfig;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use x25519_dalek::PublicKey;

const SYSTEM_PROMPT: &str = "\
You are a helpful assistant running inside a privacy-preserving LLM execution node. \
The user communicates with you via end-to-end encryption. \
Use the tools available to you when they help answer the user's request. \
Keep responses concise.";

struct AppState {
    keys: NodeKeys,
    identity: NodeIdentity,
    mock_tee: Option<MockTeeBackend>,
    local_llm: Option<LocalLlmBackend>,
    /// Held for lifetime — dropping it kills the child `llama-server`.
    _llama_server: Option<LlamaServer>,
    /// Per-session lifecycle log. Read via `/activity` so dashboards can show
    /// which sessions are in flight, their elapsed time, tool calls, etc.,
    /// regardless of who initiated the request.
    activity: Arc<ActivityLog>,
    /// Per-backend pricing (raw USDC base units per 1k tokens) the node
    /// quoted at startup. Used to value each round trip's Usage when
    /// building a channel receipt.
    pricing: Vec<BackendPrice>,
    /// Resolved from FLDX_CHAIN_ID. None ⇒ off-chain only mode; channel
    /// receipts are skipped.
    chain: Option<ChainConfig>,
    /// Per-channel cumulative state. Keyed by 32-byte channel id. v0 is
    /// in-memory only; if the node restarts mid-channel, the dashboard
    /// falls back to challengeClose with the latest state it co-signed.
    channels: Arc<Mutex<HashMap<[u8; 32], ChannelState>>>,
}

/// Per-channel state the node accumulates as requests come in.
#[derive(Debug, Clone)]
struct ChannelState {
    /// Most recent nonce the node has signed for this channel.
    nonce: u64,
    /// Most recent cumOwed the node has signed (raw USDC base units).
    cum_owed: u128,
    /// Latest bilaterally-signed (client + node) state. What the node would
    /// submit on `cooperativeClose`. None until the first ack arrives — at
    /// most one round trip's worth of bad debt at any moment.
    last_acked: Option<ClientAck>,
    /// Client's Ethereum address, learned on the first ack and asserted
    /// constant thereafter. None until the first ack.
    client_address: Option<[u8; ETH_ADDRESS_SIZE]>,
    /// On-chain deposit for this channel, fetched on first request and
    /// cached. Capping `cum_owed` at this is what bounds the node's risk;
    /// requests are refused with 402 once `cum_owed >= deposit`.
    deposit: Option<u128>,
}

const ACTIVITY_RETENTION_MS: i64 = 30_000;

/// Per-session lifecycle log. Retains completed records briefly so polling
/// dashboards don't miss fast-completing requests.
struct ActivityLog {
    records: Mutex<HashMap<String, RequestRecord>>,
}

impl ActivityLog {
    fn new() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }

    /// Called when a new `/execute` step starts. Creates a new record on first
    /// call for this session id; otherwise bumps `step_count`, marks Running,
    /// and clears any prior `ended_at_ms` (re-opens after a WaitingTool step).
    fn begin_step(&self, session_id: &str, backend: BackendType) {
        let now = now_ms();
        let mut map = self.records.lock().unwrap();
        let entry = map.entry(session_id.to_string()).or_insert_with(|| RequestRecord {
            session_id: session_id.to_string(),
            backend,
            started_at_ms: now,
            last_update_ms: now,
            ended_at_ms: None,
            status: RequestStatus::Running,
            step_count: 0,
            last_tool_name: None,
        });
        entry.step_count = entry.step_count.saturating_add(1);
        entry.last_update_ms = now;
        entry.status = RequestStatus::Running;
        entry.ended_at_ms = None;
    }

    fn end_step(
        &self,
        session_id: &str,
        status: RequestStatus,
        tool_name: Option<String>,
    ) {
        let now = now_ms();
        let mut map = self.records.lock().unwrap();
        let Some(entry) = map.get_mut(session_id) else {
            return;
        };
        entry.last_update_ms = now;
        entry.status = status;
        if tool_name.is_some() {
            entry.last_tool_name = tool_name;
        }
        if matches!(status, RequestStatus::Final | RequestStatus::Error) {
            entry.ended_at_ms = Some(now);
        } else {
            entry.ended_at_ms = None;
        }
    }

    fn snapshot(&self) -> Vec<RequestRecord> {
        let now = now_ms();
        let mut map = self.records.lock().unwrap();
        map.retain(|_, r| match r.ended_at_ms {
            None => true,
            Some(end) => now - end < ACTIVITY_RETENTION_MS,
        });
        map.values().cloned().collect()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// RAII: ensures a step is always resolved even on panic/early return.
/// Call `.resolve(status, tool)` on the happy path; otherwise Drop marks Error.
struct StepGuard<'a> {
    log: &'a ActivityLog,
    session_id: String,
    resolved: bool,
}

impl<'a> StepGuard<'a> {
    fn new(log: &'a ActivityLog, session_id: String, backend: BackendType) -> Self {
        log.begin_step(&session_id, backend);
        Self {
            log,
            session_id,
            resolved: false,
        }
    }

    fn resolve(mut self, status: RequestStatus, tool_name: Option<String>) {
        self.log.end_step(&self.session_id, status, tool_name);
        self.resolved = true;
    }
}

impl Drop for StepGuard<'_> {
    fn drop(&mut self) {
        if !self.resolved {
            self.log
                .end_step(&self.session_id, RequestStatus::Error, None);
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info,agent=info,local_llm=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let (mock_tee, local_llm, llama_server) = init_backends().await?;
    if mock_tee.is_none() && local_llm.is_none() {
        return Err(anyhow!(
            "no backends configured. Set ANTHROPIC_API_KEY for mock-tee, \
             FLDX_LLAMA_MODEL for local, or both."
        ));
    }

    let identity_path = identity::default_path()?;
    let (keys, identity) = identity::load_or_generate(&identity_path)?;

    let mut backends: Vec<BackendType> = Vec::new();
    if mock_tee.is_some() {
        backends.push(BackendType::MockTee);
    }
    if local_llm.is_some() {
        backends.push(BackendType::Local);
    }
    let pricing = read_pricing(&backends);
    let chain = chains::from_env();

    let state = Arc::new(AppState {
        keys,
        identity,
        mock_tee,
        local_llm,
        _llama_server: llama_server,
        activity: Arc::new(ActivityLog::new()),
        pricing: pricing.clone(),
        chain,
        channels: Arc::new(Mutex::new(HashMap::new())),
    });
    let identity_pubkey_hex = hex::encode(state.identity.public_compressed());
    tracing::info!(
        backends = ?backends,
        identity_pubkey = %identity_pubkey_hex,
        ecdh_pubkey = %B64.encode(state.keys.public.as_bytes()),
        "fldx node ready"
    );

    if let Some(ref chain) = state.chain {
        tracing::info!(
            chain = %chain.name,
            chain_id = chain.chain_id,
            registry = ?chain.registry,
            channel = ?chain.channel,
            usdc = %chain.usdc,
            eth_address = %format_args!("0x{}", hex::encode(state.identity.eth_address())),
            "chain config loaded"
        );
    }

    let addr = std::env::var("FLDX_NODE_ADDR").unwrap_or_else(|_| "127.0.0.1:7777".to_string());
    let advertise_url =
        std::env::var("FLDX_NODE_URL").unwrap_or_else(|_| format!("http://{addr}"));
    let max_tokens = std::env::var("FLDX_NODE_MAX_TOKENS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000u32);

    // Auto-register on-chain if we have a chain + registry. Runs in the
    // background so node startup isn't blocked by an unhealthy RPC.
    if let Some(ref chain) = state.chain {
        if let Some(registry_hex) = chain.registry {
            spawn_register(
                state.clone(),
                chain.chain_id,
                chains::rpc_url(chain),
                chain.usdc.to_string(),
                registry_hex.to_string(),
                advertise_url.clone(),
                backends.clone(),
                max_tokens,
                pricing.clone(),
            );
        }
    }

    let app = Router::new()
        .route("/info", get(info))
        .route("/activity", get(activity))
        .route("/execute", post(execute))
        .route("/ack", post(ack))
        .route("/proxy/complete", post(proxy_complete))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    if let Ok(coord_url) = std::env::var("FLDX_COORDINATOR") {
        let ecdh_pubkey_b64 = B64.encode(state.keys.public.as_bytes());
        let backends_for_bids = backends.clone();
        let pricing_for_bids = pricing.clone();
        let identity_for_bids = identity_pubkey_hex.clone();

        tokio::spawn(registration_loop(
            coord_url.clone(),
            state.clone(),
            RegistrationConfig {
                identity_pubkey: identity_pubkey_hex,
                ecdh_pubkey: ecdh_pubkey_b64,
                advertise_url,
                backends,
                max_tokens,
                pricing,
            },
        ));

        // Standing-offer bid broadcaster — refreshes every 60s, each bid
        // valid for 180s. Lets the coordinator's lowest-bid matcher pick us
        // even when registrations have stale prices.
        tokio::spawn(bid_loop(
            coord_url,
            state.clone(),
            identity_for_bids,
            backends_for_bids,
            max_tokens,
            pricing_for_bids,
        ));
    }

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    tracing::info!("fldx node listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
    Ok(())
}

/// Stake amount the node will lock when calling `register()`. Defaults to
/// 100 USDC = 100_000_000 base units; override with `FLDX_NODE_STAKE` (raw
/// USDC base units, decimal).
fn read_stake() -> u128 {
    std::env::var("FLDX_NODE_STAKE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000_000)
}

fn spawn_register(
    state: Arc<AppState>,
    chain_id: u64,
    rpc_url: String,
    usdc_hex: String,
    registry_hex: String,
    advertise_url: String,
    backends: Vec<BackendType>,
    max_tokens: u32,
    pricing: Vec<BackendPrice>,
) {
    let usdc = match parse_addr(&usdc_hex) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("auto-register skipped — bad USDC address {usdc_hex}: {e}");
            return;
        }
    };
    let registry = match parse_addr(&registry_hex) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("auto-register skipped — bad registry address {registry_hex}: {e}");
            return;
        }
    };
    let ecdh_pubkey: [u8; 32] = *state.keys.public.as_bytes();
    let bitmap = eth::backend_bitmap(&backends);
    let price_array = match eth::pricing_to_array(&pricing) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("auto-register skipped — invalid pricing: {e}");
            return;
        }
    };
    let stake = eth::u256_from_u128(read_stake());

    let params = eth::RegisterParams {
        rpc_url,
        chain_id,
        usdc,
        registry,
        url: advertise_url,
        ecdh_pubkey,
        backend_bitmap: bitmap,
        max_tokens: max_tokens as u64,
        price_per_1k: price_array,
        stake,
    };

    tokio::spawn(async move {
        if let Err(e) = eth::ensure_registered(&state.identity, params).await {
            tracing::warn!(
                "auto-register failed: {e:#}. Falling back to manual flow — \
                 see README \"Register a node on-chain\"."
            );
        }
    });
}

fn read_pricing(backends: &[BackendType]) -> Vec<BackendPrice> {
    backends
        .iter()
        .map(|b| {
            let env_key = match b {
                BackendType::MockTee => "FLDX_NODE_PRICE_MOCK_TEE",
                BackendType::Local => "FLDX_NODE_PRICE_LOCAL",
                BackendType::Fhe => "FLDX_NODE_PRICE_FHE",
                BackendType::Mcp => "FLDX_NODE_PRICE_MCP",
            };
            // Env var is a float in USDC dollars per 1k tokens (e.g. "0.015"),
            // converted to raw USDC base units (6 decimals) for protocol +
            // on-chain parity. So 0.015 → 15000 base units.
            let price_dollars: f64 = std::env::var(env_key)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let price_units = (price_dollars * 1_000_000.0) as u128;
            BackendPrice {
                backend: *b,
                price_per_1k: price_units.to_string(),
            }
        })
        .collect()
}

struct RegistrationConfig {
    identity_pubkey: String,
    ecdh_pubkey: String,
    advertise_url: String,
    backends: Vec<BackendType>,
    max_tokens: u32,
    pricing: Vec<BackendPrice>,
}

fn signed_registration(state: &AppState, cfg: &RegistrationConfig) -> NodeRegistration {
    let mut reg = NodeRegistration {
        identity_pubkey: cfg.identity_pubkey.clone(),
        public_key: cfg.ecdh_pubkey.clone(),
        url: cfg.advertise_url.clone(),
        backends: cfg.backends.clone(),
        max_tokens: cfg.max_tokens,
        pricing: cfg.pricing.clone(),
        nonce: random_nonce_hex(),
        signature: String::new(),
    };
    let canonical = canonical_register_bytes(&reg);
    reg.signature = hex::encode(state.identity.sign(&canonical));
    reg
}

fn signed_heartbeat(state: &AppState, identity_pubkey: &str) -> NodeHeartbeat {
    let mut hb = NodeHeartbeat {
        identity_pubkey: identity_pubkey.to_string(),
        nonce: random_nonce_hex(),
        signature: String::new(),
    };
    let canonical = canonical_heartbeat_bytes(&hb);
    hb.signature = hex::encode(state.identity.sign(&canonical));
    hb
}

/// Build + sign a standing-offer bid for a single backend.
fn signed_bid(
    state: &AppState,
    identity_pubkey: &str,
    backend: BackendType,
    pricing: &[BackendPrice],
    max_tokens: u32,
    valid_for_secs: u64,
) -> Option<Bid> {
    let price = pricing
        .iter()
        .find(|p| p.backend == backend)
        .map(|p| p.price_per_1k.clone())?;
    let valid_until = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs()
        .saturating_add(valid_for_secs);
    let mut bid = Bid {
        identity_pubkey: identity_pubkey.to_string(),
        backend,
        price_per_1k: price,
        max_tokens,
        valid_until,
        nonce: random_nonce_hex(),
        signature: String::new(),
    };
    let canonical = canonical_bid_bytes(&bid);
    bid.signature = hex::encode(state.identity.sign(&canonical));
    Some(bid)
}

async fn bid_loop(
    coord_url: String,
    state: Arc<AppState>,
    identity_pubkey: String,
    backends: Vec<BackendType>,
    max_tokens: u32,
    pricing: Vec<BackendPrice>,
) {
    const REFRESH: std::time::Duration = std::time::Duration::from_secs(60);
    const VALID_FOR: u64 = 180; // 3× refresh — survives one missed POST.
    let http = reqwest::Client::new();
    let bids_url = format!("{coord_url}/bids");

    loop {
        for backend in &backends {
            let Some(bid) = signed_bid(&state, &identity_pubkey, *backend, &pricing, max_tokens, VALID_FOR)
            else {
                continue;
            };
            match http.post(&bids_url).json(&bid).send().await {
                Ok(r) if r.status().is_success() => {
                    tracing::debug!(backend = ?backend, "bid posted");
                }
                Ok(r) => {
                    tracing::warn!(status = %r.status(), backend = ?backend, "bid rejected");
                }
                Err(e) => tracing::warn!("bid post failed: {e}"),
            }
        }
        tokio::time::sleep(REFRESH).await;
    }
}

async fn registration_loop(
    coord_url: String,
    state: Arc<AppState>,
    cfg: RegistrationConfig,
) {
    let http = reqwest::Client::new();
    let register_url = format!("{coord_url}/nodes/register");
    let heartbeat_url = format!("{coord_url}/nodes/heartbeat");

    loop {
        let reg = signed_registration(&state, &cfg);
        match http.post(&register_url).json(&reg).send().await {
            Ok(r) if r.status().is_success() => {
                tracing::info!(coord = %coord_url, "registered with coordinator");
                break;
            }
            Ok(r) => tracing::warn!(status = %r.status(), "coordinator register rejected"),
            Err(e) => tracing::warn!("coordinator register failed: {e}"),
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        let hb = signed_heartbeat(&state, &cfg.identity_pubkey);
        match http.post(&heartbeat_url).json(&hb).send().await {
            Ok(r) if r.status().is_success() => {}
            Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
                tracing::warn!("coordinator forgot us; re-registering");
                let reg = signed_registration(&state, &cfg);
                let _ = http.post(&register_url).json(&reg).send().await;
            }
            Ok(r) => tracing::warn!(status = %r.status(), "heartbeat rejected"),
            Err(e) => tracing::warn!("heartbeat failed: {e}"),
        }
    }
}

async fn init_backends() -> Result<(Option<MockTeeBackend>, Option<LocalLlmBackend>, Option<LlamaServer>)> {
    let tools = || -> Vec<Tool> {
        vec![
            Tool::Node(Arc::new(CurrentTimeTool)),
            Tool::Node(Arc::new(WebFetchTool::new())),
            Tool::Client(read_local_file_def()),
        ]
    };

    // mock-tee (Claude-backed) is enabled when ANTHROPIC_API_KEY is set.
    let mock_tee = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(key) => {
            let model =
                std::env::var("FLDX_NODE_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
            tracing::info!(model = %model, "initializing mock-tee backend (Anthropic)");
            let provider: Box<dyn ChatProvider> =
                Box::new(AnthropicProvider::new(AnthropicClient::new(key), model));
            let loop_ = AgentLoop::new(provider, SYSTEM_PROMPT.to_string(), tools());
            Some(MockTeeBackend::new(loop_))
        }
        Err(_) => None,
    };

    // local backend is enabled when FLDX_LLAMA_MODEL is set.
    let (local_llm, llama_server) = match std::env::var("FLDX_LLAMA_MODEL") {
        Ok(spec_str) => {
            tracing::info!(spec = %spec_str, "initializing local backend (llama-server)");
            let spec = ModelSpec::parse(&spec_str).context("parsing FLDX_LLAMA_MODEL")?;
            let cache = default_cache_dir();
            let model_path = resolve(&spec, &cache).await.context("resolving model")?;
            let server = LlamaServer::spawn(&model_path).await.context("starting llama-server")?;
            let provider: Box<dyn ChatProvider> =
                Box::new(OpenAiProvider::new(server.base_url.clone(), "local".to_string()));
            let loop_ = AgentLoop::new(provider, SYSTEM_PROMPT.to_string(), tools());
            (Some(LocalLlmBackend::new(loop_)), Some(server))
        }
        Err(_) => (None, None),
    };

    Ok((mock_tee, local_llm, llama_server))
}

async fn activity(State(state): State<Arc<AppState>>) -> Json<NodeActivityReport> {
    Json(NodeActivityReport {
        requests: state.activity.snapshot(),
    })
}

async fn info(State(state): State<Arc<AppState>>) -> Json<NodeInfo> {
    let mut backends = Vec::new();
    if state.mock_tee.is_some() {
        backends.push(BackendType::MockTee);
    }
    if state.local_llm.is_some() {
        backends.push(BackendType::Local);
    }
    Json(NodeInfo {
        public_key: B64.encode(state.keys.public.as_bytes()),
        backends,
    })
}

async fn execute(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EncryptedRequest>,
) -> Result<Json<EncryptedResponse>, ApiError> {
    // Guard is held through the whole step; on normal completion we call
    // `.resolve(...)`; on early return / panic, Drop marks the session Errored.
    let guard = StepGuard::new(&state.activity, req.session_id.clone(), req.backend);
    let client_pub = decode_client_pub(&req.client_public_key)?;
    let shared = state.keys.shared_secret(&client_pub);
    let key = derive_key(&shared, &req.session_id);

    let nonce = B64
        .decode(&req.nonce)
        .map_err(|e| ApiError::BadRequest(format!("invalid nonce b64: {e}")))?;
    let ciphertext = B64
        .decode(&req.ciphertext)
        .map_err(|e| ApiError::BadRequest(format!("invalid ciphertext b64: {e}")))?;

    let plaintext = decrypt(&key, &nonce, &ciphertext)
        .map_err(|e| ApiError::BadRequest(format!("decrypt: {e}")))?;
    let step: AgentStep = serde_json::from_slice(&plaintext)
        .map_err(|e| ApiError::BadRequest(format!("plaintext is not a valid AgentStep: {e}")))?;

    let backend: &dyn ExecutionBackend = match req.backend {
        BackendType::MockTee => state.mock_tee.as_ref().ok_or_else(|| {
            ApiError::NotImplemented(
                "mock-tee not configured — set ANTHROPIC_API_KEY to enable".into(),
            )
        })?,
        BackendType::Local => state.local_llm.as_ref().ok_or_else(|| {
            ApiError::NotImplemented(
                "local not configured — set FLDX_LLAMA_MODEL to enable".into(),
            )
        })?,
        other => {
            return Err(ApiError::NotImplemented(format!(
                "backend {other:?} not wired yet"
            )))
        }
    };

    // DoS gate: if the request is channel-bound, look up the channel's
    // on-chain deposit (caching it) and refuse upfront when the existing
    // cum_owed has already crossed the deposit. Spending compute on a
    // request whose receipt we couldn't recover anything for is a free
    // ride for the client; that's the DDoS vector.
    if let Some(id_hex) = req.channel_id.as_deref() {
        check_channel_solvent(&state, id_hex).await?;
    }

    let agent_response = backend
        .step(&req.session_id, step)
        .await
        .map_err(|e| ApiError::Internal(format!("backend step: {e}")))?;

    let (status, tool_name) = match &agent_response {
        AgentResponse::Final { .. } => (RequestStatus::Final, None),
        AgentResponse::ToolCall { name, .. } => {
            (RequestStatus::WaitingTool, Some(name.clone()))
        }
    };

    // Build a node-signed channel receipt iff the request was channel-bound.
    // Failure here aborts the request — better to surface "your channel
    // is misconfigured" loudly than silently hand back a free response.
    let receipt = match req.channel_id.as_deref() {
        Some(id_hex) => Some(build_receipt(
            &state,
            id_hex,
            req.backend,
            req.session_id.as_str(),
            usage_of(&agent_response),
            req.prev_ack.as_ref(),
        )?),
        None => None,
    };

    let resp_bytes = serde_json::to_vec(&agent_response)
        .map_err(|e| ApiError::Internal(format!("serialize response: {e}")))?;
    let (resp_nonce, resp_ct) =
        encrypt(&key, &resp_bytes).map_err(|e| ApiError::Internal(format!("encrypt: {e}")))?;

    let session_id = req.session_id;
    guard.resolve(status, tool_name);

    Ok(Json(EncryptedResponse {
        session_id,
        nonce: B64.encode(resp_nonce),
        ciphertext: B64.encode(resp_ct),
        receipt,
    }))
}

fn usage_of(resp: &AgentResponse) -> Usage {
    match resp {
        AgentResponse::Final { usage, .. } => *usage,
        AgentResponse::ToolCall { usage, .. } => *usage,
    }
}

/// Ensure `cum_owed < deposit` for the given channel. Fetches deposit on
/// first sight (lock dropped during the eth_call). Returns 402 if exhausted.
async fn check_channel_solvent(state: &AppState, channel_id_hex: &str) -> Result<(), ApiError> {
    let chain = state.chain.as_ref().ok_or_else(|| {
        ApiError::BadRequest("channel_id supplied but FLDX_CHAIN_ID is unset".into())
    })?;
    let channel_addr_hex = chain.channel.ok_or_else(|| {
        ApiError::BadRequest("channel_id supplied but no channel contract on this chain".into())
    })?;
    let channel_addr = parse_addr(channel_addr_hex)
        .map_err(|e| ApiError::Internal(format!("invalid channel address: {e}")))?;
    let channel_id = channel_id_from_hex(channel_id_hex)
        .map_err(|e| ApiError::BadRequest(format!("invalid channel_id: {e}")))?;

    // Cached deposit + current cum_owed under a brief lock.
    let (cached_deposit, cum_owed) = {
        let channels = state.channels.lock().unwrap();
        match channels.get(&channel_id) {
            Some(s) => (s.deposit, s.cum_owed),
            None => (None, 0u128),
        }
    };
    let deposit = match cached_deposit {
        Some(d) => d,
        None => {
            let rpc = chains::rpc_url(chain);
            let rpc_client = eth::rpc::EthRpc::new(rpc);
            let data = eth::abi::encode_channels_call(&channel_id);
            let returndata = rpc_client
                .eth_call(&channel_addr, &data, None)
                .await
                .map_err(|e| ApiError::Internal(format!("channels() eth_call: {e}")))?;
            let d = eth::abi::decode_channel_deposit(&returndata)
                .map_err(|e| ApiError::Internal(format!("decode channels(): {e}")))?;
            // Cache it under the lock.
            let mut channels = state.channels.lock().unwrap();
            let entry = channels.entry(channel_id).or_insert_with(|| ChannelState {
                nonce: 0,
                cum_owed: 0,
                last_acked: None,
                client_address: None,
                deposit: None,
            });
            entry.deposit = Some(d);
            d
        }
    };
    if deposit == 0 {
        return Err(ApiError::PaymentRequired(format!(
            "channel {channel_id_hex} has zero deposit (or doesn't exist on-chain)"
        )));
    }
    if cum_owed >= deposit {
        return Err(ApiError::PaymentRequired(format!(
            "channel {channel_id_hex} exhausted: cum_owed {cum_owed} ≥ deposit {deposit}"
        )));
    }
    Ok(())
}

/// Cost-account a round trip against the channel and produce a node-signed
/// receipt over the freshly-bumped cumulative state.
fn build_receipt(
    state: &AppState,
    channel_id_hex: &str,
    backend: BackendType,
    session_id: &str,
    usage: Usage,
    prev_ack: Option<&ClientAck>,
) -> Result<NodeSignedReceipt, ApiError> {
    let chain = state
        .chain
        .as_ref()
        .ok_or_else(|| ApiError::BadRequest("channel_id supplied but FLDX_CHAIN_ID is unset".into()))?;
    let channel_addr_hex = chain
        .channel
        .ok_or_else(|| ApiError::BadRequest("channel_id supplied but no channel contract on this chain".into()))?;
    let channel_addr = parse_addr(channel_addr_hex)
        .map_err(|e| ApiError::Internal(format!("invalid channel address in chain config: {e}")))?;
    let channel_id = channel_id_from_hex(channel_id_hex)
        .map_err(|e| ApiError::BadRequest(format!("invalid channel_id: {e}")))?;

    let price_units = price_for(&state.pricing, backend);
    let total_tokens = total_tokens(&usage);
    let round_trip_cost = (u128::from(total_tokens) * price_units) / 1_000;

    let mut channels = state.channels.lock().unwrap();
    let entry = channels.entry(channel_id).or_insert_with(|| ChannelState {
        nonce: 0,
        cum_owed: 0,
        last_acked: None,
        client_address: None,
        deposit: None,
    });

    // Verify any piggy-backed ack against this channel before we bump state.
    if let Some(ack) = prev_ack {
        verify_and_record_ack(entry, ack, channel_id_hex, chain.chain_id, &channel_addr)
            .map_err(|e| ApiError::BadRequest(format!("invalid prev_ack: {e}")))?;
    }

    let new_nonce = entry.nonce.saturating_add(1);
    let new_cum_owed = entry.cum_owed.saturating_add(round_trip_cost);

    let update = ChannelUpdate {
        channel_id: channel_id_hex.to_string(),
        nonce: new_nonce,
        cum_owed: new_cum_owed.to_string(),
    };
    let canonical = channel_update_canonical_for(&update, chain.chain_id, &channel_addr)
        .map_err(|e| ApiError::Internal(format!("canonical bytes: {e}")))?;
    let sig = state.identity.sign_eip191(&canonical);
    let node_sig = format!("0x{}", hex::encode(sig));

    entry.nonce = new_nonce;
    entry.cum_owed = new_cum_owed;

    let breakdown = ReceiptBreakdown {
        session_id: session_id.to_string(),
        backend,
        usage,
        price_per_1k: price_units.to_string(),
        round_trip_cost: round_trip_cost.to_string(),
    };

    Ok(NodeSignedReceipt {
        update,
        breakdown,
        node_sig,
    })
}

fn verify_and_record_ack(
    entry: &mut ChannelState,
    ack: &ClientAck,
    expected_channel_id_hex: &str,
    chain_id: u64,
    channel_addr: &[u8; 20],
) -> Result<()> {
    if ack.update.channel_id.to_lowercase().trim_start_matches("0x")
        != expected_channel_id_hex.to_lowercase().trim_start_matches("0x")
    {
        return Err(anyhow!("ack channel_id mismatch"));
    }
    let canonical = channel_update_canonical_for(&ack.update, chain_id, channel_addr)?;
    let sig_hex = ack.client_sig.trim_start_matches("0x");
    let sig_bytes = hex::decode(sig_hex)?;
    if sig_bytes.len() != EIP191_SIG_SIZE {
        return Err(anyhow!(
            "client_sig must be {EIP191_SIG_SIZE} bytes, got {}",
            sig_bytes.len()
        ));
    }
    let mut sig: [u8; EIP191_SIG_SIZE] = [0u8; EIP191_SIG_SIZE];
    sig.copy_from_slice(&sig_bytes);
    let recovered = recover_eip191(&canonical, &sig)?;

    match entry.client_address {
        Some(known) if known != recovered => {
            return Err(anyhow!("ack signer address differs from channel client"));
        }
        _ => entry.client_address = Some(recovered),
    }

    if ack.update.nonce >= entry.nonce {
        // The dashboard could in principle ack a future nonce; that's
        // harmless — we still record it as the latest bilaterally signed.
    }
    entry.last_acked = Some(ack.clone());
    Ok(())
}

fn parse_addr(s: &str) -> Result<[u8; 20]> {
    let stripped = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(stripped)?;
    if bytes.len() != 20 {
        return Err(anyhow!("address must be 20 bytes, got {}", bytes.len()));
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn price_for(pricing: &[BackendPrice], backend: BackendType) -> u128 {
    pricing
        .iter()
        .find(|p| p.backend == backend)
        .and_then(|p| p.price_per_1k.parse::<u128>().ok())
        .unwrap_or(0)
}

fn total_tokens(usage: &Usage) -> u64 {
    let cache_creation = usage.cache_creation_input_tokens.unwrap_or(0);
    let cache_read = usage.cache_read_input_tokens.unwrap_or(0);
    u64::from(usage.input_tokens)
        + u64::from(usage.output_tokens)
        + u64::from(cache_creation)
        + u64::from(cache_read)
}

/// Standalone client co-signature ingestion. Called by the dashboard before
/// `cooperativeClose` to deposit the ack on the *last* request (which has
/// no following request to piggyback on).
async fn ack(
    State(state): State<Arc<AppState>>,
    Json(ack): Json<ClientAck>,
) -> Result<StatusCode, ApiError> {
    let chain = state
        .chain
        .as_ref()
        .ok_or_else(|| ApiError::BadRequest("FLDX_CHAIN_ID unset — channels disabled".into()))?;
    let channel_addr_hex = chain
        .channel
        .ok_or_else(|| ApiError::BadRequest("no channel contract on this chain".into()))?;
    let channel_addr = parse_addr(channel_addr_hex)
        .map_err(|e| ApiError::Internal(format!("invalid channel address: {e}")))?;
    let channel_id = channel_id_from_hex(&ack.update.channel_id)
        .map_err(|e| ApiError::BadRequest(format!("invalid channel_id: {e}")))?;

    let mut channels = state.channels.lock().unwrap();
    let entry = channels.entry(channel_id).or_insert_with(|| ChannelState {
        nonce: 0,
        cum_owed: 0,
        last_acked: None,
        client_address: None,
        deposit: None,
    });
    verify_and_record_ack(entry, &ack, &ack.update.channel_id, chain.chain_id, &channel_addr)
        .map_err(|e| ApiError::BadRequest(format!("invalid ack: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Stateless completion passthrough used by the Claude Code proxy. Same
/// crypto envelope as `/execute`, but the plaintext is a `ChatRequest` and
/// the response is a `ChatResult` — no agent loop, no session state, no
/// node-side tool dispatch. The caller (the proxy) brings its own.
async fn proxy_complete(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EncryptedRequest>,
) -> Result<Json<EncryptedResponse>, ApiError> {
    let client_pub = decode_client_pub(&req.client_public_key)?;
    let shared = state.keys.shared_secret(&client_pub);
    let key = derive_key(&shared, &req.session_id);

    let nonce = B64
        .decode(&req.nonce)
        .map_err(|e| ApiError::BadRequest(format!("invalid nonce b64: {e}")))?;
    let ciphertext = B64
        .decode(&req.ciphertext)
        .map_err(|e| ApiError::BadRequest(format!("invalid ciphertext b64: {e}")))?;
    let plaintext = decrypt(&key, &nonce, &ciphertext)
        .map_err(|e| ApiError::BadRequest(format!("decrypt: {e}")))?;
    let chat_req: ChatRequest = serde_json::from_slice(&plaintext).map_err(|e| {
        ApiError::BadRequest(format!("plaintext is not a valid ChatRequest: {e}"))
    })?;

    let backend: &dyn ExecutionBackend = match req.backend {
        BackendType::MockTee => state.mock_tee.as_ref().ok_or_else(|| {
            ApiError::NotImplemented(
                "mock-tee not configured — set ANTHROPIC_API_KEY to enable".into(),
            )
        })?,
        BackendType::Local => state.local_llm.as_ref().ok_or_else(|| {
            ApiError::NotImplemented(
                "local not configured — set FLDX_LLAMA_MODEL to enable".into(),
            )
        })?,
        other => {
            return Err(ApiError::NotImplemented(format!(
                "backend {other:?} not wired yet"
            )))
        }
    };

    let chat_result = backend
        .complete(chat_req)
        .await
        .map_err(|e| ApiError::Internal(format!("backend complete: {e}")))?;

    let resp_bytes = serde_json::to_vec(&chat_result)
        .map_err(|e| ApiError::Internal(format!("serialize response: {e}")))?;
    let (resp_nonce, resp_ct) =
        encrypt(&key, &resp_bytes).map_err(|e| ApiError::Internal(format!("encrypt: {e}")))?;

    Ok(Json(EncryptedResponse {
        session_id: req.session_id,
        nonce: B64.encode(resp_nonce),
        ciphertext: B64.encode(resp_ct),
        receipt: None,
    }))
}

fn decode_client_pub(s: &str) -> Result<PublicKey, ApiError> {
    let bytes = B64
        .decode(s)
        .map_err(|e| ApiError::BadRequest(format!("invalid client public key b64: {e}")))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ApiError::BadRequest("client public key must be 32 bytes".into()))?;
    Ok(PublicKey::from(arr))
}

#[derive(Debug, Error)]
enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    PaymentRequired(String),
    #[error("{0}")]
    NotImplemented(String),
    #[error("{0}")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, msg) = match &self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::PaymentRequired(m) => (StatusCode::PAYMENT_REQUIRED, m.clone()),
            ApiError::NotImplemented(m) => (StatusCode::NOT_IMPLEMENTED, m.clone()),
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m.clone()),
        };
        tracing::warn!(error = %self, "request failed");
        (code, msg).into_response()
    }
}
