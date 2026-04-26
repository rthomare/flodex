//! Chain configuration constants. Mirrors `packages/chains/src/index.ts` —
//! addresses must stay in sync. When the node grows actual contract
//! interaction (alloy + on-chain register/settle), it'll read addresses from
//! here rather than hardcoding at the call site.
//!
//! Today this is constants + an env-driven lookup. No on-chain calls happen
//! from the node yet.

#[derive(Debug, Clone, Copy)]
pub struct ChainConfig {
    pub chain_id: u64,
    pub name: &'static str,
    pub rpc_url: &'static str,
    pub usdc: &'static str,
    pub registry: Option<&'static str>,
    pub escrow: Option<&'static str>,
}

pub const ANVIL: ChainConfig = ChainConfig {
    chain_id: 31337,
    name: "anvil",
    rpc_url: "http://127.0.0.1:8545",
    usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    registry: None,
    escrow: None,
};

pub const BASE_SEPOLIA: ChainConfig = ChainConfig {
    chain_id: 84532,
    name: "baseSepolia",
    rpc_url: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    registry: Some("0xf52b8f75eed06E61801D5251022FD052aa97A51C"),
    escrow: Some("0xEb577b58913Ad50C3203fFdD21a4EB28C46D4894"),
};

pub const BASE: ChainConfig = ChainConfig {
    chain_id: 8453,
    name: "base",
    rpc_url: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    registry: None,
    escrow: None,
};

/// Resolve the chain config from the `FLODEX_CHAIN_ID` env var. Returns
/// `None` when the env var is absent or its value isn't recognized — the
/// node simply runs in off-chain-only mode in that case.
pub fn from_env() -> Option<ChainConfig> {
    let raw = std::env::var("FLODEX_CHAIN_ID").ok()?;
    let id: u64 = raw.parse().ok()?;
    match id {
        31337 => Some(ANVIL),
        84532 => Some(BASE_SEPOLIA),
        8453 => Some(BASE),
        _ => None,
    }
}
