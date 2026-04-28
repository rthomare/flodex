//! Supervised `llama-server` subprocess.
//!
//! Spawns `llama-server --model <path> --host 127.0.0.1 --port <free>`,
//! optionally wrapped in an OS sandbox that blocks outbound network egress,
//! then polls `/health` until the model is loaded. The handle kills the
//! child on drop.
//!
//! Sandbox status per OS:
//! - macOS: `sandbox-exec` profile denying `network-outbound`.
//! - Linux/Windows: no sandbox in v0 — a warning is logged. Real enforcement
//!   on Linux needs seccomp or systemd-run scopes; tracked for a follow-up.
//!
//! Set `FLDX_SANDBOX=0` to bypass the sandbox wrapper (useful for debugging
//! profile issues).

use anyhow::{anyhow, bail, Result};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct LlamaServer {
    child: Option<Child>,
    pub base_url: String,
}

impl LlamaServer {
    pub async fn spawn(model_path: &Path) -> Result<Self> {
        which_llama_server()?;
        let port = pick_free_port()?;
        let base_url = format!("http://127.0.0.1:{port}");

        let mut cmd = build_command(model_path, port);
        cmd.stdout(Stdio::null()).stderr(Stdio::inherit());
        tracing::info!(%base_url, model = %model_path.display(), "starting llama-server");
        let child = cmd
            .spawn()
            .map_err(|e| anyhow!("spawning llama-server: {e}"))?;

        let mut server = Self {
            child: Some(child),
            base_url: base_url.clone(),
        };

        if let Err(e) = wait_for_ready(&base_url).await {
            // Kill the partially-started child so we don't leak it on error.
            let _ = server.kill();
            return Err(e);
        }

        tracing::info!(%base_url, "llama-server ready");
        Ok(server)
    }

    fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for LlamaServer {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn wait_for_ready(base_url: &str) -> Result<()> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("reqwest client");
    let start = Instant::now();
    let ready_timeout = Duration::from_secs(180);
    let mut warned = false;

    loop {
        if start.elapsed() > ready_timeout {
            bail!("llama-server did not become ready within {ready_timeout:?}");
        }
        if let Ok(r) = http.get(format!("{base_url}/health")).send().await {
            if r.status().is_success() {
                return Ok(());
            }
        }
        if !warned && start.elapsed() > Duration::from_secs(15) {
            tracing::info!("still waiting on llama-server /health — large models can take a while");
            warned = true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

fn build_command(model: &Path, port: u16) -> Command {
    let sandbox_disabled = std::env::var("FLDX_SANDBOX")
        .map(|v| v == "0" || v.eq_ignore_ascii_case("off") || v.eq_ignore_ascii_case("false"))
        .unwrap_or(false);

    #[cfg(target_os = "macos")]
    if !sandbox_disabled {
        // SBPL rejects raw IPs in `remote ip`; it only accepts hostnames like
        // `localhost` or `*`. `llama-server` is a pure inbound server (we
        // connect *to* it over loopback), so it needs zero outbound — any
        // outbound attempt = exfiltration attempt.
        const PROFILE: &str = "\
(version 1)
(allow default)
(deny network-outbound)
";
        let mut cmd = Command::new("sandbox-exec");
        cmd.arg("-p")
            .arg(PROFILE)
            .arg("llama-server")
            .arg("--model")
            .arg(model)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--log-disable");
        return cmd;
    }

    if !sandbox_disabled {
        tracing::warn!(
            "no sandbox wrapper on this platform — llama-server runs unsandboxed. \
             Set FLDX_SANDBOX=0 to silence; follow-up will add seccomp/systemd-run on Linux."
        );
    }

    let mut cmd = Command::new("llama-server");
    cmd.arg("--model")
        .arg(model)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--log-disable");
    cmd
}

fn pick_free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| anyhow!("binding for port pick: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| anyhow!("local_addr: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn which_llama_server() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let exe = dir.join("llama-server");
            if exe.is_file() {
                return Ok(exe);
            }
        }
    }
    bail!(
        "llama-server not found on PATH.\n\
         Install via:\n  \
         \tmacOS: `brew install llama.cpp`\n  \
         \tLinux: `apt install llama.cpp`, or build from https://github.com/ggml-org/llama.cpp"
    )
}
