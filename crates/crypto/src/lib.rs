//! v0 crypto:
//! - **Transport**: X25519 ECDH + HKDF-SHA256 + XChaCha20-Poly1305 between
//!   client and node (per-session key, ephemeral client keys).
//! - **Identity**: secp256k1 ECDSA over SHA-256, used to sign node
//!   registrations and heartbeats. Persistable as a 32-byte seed.
//!   secp256k1 (not Ed25519) so the same key becomes the node's Ethereum
//!   address when the on-chain registry lands.

use anyhow::{anyhow, Result};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use k256::ecdsa::{
    signature::{hazmat::PrehashVerifier, hazmat::PrehashSigner},
    Signature, SigningKey, VerifyingKey,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub const NONCE_SIZE: usize = 24;
pub const KEY_SIZE: usize = 32;
pub const IDENTITY_PUBKEY_SIZE: usize = 33; // secp256k1 compressed
pub const IDENTITY_SIG_SIZE: usize = 64; // ECDSA r||s, big-endian

const HKDF_INFO: &[u8] = b"flodex-v0-session-key";

pub struct NodeKeys {
    secret: StaticSecret,
    pub public: PublicKey,
}

impl NodeKeys {
    pub fn generate() -> Self {
        Self::from_seed(rand_seed())
    }

    pub fn from_seed(seed: [u8; KEY_SIZE]) -> Self {
        let secret = StaticSecret::from(seed);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    pub fn seed(&self) -> [u8; KEY_SIZE] {
        self.secret.to_bytes()
    }

    pub fn shared_secret(&self, client_public: &PublicKey) -> [u8; KEY_SIZE] {
        self.secret.diffie_hellman(client_public).to_bytes()
    }
}

/// secp256k1 signing identity. Stable across restarts when persisted.
pub struct NodeIdentity {
    signing: SigningKey,
}

impl NodeIdentity {
    pub fn generate() -> Self {
        Self::from_seed(rand_seed()).expect("random seed is a valid scalar with overwhelming probability")
    }

    pub fn from_seed(seed: [u8; KEY_SIZE]) -> Result<Self> {
        let signing = SigningKey::from_bytes(&seed.into())
            .map_err(|e| anyhow!("invalid secp256k1 seed: {e}"))?;
        Ok(Self { signing })
    }

    pub fn seed(&self) -> [u8; KEY_SIZE] {
        self.signing.to_bytes().into()
    }

    pub fn public_compressed(&self) -> [u8; IDENTITY_PUBKEY_SIZE] {
        let point = self.signing.verifying_key().to_encoded_point(true);
        let bytes = point.as_bytes();
        debug_assert_eq!(bytes.len(), IDENTITY_PUBKEY_SIZE);
        let mut out = [0u8; IDENTITY_PUBKEY_SIZE];
        out.copy_from_slice(bytes);
        out
    }

    /// Sign `message` (raw bytes — caller's responsibility to canonicalize +
    /// domain-tag before passing in). Returns 64-byte compact ECDSA r||s.
    pub fn sign(&self, message: &[u8]) -> [u8; IDENTITY_SIG_SIZE] {
        let hash = Sha256::digest(message);
        let sig: Signature = self
            .signing
            .sign_prehash(&hash)
            .expect("signing a valid prehash cannot fail");
        let bytes = sig.to_bytes();
        let mut out = [0u8; IDENTITY_SIG_SIZE];
        out.copy_from_slice(&bytes);
        out
    }
}

/// Verify a 64-byte ECDSA signature over `message` against a 33-byte
/// compressed secp256k1 pubkey. Returns true iff the signature is valid.
pub fn verify_identity_signature(
    pubkey_compressed: &[u8],
    message: &[u8],
    signature: &[u8],
) -> bool {
    if pubkey_compressed.len() != IDENTITY_PUBKEY_SIZE
        || signature.len() != IDENTITY_SIG_SIZE
    {
        return false;
    }
    let Ok(verifying) = VerifyingKey::from_sec1_bytes(pubkey_compressed) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(signature) else {
        return false;
    };
    let hash = Sha256::digest(message);
    verifying.verify_prehash(&hash, &sig).is_ok()
}

fn rand_seed() -> [u8; KEY_SIZE] {
    let mut seed = [0u8; KEY_SIZE];
    OsRng.fill_bytes(&mut seed);
    seed
}

/// 16 random bytes encoded as 32 hex chars. Used as the registration /
/// heartbeat nonce to make replay distinguishable.
pub fn random_nonce_hex() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
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

    #[test]
    fn node_keys_seed_roundtrip() {
        let a = NodeKeys::generate();
        let b = NodeKeys::from_seed(a.seed());
        assert_eq!(a.public.as_bytes(), b.public.as_bytes());
    }

    #[test]
    fn identity_sign_verify() {
        let id = NodeIdentity::generate();
        let pub_compressed = id.public_compressed();
        let msg = b"flodex-v0-register|some|payload";
        let sig = id.sign(msg);
        assert!(verify_identity_signature(&pub_compressed, msg, &sig));
        assert!(!verify_identity_signature(&pub_compressed, b"tampered", &sig));
        let mut bad_sig = sig;
        bad_sig[0] ^= 1;
        assert!(!verify_identity_signature(&pub_compressed, msg, &bad_sig));
    }

    #[test]
    fn identity_seed_roundtrip() {
        let a = NodeIdentity::generate();
        let b = NodeIdentity::from_seed(a.seed()).unwrap();
        assert_eq!(a.public_compressed(), b.public_compressed());
    }
}
