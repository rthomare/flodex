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
    routing::{get, post},
    Json, Router,
};
use crypto::verify_identity_signature;
use dashmap::DashMap;
use protocol::{
    canonical_bid_bytes, canonical_heartbeat_bytes, canonical_register_bytes, BackendType, Bid,
    JobMatch, JobSpec, NodeHeartbeat, NodeRegistration,
};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
    /// Bid book — keyed by `(identity_pubkey, backend)`. Latest signed bid
    /// wins; expired bids (`valid_until` < now) are evicted by the GC loop
    /// and rejected at read time as a defense-in-depth check.
    bids: DashMap<(String, BackendType), Bid>,
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
        bids: DashMap::new(),
    });

    // Background GC: expire nodes whose heartbeats have stopped, and bids
    // past their `valid_until`.
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(GC_INTERVAL).await;
                let now = Instant::now();
                state.nodes.retain(|id, entry| {
                    let alive = now.duration_since(entry.last_seen) < HEARTBEAT_TIMEOUT;
                    if !alive {
                        tracing::info!(identity = %id, "expiring stale node");
                    }
                    alive
                });
                let now_secs = unix_now();
                state.bids.retain(|_, bid| bid.valid_until > now_secs);
            }
        });
    }

    let app = Router::new()
        .route("/nodes/register", post(register))
        .route("/nodes/heartbeat", post(heartbeat))
        .route("/nodes", get(list_nodes))
        .route("/jobs/match", post(match_job))
        .route("/bids", post(post_bid).get(list_bids))
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

/// Decode hex and verify the canonical-bytes ECDSA signature against the
/// claimed identity_pubkey. Used by both `/nodes/register` and
/// `/nodes/heartbeat`. Returns the decoded pubkey bytes on success.
fn verify_signed(
    identity_pubkey_hex: &str,
    signature_hex: &str,
    canonical: &[u8],
) -> Result<Vec<u8>, (StatusCode, &'static str)> {
    let pubkey = hex::decode(identity_pubkey_hex)
        .map_err(|_| (StatusCode::BAD_REQUEST, "identity_pubkey not hex"))?;
    let signature = hex::decode(signature_hex)
        .map_err(|_| (StatusCode::BAD_REQUEST, "signature not hex"))?;
    if !verify_identity_signature(&pubkey, canonical, &signature) {
        return Err((StatusCode::UNAUTHORIZED, "invalid signature"));
    }
    Ok(pubkey)
}

async fn register(
    State(state): State<Arc<AppState>>,
    Json(reg): Json<NodeRegistration>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    let canonical = canonical_register_bytes(&reg);
    verify_signed(&reg.identity_pubkey, &reg.signature, &canonical)?;

    tracing::info!(
        identity = %reg.identity_pubkey,
        url = %reg.url,
        backends = ?reg.backends,
        "node registered"
    );
    state.nodes.insert(
        reg.identity_pubkey.clone(),
        Entry {
            reg,
            last_seen: Instant::now(),
        },
    );
    Ok(StatusCode::OK)
}

async fn heartbeat(
    State(state): State<Arc<AppState>>,
    Json(hb): Json<NodeHeartbeat>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    let canonical = canonical_heartbeat_bytes(&hb);
    verify_signed(&hb.identity_pubkey, &hb.signature, &canonical)?;

    match state.nodes.get_mut(&hb.identity_pubkey) {
        Some(mut entry) => {
            entry.last_seen = Instant::now();
            Ok(StatusCode::OK)
        }
        None => Err((StatusCode::NOT_FOUND, "unknown identity_pubkey")),
    }
}

async fn list_nodes(State(state): State<Arc<AppState>>) -> Json<Vec<NodeRegistration>> {
    let nodes: Vec<NodeRegistration> =
        state.nodes.iter().map(|e| e.value().reg.clone()).collect();
    Json(nodes)
}

/// Lowest-bid match. Walks the registered node set, prefers each node's
/// active bid for the requested backend (if present and unexpired) over its
/// standing registration pricing, then returns whichever candidate has the
/// lowest effective price within the spec's constraints. Falls back to
/// first-match when no node has bid (mostly tests / cold-start).
async fn match_job(
    State(state): State<Arc<AppState>>,
    Json(spec): Json<JobSpec>,
) -> Result<Json<JobMatch>, (StatusCode, String)> {
    let max_units = (spec.max_price_per_1k * 1_000_000.0) as u128;
    let now_secs = unix_now();

    let mut best: Option<(u128, NodeRegistration, Option<u32>)> = None;
    for entry in state.nodes.iter() {
        let reg = &entry.value().reg;
        if !reg.backends.contains(&spec.backend) {
            continue;
        }
        // Bid takes precedence over registration pricing when present.
        let bid = state
            .bids
            .get(&(reg.identity_pubkey.clone(), spec.backend))
            .filter(|b| b.valid_until > now_secs)
            .map(|b| b.clone());
        let (price_units, bid_max_tokens) = if let Some(b) = &bid {
            let Ok(p) = b.price_per_1k.parse::<u128>() else { continue };
            (p, Some(b.max_tokens))
        } else {
            let Some(p_str) = reg
                .pricing
                .iter()
                .find(|p| p.backend == spec.backend)
                .map(|p| p.price_per_1k.clone())
            else { continue };
            let Ok(p) = p_str.parse::<u128>() else { continue };
            (p, None)
        };
        let cap = bid_max_tokens.unwrap_or(reg.max_tokens);
        if cap < spec.estimated_tokens {
            continue;
        }
        if price_units > max_units {
            continue;
        }
        let take = match &best {
            None => true,
            Some((cur, _, _)) => price_units < *cur,
        };
        if take {
            best = Some((price_units, reg.clone(), bid_max_tokens));
        }
    }

    if let Some((price, reg, _)) = best {
        tracing::info!(
            pubkey = %reg.public_key,
            backend = ?spec.backend,
            price_units = price,
            "job matched to node (lowest bid)"
        );
        return Ok(Json(JobMatch {
            url: reg.url,
            public_key: reg.public_key,
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

async fn post_bid(
    State(state): State<Arc<AppState>>,
    Json(bid): Json<Bid>,
) -> Result<StatusCode, (StatusCode, &'static str)> {
    // Validate signature against the node's claimed identity key.
    let canonical = canonical_bid_bytes(&bid);
    verify_signed(&bid.identity_pubkey, &bid.signature, &canonical)?;
    // Reject already-expired bids.
    if bid.valid_until <= unix_now() {
        return Err((StatusCode::BAD_REQUEST, "bid already expired"));
    }
    // Bid is valid — replace any prior bid for (node, backend).
    state
        .bids
        .insert((bid.identity_pubkey.clone(), bid.backend), bid);
    Ok(StatusCode::OK)
}

async fn list_bids(State(state): State<Arc<AppState>>) -> Json<Vec<Bid>> {
    let now_secs = unix_now();
    Json(
        state
            .bids
            .iter()
            .filter(|e| e.value().valid_until > now_secs)
            .map(|e| e.value().clone())
            .collect(),
    )
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
