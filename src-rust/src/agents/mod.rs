//! Agent CLI status of each terminal: which coding agent runs in it (Claude Code, Codex, opencode …)
//! and whether it is working, waiting for an answer, or idle (detection manifests in `manifests/`).
//!
//! - Every terminal's output also goes through a screen model (`vt100`, no scrollback): the
//!   detection rules look at the visible rows as plain text, plus the last OSC 0/2 window title and OSC 9 payload (progress) the program sent.
//! - The agent: local terminals ask the PTY for its foreground process group (process.rs); where
//!   that is not possible (SSH, Telnet, serial, Windows, `ssh host` inside a local shell) the
//!   screen signatures of `identify.toml` name it.
//! - The state: the agent's manifest (manifest.rs), evaluated when the screen has changed, at
//!   most every 100 ms. Working → idle without a visible idle prompt waits for three
//!   confirmations (an agent between two steps shows no spinner for a moment), and a turn that
//!   finished while the user was looking elsewhere is `done` until its terminal is viewed
//!   (`agent.focus`).
//! - Changes are pushed as `agent.state` events; the UI only shows them (Session panel).
//!
//! Overrides: `~/.metroterm/agents/<agent>.toml` replaces a bundled manifest (e.g. `claude.toml`),
//! `~/.metroterm/agents/identify.toml` the screen signatures — read once at startup.

/// Bundled and user manifests, screen signatures (`identify.toml`).
mod catalog;
/// Manifest format and evaluation.
mod manifest;
/// Foreground process of a local PTY.
mod process;
#[cfg(test)]
mod tests;
/// One terminal: screen model, OSC title / progress, detection and state machine.
mod watch;

use crate::common::events::{Event, EventSink};
use catalog::*;
use manifest::{Detection, Gate, GateFile, Input, Manifest, Region, State};
use process::Foreground;
pub use process::Probe;
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
use watch::*;

/// A known agent CLI: manifest id, display name, bundled manifest, process names.
pub(crate) struct AgentInfo {
    pub id: &'static str,
    pub name: &'static str,
    file: &'static str,
    manifest: &'static str,
    /// Executable names besides `id` (aliases).
    pub processes: &'static [&'static str],
}

macro_rules! agent {
    ($id:literal, $name:literal, $file:literal, [$($process:literal),*]) => {
        AgentInfo {
            id: $id,
            name: $name,
            file: $file,
            manifest: include_str!(concat!("manifests/", $file)),
            processes: &[$($process),*],
        }
    };
}

pub(crate) static AGENTS: &[AgentInfo] = &[
    agent!("claude", "Claude Code", "claude.toml", ["claude-code"]),
    agent!("codex", "Codex", "codex.toml", []),
    agent!(
        "opencode",
        "opencode",
        "opencode.toml",
        ["opencode2", "open-code", "opencode-ai"]
    ),
    agent!("gemini", "Gemini CLI", "gemini.toml", ["gemini-cli"]),
    agent!(
        "copilot",
        "Copilot CLI",
        "github-copilot.toml",
        ["github-copilot", "ghcs"]
    ),
    agent!("cursor", "Cursor Agent", "cursor.toml", ["cursor-agent"]),
    agent!("qwen", "Qwen Code", "qwen.toml", ["qwen-code"]),
    agent!("kimi", "Kimi Code", "kimi.toml", ["kimi-code"]),
    agent!("amp", "Amp", "amp.toml", ["amp-local"]),
    agent!(
        "agy",
        "Antigravity",
        "antigravity.toml",
        ["antigravity", "antigravity-cli"]
    ),
    agent!("cline", "Cline", "cline.toml", [".cline"]),
    agent!("devin", "Devin", "devin.toml", ["devin-cli"]),
    agent!("droid", "Droid", "droid.toml", []),
    agent!("grok", "Grok", "grok.toml", ["grok-build"]),
    agent!("hermes", "Hermes", "hermes.toml", ["hermes-agent"]),
    agent!("kilo", "Kilo Code", "kilo.toml", ["kilo-code"]),
    agent!("kiro", "Kiro", "kiro.toml", ["kiro-cli"]),
    agent!("letta", "Letta Code", "letta.toml", ["letta-code"]),
    agent!("maki", "Maki", "maki.toml", []),
    agent!("muse", "Muse", "muse.toml", ["muse-code", "muse-cli"]),
    agent!("pi", "Pi", "pi.toml", []),
    agent!(
        "qodercli",
        "Qoder CLI",
        "qodercli.toml",
        ["qoderclicn", "qoder", "qodercn"]
    ),
];

const IDENTIFY: &str = include_str!("identify.toml");

/// How often the screens are looked at.
const TICK: Duration = Duration::from_millis(100);
/// How often a local terminal's foreground process is looked up.
const PROBE_EVERY: Duration = Duration::from_millis(500);
/// working → plain idle: confirmations needed, and the longest wait for them.
const IDLE_CONFIRMATIONS: u8 = 3;
const IDLE_HOLD_MAX: Duration = Duration::from_millis(700);
/// A screen-recognised agent is gone after this long without its signature or an on-screen rule.
const SCREEN_EVIDENCE_GRACE: Duration = Duration::from_secs(3);
/// Longest retained OSC title / progress payload (untrusted program output).
const OSC_MAX_CHARS: usize = 256;
/// Raw output kept per terminal for reads beyond the visible screen (MCP `read_terminal`).
const RECENT_BYTES: usize = 256 * 1024;

// ---------- all terminals ----------

pub struct Agents {
    sink: Arc<dyn EventSink>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Watch>>>>,
    /// The terminal the user is looking at (`agent.focus`); None = the window is in the background.
    viewed: Mutex<Option<String>>,
}

fn event(session_id: &str, shown: (Option<usize>, Shown)) -> Event {
    let agent = shown.0.map(|index| &AGENTS[index]);
    Event::AgentState {
        session_id: session_id.to_owned(),
        agent: agent.map(|agent| agent.id),
        name: agent.map(|agent| agent.name),
        state: agent.map(|_| shown.1.label()),
    }
}

impl Agents {
    /// Starts the watcher thread; it ends when the `Agents` is dropped.
    pub fn new(sink: Arc<dyn EventSink>) -> Arc<Self> {
        let agents = Arc::new(Self {
            sink,
            sessions: Mutex::new(HashMap::new()),
            viewed: Mutex::new(None),
        });
        let weak: Weak<Self> = Arc::downgrade(&agents);
        let started = std::thread::Builder::new()
            .name("agent-status".into())
            .spawn(move || loop {
                std::thread::sleep(TICK);
                match weak.upgrade() {
                    Some(agents) => agents.tick(),
                    None => break,
                }
            });
        if let Err(error) = started {
            log::warn!("Agent status: cannot start: {error}");
        }
        agents
    }

    fn watch(&self, session_id: &str) -> Option<Arc<Mutex<Watch>>> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    /// A terminal is being started (before its first output).
    pub fn open(&self, session_id: &str, cols: u16, rows: u16) {
        self.sessions.lock().unwrap().insert(
            session_id.to_owned(),
            Arc::new(Mutex::new(Watch::new(cols, rows))),
        );
    }

    /// Local terminal: where to look up its foreground process.
    pub fn set_probe(&self, session_id: &str, probe: Probe) {
        if let Some(watch) = self.watch(session_id) {
            watch.lock().unwrap().probe = Some(probe);
        }
    }

    pub fn output(&self, session_id: &str, data: &str) {
        if let Some(watch) = self.watch(session_id) {
            watch.lock().unwrap().feed(data.as_bytes());
        }
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(watch) = self.watch(session_id) {
            let mut watch = watch.lock().unwrap();
            watch.parser.screen_mut().set_size(rows.max(1), cols.max(2));
            watch.dirty = true;
        }
    }

    /// The terminal ended or was closed: its agent (if any) is gone.
    pub fn close(&self, session_id: &str) {
        let removed = self.sessions.lock().unwrap().remove(session_id);
        if let Some(watch) = removed {
            if watch.lock().unwrap().sent.is_some() {
                self.sink.emit(event(session_id, (None, Shown::Idle)));
            }
        }
    }

    /// The UI shows this terminal (None: none / the window is in the background). A `done` agent
    /// in it becomes `idle`.
    pub fn focus(&self, session_id: Option<String>) {
        *self.viewed.lock().unwrap() = session_id.clone();
        let Some(session_id) = session_id else { return };
        let Some(watch) = self.watch(&session_id) else {
            return;
        };
        let shown = {
            let mut watch = watch.lock().unwrap();
            if !watch.done {
                return;
            }
            watch.done = false;
            let shown = watch.shown();
            watch.sent = shown;
            shown
        };
        if let Some((agent, state)) = shown {
            self.sink.emit(event(&session_id, (Some(agent), state)));
        }
    }

    fn tick(&self) {
        let catalog = catalog();
        let viewed = self.viewed.lock().unwrap().clone();
        let watches: Vec<(String, Arc<Mutex<Watch>>)> = self
            .sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(id, watch)| (id.clone(), watch.clone()))
            .collect();
        let now = Instant::now();
        for (session_id, watch) in watches {
            let is_viewed = viewed.as_deref() == Some(session_id.as_str());
            let change = watch.lock().unwrap().tick(now, is_viewed, catalog);
            if let Some(shown) = change {
                // Closed meanwhile: `close` has already cleared it.
                if self.watch(&session_id).is_some() {
                    self.sink.emit(event(&session_id, shown));
                }
            }
        }
    }
}

/// One terminal as the MCP server sees it (mcp/).
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// Manifest id and display name of the agent running in it.
    pub agent: Option<(&'static str, &'static str)>,
    /// `working` | `blocked` | `done` | `idle` | `unknown` (with an agent).
    pub state: Option<&'static str>,
    /// Last OSC 0/2 window title.
    pub title: String,
    pub cols: u16,
    pub rows: u16,
    pub bracketed_paste: bool,
    pub application_cursor: bool,
    pub alternate_screen: bool,
    /// The terminal the user is looking at.
    pub viewed: bool,
}

/// Text rows without trailing blanks, without blank rows at the end.
fn tidy(rows: impl Iterator<Item = String>) -> Vec<String> {
    let mut rows: Vec<String> = rows.map(|row| row.trim_end().to_owned()).collect();
    while rows.last().is_some_and(|row| row.is_empty()) {
        rows.pop();
    }
    rows
}

impl Agents {
    pub fn snapshot(&self, session_id: &str) -> Option<Snapshot> {
        let watch = self.watch(session_id)?;
        let viewed = self.viewed.lock().unwrap().as_deref() == Some(session_id);
        let watch = watch.lock().unwrap();
        let screen = watch.parser.screen();
        let (rows, cols) = screen.size();
        let shown = watch.shown();
        Some(Snapshot {
            agent: shown.map(|(agent, _)| (AGENTS[agent].id, AGENTS[agent].name)),
            state: shown.map(|(_, state)| state.label()),
            title: watch.parser.callbacks().title.clone(),
            cols,
            rows,
            bracketed_paste: screen.bracketed_paste(),
            application_cursor: screen.application_cursor(),
            alternate_screen: screen.alternate_screen(),
            viewed,
        })
    }

    /// The visible screen as text rows.
    pub fn screen(&self, session_id: &str) -> Option<Vec<String>> {
        let watch = self.watch(session_id)?;
        let watch = watch.lock().unwrap();
        let screen = watch.parser.screen();
        let (_, cols) = screen.size();
        Some(tidy(screen.rows(0, cols)))
    }

    /// The last `lines` rows of output, scrolled-off rows included: the kept raw output replayed
    /// on a screen of the terminal's size with scrollback. Full-screen programs (the alternate
    /// screen) have no scrollback: their screen is returned.
    pub fn recent(&self, session_id: &str, lines: usize) -> Option<Vec<String>> {
        let (bytes, rows, cols) = {
            let watch = self.watch(session_id)?;
            let watch = watch.lock().unwrap();
            let (rows, cols) = watch.parser.screen().size();
            let bytes: Vec<u8> = watch.recent.iter().copied().collect();
            (bytes, rows, cols)
        };
        let mut parser = vt100::Parser::new(rows, cols, lines.max(rows as usize));
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| parser.process(&bytes)))
            .is_err()
        {
            return self.screen(session_id);
        }
        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        let history = screen.scrollback();
        let mut out = Vec::with_capacity(history + rows as usize);
        // Offset n shows history row (history - n) at the top: take that one row each time.
        for offset in (1..=history).rev() {
            screen.set_scrollback(offset);
            out.extend(screen.rows(0, cols).next());
        }
        screen.set_scrollback(0);
        out.extend(screen.rows(0, cols));
        let mut out = tidy(out.into_iter());
        if out.len() > lines {
            out.drain(..out.len() - lines);
        }
        Some(out)
    }
}

/// Event sink in front of the UI's: feeds terminal output to the screen models on its way.
pub struct Tap {
    pub inner: Arc<dyn EventSink>,
    pub agents: Arc<Agents>,
}

impl EventSink for Tap {
    fn emit(&self, event: Event) {
        let exited = match &event {
            Event::TerminalData { session_id, data } => {
                self.agents.output(session_id, data);
                None
            }
            Event::TerminalExit { session_id, .. } => Some(session_id.clone()),
            _ => None,
        };
        self.inner.emit(event);
        if let Some(session_id) = exited {
            self.agents.close(&session_id);
        }
    }
}
