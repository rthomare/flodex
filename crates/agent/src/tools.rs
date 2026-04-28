//! Tool registry: node-executed tools (live behind the trait) and
//! client-executed tools (just a definition — the client runs them and
//! returns the result back to the node).

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

impl ToolDef {
    pub fn to_api_value(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        })
    }
}

#[async_trait]
pub trait NodeTool: Send + Sync {
    fn def(&self) -> ToolDef;
    async fn execute(&self, input: Value) -> Result<String>;
}

pub enum Tool {
    Node(Arc<dyn NodeTool>),
    Client(ToolDef),
}

impl Tool {
    pub fn def(&self) -> ToolDef {
        match self {
            Tool::Node(t) => t.def(),
            Tool::Client(d) => d.clone(),
        }
    }
}

pub struct ToolRegistry {
    tools: Vec<Tool>,
}

impl ToolRegistry {
    pub fn new(mut tools: Vec<Tool>) -> Self {
        tools.sort_by(|a, b| a.def().name.cmp(&b.def().name));
        Self { tools }
    }

    pub fn api_definitions(&self) -> Vec<Value> {
        self.tools.iter().map(|t| t.def().to_api_value()).collect()
    }

    pub fn find(&self, name: &str) -> Option<&Tool> {
        self.tools.iter().find(|t| t.def().name == name)
    }
}

pub struct CurrentTimeTool;

#[async_trait]
impl NodeTool for CurrentTimeTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "current_time".into(),
            description:
                "Returns the current UTC time as an ISO 8601 timestamp. Takes no arguments. \
                 Use this whenever the user asks for the time, date, or 'now'."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, _input: Value) -> Result<String> {
        Ok(chrono::Utc::now().to_rfc3339())
    }
}

pub struct WebFetchTool {
    http: reqwest::Client,
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WebFetchTool {
    const MAX_BYTES: usize = 100_000;

    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent("fldx-node/0.0.0")
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("build reqwest client for web_fetch");
        Self { http }
    }
}

#[async_trait]
impl NodeTool for WebFetchTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "web_fetch".into(),
            description: "Fetches text content from an http:// or https:// URL. \
                          Returns the response body as text, truncated to ~100KB. \
                          Use for reading web pages, REST APIs, and documentation. \
                          The node owns the outbound connection — the client never \
                          sees the target host."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Absolute http:// or https:// URL to fetch."
                    }
                },
                "required": ["url"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, input: Value) -> Result<String> {
        let url_str = input
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("web_fetch: `url` must be a string"))?;

        let parsed = reqwest::Url::parse(url_str)
            .map_err(|e| anyhow!("invalid URL: {e}"))?;

        // Best-effort SSRF guardrail. Not a substitute for a real allowlist,
        // but keeps obvious loopback / scheme abuse out.
        match parsed.scheme() {
            "http" | "https" => {}
            other => return Err(anyhow!("scheme `{other}` not allowed; use http or https")),
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| anyhow!("URL has no host"))?;
        if is_loopback_host(host) {
            return Err(anyhow!("loopback hosts not allowed"));
        }

        let res = self
            .http
            .get(parsed.clone())
            .send()
            .await
            .map_err(|e| anyhow!("request failed: {e}"))?;
        let status = res.status();
        let content_type = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown")
            .to_string();

        let bytes = res
            .bytes()
            .await
            .map_err(|e| anyhow!("read body: {e}"))?;
        let truncated = bytes.len() > Self::MAX_BYTES;
        let slice = &bytes[..bytes.len().min(Self::MAX_BYTES)];
        let text = String::from_utf8_lossy(slice);

        let mut out = format!(
            "HTTP {} ({content_type})\n\n{text}",
            status.as_u16()
        );
        if truncated {
            out.push_str(&format!(
                "\n\n[truncated at {} bytes of {}]",
                Self::MAX_BYTES,
                bytes.len()
            ));
        }
        Ok(out)
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "0.0.0.0")
}

pub fn read_local_file_def() -> ToolDef {
    ToolDef {
        name: "read_local_file".into(),
        description:
            "Reads a file from the user's local filesystem and returns its text contents. \
             Use this when the user asks about the contents of a specific file on their machine. \
             Pass an absolute or relative path in `path`."
                .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Filesystem path to the file to read."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
    }
}
