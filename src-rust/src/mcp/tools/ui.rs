//! Windows, panes and tabs: `mcp.ui` requests answered by the UI, with its ids translated.

use super::*;

// ---------- windows, panes and tabs (the UI's) ----------

/// Which UI (backend) a call is about, and its arguments in that UI's own ids.
pub(super) struct Scope {
    pub(super) number: u32,
    pub(super) backend: Arc<Backend>,
    pub(super) params: serde_json::Map<String, Value>,
}

/// The tab of a terminal session (`tab-3#2` → `tab-3`).
pub(super) fn tab_of(session_id: &str) -> &str {
    session_id.split('#').next().unwrap_or(session_id)
}

/// The UI and tab of a terminal id (also of a tab whose session has ended: the UI checks the tab).
pub(super) fn tab_ref(id: &str) -> (u32, String) {
    let (number, session_id) = split_terminal_id(id.trim());
    (number, tab_of(session_id).to_owned())
}

/// The UI of the caller's terminal, else the newest one (the desktop app has just one).
pub(super) fn default_ui(context: &Context) -> Result<(u32, Arc<Backend>)> {
    let all = backends();
    let caller = context
        .caller
        .as_deref()
        .map(|caller| split_terminal_id(caller).0);
    all.iter()
        .find(|(n, _)| Some(*n) == caller)
        .or(all.last())
        .cloned()
        .ok_or_else(|| fail("no_window", "MetroTerm has no window open"))
}

pub(super) fn same_ui(number: &mut Option<u32>, n: u32) -> Result<()> {
    match *number {
        Some(m) if m != n => Err(fail(
            "invalid_arguments",
            "the ids belong to different MetroTerm windows (browser clients)",
        )),
        _ => {
            *number = Some(n);
            Ok(())
        }
    }
}

/// The arguments for the UI: `terminal` (an MCP terminal id) becomes its tab, `window` / `pane`
/// lose the UI prefix (`2/…`) — all of them must name the same UI — and `selfTab` is the caller's
/// tab there (the UI does not close it).
pub(super) fn scope(args: &Value, context: &Context) -> Result<Scope> {
    let mut params = args.as_object().cloned().unwrap_or_default();
    for key in ["timeout_ms", "command"] {
        params.remove(key);
    }
    let mut number = None;
    for key in ["terminal", "before"] {
        if let Some(id) = string_arg(args, key) {
            let (n, tab) = tab_ref(id);
            same_ui(&mut number, n)?;
            params.insert(key.into(), json!(tab));
        }
    }
    if let Some(list) = args.get("terminals").and_then(Value::as_array) {
        let mut tabs = Vec::new();
        for id in list {
            let id = id
                .as_str()
                .ok_or_else(|| fail("invalid_arguments", "terminals must be terminal ids"))?;
            let (n, tab) = tab_ref(id);
            same_ui(&mut number, n)?;
            tabs.push(tab);
        }
        params.insert("terminals".into(), json!(tabs));
    }
    for key in ["window", "pane"] {
        if let Some(id) = string_arg(args, key) {
            let (n, local) = split_terminal_id(id.trim());
            same_ui(&mut number, n)?;
            params.insert(key.into(), json!(local));
        }
    }
    let (number, backend) = match number {
        Some(n) => backends()
            .into_iter()
            .find(|(m, _)| *m == n)
            .ok_or_else(|| {
                let about_terminal = ["terminal", "before", "terminals"]
                    .iter()
                    .any(|key| args.get(*key).is_some());
                fail(
                    if about_terminal {
                        "terminal_not_found"
                    } else {
                        "window_not_found"
                    },
                    "no such MetroTerm terminal / window: take the ids from list_terminals / list_windows",
                )
            })?,
        None => default_ui(context)?,
    };
    if let Some(caller) = context.caller.as_deref() {
        let (n, session) = split_terminal_id(caller);
        if n == number {
            params.insert("selfTab".into(), json!(tab_of(session)));
        }
    }
    Ok(Scope {
        number,
        backend,
        params,
    })
}

/// The UI's error codes (anything else: `ui_failed`).
pub(super) fn ui_code(code: &str) -> &'static str {
    match code {
        "window_not_found" => "window_not_found",
        "pane_not_found" => "pane_not_found",
        "terminal_not_found" => "terminal_not_found",
        "session_not_found" => "session_not_found",
        "own_terminal" => "own_terminal",
        "cancelled" => "cancelled",
        "busy" => "busy",
        "last_window" => "last_window",
        "no_split" => "no_split",
        "invalid_arguments" => "invalid_arguments",
        "not_connected" => "not_connected",
        _ => "ui_failed",
    }
}

/// Ask the UI (`mcp.ui` → `mcp.reply`).
pub(super) async fn ui_request(
    backend: &Arc<Backend>,
    action: &'static str,
    params: Value,
    wait: Duration,
) -> Result<Value> {
    let request_id = new_id();
    let (tx, rx) = oneshot::channel();
    hub().ui.lock().unwrap().insert(request_id.clone(), tx);
    backend.shared.sink.emit(Event::McpUi {
        request_id: request_id.clone(),
        action,
        params,
    });
    let reply = tokio::time::timeout(wait, rx).await;
    hub().ui.lock().unwrap().remove(&request_id);
    match reply {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err((code, message)))) => Err(fail(ui_code(&code), message)),
        _ => Err(fail(
            "no_answer",
            "the MetroTerm window did not answer (is it open?)",
        )),
    }
}

/// The UI's answer in MCP ids: a tab (`terminal`) becomes its terminal id (null while it has not
/// started), `window` / `pane` / `focused_pane` get the UI prefix; `self: true` marks the caller's.
pub(super) fn globalize(
    value: Value,
    number: u32,
    sessions: &[String],
    caller: Option<&str>,
) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| globalize(item, number, sessions, caller))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            let mut mine = false;
            let mut disconnected = false;
            for (key, item) in map {
                let item = match (key.as_str(), item) {
                    ("terminal" | "before", Value::String(tab)) => {
                        match current_session(sessions, &tab) {
                            Some(session) => {
                                let id = terminal_id(number, session);
                                mine |= key == "terminal" && caller == Some(id.as_str());
                                json!(id)
                            }
                            None => {
                                // No session (ended, or not started yet): the tab itself.
                                if key == "terminal" {
                                    disconnected = true;
                                }
                                json!(terminal_id(number, &tab))
                            }
                        }
                    }
                    ("window" | "pane" | "focused_pane", Value::String(id)) => {
                        json!(terminal_id(number, &id))
                    }
                    (_, item) => globalize(item, number, sessions, caller),
                };
                out.insert(key, item);
            }
            if mine {
                out.insert("self".into(), json!(true));
            }
            if disconnected {
                out.insert("connected".into(), json!(false));
            }
            Value::Object(out)
        }
        other => other,
    }
}

pub(super) fn sessions_of(backend: &Backend) -> Vec<String> {
    backend
        .terminals
        .list()
        .into_iter()
        .map(|info| info.session_id)
        .collect()
}

/// A UI action that changes no terminal: its answer, in MCP ids.
pub(super) async fn ui_action(
    action: &'static str,
    args: &Value,
    context: &Context,
    wait: Duration,
) -> Result<Value> {
    let scope = scope(args, context)?;
    let reply = ui_request(&scope.backend, action, Value::Object(scope.params), wait).await?;
    Ok(globalize(
        reply,
        scope.number,
        &sessions_of(&scope.backend),
        context.caller.as_deref(),
    ))
}

/// Every UI's windows (the desktop app has one UI; each browser client is one).
pub(super) async fn list_windows(context: &Context) -> Result<Value> {
    let all = backends();
    let mut windows = Vec::new();
    let mut failed = None;
    for (number, backend) in &all {
        match ui_request(backend, "layout", json!({}), Duration::from_secs(5)).await {
            Ok(reply) => {
                let reply = globalize(
                    reply,
                    *number,
                    &sessions_of(backend),
                    context.caller.as_deref(),
                );
                if let Some(list) = reply.get("windows").and_then(Value::as_array) {
                    windows.extend(list.iter().cloned());
                }
            }
            Err(error) => failed = Some(error),
        }
    }
    match failed {
        Some(error) if windows.is_empty() => Err(error),
        _ if all.is_empty() => Err(fail("no_window", "MetroTerm has no window open")),
        _ => Ok(json!({ "windows": windows })),
    }
}

/// A UI action that adds a terminal (open / split / new_window): the UI's answer, then the
/// terminal once it has started (and `command` typed into it).
pub(super) async fn create(action: &'static str, args: &Value, context: &Context) -> Result<Value> {
    let deadline = deadline(args, 60_000);
    let scope = scope(args, context)?;
    let reply = ui_request(&scope.backend, action, Value::Object(scope.params), UI_WAIT).await?;
    let Some(tab_id) = reply
        .get("terminal")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Err(fail("ui_failed", "the UI did not say which tab it opened"));
    };
    let started = started(
        scope.number,
        &scope.backend,
        &tab_id,
        &[],
        deadline,
        string_arg(args, "command"),
    )
    .await?;
    let mut out = globalize(
        reply,
        scope.number,
        &sessions_of(&scope.backend),
        context.caller.as_deref(),
    );
    if let (Some(out), Value::Object(started)) = (out.as_object_mut(), started) {
        out.extend(started);
    }
    Ok(out)
}

/// reconnect_terminal: the UI restarts the tab's session; then wait for the new one.
pub(super) async fn reconnect(args: &Value, context: &Context) -> Result<Value> {
    let deadline = deadline(args, 60_000);
    let scope = scope(args, context)?;
    let tab = scope
        .params
        .get("terminal")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let prefix = format!("{tab}#");
    let old: Vec<String> = sessions_of(&scope.backend)
        .into_iter()
        .filter(|session| session.starts_with(&prefix))
        .collect();
    ui_request(
        &scope.backend,
        "reconnect",
        Value::Object(scope.params.clone()),
        UI_WAIT,
    )
    .await?;
    let mut out = started(
        scope.number,
        &scope.backend,
        &tab,
        &old,
        deadline,
        string_arg(args, "command"),
    )
    .await?;
    out["reconnected"] = json!(true);
    Ok(out)
}

/// Wait for the terminal of a new tab and its shell; then type `command` + Enter.
pub(super) async fn started(
    number: u32,
    backend: &Arc<Backend>,
    tab_id: &str,
    old: &[String],
    deadline: Instant,
    command: Option<&str>,
) -> Result<Value> {
    // Its terminal starts once the tab is laid out (an SSH login may ask the user first).
    let prefix = format!("{tab_id}#");
    let info =
        loop {
            if let Some(info) = backend.terminals.list().into_iter().find(|info| {
                info.session_id.starts_with(&prefix) && !old.contains(&info.session_id)
            }) {
                break info;
            }
            if Instant::now() >= deadline {
                return Err(fail(
                    "timeout",
                    format!("tab {tab_id} was opened, but its terminal did not start in time"),
                ));
            }
            tokio::time::sleep(POLL).await;
        };
    let target = Target {
        id: terminal_id(number, &info.session_id),
        backend: backend.clone(),
        session_id: info.session_id.clone(),
    };
    // Ready: the shell has printed something and then been quiet for a moment (at most 10 s).
    let ready_by = (Instant::now() + Duration::from_secs(10)).min(deadline);
    let mut last = String::new();
    let mut quiet_since = Instant::now();
    loop {
        let text = target.text("visible", 0)?.join("\n");
        if text != last {
            last = text;
            quiet_since = Instant::now();
        } else if !last.trim().is_empty() && quiet_since.elapsed() >= Duration::from_millis(600) {
            break;
        }
        if Instant::now() >= ready_by {
            break;
        }
        tokio::time::sleep(POLL).await;
    }
    let command = command.filter(|command| !command.trim().is_empty());
    if let Some(command) = command {
        send_text(&target, command, true).await?;
    }
    Ok(json!({
        "terminal": target.id,
        "name": info.name,
        "transport": info.transport,
        "command_sent": command.is_some(),
    }))
}
