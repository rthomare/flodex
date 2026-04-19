//! v0 crypto: X25519 ECDH + HKDF-SHA256 + XChaCha20-Poly1305.
//!
//! Flow: client generates an ephemeral X25519 keypair per request, derives a
//! shared secret against the node's static public key, then runs HKDF with
//! the session id as salt to produce a symmetric AEAD key.

use anyhow::{anyhow, Result};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

pub const NONCE_SIZE: usize = 24;
pub const KEY_SIZE: usize = 32;

const HKDF_INFO: &[u8] = b"flodex-v0-session-key";

pub struct NodeKeys {
    secret: StaticSecret,
    pub public: PublicKey,
}

impl NodeKeys {
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    pub fn shared_secret(&self, client_public: &PublicKey) -> [u8; KEY_SIZE] {
        self.secret.diffie_hellman(client_public).to_bytes()
    }
}

pub fn derive_key(shared_secret: &[u8; KEY_SIZE], session_id: &str) -> [u8; KEY_SIZE] {
    let hk = Hkdf::<Sha256>::new(Some(session_id.as_bytes()), shared_secret);
    let mut key = [0u8; KEY_SIZE];
    hk.expand(HKDF_INFO, &mut key).expect("hkdf expand into 32 bytes cannot fail");
    key
}

pub fn encrypt(key: &[u8; KEY_SIZE], plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow!("encrypt failed: {e}"))?;
    Ok((nonce_bytes.to_vec(), ciphertext))
}

pub fn decrypt(key: &[u8; KEY_SIZE], nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    if nonce.len() != NONCE_SIZE {
        return Err(anyhow!("nonce must be {NONCE_SIZE} bytes, got {}", nonce.len()));
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(nonce);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow!("decrypt failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let node = NodeKeys::generate();
        let client_secret = StaticSecret::random_from_rng(OsRng);
        let client_pub = PublicKey::from(&client_secret);

        let node_side = node.shared_secret(&client_pub);
        let client_side = client_secret.diffie_hellman(&node.public).to_bytes();
        assert_eq!(node_side, client_side);

        let key = derive_key(&node_side, "session-abc");
        let (nonce, ct) = encrypt(&key, b"hello flodex").unwrap();
        let pt = decrypt(&key, &nonce, &ct).unwrap();
        assert_eq!(pt, b"hello flodex");
    }
}
