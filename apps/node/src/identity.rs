//! Persists the node's two long-lived keypairs (X25519 for ECDH, secp256k1
//! for identity) to a single JSON file. Generated on first startup; loaded on
//! subsequent runs so node identity is stable across restarts.
//!
//! Default path: `$HOME/.flodex/node/identity.json`. Override with
//! `FLODEX_NODE_IDENTITY_PATH`. File mode is set to 0600 on Unix.

use anyhow::{anyhow, Context, Result};
use crypto::{NodeIdentity, NodeKeys, KEY_SIZE};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
struct OnDiskIdentity {
    /// 32-byte X25519 secret seed, hex-encoded.
    ecdh_seed: String,
    /// 32-byte secp256k1 secret seed, hex-encoded.
    identity_seed: String,
}

pub fn default_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("FLODEX_NODE_IDENTITY_PATH") {
        return Ok(PathBuf::from(p));
    }
    let home = dirs::home_dir().ok_or_else(|| anyhow!("could not resolve home dir"))?;
    Ok(home.join(".flodex").join("node").join("identity.json"))
}

pub fn load_or_generate(path: &Path) -> Result<(NodeKeys, NodeIdentity)> {
    if path.exists() {
        load(path)
    } else {
        let keys = NodeKeys::generate();
        let identity = NodeIdentity::generate();
        save(path, &keys, &identity)?;
        tracing::info!(
            path = %path.display(),
            "generated new node identity"
        );
        Ok((keys, identity))
    }
}

fn load(path: &Path) -> Result<(NodeKeys, NodeIdentity)> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("reading identity file {}", path.display()))?;
    let on_disk: OnDiskIdentity = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing identity file {}", path.display()))?;
    let keys = NodeKeys::from_seed(parse_seed(&on_disk.ecdh_seed, "ecdh_seed")?);
    let identity = NodeIdentity::from_seed(parse_seed(&on_disk.identity_seed, "identity_seed")?)
        .context("identity_seed is not a valid secp256k1 scalar")?;
    tracing::info!(path = %path.display(), "loaded persisted node identity");
    Ok((keys, identity))
}

fn save(path: &Path, keys: &NodeKeys, identity: &NodeIdentity) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let on_disk = OnDiskIdentity {
        ecdh_seed: hex::encode(keys.seed()),
        identity_seed: hex::encode(identity.seed()),
    };
    let json = serde_json::to_vec_pretty(&on_disk)?;
    std::fs::write(path, &json)
        .with_context(|| format!("writing identity file {}", path.display()))?;
    set_secret_perms(path);
    Ok(())
}

#[cfg(unix)]
fn set_secret_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(path = %path.display(), "could not chmod 600 identity file: {e}");
    }
}

#[cfg(not(unix))]
fn set_secret_perms(_path: &Path) {
    // Best-effort only on non-Unix; users on Windows should secure the file
    // manually.
}

fn parse_seed(s: &str, field: &str) -> Result<[u8; KEY_SIZE]> {
    let bytes = hex::decode(s).with_context(|| format!("hex-decoding {field}"))?;
    let arr: [u8; KEY_SIZE] = bytes
        .try_into()
        .map_err(|_| anyhow!("{field} must be {KEY_SIZE} bytes after hex-decode"))?;
    Ok(arr)
}
