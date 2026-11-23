//! Terminals: ids → sessions (`resolve`), `list_terminals`, typing and waiting for agent states.

use super::*;

// ---------- terminals ----------

pub(super) struct Target {
    pub(super) id: String,
    pub(super) backend: Arc<Backend>,
    pub(super) session_id: String,
}

/// A terminal by id. An id from before its tab was reconnected (`tab-3#1` while `tab-3#2` runs), or
/// a bare tab (`tab-3`), means the tab's current session.
pub(super) fn resolve(id: &str) -> Result<Target> {
    let (number, session_id) = split_terminal_id(id.trim());
    let backend = backends()
        .into_iter()
        .find(|(n, _)| *n == number)
        .map(|(_, backend)| backend);
    let found = backend.and_then(|backend| {
        let sessions = sessions_of(&backend);
        let session = if sessions.iter().any(|session| session == session_id) {
            Some(session_id.to_owned())
        } else {
            current_session(&sessions, tab_of(session_id)).map(str::to_owned)
        }?;
        Some((backend, session))
    });
    match found {
        Some((backend, session_id)) => Ok(Target {
            id: terminal_id(number, &session_id),
            session_id,
            backend,
        }),
        None => Err(fail(
            "terminal_not_found",
            format!("no open terminal {id:?} (see list_terminals)"),
        )),
    }
}

/// The newest session of a tab (`tab-3` → `tab-3#2` rather than `tab-3#1`).
pub(super) fn current_session<'a>(sessions: &'a [String], tab: &str) -> Option<&'a str> {
    let prefix = format!("{tab}#");
    sessions
        .iter()
        .filter_map(|session| {
            let generation: u64 = session.strip_prefix(&prefix)?.parse().ok()?;
            Some((generation, session.as_str()))
        })
        .max_by_key(|(generation, _)| *generation)
        .map(|(_, session)| session)
}

impl Target {
    pub(super) fn snapshot(&self) -> Result<Snapshot> {
        self.backend
            .agents
            .snapshot(&self.session_id)
            .ok_or_else(|| {
                fail(
                    "terminal_closed",
                    format!("terminal {} was closed", self.id),
                )
            })
    }

    pub(super) fn alive(&self) -> bool {
        self.backend
            .terminals
            .list()
            .iter()
            .any(|info| info.session_id == self.session_id)
    }

    pub(super) async fn write(&self, bytes: &[u8]) -> Result<()> {
        self.backend
            .terminals
            .write(&self.session_id, bytes)
            .await
            .map_err(|error| fail("write_failed", error))
    }

    pub(super) fn text(&self, source: &str, lines: usize) -> Result<Vec<String>> {
        let agents = &self.backend.agents;
        match source {
            "visible" => agents.screen(&self.session_id),
            _ => agents.recent(&self.session_id, lines),
        }
        .ok_or_else(|| {
            fail(
                "terminal_closed",
                format!("terminal {} was closed", self.id),
            )
        })
    }
}

pub(super) fn agent_json(snapshot: &Snapshot) -> Value {
    match snapshot.agent {
        Some((id, name)) => json!({ "id": id, "name": name, "state": snapshot.state }),
        None => Value::Null,
    }
}

/// Tab number of a session id (`tab-12#1` → 12), for listing in opening order.
pub(super) fn tab_number(session_id: &str) -> u64 {
    session_id
        .strip_prefix("tab-")
        .and_then(|rest| rest.split('#').next())
        .and_then(|number| number.parse().ok())
        .unwrap_or(u64::MAX)
}

pub(super) async fn list_terminals(context: &Context) -> Value {
    let mut terminals = Vec::new();
    for (number, backend) in backends() {
        // The UI's tabs: their names, windows and panes (and tabs without a session).
        let mut tabs: Vec<Value> = Vec::new();
        if let Ok(layout) = ui_request(&backend, "layout", json!({}), Duration::from_secs(3)).await
        {
            let layout = globalize(
                layout,
                number,
                &sessions_of(&backend),
                context.caller.as_deref(),
            );
            for window in layout["windows"].as_array().into_iter().flatten() {
                for pane in window["panes"].as_array().into_iter().flatten() {
                    for tab in pane["tabs"].as_array().into_iter().flatten() {
                        tabs.push(json!({
                            "id": tab["terminal"],
                            "tab_name": tab["name"],
                            "window": window["window"],
                            "pane": pane["pane"],
                            "connected": tab.get("connected").is_none(),
                        }));
                    }
                }
            }
        }
        let mut infos = backend.terminals.list();
        infos.sort_by_key(|info| (tab_number(&info.session_id), info.session_id.clone()));
        let mut live = Vec::new();
        for info in &infos {
            let id = terminal_id(number, &info.session_id);
            let snapshot = backend.agents.snapshot(&info.session_id);
            let mut entry = json!({
                "id": id,
                "name": info.name,
                "transport": info.transport,
                "agent": snapshot.as_ref().map(agent_json).unwrap_or(Value::Null),
                "viewed": snapshot.as_ref().is_some_and(|snapshot| snapshot.viewed),
                "self": context.caller.as_deref() == Some(id.as_str()),
                "connected": true,
            });
            if !info.host.is_empty() {
                entry["host"] = json!(info.host);
            }
            if !info.username.is_empty() {
                entry["user"] = json!(info.username);
            }
            if let Some(snapshot) = snapshot.filter(|snapshot| !snapshot.title.is_empty()) {
                entry["title"] = json!(snapshot.title);
            }
            live.push(entry);
        }
        // In the UI's order (windows, panes, tabs as in their tab bars); tabs without a session
        // (ended, or not started yet) as they are; terminals the UI did not report last.
        for tab in tabs {
            match live.iter().position(|entry| entry["id"] == tab["id"]) {
                Some(index) => {
                    let mut entry = live.remove(index);
                    for key in ["tab_name", "window", "pane"] {
                        entry[key] = tab[key].clone();
                    }
                    terminals.push(entry);
                }
                None if tab["connected"] == json!(false) => terminals.push(tab),
                None => {}
            }
        }
        terminals.extend(live);
    }
    json!({ "terminals": terminals, "self": context.caller })
}

/// The local terminal on PTY device (major, minor) — the caller's terminal (caller.rs).
pub async fn terminal_on_device(device: (u64, u64)) -> Option<String> {
    for (number, backend) in backends() {
        for info in backend.terminals.list() {
            if info.transport != "local" {
                continue;
            }
            let Some(path) = backend.terminals.tty_path(&info.session_id).await else {
                continue;
            };
            if crate::mcp::caller::device_of(&path) == Some(device) {
                return Some(terminal_id(number, &info.session_id));
            }
        }
    }
    None
}

// ---------- arguments ----------

pub(super) fn string_arg<'a>(args: &'a Value, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Value::as_str)
}

pub(super) fn required<'a>(args: &'a Value, name: &str) -> Result<&'a str> {
    string_arg(args, name).ok_or_else(|| {
        fail(
            "invalid_arguments",
            format!("`{name}` (string) is required"),
        )
    })
}

pub(super) fn bool_arg(args: &Value, name: &str, default: bool) -> bool {
    args.get(name).and_then(Value::as_bool).unwrap_or(default)
}

pub(super) fn number_arg(args: &Value, name: &str, default: u64, max: u64) -> u64 {
    args.get(name)
        .and_then(Value::as_u64)
        .unwrap_or(default)
        .min(max)
}

pub(super) fn deadline(args: &Value, default_ms: u64) -> Instant {
    Instant::now() + Duration::from_millis(number_arg(args, "timeout_ms", default_ms, MAX_WAIT_MS))
}

pub(super) fn not_self(target: &Target, context: &Context) -> Result<()> {
    if context.caller.as_deref() == Some(target.id.as_str()) {
        return Err(fail(
            "own_terminal",
            "this is the terminal you are running in",
        ));
    }
    Ok(())
}

// ---------- input ----------

/// Text as the program expects a paste: bracketed when it turned bracketed paste on (an embedded
/// end marker could not end the paste early).
pub(super) fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    if bracketed {
        format!("\x1b[200~{}\x1b[201~", text.replace("\x1b[201~", "")).into_bytes()
    } else {
        text.as_bytes().to_vec()
    }
}

pub(super) async fn send_text(target: &Target, text: &str, enter: bool) -> Result<()> {
    let snapshot = target.snapshot()?;
    if !text.is_empty() {
        target
            .write(&paste_bytes(text, snapshot.bracketed_paste))
            .await?;
    }
    if enter {
        if !text.is_empty() {
            tokio::time::sleep(if snapshot.agent.is_some() {
                SUBMIT_DELAY
            } else {
                Duration::from_millis(50)
            })
            .await;
        }
        target.write(b"\r").await?;
    }
    Ok(())
}

// ---------- waiting ----------

pub(super) fn agent_state(target: &Target) -> Result<Option<&'static str>> {
    let snapshot = target.snapshot()?;
    Ok(snapshot.agent.and(snapshot.state))
}

/// Until the agent's state is one of `until`.
pub(super) async fn wait_state(
    target: &Target,
    until: &[&str],
    deadline: Instant,
) -> Result<Snapshot> {
    loop {
        let snapshot = target.snapshot()?;
        let Some(state) = snapshot.agent.and(snapshot.state) else {
            return Err(fail(
                "agent_not_running",
                format!("no agent CLI is running in terminal {} any more", target.id),
            ));
        };
        if until.contains(&state) {
            return Ok(snapshot);
        }
        if Instant::now() >= deadline {
            return Err(fail(
                "timeout",
                format!(
                    "timed out waiting for {}; the agent is {state} (check read_terminal before retrying)",
                    until.join(" / ")
                ),
            ));
        }
        tokio::time::sleep(POLL).await;
    }
}
