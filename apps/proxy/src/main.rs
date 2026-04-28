//! fldx Claude Code proxy.
//!
//! Exposes an Anthropic-Messages-compatible `POST /v1/messages` endpoint and
//! routes each request through the fldx encrypted boundary to a node. The
//! proxy keeps a runtime-toggleable `backend` choice (`local` | `mock-tee`)
//! so a single Claude Code session can swap execution targets without
//! restart.
//!
//! Wire path:  Claude Code → (HTTP)
//!          → proxy: build `ChatRequest`, ask coordinator for a matching node,
//!            encrypt, POST to node `/proxy/complete`
//!          → node: decrypt, call `ChatProvider.complete()` directly (no
//!            agent loop), encrypt the `ChatResult`, return
//!          → proxy: decrypt, repackage as Anthropic Messages response
//!
//! The agent loop is deliberately bypassed in this mode — Claude Code already
//! drives its own tool loop, so node-side tools (`web_fetch`, `current_time`)
//! aren't available here. Privacy invariant still holds: the request body is
//! end-to-end encrypted between proxy and node.

use agent::{ChatRequest, ChatResult};
use anyhow::Result;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crypto::{decrypt, derive_key, encrypt};
use protocol::{BackendType, EncryptedRequest, EncryptedResponse, JobMatch, JobSpec};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use x25519_dalek::{PublicKey, StaticSecret};

struct AppState {
    coord_url: String,
    backend: RwLock<BackendType>,
    http: reqwest::Client,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let coord_url = std::env::var("FLDX_COORDINATOR")
        .unwrap_or_else(|_| "http://127.0.0.1:8000".to_string());
    let initial_backend = match std::env::var("FLDX_PROXY_BACKEND")
        .as_deref()
        .unwrap_or("local")
    {
        "local" => BackendType::Local,
        "mock-tee" => BackendType::MockTee,
        other => {
            tracing::warn!(
                requested = %other,
                "FLDX_PROXY_BACKEND must be `local` or `mock-tee`; defaulting to local"
            );
            BackendType::Local
        }
    };

    let state = Arc::new(AppState {
        coord_url: coord_url.clone(),
        backend: RwLock::new(initial_backend),
        http: reqwest::Client::new(),
    });

    let app = Router::new()
        .route("/v1/messages", post(messages))
        .route("/backend", get(get_backend).post(set_backend))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = std::env::var("FLDX_PROXY_ADDR").unwrap_or_else(|_| "127.0.0.1:8001".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    tracing::info!(
        addr = %addr,
        coord = %coord_url,
        backend = %backend_label(initial_backend),
        "fldx claude proxy listening"
    );
    axum::serve(listener, app).await.expect("serve");
    Ok(())
}

// ---- /v1/messages -----------------------------------------------------------

#[derive(Debug, Deserialize)]
struct AnthropicMessagesRequest {
    #[serde(default)]
    model: Option<String>,
    messages: Vec<Value>,
    #[serde(default)]
    max_tokens: Option<u32>,
    /// Anthropic accepts either a string or an array of content blocks.
    #[serde(default)]
    system: Value,
    #[serde(default)]
    tools: Vec<Value>,
}

async fn messages(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AnthropicMessagesRequest>,
) -> Result<Json<Value>, ProxyError> {
    let backend = *state.backend.read().await;
    tracing::info!(backend = %backend_label(backend), "proxy /v1/messages");

    // 1) Match a node for the chosen backend via the coordinator.
    let spec = JobSpec {
        backend,
        estimated_tokens: estimate_tokens(&req.messages),
        // Proxy isn't doing price discovery — accept any node the coord finds.
        max_price_per_1k: f64::MAX,
    };
    let match_url = format!("{}/jobs/match", state.coord_url);
    let m_resp = state
        .http
        .post(&match_url)
        .json(&spec)
        .send()
        .await
        .map_err(|e| ProxyError::Coord(format!("POST {match_url}: {e}")))?;
    if !m_resp.status().is_success() {
        let status = m_resp.status();
        let body = m_resp.text().await.unwrap_or_default();
        return Err(ProxyError::Coord(format!(
            "coordinator match failed {status}: {body}"
        )));
    }
    let job_match: JobMatch = m_resp
        .json()
        .await
        .map_err(|e| ProxyError::Coord(format!("parse match: {e}")))?;

    // 2) Decode node pubkey, generate ephemeral keypair, derive session key.
    let node_pub = decode_pubkey(&job_match.public_key)?;
    let client_secret = StaticSecret::random_from_rng(OsRng);
    let client_pub = PublicKey::from(&client_secret);
    let shared = client_secret.diffie_hellman(&node_pub).to_bytes();

    let mut sid_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut sid_bytes);
    let session_id = format!("proxy-{}", B64.encode(sid_bytes));
    let key = derive_key(&shared, &session_id);

    // 3) Build & encrypt the ChatRequest. Pass through tools and the full
    // message history verbatim — Claude Code drives its own loop.
    let chat_req = ChatRequest {
        system: flatten_system(&req.system),
        messages: req.messages,
        tools: req.tools,
        max_tokens: req.max_tokens.unwrap_or(4096),
    };
    let plaintext = serde_json::to_vec(&chat_req)
        .map_err(|e| ProxyError::Internal(format!("serialize ChatRequest: {e}")))?;
    let (nonce, ciphertext) =
        encrypt(&key, &plaintext).map_err(|e| ProxyError::Internal(format!("encrypt: {e}")))?;

    let enc_req = EncryptedRequest {
        session_id: session_id.clone(),
        client_public_key: B64.encode(client_pub.as_bytes()),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
        backend,
        channel_id: None,
        prev_ack: None,
    };

    // 4) Send to the matched node's /proxy/complete and decrypt the response.
    let exec_url = format!("{}/proxy/complete", job_match.url);
    let n_resp = state
        .http
        .post(&exec_url)
        .json(&enc_req)
        .send()
        .await
        .map_err(|e| ProxyError::Node(format!("POST {exec_url}: {e}")))?;
    if !n_resp.status().is_success() {
        let status = n_resp.status();
        let body = n_resp.text().await.unwrap_or_default();
        return Err(ProxyError::Node(format!(
            "node {exec_url} returned {status}: {body}"
        )));
    }
    let enc_resp: EncryptedResponse = n_resp
        .json()
        .await
        .map_err(|e| ProxyError::Node(format!("parse encrypted response: {e}")))?;

    let resp_nonce = B64
        .decode(&enc_resp.nonce)
        .map_err(|e| ProxyError::Internal(format!("bad nonce b64: {e}")))?;
    let resp_ct = B64
        .decode(&enc_resp.ciphertext)
        .map_err(|e| ProxyError::Internal(format!("bad ciphertext b64: {e}")))?;
    let plaintext = decrypt(&key, &resp_nonce, &resp_ct)
        .map_err(|e| ProxyError::Internal(format!("decrypt: {e}")))?;
    let chat_result: ChatResult = serde_json::from_slice(&plaintext)
        .map_err(|e| ProxyError::Internal(format!("parse ChatResult: {e}")))?;

    // 5) Repackage as an Anthropic Messages API response. The id/model fields
    // exist for client compatibility — Claude Code reads `content`,
    // `stop_reason`, and `usage`, the rest is decorative.
    let mut id_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut id_bytes);
    let resp = json!({
        "id": format!("msg_fldx_{}", hex(&id_bytes)),
        "type": "message",
        "role": "assistant",
        "model": req.model.unwrap_or_else(|| format!("fldx-{}", backend_label(backend))),
        "content": chat_result.content,
        "stop_reason": chat_result.stop_reason,
        "stop_sequence": Value::Null,
        "usage": {
            "input_tokens": chat_result.usage.input_tokens,
            "output_tokens": chat_result.usage.output_tokens,
            "cache_creation_input_tokens": chat_result.usage.cache_creation_input_tokens,
            "cache_read_input_tokens": chat_result.usage.cache_read_input_tokens,
        },
    });
    Ok(Json(resp))
}

// ---- /backend (live toggle) -------------------------------------------------

#[derive(Debug, Deserialize)]
struct BackendQuery {
    #[serde(rename = "type")]
    kind: Option<String>,
}

async fn get_backend(State(state): State<Arc<AppState>>) -> Json<Value> {
    let b = *state.backend.read().await;
    Json(json!({ "backend": backend_label(b) }))
}

async fn set_backend(
    State(state): State<Arc<AppState>>,
    Query(q): Query<BackendQuery>,
) -> Result<Json<Value>, ProxyError> {
    let kind = q
        .kind
        .ok_or_else(|| ProxyError::BadRequest("missing ?type=local|mock-tee".into()))?;
    let backend = match kind.as_str() {
        "local" => BackendType::Local,
        "mock-tee" => BackendType::MockTee,
        other => {
            return Err(ProxyError::BadRequest(format!(
                "unknown backend `{other}`; want `local` or `mock-tee`"
            )))
        }
    };
    *state.backend.write().await = backend;
    tracing::info!(backend = %backend_label(backend), "proxy backend switched");
    Ok(Json(json!({ "backend": backend_label(backend) })))
}

// ---- helpers ----------------------------------------------------------------

fn backend_label(b: BackendType) -> &'static str {
    match b {
        BackendType::MockTee => "mock-tee",
        BackendType::Local => "local",
        BackendType::Fhe => "fhe",
        BackendType::Mcp => "mcp",
    }
}

fn flatten_system(v: &Value) -> String {
    if v.is_null() {
        return String::new();
    }
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(arr) = v.as_array() {
        return arr
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    String::new()
}

/// Rough char-count heuristic so the coord's max-tokens filter doesn't reject
/// us. Real token accounting lives in the providers.
fn estimate_tokens(messages: &[Value]) -> u32 {
    let chars: usize = messages
        .iter()
        .map(|m| {
            m.get("content")
                .map(|c| c.to_string().len())
                .unwrap_or(0)
        })
        .sum();
    ((chars / 4) as u32).clamp(1, 100_000)
}

fn decode_pubkey(b64: &str) -> Result<PublicKey, ProxyError> {
    let bytes = B64
        .decode(b64)
        .map_err(|e| ProxyError::Internal(format!("bad node pubkey b64: {e}")))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ProxyError::Internal("node pubkey not 32 bytes".into()))?;
    Ok(PublicKey::from(arr))
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for byte in b {
        s.push_str(&format!("{:02x}", byte));
    }
    s
}

// ---- error type -------------------------------------------------------------

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
enum ProxyError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("coordinator: {0}")]
    Coord(String),
    #[error("node: {0}")]
    Node(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl IntoResponse for ProxyError {
    fn into_response(self) -> Response {
        let status = match &self {
            ProxyError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ProxyError::Coord(_) => StatusCode::BAD_GATEWAY,
            ProxyError::Node(_) => StatusCode::BAD_GATEWAY,
            ProxyError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        tracing::warn!(error = %self, "proxy error");
        let body = json!({
            "type": "error",
            "error": { "type": "fldx_proxy_error", "message": self.to_string() },
        });
        (status, Json(body)).into_response()
    }
}
