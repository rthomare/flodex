//! Model-spec parsing + resolution.
//!
//! Accepted specs:
//! - `hf://owner/repo/path/to/file.gguf` — fetched from HuggingFace Hub
//! - `file:///absolute/path/to/file.gguf` — absolute path passthrough
//! - `/abs/path` or `./rel/path` — bare path passthrough
//!
//! HuggingFace downloads hit `huggingface.co/{repo}/resolve/main/{filename}`,
//! follow CDN redirects, and stream to disk into `{cache}/{repo}/{filename}`.
//! Optional auth via `HF_TOKEN` env var.

use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone)]
pub enum ModelSpec {
    HuggingFace { repo: String, filename: String },
    File(PathBuf),
}

impl ModelSpec {
    pub fn parse(s: &str) -> Result<Self> {
        if let Some(rest) = s.strip_prefix("hf://") {
            let parts: Vec<&str> = rest.splitn(3, '/').collect();
            if parts.len() < 3 || parts.iter().any(|p| p.is_empty()) {
                bail!("hf:// spec must be `hf://owner/repo/filename`, got `{s}`");
            }
            Ok(Self::HuggingFace {
                repo: format!("{}/{}", parts[0], parts[1]),
                filename: parts[2].to_string(),
            })
        } else if let Some(path) = s.strip_prefix("file://") {
            Ok(Self::File(PathBuf::from(path)))
        } else if s.starts_with('/') || s.starts_with("./") || s.starts_with("../") {
            Ok(Self::File(PathBuf::from(s)))
        } else {
            bail!("unknown model spec `{s}` — use hf://, file://, or an absolute path");
        }
    }
}

pub async fn resolve(spec: &ModelSpec, cache_dir: &Path) -> Result<PathBuf> {
    match spec {
        ModelSpec::File(p) => {
            if !p.exists() {
                bail!("model file not found: {}", p.display());
            }
            Ok(p.clone())
        }
        ModelSpec::HuggingFace { repo, filename } => {
            fetch_hf(repo, filename, cache_dir).await
        }
    }
}

pub fn default_cache_dir() -> PathBuf {
    if let Ok(p) = std::env::var("FLODEX_CACHE") {
        return PathBuf::from(p);
    }
    dirs::cache_dir()
        .map(|d| d.join("flodex").join("models"))
        .unwrap_or_else(|| PathBuf::from(".flodex-cache/models"))
}

async fn fetch_hf(repo: &str, filename: &str, cache_dir: &Path) -> Result<PathBuf> {
    let target_dir = cache_dir.join(repo);
    let target = target_dir.join(filename);

    if target.exists() {
        tracing::debug!(path = %target.display(), "model cache hit");
        return Ok(target);
    }

    tokio::fs::create_dir_all(target.parent().unwrap())
        .await
        .with_context(|| format!("creating {}", target_dir.display()))?;

    let url = format!("https://huggingface.co/{repo}/resolve/main/{filename}");
    tracing::info!(
        %repo,
        %filename,
        cache = %cache_dir.display(),
        "downloading model from HuggingFace"
    );

    let mut req = reqwest::Client::new().get(&url);
    if let Ok(token) = std::env::var("HF_TOKEN") {
        req = req.bearer_auth(token);
    }
    let res = req
        .send()
        .await
        .map_err(|e| anyhow!("GET {url}: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow!("GET {url}: {e}"))?;

    let total = res.content_length();
    let tmp = target.with_extension("gguf.partial");
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("creating {}", tmp.display()))?;

    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_log: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("stream chunk: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| anyhow!("writing {}: {e}", tmp.display()))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_log >= 16 * 1024 * 1024 {
            match total {
                Some(t) => tracing::info!(
                    "downloaded {} / {} MiB",
                    downloaded / (1024 * 1024),
                    t / (1024 * 1024)
                ),
                None => tracing::info!("downloaded {} MiB", downloaded / (1024 * 1024)),
            }
            last_log = downloaded;
        }
    }
    file.flush()
        .await
        .map_err(|e| anyhow!("flushing {}: {e}", tmp.display()))?;
    drop(file);
    tokio::fs::rename(&tmp, &target)
        .await
        .map_err(|e| anyhow!("rename {} -> {}: {e}", tmp.display(), target.display()))?;

    tracing::info!(path = %target.display(), "model download complete");
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hf_spec() {
        let s = ModelSpec::parse(
            "hf://bartowski/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf",
        )
        .unwrap();
        match s {
            ModelSpec::HuggingFace { repo, filename } => {
                assert_eq!(repo, "bartowski/Qwen2.5-0.5B-Instruct-GGUF");
                assert_eq!(filename, "qwen2.5-0.5b-instruct-q4_k_m.gguf");
            }
            _ => panic!("expected HuggingFace"),
        }
    }

    #[test]
    fn parses_file_spec() {
        let s = ModelSpec::parse("file:///tmp/model.gguf").unwrap();
        match s {
            ModelSpec::File(p) => assert_eq!(p, PathBuf::from("/tmp/model.gguf")),
            _ => panic!("expected File"),
        }
    }

    #[test]
    fn rejects_bad_hf_spec() {
        assert!(ModelSpec::parse("hf://only-one-part").is_err());
        assert!(ModelSpec::parse("hf://owner/repo").is_err());
    }
}
