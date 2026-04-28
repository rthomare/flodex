//! Chain configuration constants. Mirrors `packages/chains/src/index.ts` —
//! addresses must stay in sync. The `channel` field points at the
//! `JobChannel` contract deployed per chain; `None` means channels aren't
//! available there yet (the node still runs, just without on-chain
//! settlement).

#[derive(Debug, Clone, Copy)]
pub struct ChainConfig {
    pub chain_id: u64,
    pub name: &'static str,
    pub rpc_url: &'static str,
    pub usdc: &'static str,
    pub registry: Option<&'static str>,
    pub channel: Option<&'static str>,
}

// Deterministic addresses produced by `forge script Deploy.s.sol` from anvil's
// default account 0 (`0xf39F…2266`) on a fresh chain: USDC at nonce 0,
// NodeRegistry at nonce 1, JobChannel at nonce 2. Matches `tests/e2e/`.
pub const ANVIL: ChainConfig = ChainConfig {
    chain_id: 31337,
    name: "anvil",
    rpc_url: "http://127.0.0.1:8545",
    usdc: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    registry: Some("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"),
    channel: Some("0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"),
};

pub const BASE_SEPOLIA: ChainConfig = ChainConfig {
    chain_id: 84532,
    name: "baseSepolia",
    rpc_url: "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    registry: Some("0xf52b8f75eed06E61801D5251022FD052aa97A51C"),
    channel: Some("0x8afaE8DF7E2b9f28c2e0A7655BF2Df57506Fb58a"),
};

pub const BASE: ChainConfig = ChainConfig {
    chain_id: 8453,
    name: "base",
    rpc_url: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    registry: None,
    channel: None,
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

/// RPC URL with `FLODEX_RPC_URL` override, falling back to the chain's
/// default. Lets the demo run against a private RPC without recompiling.
#[allow(dead_code)]
pub fn rpc_url(cfg: &ChainConfig) -> String {
    std::env::var("FLODEX_RPC_URL").unwrap_or_else(|_| cfg.rpc_url.to_string())
}
