use agent::{
    AgentLoop, AnthropicClient, AnthropicProvider, ChatProvider, CurrentTimeTool, DEFAULT_MODEL,
    Tool, WebFetchTool, read_local_file_def,
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
use crypto::{decrypt, derive_key, encrypt, NodeKeys};
use execution::{ExecutionBackend, LocalLlmBackend, MockTeeBackend};
use local_llm::{default_cache_dir, resolve, LlamaServer, ModelSpec, OpenAiProvider};
use protocol::{
    AgentStep, BackendPrice, BackendType, EncryptedRequest, EncryptedResponse, NodeHeartbeat,
    NodeInfo, NodeRegistration,
};
use std::sync::Arc;
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
    mock_tee: Option<MockTeeBackend>,
    local_llm: Option<LocalLlmBackend>,
    /// Held for lifetime — dropping it kills the child `llama-server`.
    _llama_server: Option<LlamaServer>,
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
             FLODEX_LLAMA_MODEL for local, or both."
        ));
    }

    let state = Arc::new(AppState {
        keys: NodeKeys::generate(),
        mock_tee,
        local_llm,
        _llama_server: llama_server,
    });

    let mut backends: Vec<BackendType> = Vec::new();
    if state.mock_tee.is_some() {
        backends.push(BackendType::MockTee);
    }
    if state.local_llm.is_some() {
        backends.push(BackendType::Local);
    }
    tracing::info!(
        backends = ?backends,
        node_public_key = %B64.encode(state.keys.public.as_bytes()),
        "flodex node ready"
    );

    let app = Router::new()
        .route("/info", get(info))
        .route("/execute", post(execute))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr = std::env::var("FLODEX_NODE_ADDR").unwrap_or_else(|_| "127.0.0.1:7777".to_string());
    let advertise_url =
        std::env::var("FLODEX_NODE_URL").unwrap_or_else(|_| format!("http://{addr}"));

    if let Ok(coord_url) = std::env::var("FLODEX_COORDINATOR") {
        let pubkey_b64 = B64.encode(state.keys.public.as_bytes());
        let reg = NodeRegistration {
            public_key: pubkey_b64.clone(),
            url: advertise_url,
            backends: backends.clone(),
            max_tokens: std::env::var("FLODEX_NODE_MAX_TOKENS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(100_000),
            pricing: read_pricing(&backends),
        };
        tokio::spawn(registration_loop(coord_url, reg, pubkey_b64));
    }

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    tracing::info!("flodex node listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
    Ok(())
}

fn read_pricing(backends: &[BackendType]) -> Vec<BackendPrice> {
    backends
        .iter()
        .map(|b| {
            let env_key = match b {
                BackendType::MockTee => "FLODEX_NODE_PRICE_MOCK_TEE",
                BackendType::Local => "FLODEX_NODE_PRICE_LOCAL",
                BackendType::Fhe => "FLODEX_NODE_PRICE_FHE",
                BackendType::Mcp => "FLODEX_NODE_PRICE_MCP",
            };
            let price = std::env::var(env_key)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            BackendPrice {
                backend: *b,
                price_per_1k: price,
            }
        })
        .collect()
}

async fn registration_loop(coord_url: String, reg: NodeRegistration, pubkey: String) {
    let http = reqwest::Client::new();
    let register_url = format!("{coord_url}/nodes/register");
    let heartbeat_url = format!("{coord_url}/nodes/heartbeat");

    loop {
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

    let hb = NodeHeartbeat {
        public_key: pubkey.clone(),
    };
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        match http.post(&heartbeat_url).json(&hb).send().await {
            Ok(r) if r.status().is_success() => {}
            Ok(r) if r.status() == reqwest::StatusCode::NOT_FOUND => {
                tracing::warn!("coordinator forgot us; re-registering");
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
                std::env::var("FLODEX_NODE_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
            tracing::info!(model = %model, "initializing mock-tee backend (Anthropic)");
            let provider: Box<dyn ChatProvider> =
                Box::new(AnthropicProvider::new(AnthropicClient::new(key), model));
            let loop_ = AgentLoop::new(provider, SYSTEM_PROMPT.to_string(), tools());
            Some(MockTeeBackend::new(loop_))
        }
        Err(_) => None,
    };

    // local backend is enabled when FLODEX_LLAMA_MODEL is set.
    let (local_llm, llama_server) = match std::env::var("FLODEX_LLAMA_MODEL") {
        Ok(spec_str) => {
            tracing::info!(spec = %spec_str, "initializing local backend (llama-server)");
            let spec = ModelSpec::parse(&spec_str).context("parsing FLODEX_LLAMA_MODEL")?;
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
                "local not configured — set FLODEX_LLAMA_MODEL to enable".into(),
            )
        })?,
        other => {
            return Err(ApiError::NotImplemented(format!(
                "backend {other:?} not wired yet"
            )))
        }
    };

    let agent_response = backend
        .step(&req.session_id, step)
        .await
        .map_err(|e| ApiError::Internal(format!("backend step: {e}")))?;

    let resp_bytes = serde_json::to_vec(&agent_response)
        .map_err(|e| ApiError::Internal(format!("serialize response: {e}")))?;
    let (resp_nonce, resp_ct) =
        encrypt(&key, &resp_bytes).map_err(|e| ApiError::Internal(format!("encrypt: {e}")))?;

    Ok(Json(EncryptedResponse {
        session_id: req.session_id,
        nonce: B64.encode(resp_nonce),
        ciphertext: B64.encode(resp_ct),
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
    NotImplemented(String),
    #[error("{0}")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, msg) = match &self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::NotImplemented(m) => (StatusCode::NOT_IMPLEMENTED, m.clone()),
            ApiError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m.clone()),
        };
        tracing::warn!(error = %self, "request failed");
        (code, msg).into_response()
    }
}
