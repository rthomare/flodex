//! flodex coordinator — thin node registry with first-match job assignment.
//!
//! Nodes register and heartbeat; clients POST a JobSpec and get back a matching
//! node. Registry is in-memory, keyed by node pubkey. Stale entries expire
//! after ~30s without a heartbeat.
//!
//! The coordinator never sees request bodies or keys — only node metadata
//! and job specs. Encrypted payloads flow client → node directly.

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use dashmap::DashMap;
use protocol::{JobMatch, JobSpec, NodeHeartbeat, NodeRegistration};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const GC_INTERVAL: Duration = Duration::from_secs(5);

struct Entry {
    reg: NodeRegistration,
    last_seen: Instant,
}

struct AppState {
    nodes: DashMap<String, Entry>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let state = Arc::new(AppState {
        nodes: DashMap::new(),
    });

    // Background GC: expire nodes whose heartbeats have stopped.
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(GC_INTERVAL).await;
                let now = Instant::now();
                state.nodes.retain(|_pk, entry| {
                    let alive = now.duration_since(entry.last_seen) < HEARTBEAT_TIMEOUT;
                    if !alive {
                        tracing::info!(pubkey = %_pk, "expiring stale node");
                    }
                    alive
                });
            }
        });
    }

    let app = Router::new()
        .route("/nodes/register", post(register))
        .route("/nodes/heartbeat", post(heartbeat))
        .route("/nodes", get(list_nodes))
        .route("/jobs/match", post(match_job))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr = std::env::var("FLODEX_COORDINATOR_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8000".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("bind {addr}: {e}"));
    tracing::info!("flodex coordinator listening on http://{addr}");
    axum::serve(listener, app).await.expect("serve");
}

async fn register(
    State(state): State<Arc<AppState>>,
    Json(reg): Json<NodeRegistration>,
) -> impl IntoResponse {
    tracing::info!(
        pubkey = %reg.public_key,
        url = %reg.url,
        backends = ?reg.backends,
        "node registered"
    );
    state.nodes.insert(
        reg.public_key.clone(),
        Entry {
            reg,
            last_seen: Instant::now(),
        },
    );
    StatusCode::OK
}

async fn heartbeat(
    State(state): State<Arc<AppState>>,
    Json(hb): Json<NodeHeartbeat>,
) -> impl IntoResponse {
    match state.nodes.get_mut(&hb.public_key) {
        Some(mut entry) => {
            entry.last_seen = Instant::now();
            StatusCode::OK
        }
        None => StatusCode::NOT_FOUND,
    }
}

async fn list_nodes(State(state): State<Arc<AppState>>) -> Json<Vec<NodeRegistration>> {
    let nodes: Vec<NodeRegistration> =
        state.nodes.iter().map(|e| e.value().reg.clone()).collect();
    Json(nodes)
}

async fn match_job(
    State(state): State<Arc<AppState>>,
    Json(spec): Json<JobSpec>,
) -> Result<Json<JobMatch>, (StatusCode, String)> {
    for entry in state.nodes.iter() {
        let reg = &entry.value().reg;
        if !reg.backends.contains(&spec.backend) {
            continue;
        }
        if reg.max_tokens < spec.estimated_tokens {
            continue;
        }
        let price = reg
            .pricing
            .iter()
            .find(|p| p.backend == spec.backend)
            .map(|p| p.price_per_1k);
        let Some(price) = price else { continue };
        if price > spec.max_price_per_1k {
            continue;
        }
        tracing::info!(
            pubkey = %reg.public_key,
            backend = ?spec.backend,
            price,
            "job matched to node"
        );
        return Ok(Json(JobMatch {
            url: reg.url.clone(),
            public_key: reg.public_key.clone(),
        }));
    }
    Err((
        StatusCode::NOT_FOUND,
        format!(
            "no node matching spec (backend={:?}, estimated_tokens={}, max_price_per_1k={})",
            spec.backend, spec.estimated_tokens, spec.max_price_per_1k
        ),
    ))
}
