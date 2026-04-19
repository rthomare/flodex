//! `ChatProvider` trait — the seam the agent loop talks through.
//!
//! Providers accept Anthropic-shaped content blocks (our internal lingua
//! franca) and return Anthropic-shaped content blocks. Non-Anthropic providers
//! translate to/from their native format at the trait boundary.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;

#[async_trait]
pub trait ChatProvider: Send + Sync {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResult>;
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub system: String,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub max_tokens: u32,
}

#[derive(Debug)]
pub struct ChatResult {
    pub content: Vec<Value>,
    pub stop_reason: String,
    pub usage: Usage,
}

#[derive(Debug, Default)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: Option<u32>,
    pub cache_read_input_tokens: Option<u32>,
}
