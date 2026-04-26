//! Execution backend abstraction.
//!
//! A backend sees already-decrypted `AgentStep` messages from a given session
//! and produces `AgentResponse`s. Both the MockTee and Local backends share
//! the same agent-loop + session machinery; they differ only in their
//! `BackendType` label and metadata.

use agent::{
    AgentLoop, AgentSession, AgentStepInput, AgentStepOutcome, ChatRequest, ChatResult,
};
use anyhow::Result;
use async_trait::async_trait;
use dashmap::DashMap;
use protocol::{AgentResponse, AgentStep, BackendType};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy)]
pub enum TrustLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy)]
pub enum Latency {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy)]
pub struct BackendMetadata {
    pub trust_level: TrustLevel,
    pub latency: Latency,
    pub supports_tools: bool,
}

#[async_trait]
pub trait ExecutionBackend: Send + Sync {
    fn backend_type(&self) -> BackendType;
    fn metadata(&self) -> BackendMetadata;
    async fn step(&self, session_id: &str, input: AgentStep) -> Result<AgentResponse>;
    /// Stateless provider passthrough — used by the Claude Code proxy where
    /// the caller already runs its own agent loop. Bypasses session state,
    /// node-side tools, and the configured system prompt.
    async fn complete(&self, req: ChatRequest) -> Result<ChatResult>;
}

/// Shared agent-loop + session-state machinery. Not public — backend variants
/// wrap this and supply their own `BackendType` label / metadata.
struct AgentRuntime {
    agent: Arc<AgentLoop>,
    sessions: DashMap<String, Arc<Mutex<AgentSession>>>,
}

impl AgentRuntime {
    fn new(agent: AgentLoop) -> Self {
        Self {
            agent: Arc::new(agent),
            sessions: DashMap::new(),
        }
    }

    fn session(&self, id: &str) -> Arc<Mutex<AgentSession>> {
        if let Some(s) = self.sessions.get(id) {
            return s.clone();
        }
        let new_session = Arc::new(Mutex::new(AgentSession::new()));
        self.sessions
            .entry(id.to_string())
            .or_insert(new_session)
            .clone()
    }

    async fn complete(&self, req: ChatRequest) -> Result<ChatResult> {
        self.agent.complete(req).await
    }

    async fn step(&self, session_id: &str, input: AgentStep) -> Result<AgentResponse> {
        let agent_input = match input {
            AgentStep::Prompt { prompt } => AgentStepInput::Prompt(prompt),
            AgentStep::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => AgentStepInput::ToolResult {
                tool_use_id,
                content,
                is_error,
            },
        };

        let session_arc = self.session(session_id);
        let mut session = session_arc.lock().await;
        let outcome = self.agent.step(&mut session, agent_input).await?;

        Ok(match outcome {
            AgentStepOutcome::Final { content, usage } => {
                AgentResponse::Final { content, usage }
            }
            AgentStepOutcome::NeedsClientTool {
                tool_use_id,
                name,
                input,
                usage,
            } => AgentResponse::ToolCall {
                tool_use_id,
                name,
                input,
                usage,
            },
        })
    }
}

/// Simulated enclave — decrypts inside a controlled module and runs the agent
/// loop there. Today "enclave" is a struct boundary; real enforcement would
/// ride a hardware TEE or a sandboxed subprocess.
pub struct MockTeeBackend {
    inner: AgentRuntime,
}

impl MockTeeBackend {
    pub fn new(agent: AgentLoop) -> Self {
        Self {
            inner: AgentRuntime::new(agent),
        }
    }
}

#[async_trait]
impl ExecutionBackend for MockTeeBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::MockTee
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            trust_level: TrustLevel::Medium,
            latency: Latency::Low,
            supports_tools: true,
        }
    }

    async fn step(&self, session_id: &str, input: AgentStep) -> Result<AgentResponse> {
        self.inner.step(session_id, input).await
    }

    async fn complete(&self, req: ChatRequest) -> Result<ChatResult> {
        self.inner.complete(req).await
    }
}

/// Local-LLM backend — a local model (via `llama-server`) serves inference
/// inside the node operator's sandbox. The plaintext never leaves the node.
pub struct LocalLlmBackend {
    inner: AgentRuntime,
}

impl LocalLlmBackend {
    pub fn new(agent: AgentLoop) -> Self {
        Self {
            inner: AgentRuntime::new(agent),
        }
    }
}

#[async_trait]
impl ExecutionBackend for LocalLlmBackend {
    fn backend_type(&self) -> BackendType {
        BackendType::Local
    }

    fn metadata(&self) -> BackendMetadata {
        BackendMetadata {
            trust_level: TrustLevel::High,
            latency: Latency::Medium,
            supports_tools: true,
        }
    }

    async fn step(&self, session_id: &str, input: AgentStep) -> Result<AgentResponse> {
        self.inner.step(session_id, input).await
    }

    async fn complete(&self, req: ChatRequest) -> Result<ChatResult> {
        self.inner.complete(req).await
    }
}
