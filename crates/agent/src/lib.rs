//! Agent loop: drives a `ChatProvider`, dispatches tool calls to node-side
//! executors, and hands off client-side tool calls to the caller via
//! [`AgentStepOutcome::NeedsClientTool`].
//!
//! Session state is a list of Anthropic-shaped messages — we append the full
//! `response.content` back verbatim each turn so thinking/tool_use blocks are
//! preserved across turns regardless of which provider served them.

pub mod anthropic;
pub mod provider;
pub mod tools;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

pub use anthropic::{AnthropicClient, AnthropicProvider};
pub use provider::{ChatProvider, ChatRequest, ChatResult, Usage};
pub use tools::{
    CurrentTimeTool, NodeTool, Tool, ToolDef, ToolRegistry, WebFetchTool, read_local_file_def,
};

/// Recommended default for Opus 4.7 per Anthropic guidance.
pub const DEFAULT_MODEL: &str = "claude-opus-4-7";
pub const DEFAULT_MAX_TOKENS: u32 = 16_000;

pub struct AgentLoop {
    provider: Box<dyn ChatProvider>,
    max_tokens: u32,
    system_prompt: String,
    registry: ToolRegistry,
}

pub struct AgentSession {
    pub messages: Vec<Value>,
}

impl Default for AgentSession {
    fn default() -> Self {
        Self { messages: Vec::new() }
    }
}

impl AgentSession {
    pub fn new() -> Self {
        Self::default()
    }
}

pub enum AgentStepInput {
    Prompt(String),
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

pub enum AgentStepOutcome {
    Final(String),
    NeedsClientTool {
        tool_use_id: String,
        name: String,
        input: Value,
    },
}

impl AgentLoop {
    pub fn new(
        provider: Box<dyn ChatProvider>,
        system_prompt: String,
        tools: Vec<Tool>,
    ) -> Self {
        Self {
            provider,
            max_tokens: DEFAULT_MAX_TOKENS,
            system_prompt,
            registry: ToolRegistry::new(tools),
        }
    }

    pub async fn step(
        &self,
        session: &mut AgentSession,
        input: AgentStepInput,
    ) -> Result<AgentStepOutcome> {
        session.messages.push(input_to_user_message(input));

        loop {
            let req = ChatRequest {
                system: self.system_prompt.clone(),
                messages: session.messages.clone(),
                tools: self.registry.api_definitions(),
                max_tokens: self.max_tokens,
            };

            tracing::debug!(turn = session.messages.len(), "calling chat provider");
            let resp = self.provider.complete(req).await?;
            tracing::info!(
                stop_reason = %resp.stop_reason,
                input_tokens = resp.usage.input_tokens,
                output_tokens = resp.usage.output_tokens,
                cache_read = ?resp.usage.cache_read_input_tokens,
                cache_create = ?resp.usage.cache_creation_input_tokens,
                "provider response"
            );

            session.messages.push(json!({
                "role": "assistant",
                "content": resp.content.clone(),
            }));

            match resp.stop_reason.as_str() {
                "end_turn" => return Ok(AgentStepOutcome::Final(extract_text(&resp.content))),
                "tool_use" => {
                    let (id, name, tool_input) = find_tool_use(&resp.content)?;
                    match self.registry.find(&name) {
                        Some(Tool::Node(executor)) => {
                            let (content, is_error) = match executor.execute(tool_input).await {
                                Ok(s) => (s, false),
                                Err(e) => (format!("tool error: {e}"), true),
                            };
                            session
                                .messages
                                .push(tool_result_message(&id, &content, is_error));
                        }
                        Some(Tool::Client(_)) => {
                            return Ok(AgentStepOutcome::NeedsClientTool {
                                tool_use_id: id,
                                name,
                                input: tool_input,
                            });
                        }
                        None => {
                            let msg = format!("unknown tool `{name}`");
                            session.messages.push(tool_result_message(&id, &msg, true));
                        }
                    }
                }
                "pause_turn" => continue,
                other => return Err(anyhow!("unexpected stop_reason: {other}")),
            }
        }
    }
}

fn input_to_user_message(input: AgentStepInput) -> Value {
    match input {
        AgentStepInput::Prompt(text) => json!({
            "role": "user",
            "content": [{ "type": "text", "text": text }]
        }),
        AgentStepInput::ToolResult {
            tool_use_id,
            content,
            is_error,
        } => {
            let mut block = json!({
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
            });
            if is_error {
                block["is_error"] = json!(true);
            }
            json!({ "role": "user", "content": [block] })
        }
    }
}

fn tool_result_message(tool_use_id: &str, content: &str, is_error: bool) -> Value {
    let mut block = json!({
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content,
    });
    if is_error {
        block["is_error"] = json!(true);
    }
    json!({ "role": "user", "content": [block] })
}

fn find_tool_use(content: &[Value]) -> Result<(String, String, Value)> {
    let block = content
        .iter()
        .find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .ok_or_else(|| anyhow!("stop_reason=tool_use but no tool_use block in content"))?;
    let id = block
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tool_use block missing id"))?
        .to_string();
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tool_use block missing name"))?
        .to_string();
    let input = block.get("input").cloned().unwrap_or(Value::Null);
    Ok((id, name, input))
}

fn extract_text(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|b| {
            if b.get("type").and_then(Value::as_str) == Some("text") {
                b.get("text").and_then(Value::as_str).map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
