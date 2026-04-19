//! OpenAI-compatible chat completion client + `ChatProvider` impl.
//!
//! Targets llama.cpp's server (`llama-server`), which exposes the OpenAI
//! `/v1/chat/completions` surface. The agent loop speaks Anthropic-shaped
//! content blocks internally, so this module does the translation at the
//! seam — Anthropic ↔ OpenAI, in both directions.

use agent::{ChatProvider, ChatRequest, ChatResult, Usage};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OpenAiProvider {
    http: reqwest::Client,
    base_url: String,
    model: String,
}

impl OpenAiProvider {
    pub fn new(base_url: String, model: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url,
            model,
        }
    }
}

#[async_trait]
impl ChatProvider for OpenAiProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResult> {
        let oai_messages = messages_anthropic_to_oai(&req.system, &req.messages);
        let oai_tools: Vec<Value> = req.tools.iter().map(tool_anthropic_to_oai).collect();

        let body = json!({
            "model": self.model,
            "messages": oai_messages,
            "tools": oai_tools,
            "tool_choice": "auto",
            "max_tokens": req.max_tokens,
            "stream": false,
        });

        let url = format!("{}/v1/chat/completions", self.base_url);
        let res = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow!("POST {url}: {e}"))?;
        let status = res.status();
        let body_text = res
            .text()
            .await
            .map_err(|e| anyhow!("reading response body: {e}"))?;
        if !status.is_success() {
            return Err(anyhow!("llama-server {status}: {body_text}"));
        }

        let body: Value = serde_json::from_str(&body_text)
            .map_err(|e| anyhow!("parse response: {e}; body: {body_text}"))?;
        response_oai_to_anthropic(body)
    }
}

fn messages_anthropic_to_oai(system: &str, messages: &[Value]) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": system })];

    for msg in messages {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
        let empty = Vec::new();
        let content = msg
            .get("content")
            .and_then(Value::as_array)
            .unwrap_or(&empty);

        match role {
            "user" => {
                let mut text_parts: Vec<String> = Vec::new();
                for block in content {
                    match block_type(block) {
                        "text" => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                text_parts.push(t.to_string());
                            }
                        }
                        "tool_result" => {
                            let tool_call_id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let content_str = tool_result_content_to_string(block);
                            out.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_call_id,
                                "content": content_str,
                            }));
                        }
                        _ => {}
                    }
                }
                if !text_parts.is_empty() {
                    out.push(json!({ "role": "user", "content": text_parts.join("\n") }));
                }
            }
            "assistant" => {
                let mut text_parts: Vec<String> = Vec::new();
                let mut tool_calls: Vec<Value> = Vec::new();
                for block in content {
                    match block_type(block) {
                        "text" => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                text_parts.push(t.to_string());
                            }
                        }
                        "tool_use" => {
                            let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                            let input = block.get("input").cloned().unwrap_or(Value::Null);
                            let arguments =
                                serde_json::to_string(&input).unwrap_or_else(|_| "{}".into());
                            tool_calls.push(json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": arguments,
                                }
                            }));
                        }
                        // Anthropic `thinking` blocks have no OpenAI equivalent — drop.
                        _ => {}
                    }
                }
                let content_val = if text_parts.is_empty() {
                    Value::Null
                } else {
                    json!(text_parts.join("\n"))
                };
                let mut msg = json!({ "role": "assistant", "content": content_val });
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = json!(tool_calls);
                }
                out.push(msg);
            }
            _ => {}
        }
    }

    out
}

fn tool_anthropic_to_oai(tool: &Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool.get("name").cloned().unwrap_or(Value::Null),
            "description": tool.get("description").cloned().unwrap_or(Value::Null),
            "parameters": tool.get("input_schema").cloned().unwrap_or(json!({"type": "object"})),
        }
    })
}

fn response_oai_to_anthropic(body: Value) -> Result<ChatResult> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| anyhow!("response missing choices[0]"))?;
    let message = choice
        .get("message")
        .ok_or_else(|| anyhow!("choice missing message"))?;
    let finish_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .unwrap_or("stop");

    let mut content: Vec<Value> = Vec::new();
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        if !text.is_empty() {
            content.push(json!({ "type": "text", "text": text }));
        }
    }
    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for call in tool_calls {
            let id = call.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let arguments_str = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let input: Value = serde_json::from_str(arguments_str).unwrap_or(Value::Null);
            content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }));
        }
    }

    let stop_reason = match finish_reason {
        "stop" => "end_turn",
        "tool_calls" => "tool_use",
        "length" => "max_tokens",
        other => other,
    }
    .to_string();

    let usage_obj = body.get("usage");
    let usage = Usage {
        input_tokens: usage_obj
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        output_tokens: usage_obj
            .and_then(|u| u.get("completion_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        cache_creation_input_tokens: None,
        cache_read_input_tokens: None,
    };

    Ok(ChatResult {
        content,
        stop_reason,
        usage,
    })
}

fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

fn tool_result_content_to_string(block: &Value) -> String {
    match block.get("content") {
        Some(v) if v.is_string() => v.as_str().unwrap().to_string(),
        Some(v) => v.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn translates_user_text() {
        let messages = vec![json!({
            "role": "user",
            "content": [{ "type": "text", "text": "hello" }]
        })];
        let out = messages_anthropic_to_oai("sys", &messages);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[1]["role"], "user");
        assert_eq!(out[1]["content"], "hello");
    }

    #[test]
    fn translates_assistant_tool_use() {
        let messages = vec![json!({
            "role": "assistant",
            "content": [
                { "type": "text", "text": "ok" },
                { "type": "tool_use", "id": "t1", "name": "foo", "input": {"x": 1} }
            ]
        })];
        let out = messages_anthropic_to_oai("sys", &messages);
        let asst = &out[1];
        assert_eq!(asst["role"], "assistant");
        assert_eq!(asst["content"], "ok");
        assert_eq!(asst["tool_calls"][0]["id"], "t1");
        assert_eq!(asst["tool_calls"][0]["function"]["name"], "foo");
        assert_eq!(
            asst["tool_calls"][0]["function"]["arguments"],
            json!("{\"x\":1}")
        );
    }

    #[test]
    fn translates_tool_result_into_role_tool() {
        let messages = vec![json!({
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "result" }]
        })];
        let out = messages_anthropic_to_oai("sys", &messages);
        let tool = &out[1];
        assert_eq!(tool["role"], "tool");
        assert_eq!(tool["tool_call_id"], "t1");
        assert_eq!(tool["content"], "result");
    }

    #[test]
    fn parses_openai_response_with_tool_call() {
        let body = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "current_time", "arguments": "{}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 2 }
        });
        let r = response_oai_to_anthropic(body).unwrap();
        assert_eq!(r.stop_reason, "tool_use");
        assert_eq!(r.content.len(), 1);
        assert_eq!(r.content[0]["type"], "tool_use");
        assert_eq!(r.content[0]["id"], "call_1");
        assert_eq!(r.content[0]["name"], "current_time");
        assert_eq!(r.usage.input_tokens, 10);
        assert_eq!(r.usage.output_tokens, 2);
    }
}
