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
                    // The model can emit multiple tool_use blocks in one
                    // assistant message (parallel tool calls). Anthropic
                    // requires every tool_use in a message to have a
                    // matching tool_result in the immediately-following
                    // user message — so we must execute them all and batch
                    // their results into a single user turn.
                    let tool_uses = collect_tool_uses(&resp.content);
                    if tool_uses.is_empty() {
                        return Err(anyhow!(
                            "stop_reason=tool_use but no tool_use blocks in content"
                        ));
                    }

                    // Classify before doing any work. Mixed node+client (or
                    // multiple client) calls in one turn don't fit the wire
                    // protocol — we only carry one client tool round trip
                    // at a time, with no place to stash the others' results.
                    let mut has_node = false;
                    let mut client_count = 0usize;
                    for (_, name, _) in &tool_uses {
                        match self.registry.find(name) {
                            Some(Tool::Node(_)) | None => has_node = true,
                            Some(Tool::Client(_)) => client_count += 1,
                        }
                    }
                    if client_count > 0 && (has_node || client_count > 1) {
                        return Err(anyhow!(
                            "model returned mixed node/client or multiple client \
                             tool calls in one turn; not supported by the current \
                             wire protocol"
                        ));
                    }

                    if client_count == 1 {
                        // Single client tool: hand off to the caller.
                        let (id, name, input) = tool_uses
                            .into_iter()
                            .find(|(_, n, _)| {
                                matches!(self.registry.find(n), Some(Tool::Client(_)))
                            })
                            .expect("client tool present");
                        return Ok(AgentStepOutcome::NeedsClientTool {
                            tool_use_id: id,
                            name,
                            input,
                        });
                    }

                    // All node-side (or unknown — which we surface as an error
                    // tool_result so the model can recover). Execute each in
                    // declaration order, then push a single user message with
                    // every tool_result block.
                    let mut blocks: Vec<Value> = Vec::with_capacity(tool_uses.len());
                    for (id, name, input) in tool_uses {
                        let (content, is_error) = match self.registry.find(&name) {
                            Some(Tool::Node(executor)) => match executor.execute(input).await {
                                Ok(s) => (s, false),
                                Err(e) => (format!("tool error: {e}"), true),
                            },
                            Some(Tool::Client(_)) => unreachable!("filtered above"),
                            None => (format!("unknown tool `{name}`"), true),
                        };
                        blocks.push(tool_result_block(&id, &content, is_error));
                    }
                    session
                        .messages
                        .push(json!({ "role": "user", "content": blocks }));
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

fn tool_result_block(tool_use_id: &str, content: &str, is_error: bool) -> Value {
    let mut block = json!({
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": content,
    });
    if is_error {
        block["is_error"] = json!(true);
    }
    block
}

fn collect_tool_uses(content: &[Value]) -> Vec<(String, String, Value)> {
    content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|b| {
            let id = b.get("id").and_then(Value::as_str)?.to_string();
            let name = b.get("name").and_then(Value::as_str)?.to_string();
            let input = b.get("input").cloned().unwrap_or(Value::Null);
            Some((id, name, input))
        })
        .collect()
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
