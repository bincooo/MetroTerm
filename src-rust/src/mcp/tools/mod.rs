//! The MCP tools for MetroTerm's terminals:
//!
//! | tool              | what it does |
//! |-------------------|--------------|
//! | `list_terminals`  | open terminals, their agent CLI and its state, which one is yours |
//! | `read_terminal`   | visible screen, or the last N lines with scrolled-off output |
//! | `send_text`       | type text (bracketed paste when the program asked for it), optionally Enter |
//! | `send_keys`       | logical keys: `esc`, `ctrl+c`, `up`, `enter`, `y` … |
//! | `wait_for_output` | wait until a substring / regex shows up |
//! | `agent_prompt`    | submit a prompt to the agent CLI and wait until it settles |
//! | `agent_wait`      | wait for an agent state |
//! | `open_terminal`   | open a saved session in a new tab, optionally run a command |
//! | `focus_terminal`  | show a terminal to the user |
//! | `list_windows`    | MetroTerm's windows, their split panes (tree, letters) and the tabs in each pane |
//! | `split_pane`      | split a pane right / down / left / up; the new pane gets a new terminal |
//! | `resize_pane`     | move a pane's border |
//! | `zoom_pane`       | show only one pane of a window (or all again) |
//! | `move_terminal`   | move a tab to another pane / window, or into a new pane |
//! | `rename_terminal` | give a tab another name (as in the Session panel), or its default name back |
//! | `reconnect_terminal`, `disconnect_terminal` | restart / end a tab's session (the tab stays) |
//! | `close_terminal`, `close_pane`, `close_window` | close them (the user confirms unless an agent opened all of it) |
//! | `new_window`, `focus_window`, `rename_window` | windows |
//!
//! Windows, panes and tabs live in the UI: those tools are `mcp.ui` requests answered by the UI
//! (`ui_request`), with the UI's ids translated (`scope`, `globalize`). Ids: window `win-1`, pane
//! `win-1:p-2` (`2/…` from the second browser client on, like terminals).
//!
//! Without "allow input" (settings) only the reading / waiting / showing tools exist.

use super::{backends, hub, keys, new_id, split_terminal_id, terminal_id, Context};
use crate::{agents::Snapshot, backend::Backend, common::events::Event};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

/// A failed call (`isError: true`, the code and message as structured content).
#[derive(Debug, Serialize)]
pub struct ToolError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub enum CallError {
    UnknownTool,
    Failed(ToolError),
}

/// A result: structured content, and the text shown to the model (default: the JSON).
pub struct Output {
    pub value: Value,
    pub text: Option<String>,
}

pub(super) fn fail(code: &'static str, message: impl Into<String>) -> CallError {
    CallError::Failed(ToolError {
        code,
        message: message.into(),
    })
}

pub(super) type Result<T> = std::result::Result<T, CallError>;

pub(super) const POLL: Duration = Duration::from_millis(100);
/// Text first, Enter a moment later (TUIs that treat a fast
/// paste + Enter as part of the paste).
pub(super) const SUBMIT_DELAY: Duration = Duration::from_millis(300);
/// After `agent_prompt`, how long to wait for the agent to show any activity.
pub(super) const PROMPT_ACTIVITY: Duration = Duration::from_secs(5);
/// How long the UI may take for an `mcp.ui` request.
pub(super) const UI_WAIT: Duration = Duration::from_secs(10);
/// Closing something an agent did not open waits for the user's answer (the UI gives up after 120 s).
pub(super) const CONFIRM_WAIT: Duration = Duration::from_secs(130);
pub(super) const MAX_WAIT_MS: u64 = 60 * 60 * 1000;
pub(super) const STATES: &[&str] = &["idle", "working", "blocked", "done", "unknown"];
pub(super) const SETTLED: &[&str] = &["idle", "done", "blocked"];

/// `tools/list`: names, descriptions, input schemas.
mod definitions;
/// Terminal ids, reading, typing, waiting for output / agent states, opening sessions.
mod terminals;
#[cfg(test)]
mod tests;
/// Windows, split panes and tabs: `mcp.ui` requests to the UI and id mapping.
mod ui;

pub use definitions::definitions;
pub use terminals::terminal_on_device;
use terminals::*;
use ui::*;

// ---------- calls ----------

pub async fn call(
    name: &str,
    args: Value,
    context: &Context,
    allow_input: bool,
) -> std::result::Result<Output, CallError> {
    let input_tool = matches!(
        name,
        "agent_prompt"
            | "send_text"
            | "send_keys"
            | "open_terminal"
            | "split_pane"
            | "resize_pane"
            | "zoom_pane"
            | "move_terminal"
            | "close_terminal"
            | "rename_terminal"
            | "reconnect_terminal"
            | "disconnect_terminal"
            | "close_pane"
            | "new_window"
            | "rename_window"
            | "close_window"
    );
    if input_tool && !allow_input {
        return Err(fail(
            "input_disabled",
            "typing into terminals and arranging them is turned off in MetroTerm's settings \
             (MCP SERVER → Allow agents to type, open and arrange tabs)",
        ));
    }
    let value = match name {
        "list_terminals" => list_terminals(context).await,
        "read_terminal" => {
            let target = resolve(required(&args, "terminal")?)?;
            let source = match string_arg(&args, "source").unwrap_or("recent") {
                "visible" => "visible",
                "recent" => "recent",
                other => {
                    return Err(fail(
                        "invalid_arguments",
                        format!("unknown source {other:?}"),
                    ))
                }
            };
            let lines = number_arg(&args, "lines", 120, 2000).max(1) as usize;
            let text = target.text(source, lines)?.join("\n");
            let snapshot = target.snapshot()?;
            return Ok(Output {
                text: Some(text.clone()),
                value: json!({
                    "terminal": target.id,
                    "source": source,
                    "agent": agent_json(&snapshot),
                    "text": text,
                }),
            });
        }
        "wait_for_output" => {
            let target = resolve(required(&args, "terminal")?)?;
            let pattern = match (string_arg(&args, "match"), string_arg(&args, "regex")) {
                (Some(literal), None) if !literal.is_empty() => {
                    regex::Regex::new(&regex::escape(literal)).unwrap()
                }
                (None, Some(pattern)) => regex::Regex::new(pattern)
                    .map_err(|error| fail("invalid_arguments", format!("regex: {error}")))?,
                _ => {
                    return Err(fail(
                        "invalid_arguments",
                        "give exactly one of `match` or `regex`",
                    ))
                }
            };
            let source = if string_arg(&args, "source") == Some("visible") {
                "visible"
            } else {
                "recent"
            };
            let lines = number_arg(&args, "lines", 200, 2000).max(1) as usize;
            let deadline = deadline(&args, 60_000);
            let started = Instant::now();
            loop {
                if !target.alive() {
                    return Err(fail(
                        "terminal_closed",
                        format!("terminal {} was closed", target.id),
                    ));
                }
                let rows = target.text(source, lines)?;
                // Soft-wrapped lines are separate rows: also try the whole text.
                let found = rows
                    .iter()
                    .find(|row| pattern.is_match(row))
                    .cloned()
                    .or_else(|| {
                        let joined = rows.join("\n");
                        pattern.find(&joined).map(|found| found.as_str().to_owned())
                    });
                if let Some(line) = found {
                    break json!({
                        "terminal": target.id,
                        "matched": line,
                        "waited_ms": started.elapsed().as_millis() as u64,
                    });
                }
                if Instant::now() >= deadline {
                    return Err(fail("timeout", "timed out waiting for the output"));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        "agent_wait" => {
            let target = resolve(required(&args, "terminal")?)?;
            let until: Vec<&str> = match args.get("until").and_then(Value::as_array) {
                Some(states) if !states.is_empty() => {
                    let mut out = Vec::new();
                    for state in states {
                        let state = state.as_str().unwrap_or_default();
                        match STATES.iter().find(|known| **known == state) {
                            Some(known) => out.push(*known),
                            None => {
                                return Err(fail(
                                    "invalid_arguments",
                                    format!("unknown state {state:?}"),
                                ))
                            }
                        }
                    }
                    out
                }
                _ => SETTLED.to_vec(),
            };
            let started = Instant::now();
            let snapshot = wait_state(&target, &until, deadline(&args, 600_000)).await?;
            json!({
                "terminal": target.id,
                "agent": agent_json(&snapshot),
                "waited_ms": started.elapsed().as_millis() as u64,
            })
        }
        "focus_terminal" => {
            required(&args, "terminal")?;
            ui_action("focus", &args, context, UI_WAIT).await?
        }
        "list_windows" => list_windows(context).await?,
        "focus_window" => {
            required(&args, "window")?;
            ui_action("focus_window", &args, context, UI_WAIT).await?
        }
        "split_pane" => create("split", &args, context).await?,
        "new_window" => create("new_window", &args, context).await?,
        "resize_pane" => {
            required(&args, "direction")?;
            ui_action("resize", &args, context, UI_WAIT).await?
        }
        "zoom_pane" => ui_action("zoom", &args, context, UI_WAIT).await?,
        "move_terminal" => {
            required(&args, "terminal")?;
            ui_action("move", &args, context, UI_WAIT).await?
        }
        "rename_window" => {
            required(&args, "window")?;
            required(&args, "name")?;
            ui_action("rename_window", &args, context, UI_WAIT).await?
        }
        "close_terminal" => {
            if string_arg(&args, "terminal").is_none()
                && !args.get("terminals").is_some_and(Value::is_array)
            {
                return Err(fail("invalid_arguments", "give terminal or terminals"));
            }
            ui_action("close", &args, context, CONFIRM_WAIT).await?
        }
        "rename_terminal" => {
            required(&args, "terminal")?;
            ui_action("rename", &args, context, UI_WAIT).await?
        }
        "disconnect_terminal" => {
            if resolve(required(&args, "terminal")?).is_err() {
                return Err(fail("not_connected", "the terminal is not connected"));
            }
            ui_action("disconnect", &args, context, CONFIRM_WAIT).await?
        }
        "reconnect_terminal" => reconnect(&args, context).await?,
        "close_pane" => ui_action("close_pane", &args, context, CONFIRM_WAIT).await?,
        "close_window" => {
            required(&args, "window")?;
            ui_action("close_window", &args, context, CONFIRM_WAIT).await?
        }
        "send_text" => {
            let target = resolve(required(&args, "terminal")?)?;
            not_self(&target, context)?;
            let text = required(&args, "text")?;
            let enter = bool_arg(&args, "enter", false);
            send_text(&target, text, enter).await?;
            json!({ "terminal": target.id, "sent": true })
        }
        "send_keys" => {
            let target = resolve(required(&args, "terminal")?)?;
            not_self(&target, context)?;
            let names: Vec<&str> = args
                .get("keys")
                .and_then(Value::as_array)
                .map(|keys| keys.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if names.is_empty() || names.len() > 64 {
                return Err(fail("invalid_arguments", "`keys`: 1 to 64 key names"));
            }
            let application_cursor = target.snapshot()?.application_cursor;
            let encoded = names
                .iter()
                .map(|name| keys::encode(name, application_cursor))
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|error| fail("invalid_key", error))?;
            for (index, bytes) in encoded.iter().enumerate() {
                if index > 0 {
                    // Apart, so `esc` then `b` is not read as alt+b.
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                target.write(bytes).await?;
            }
            json!({ "terminal": target.id, "sent": names.len() })
        }
        "agent_prompt" => {
            let target = resolve(required(&args, "terminal")?)?;
            not_self(&target, context)?;
            let text = required(&args, "text")?;
            if text.trim().is_empty() {
                return Err(fail("invalid_arguments", "`text` is empty"));
            }
            let snapshot = target.snapshot()?;
            let Some((agent_id, _)) = snapshot.agent else {
                return Err(fail(
                    "agent_not_found",
                    format!(
                        "no agent CLI is recognised in terminal {} (use send_text for a shell)",
                        target.id
                    ),
                ));
            };
            let before = snapshot.state.unwrap_or("unknown");
            if before == "blocked" {
                return Err(fail(
                    "agent_blocked",
                    "the agent is waiting at an approval or question: read_terminal and ask the user before answering it",
                ));
            }
            let deadline = deadline(&args, 600_000);
            let started = Instant::now();
            send_text(&target, text, true).await?;
            if !bool_arg(&args, "wait", true) {
                json!({
                    "terminal": target.id,
                    "agent": agent_json(&target.snapshot()?),
                    "submitted": true,
                })
            } else {
                // A prompt from a non-working state must show activity (else agent_prompt_stalled).
                if before != "working" {
                    let activity_until = (Instant::now() + PROMPT_ACTIVITY).min(deadline);
                    loop {
                        match agent_state(&target)? {
                            None => {
                                return Err(fail(
                                    "agent_not_running",
                                    "the agent quit after the prompt",
                                ))
                            }
                            Some("working" | "blocked") => break,
                            Some(state) if Instant::now() >= activity_until => {
                                return Err(fail(
                                    "agent_prompt_stalled",
                                    format!(
                                        "the prompt was typed, but {agent_id} showed no working or blocked state within {} ms; \
                                         it is {state} — check read_terminal, do not blindly send it again",
                                        PROMPT_ACTIVITY.as_millis()
                                    ),
                                ));
                            }
                            Some(_) => tokio::time::sleep(POLL).await,
                        }
                    }
                }
                let snapshot = wait_state(&target, SETTLED, deadline).await?;
                json!({
                    "terminal": target.id,
                    "agent": agent_json(&snapshot),
                    "submitted": true,
                    "waited_ms": started.elapsed().as_millis() as u64,
                })
            }
        }
        "open_terminal" => create("open", &args, context).await?,
        _ => return Err(CallError::UnknownTool),
    };
    Ok(Output { value, text: None })
}
