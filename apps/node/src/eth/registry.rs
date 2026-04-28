//! Auto-register flow. On node startup, when `FLDX_CHAIN_ID` selects a
//! chain that has both a registry and an RPC:
//!
//! 1. `eth_call NodeRegistry.isActive(myAddr)`. If already active, skip
//!    (v0: doesn't reconcile changed url/pricing — operator can re-register
//!    by unregistering first or wait for a future update path).
//! 2. `USDC.approve(registry, stake)`, wait for confirmation.
//! 3. `NodeRegistry.register(url, ecdhPubkey, backendBitmap, maxTokens,
//!    pricePer1k, stake)`, wait for confirmation.
//!
//! Failure logs a warning and returns; the node keeps running so the
//! operator can fall back to the documented `cast send` recipe in the README.

use anyhow::{anyhow, Context, Result};
use crypto::NodeIdentity;
use protocol::{BackendPrice, BackendType};
use std::time::Duration;

use super::abi;
use super::rpc::EthRpc;
use super::tx::Eip1559Tx;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const TX_TIMEOUT: Duration = Duration::from_secs(120);

pub struct RegisterParams {
    pub rpc_url: String,
    pub chain_id: u64,
    pub usdc: [u8; 20],
    pub registry: [u8; 20],
    pub url: String,
    pub ecdh_pubkey: [u8; 32],
    pub backend_bitmap: u8,
    pub max_tokens: u64,
    pub price_per_1k: [[u8; 32]; 4],
    pub stake: [u8; 32],
}

pub async fn ensure_registered(identity: &NodeIdentity, p: RegisterParams) -> Result<()> {
    let rpc = EthRpc::new(p.rpc_url.clone());
    let from = identity.eth_address();

    // Sanity: the chain we're talking to matches the configured chain id.
    let on_chain_id = rpc
        .chain_id()
        .await
        .with_context(|| format!("eth_chainId against {}", p.rpc_url))?;
    if on_chain_id != p.chain_id {
        return Err(anyhow!(
            "RPC chain id mismatch: configured {} but RPC reports {}",
            p.chain_id,
            on_chain_id
        ));
    }

    // 1) Already active? Skip.
    let is_active_data = abi::encode_is_active(&from);
    let is_active_out = rpc
        .eth_call(&p.registry, &is_active_data, Some(&from))
        .await
        .context("isActive(address) eth_call")?;
    if abi::decode_bool(&is_active_out) {
        tracing::info!(
            address = %format_args!("0x{}", hex::encode(from)),
            "node already registered on-chain — skipping"
        );
        return Ok(());
    }

    tracing::info!(
        address = %format_args!("0x{}", hex::encode(from)),
        "node not yet registered on-chain — submitting approve + register"
    );

    // 2) USDC.approve(registry, stake)
    let approve_data = abi::encode_approve(&p.registry, &p.stake);
    let approve_hash = send_tx(&rpc, identity, &from, &p.usdc, &approve_data, p.chain_id)
        .await
        .context("approve tx")?;
    tracing::info!(tx = %format_args!("0x{}", hex::encode(approve_hash)), "approve submitted");
    rpc.wait_for_receipt(&approve_hash, POLL_INTERVAL, TX_TIMEOUT)
        .await
        .context("approve receipt")?;
    tracing::info!("approve confirmed");

    // 3) NodeRegistry.register(...)
    let register_data = abi::encode_register(
        &p.url,
        &p.ecdh_pubkey,
        p.backend_bitmap,
        p.max_tokens,
        &p.price_per_1k,
        &p.stake,
    );
    let register_hash = send_tx(
        &rpc,
        identity,
        &from,
        &p.registry,
        &register_data,
        p.chain_id,
    )
    .await
    .context("register tx")?;
    tracing::info!(tx = %format_args!("0x{}", hex::encode(register_hash)), "register submitted");
    rpc.wait_for_receipt(&register_hash, POLL_INTERVAL, TX_TIMEOUT)
        .await
        .context("register receipt")?;
    tracing::info!("register confirmed — node is on-chain");

    Ok(())
}

async fn send_tx(
    rpc: &EthRpc,
    identity: &NodeIdentity,
    from: &[u8; 20],
    to: &[u8; 20],
    data: &[u8],
    chain_id: u64,
) -> Result<[u8; 32]> {
    let nonce = rpc.nonce(from).await.context("nonce")?;
    let priority = rpc
        .max_priority_fee_per_gas()
        .await
        .unwrap_or(1_000_000_000); // 1 gwei fallback for chains without the rpc
    let base_fee = rpc.pending_base_fee().await.context("base fee")?;
    // 2× base fee + priority gives us a generous max-fee cap that survives
    // a few blocks of base-fee escalation.
    let max_fee = base_fee.saturating_mul(2).saturating_add(priority);

    let gas_limit = rpc
        .estimate_gas(from, to, data, 0)
        .await
        .context("estimateGas")?
        // Pad 20% — `estimateGas` is best-effort.
        .saturating_mul(120)
        / 100;

    let tx = Eip1559Tx {
        chain_id,
        nonce,
        max_priority_fee_per_gas: priority,
        max_fee_per_gas: max_fee,
        gas_limit,
        to: *to,
        value: 0,
        data: data.to_vec(),
    };
    let raw = tx.sign(identity);
    rpc.send_raw(&raw).await
}

/// Convert `Vec<BackendPrice>` (sparse, indexed by enum tag) into the dense
/// `[uint256; 4]` layout the contract expects, indexed by:
/// 0 = MockTee, 1 = Fhe, 2 = Mcp, 3 = Local. Missing prices default to 0
/// (matches the contract's "0 = backend not priced" convention).
pub fn pricing_to_array(pricing: &[BackendPrice]) -> Result<[[u8; 32]; 4]> {
    let mut out = [[0u8; 32]; 4];
    for p in pricing {
        let idx = match p.backend {
            BackendType::MockTee => 0,
            BackendType::Fhe => 1,
            BackendType::Mcp => 2,
            BackendType::Local => 3,
        };
        let units: u128 = p
            .price_per_1k
            .parse()
            .with_context(|| format!("invalid price_per_1k: {}", p.price_per_1k))?;
        out[idx][16..].copy_from_slice(&units.to_be_bytes());
    }
    Ok(out)
}

pub fn backend_bitmap(backends: &[BackendType]) -> u8 {
    let mut bm = 0u8;
    for b in backends {
        let i = match b {
            BackendType::MockTee => 0,
            BackendType::Fhe => 1,
            BackendType::Mcp => 2,
            BackendType::Local => 3,
        };
        bm |= 1u8 << i;
    }
    bm
}

pub fn u256_from_u128(v: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&v.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pricing_layout() {
        let pricing = vec![
            BackendPrice {
                backend: BackendType::MockTee,
                price_per_1k: "15000".to_string(),
            },
            BackendPrice {
                backend: BackendType::Local,
                price_per_1k: "1000".to_string(),
            },
        ];
        let arr = pricing_to_array(&pricing).unwrap();
        // Slot 0 = mock-tee = 15000.
        let mut mtee = [0u8; 32];
        mtee[24..].copy_from_slice(&15000u64.to_be_bytes());
        assert_eq!(arr[0], mtee);
        // Slot 3 = local = 1000.
        let mut loc = [0u8; 32];
        loc[24..].copy_from_slice(&1000u64.to_be_bytes());
        assert_eq!(arr[3], loc);
        // Slots 1 and 2 are zero.
        assert_eq!(arr[1], [0u8; 32]);
        assert_eq!(arr[2], [0u8; 32]);
    }

    #[test]
    fn bitmap() {
        assert_eq!(backend_bitmap(&[BackendType::MockTee]), 0b0001);
        assert_eq!(
            backend_bitmap(&[BackendType::MockTee, BackendType::Local]),
            0b1001
        );
        assert_eq!(backend_bitmap(&[BackendType::Local]), 0b1000);
    }
}
