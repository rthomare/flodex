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
    RecoveryId, Signature, SigningKey, VerifyingKey,
};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use x25519_dalek::{PublicKey, StaticSecret};

pub const NONCE_SIZE: usize = 24;
pub const KEY_SIZE: usize = 32;
pub const IDENTITY_PUBKEY_SIZE: usize = 33; // secp256k1 compressed
pub const IDENTITY_SIG_SIZE: usize = 64; // ECDSA r||s, big-endian
pub const ETH_ADDRESS_SIZE: usize = 20;
pub const EIP191_SIG_SIZE: usize = 65; // r||s||v, v in {27,28}
pub const ETH_TX_SIG_SIZE: usize = 65; // r||s||v, v in {0,1} (EIP-1559)

const EIP191_PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n32";

const HKDF_INFO: &[u8] = b"fldx-v0-session-key";

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

    /// Sign `message` with the EIP-191 prefix (`"\x19Ethereum Signed Message:\n32"`)
    /// after keccak256-hashing — the format `ECDSA.recover` expects on-chain.
    /// Returns 65 bytes `r||s||v` with `v ∈ {27, 28}`.
    pub fn sign_eip191(&self, message: &[u8]) -> [u8; EIP191_SIG_SIZE] {
        let digest = eip191_digest(message);
        let (sig, recid): (Signature, RecoveryId) = self
            .signing
            .sign_prehash_recoverable(&digest)
            .expect("signing a valid prehash cannot fail");
        let sig_bytes = sig.to_bytes();
        let mut out = [0u8; EIP191_SIG_SIZE];
        out[..IDENTITY_SIG_SIZE].copy_from_slice(&sig_bytes);
        out[IDENTITY_SIG_SIZE] = recid.to_byte() + 27;
        out
    }

    /// Ethereum address derived from this identity's secp256k1 public key —
    /// `keccak256(uncompressed_pub[1..])[12..]`. Same address that goes
    /// on-chain as `msg.sender` when the node calls `register()`.
    pub fn eth_address(&self) -> [u8; ETH_ADDRESS_SIZE] {
        eth_address_from_verifying_key(self.signing.verifying_key())
    }

    /// Sign a precomputed 32-byte digest (caller hashed already). Returns
    /// 65 bytes `r||s||v` with `v ∈ {0, 1}` — the parity byte EIP-1559
    /// transactions encode in their RLP signature field. NOT the +27 form
    /// EIP-191 / EIP-155 use.
    pub fn sign_eth_tx_digest(&self, digest: &[u8; 32]) -> [u8; ETH_TX_SIG_SIZE] {
        let (sig, recid): (Signature, RecoveryId) = self
            .signing
            .sign_prehash_recoverable(digest)
            .expect("signing a valid prehash cannot fail");
        let bytes = sig.to_bytes();
        let mut out = [0u8; ETH_TX_SIG_SIZE];
        out[..IDENTITY_SIG_SIZE].copy_from_slice(&bytes);
        out[IDENTITY_SIG_SIZE] = recid.to_byte();
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

/// keccak256 over arbitrary bytes. Distinct from SHA-256 — used for
/// Ethereum-flavored hashing (EIP-191, `abi.encode` digests, address derivation).
pub fn keccak256(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Keccak256::digest(bytes));
    out
}

/// `keccak256("\x19Ethereum Signed Message:\n32" || keccak256(message))`.
/// This is the digest `ECDSA.recover` expects in OpenZeppelin's library.
pub fn eip191_digest(message: &[u8]) -> [u8; 32] {
    let inner = keccak256(message);
    let mut hasher = Keccak256::new();
    Digest::update(&mut hasher, EIP191_PREFIX);
    Digest::update(&mut hasher, &inner);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hasher.finalize());
    out
}

/// Recover the Ethereum address that signed `message` (EIP-191 envelope). The
/// signature is 65 bytes `r||s||v` with `v ∈ {27, 28}` — exactly what
/// `NodeIdentity::sign_eip191` produces.
pub fn recover_eip191(message: &[u8], sig: &[u8; EIP191_SIG_SIZE]) -> Result<[u8; ETH_ADDRESS_SIZE]> {
    let digest = eip191_digest(message);
    let v = sig[IDENTITY_SIG_SIZE];
    let recid_byte = v.checked_sub(27).ok_or_else(|| anyhow!("invalid v: {v}"))?;
    let recid = RecoveryId::from_byte(recid_byte)
        .ok_or_else(|| anyhow!("invalid recovery id: {recid_byte}"))?;
    let signature = Signature::from_slice(&sig[..IDENTITY_SIG_SIZE])
        .map_err(|e| anyhow!("invalid signature bytes: {e}"))?;
    let verifying = VerifyingKey::recover_from_prehash(&digest, &signature, recid)
        .map_err(|e| anyhow!("recovery failed: {e}"))?;
    Ok(eth_address_from_verifying_key(&verifying))
}

fn eth_address_from_verifying_key(vk: &VerifyingKey) -> [u8; ETH_ADDRESS_SIZE] {
    let point = vk.to_encoded_point(false); // 0x04 || X(32) || Y(32) = 65 bytes
    let bytes = point.as_bytes();
    debug_assert_eq!(bytes.len(), 65);
    let hash = keccak256(&bytes[1..]);
    let mut addr = [0u8; ETH_ADDRESS_SIZE];
    addr.copy_from_slice(&hash[12..]);
    addr
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
        let (nonce, ct) = encrypt(&key, b"hello fldx").unwrap();
        let pt = decrypt(&key, &nonce, &ct).unwrap();
        assert_eq!(pt, b"hello fldx");
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
        let msg = b"fldx-v0-register|some|payload";
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

    #[test]
    fn keccak256_known_vector() {
        // keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
        let expected = hex::decode(
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        )
        .unwrap();
        assert_eq!(keccak256(b"").to_vec(), expected);
    }

    #[test]
    fn eth_address_from_anvil_key() {
        // Anvil's first dev key — the address is well-known and lets us
        // sanity-check the keccak / address-derivation path against viem.
        let seed = hex::decode(
            "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        )
        .unwrap();
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&seed);
        let id = NodeIdentity::from_seed(bytes).unwrap();
        let addr = id.eth_address();
        assert_eq!(
            hex::encode(addr),
            "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        );
    }

    #[test]
    fn eip191_sign_recover_roundtrip() {
        let id = NodeIdentity::generate();
        let msg = b"fldx-v0-channel-update-test-payload";
        let sig = id.sign_eip191(msg);
        let recovered = recover_eip191(msg, &sig).unwrap();
        assert_eq!(recovered, id.eth_address());
        // Tamper with the message — recovery yields a *different* address
        // (it doesn't fail; that's how ecrecover works), so the equality
        // check fails.
        let other = recover_eip191(b"different", &sig).unwrap();
        assert_ne!(other, id.eth_address());
    }
}
