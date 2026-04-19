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
use protocol::{AgentStep, BackendType, EncryptedRequest, EncryptedResponse, NodeInfo};
use std::sync::Arc;
use thiserror::Error;
use tower_http::trace::TraceLayer;
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

    let mut enabled: Vec<&'static str> = Vec::new();
    if state.mock_tee.is_some() {
        enabled.push("mock-tee");
    }
    if state.local_llm.is_some() {
        enabled.push("local");
    }
    tracing::info!(
        backends = %enabled.join(","),
        node_public_key = %B64.encode(state.keys.public.as_bytes()),
        "flodex node ready"
    );

    let app = Router::new()
        .route("/info", get(info))
        .route("/execute", post(execute))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = std::env::var("FLODEX_NODE_ADDR").unwrap_or_else(|_| "127.0.0.1:7777".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    tracing::info!("flodex node listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
    Ok(())
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
