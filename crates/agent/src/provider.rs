//! `ChatProvider` trait — the seam the agent loop talks through.
//!
//! Providers accept Anthropic-shaped content blocks (our internal lingua
//! franca) and return Anthropic-shaped content blocks. Non-Anthropic providers
//! translate to/from their native format at the trait boundary.

use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[async_trait]
pub trait ChatProvider: Send + Sync {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResult>;
}

// Serde derives let these types ride the encrypted boundary as JSON for the
// node's `/proxy/complete` passthrough endpoint (used by the Claude Code proxy).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub system: String,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub max_tokens: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatResult {
    pub content: Vec<Value>,
    pub stop_reason: String,
    pub usage: Usage,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u32>,
}
