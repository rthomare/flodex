//! Anthropic Messages API client + `ChatProvider` implementation.
//!
//! No official Rust SDK exists, so we hand-roll against /v1/messages.
//! Content blocks are kept as `serde_json::Value` so we round-trip whatever
//! shapes the API emits (text, tool_use, thinking, etc.) without having to
//! model every variant.

use crate::provider::{ChatProvider, ChatRequest, ChatResult, Usage};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";

pub struct AnthropicClient {
    http: Client,
    api_key: String,
}

#[derive(Debug, Serialize)]
pub struct MessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    /// Each message is `{ "role": "user" | "assistant", "content": [...] }`.
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct MessagesResponse {
    pub content: Vec<Value>,
    pub stop_reason: String,
    #[serde(default)]
    pub usage: AnthropicUsage,
}

#[derive(Debug, Default, Deserialize)]
pub struct AnthropicUsage {
    #[serde(default)]
    pub input_tokens: u32,
    #[serde(default)]
    pub output_tokens: u32,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u32>,
}

impl AnthropicClient {
    pub fn new(api_key: String) -> Self {
        Self {
            http: Client::new(),
            api_key,
        }
    }

    pub async fn messages(&self, req: &MessagesRequest) -> Result<MessagesResponse> {
        let res = self
            .http
            .post(API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .json(req)
            .send()
            .await
            .map_err(|e| anyhow!("anthropic request failed: {e}"))?;

        let status = res.status();
        let body = res
            .text()
            .await
            .map_err(|e| anyhow!("reading anthropic response body: {e}"))?;

        if !status.is_success() {
            return Err(anyhow!("anthropic {status}: {body}"));
        }

        serde_json::from_str(&body)
            .map_err(|e| anyhow!("parsing anthropic response: {e}; body: {body}"))
    }
}

/// `ChatProvider` that targets the Anthropic Messages API.
pub struct AnthropicProvider {
    client: AnthropicClient,
    model: String,
}

impl AnthropicProvider {
    pub fn new(client: AnthropicClient, model: String) -> Self {
        Self { client, model }
    }
}

#[async_trait]
impl ChatProvider for AnthropicProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResult> {
        let system = vec![json!({
            "type": "text",
            "text": req.system,
            "cache_control": { "type": "ephemeral" }
        })];
        let messages_req = MessagesRequest {
            model: self.model.clone(),
            max_tokens: req.max_tokens,
            messages: req.messages,
            system: Some(system),
            tools: Some(req.tools),
            thinking: Some(json!({ "type": "adaptive" })),
        };
        let resp = self.client.messages(&messages_req).await?;
        Ok(ChatResult {
            content: resp.content,
            stop_reason: resp.stop_reason,
            usage: Usage {
                input_tokens: resp.usage.input_tokens,
                output_tokens: resp.usage.output_tokens,
                cache_creation_input_tokens: resp.usage.cache_creation_input_tokens,
                cache_read_input_tokens: resp.usage.cache_read_input_tokens,
            },
        })
    }
}
