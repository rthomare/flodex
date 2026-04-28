//! On-chain interaction. Hand-rolled (no alloy/ethers) so we stay on
//! Rust 1.74 — see CLAUDE.md `Rust 1.74 compat` invariant.

pub mod abi;
pub mod registry;
pub mod rlp;
pub mod rpc;
pub mod tx;

pub use registry::{
    backend_bitmap, ensure_registered, pricing_to_array, u256_from_u128, RegisterParams,
};
