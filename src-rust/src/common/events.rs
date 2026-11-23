//! Events pushed from the backend to the UI, and the interactive prompt broker.
//!
//! The same JSON shapes are used by both front-ends:
//! - desktop (Tauri): emitted as the `backend-event` window event
//! - server (WebSocket): sent as `{"event": {...}}` frames

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum Event {
    /// Terminal output (UTF-8, never split inside a multi-byte character).
    #[serde(rename = "terminal.data", rename_all = "camelCase")]
    TerminalData { session_id: String, data: String },
    /// Shell process / SSH channel ended.
    #[serde(rename = "terminal.exit", rename_all = "camelCase")]
    TerminalExit {
        session_id: String,
        code: Option<u32>,
        reason: Option<String>,
    },
    /// `connecting` | `online` | `offline` | `error`
    #[serde(rename = "connection.state", rename_all = "camelCase")]
    ConnectionState {
        connection_id: String,
        state: &'static str,
        message: Option<String>,
    },
    /// The backend needs user input: password, key passphrase, keyboard-interactive or host key confirmation.
    #[serde(rename = "auth.prompt", rename_all = "camelCase")]
    AuthPrompt {
        request_id: String,
        connection_id: String,
        /// `password` | `passphrase` | `keyboard` | `hostkey`
        kind: &'static str,
        title: String,
        message: String,
        fields: Vec<PromptField>,
    },
    /// Prompt answered / cancelled elsewhere (e.g. timeout) — UI should close its dialog.
    #[serde(rename = "auth.done", rename_all = "camelCase")]
    AuthDone { request_id: String },
    /// Agent CLI in a terminal (Claude Code, Codex, opencode …) and its state (agents/mod.rs).
    /// `agent: null` = no agent runs in it (any more).
    #[serde(rename = "agent.state", rename_all = "camelCase")]
    AgentState {
        session_id: String,
        /// Manifest id: `claude`, `codex`, `opencode` …
        agent: Option<&'static str>,
        /// Display name: "Claude Code", "Codex", "opencode" …
        name: Option<&'static str>,
        /// `working` | `blocked` | `done` | `idle` | `unknown`
        state: Option<&'static str>,
    },
    /// MCP (mcp/tools/ui.rs): something only the UI knows or can do — its windows, split panes and
    /// tabs (`layout`), and opening / splitting / moving / closing them. `params` use the UI's own
    /// ids (tab, `win-1`, `win-1:p-2`); the UI answers with `mcp.reply`.
    #[serde(rename = "mcp.ui", rename_all = "camelCase")]
    McpUi {
        request_id: String,
        action: &'static str,
        params: serde_json::Value,
    },
    #[serde(rename = "transfer.progress", rename_all = "camelCase")]
    TransferProgress {
        transfer_id: String,
        done: u64,
        total: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptField {
    pub label: String,
    pub secret: bool,
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: Event);
}

/// Routes interactive questions to the UI and waits for the answer.
pub struct Prompts {
    sink: Arc<dyn EventSink>,
    next: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Option<Vec<String>>>>>,
}

const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

impl Prompts {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            sink,
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Ask the user. `None` = cancelled / timed out.
    pub async fn ask(
        &self,
        connection_id: &str,
        kind: &'static str,
        title: impl Into<String>,
        message: impl Into<String>,
        fields: Vec<PromptField>,
    ) -> Option<Vec<String>> {
        let request_id = format!("prompt-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(request_id.clone(), tx);
        self.sink.emit(Event::AuthPrompt {
            request_id: request_id.clone(),
            connection_id: connection_id.to_owned(),
            kind,
            title: title.into(),
            message: message.into(),
            fields,
        });
        let answer = match tokio::time::timeout(PROMPT_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            _ => None,
        };
        if self.pending.lock().unwrap().remove(&request_id).is_some() {
            self.sink.emit(Event::AuthDone { request_id });
        }
        answer
    }

    pub fn respond(&self, request_id: &str, answers: Option<Vec<String>>) -> bool {
        match self.pending.lock().unwrap().remove(request_id) {
            Some(tx) => tx.send(answers).is_ok(),
            None => false,
        }
    }

    /// Cancel every open question (client went away).
    pub fn cancel_all(&self) {
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(None);
        }
    }
}
