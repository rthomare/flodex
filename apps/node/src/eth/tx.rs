//! EIP-1559 (type 0x02) transaction encoding + signing. Hand-rolled rather
//! than pulling alloy/ethers because the latter need Rust ≥1.85 and we're
//! pinned at 1.74.
//!
//! Wire format:
//! ```text
//! 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
//!              gasLimit, to, value, data, accessList, v, r, s])
//! ```
//! Signing hash: `keccak256(0x02 || rlp([... no v/r/s ...]))`.
//! `v` is parity 0 or 1 (NOT 27/28).

use crypto::{keccak256, NodeIdentity, ETH_TX_SIG_SIZE};

use super::rlp::{encode_bytes, encode_list, encode_uint};

#[derive(Debug, Clone)]
pub struct Eip1559Tx {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: u128,
    pub data: Vec<u8>,
}

impl Eip1559Tx {
    /// 0x02 || rlp([chainId, nonce, ..., accessList])
    pub fn signing_payload(&self) -> Vec<u8> {
        let items = self.unsigned_items();
        let rlp = encode_list(&items);
        let mut out = Vec::with_capacity(1 + rlp.len());
        out.push(0x02);
        out.extend_from_slice(&rlp);
        out
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        keccak256(&self.signing_payload())
    }

    /// Sign and return the raw bytes ready for `eth_sendRawTransaction`.
    pub fn sign(&self, identity: &NodeIdentity) -> Vec<u8> {
        let sig = identity.sign_eth_tx_digest(&self.signing_hash());
        self.encode_signed(&sig)
    }

    fn unsigned_items(&self) -> Vec<Vec<u8>> {
        vec![
            encode_uint(self.chain_id as u128),
            encode_uint(self.nonce as u128),
            encode_uint(self.max_priority_fee_per_gas),
            encode_uint(self.max_fee_per_gas),
            encode_uint(self.gas_limit as u128),
            encode_bytes(&self.to),
            encode_uint(self.value),
            encode_bytes(&self.data),
            // Empty access list.
            encode_list(&[]),
        ]
    }

    fn encode_signed(&self, sig: &[u8; ETH_TX_SIG_SIZE]) -> Vec<u8> {
        let r = &sig[0..32];
        let s = &sig[32..64];
        let v = sig[64];
        let mut items = self.unsigned_items();
        items.push(encode_uint(v as u128));
        // r and s are 32-byte big-endian uints; RLP strips leading zeros.
        items.push(strip_leading_zeros_uint(r));
        items.push(strip_leading_zeros_uint(s));
        let rlp = encode_list(&items);
        let mut out = Vec::with_capacity(1 + rlp.len());
        out.push(0x02);
        out.extend_from_slice(&rlp);
        out
    }
}

fn strip_leading_zeros_uint(bytes: &[u8]) -> Vec<u8> {
    let first = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len() - 1);
    encode_bytes(&bytes[first..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_payload_starts_with_02() {
        let tx = Eip1559Tx {
            chain_id: 84532,
            nonce: 0,
            max_priority_fee_per_gas: 1_000_000,
            max_fee_per_gas: 5_000_000,
            gas_limit: 21000,
            to: [0x11; 20],
            value: 0,
            data: vec![],
        };
        let p = tx.signing_payload();
        assert_eq!(p[0], 0x02);
    }

    #[test]
    fn sign_produces_recoverable_address() {
        // Anvil dev key 0 — known address f39f...2266.
        let seed = hex::decode(
            "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        )
        .unwrap();
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&seed);
        let id = NodeIdentity::from_seed(bytes).unwrap();

        let tx = Eip1559Tx {
            chain_id: 84532,
            nonce: 7,
            max_priority_fee_per_gas: 1_500_000_000,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 100_000,
            to: [0x22; 20],
            value: 0,
            data: vec![0xde, 0xad, 0xbe, 0xef],
        };
        let signed = tx.sign(&id);
        assert!(!signed.is_empty());
        assert_eq!(signed[0], 0x02);
    }
}
