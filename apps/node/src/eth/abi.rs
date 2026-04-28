//! Hand-rolled ABI encoder for the four contract calls auto-register makes.
//! No general ABI codec — just enough for our specific signatures.

use crypto::keccak256;

/// First 4 bytes of `keccak256(signature)`.
pub fn selector(signature: &str) -> [u8; 4] {
    let h = keccak256(signature.as_bytes());
    let mut out = [0u8; 4];
    out.copy_from_slice(&h[..4]);
    out
}

fn pad_left(bytes: &[u8]) -> [u8; 32] {
    assert!(bytes.len() <= 32);
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(bytes);
    out
}

fn encode_address(addr: &[u8; 20]) -> [u8; 32] {
    pad_left(addr)
}

fn encode_uint256(value: &[u8; 32]) -> [u8; 32] {
    *value
}

fn encode_uint(value: u128) -> [u8; 32] {
    pad_left(&value.to_be_bytes())
}

fn encode_string(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(32 + ((bytes.len() + 31) / 32) * 32);
    out.extend_from_slice(&encode_uint(bytes.len() as u128));
    out.extend_from_slice(bytes);
    let pad = (32 - (bytes.len() % 32)) % 32;
    out.extend(std::iter::repeat(0u8).take(pad));
    out
}

/// `approve(address spender, uint256 amount)` — ERC-20.
pub fn encode_approve(spender: &[u8; 20], amount: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 64);
    out.extend_from_slice(&selector("approve(address,uint256)"));
    out.extend_from_slice(&encode_address(spender));
    out.extend_from_slice(&encode_uint256(amount));
    out
}

/// `isActive(address node)` — NodeRegistry view.
pub fn encode_is_active(node: &[u8; 20]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 32);
    out.extend_from_slice(&selector("isActive(address)"));
    out.extend_from_slice(&encode_address(node));
    out
}

/// `register(string url, bytes32 ecdhPubkey, uint8 backendBitmap,
///   uint64 maxTokens, uint256[4] pricePer1k, uint256 stake)`.
pub fn encode_register(
    url: &str,
    ecdh_pubkey: &[u8; 32],
    backend_bitmap: u8,
    max_tokens: u64,
    price_per_1k: &[[u8; 32]; 4],
    stake: &[u8; 32],
) -> Vec<u8> {
    // Head layout (6 slots = 192 bytes for the dynamic-offset slot + statics,
    // plus the inline 4-slot array = 288 bytes total before the tail).
    //   slot 0: offset to url tail (uint256)
    //   slot 1: ecdhPubkey (bytes32)
    //   slot 2: backendBitmap (uint8 padded)
    //   slot 3: maxTokens (uint64 padded)
    //   slots 4..8: pricePer1k[0..4] (uint256 each, inline because fixed-size)
    //   slot 8: stake (uint256)
    // So head_len = 9 * 32 = 288, url offset = 288.
    let url_offset: u128 = 9 * 32;

    let mut out = Vec::new();
    out.extend_from_slice(&selector(
        "register(string,bytes32,uint8,uint64,uint256[4],uint256)",
    ));
    out.extend_from_slice(&encode_uint(url_offset));
    out.extend_from_slice(ecdh_pubkey);
    out.extend_from_slice(&encode_uint(backend_bitmap as u128));
    out.extend_from_slice(&encode_uint(max_tokens as u128));
    for p in price_per_1k {
        out.extend_from_slice(p);
    }
    out.extend_from_slice(stake);
    out.extend_from_slice(&encode_string(url));
    out
}

/// `update(string url, bytes32 ecdhPubkey, uint8 backendBitmap,
///   uint64 maxTokens, uint256[4] pricePer1k)`.
#[allow(dead_code)] // wired in once we add an "update if pricing/url drifted" path.
pub fn encode_update(
    url: &str,
    ecdh_pubkey: &[u8; 32],
    backend_bitmap: u8,
    max_tokens: u64,
    price_per_1k: &[[u8; 32]; 4],
) -> Vec<u8> {
    // Head: 8 slots (1 dynamic offset + bytes32 + uint8 + uint64 + 4×uint256).
    let url_offset: u128 = 8 * 32;
    let mut out = Vec::new();
    out.extend_from_slice(&selector(
        "update(string,bytes32,uint8,uint64,uint256[4])",
    ));
    out.extend_from_slice(&encode_uint(url_offset));
    out.extend_from_slice(ecdh_pubkey);
    out.extend_from_slice(&encode_uint(backend_bitmap as u128));
    out.extend_from_slice(&encode_uint(max_tokens as u128));
    for p in price_per_1k {
        out.extend_from_slice(p);
    }
    out.extend_from_slice(&encode_string(url));
    out
}

/// Decode a single bool returned by an `eth_call` (right-padded in 32 bytes).
pub fn decode_bool(out: &[u8]) -> bool {
    out.len() >= 32 && out[31] != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approve_selector_matches_known() {
        // `cast sig "approve(address,uint256)"` = 0x095ea7b3
        assert_eq!(selector("approve(address,uint256)"), [0x09, 0x5e, 0xa7, 0xb3]);
    }

    #[test]
    fn is_active_selector_matches_known() {
        // `cast sig "isActive(address)"` = 0x9f8a13d7
        assert_eq!(selector("isActive(address)"), [0x9f, 0x8a, 0x13, 0xd7]);
    }

    #[test]
    fn approve_encoding_layout() {
        let spender = [0x11u8; 20];
        let amt = {
            let mut a = [0u8; 32];
            a[24..].copy_from_slice(&100u64.to_be_bytes());
            a
        };
        let enc = encode_approve(&spender, &amt);
        assert_eq!(enc.len(), 4 + 64);
        assert_eq!(&enc[0..4], &[0x09, 0x5e, 0xa7, 0xb3]);
        assert_eq!(&enc[16..36], &spender);
        assert_eq!(&enc[36..], &amt);
    }

    #[test]
    fn register_encoding_url_tail() {
        let url = "https://example.com";
        let pub_ = [0x22u8; 32];
        let prices = [[0u8; 32]; 4];
        let stake = [0u8; 32];
        let enc = encode_register(url, &pub_, 0x09, 100_000, &prices, &stake);
        // Selector + 9 head slots + tail (length slot + url padded to 32-byte multiple)
        assert_eq!(&enc[0..4], &selector(
            "register(string,bytes32,uint8,uint64,uint256[4],uint256)",
        ));
        // url offset slot — last 2 bytes should encode 9*32 = 288 = 0x0120.
        let mut url_off = [0u8; 32];
        url_off[30] = 0x01;
        url_off[31] = 0x20;
        assert_eq!(&enc[4..36], &url_off);
        // url length sits right after the 9 head slots = byte 4 + 9*32 = 292.
        let len_slot_start = 4 + 9 * 32;
        let mut expected_len = [0u8; 32];
        expected_len[24..].copy_from_slice(&(url.len() as u64).to_be_bytes());
        assert_eq!(&enc[len_slot_start..len_slot_start + 32], &expected_len);
        // url bytes follow, padded to 32-byte multiple.
        assert_eq!(
            &enc[len_slot_start + 32..len_slot_start + 32 + url.len()],
            url.as_bytes()
        );
    }
}
