//! MCP server for agent CLIs (Model Context Protocol, https://modelcontextprotocol.io): lets an
//! agent running in one MetroTerm terminal see and drive the others — list them, read their
//! screens, type into them, prompt the agent CLI in another terminal and wait for it to finish,
//! open new terminals, and arrange MetroTerm's windows and split panes (tools/).
//!
//! - Off by default; Session → Preferences → Settings… → MCP SERVER (settings.json `"mcp"`: enabled,
//!   port, token, allowInput). Read at start-up, applied live with `mcp.configure`.
//! - Transports: SSE (`GET /sse` + `POST /messages?sessionId=…`, MCP 2024-11-05) and Streamable
//!   HTTP (`POST /mcp`, 2025-03-26 / 2025-06-18; answered as plain JSON).
//! - Only on 127.0.0.1. Every request needs the token (`Authorization: Bearer …` or `?token=…`);
//!   `Host` must be a loopback name and a browser `Origin` is refused (DNS rebinding).
//! - Agent state comes from the terminal output only (agents/), as for the Session panel: there is
//!   no tool for an agent to report its own state.
//! - The caller's own terminal is recognised from its TCP connection (caller.rs, Linux).
//!
//! Modules: this file (config, `Hub`, routes, guards, JSON-RPC); `tools/` — `definitions.rs` (tool
//! list and input schemas), `terminals.rs` (terminal tools), `ui.rs` (window / pane / tab tools via
//! `mcp.ui`), `mod.rs` (dispatch, errors); `keys.rs` (key names → bytes); `caller.rs`.

mod caller;
mod keys;
mod tools;

use crate::backend::Backend;
use axum::{
    body::Bytes,
    extract::{ConnectInfo, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

pub const DEFAULT_PORT: u16 = 7690;
/// MCP revisions this server speaks (newest first); a client asking for another gets the newest.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// settings.json → `"mcp"`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    pub enabled: bool,
    pub port: u16,
    /// Required by every request; empty = the server does not start.
    pub token: String,
    /// Tools that type into terminals or open them (off: read-only — list, read, wait).
    pub allow_input: bool,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: String::new(),
            allow_input: true,
        }
    }
}

/// `mcp.status` / `mcp.configure`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    /// `http://127.0.0.1:<port>` while running.
    pub url: Option<String>,
    pub error: Option<String>,
    /// Connected SSE clients.
    pub clients: usize,
}

/// One client (SSE stream, or Streamable HTTP session).
struct ClientSession {
    /// SSE: where responses go. Streamable HTTP: None (answered in the POST).
    events: Option<mpsc::UnboundedSender<String>>,
    /// The terminal the client runs in (MCP terminal id), when known.
    caller: Option<String>,
}

struct Running {
    port: u16,
    stop: oneshot::Sender<()>,
}

struct Hub {
    backends: Mutex<Vec<(u32, Weak<Backend>)>>,
    next_backend: AtomicU32,
    config: Mutex<McpConfig>,
    running: Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
    sessions: Mutex<HashMap<String, ClientSession>>,
    /// `mcp.ui` requests waiting for the UI's `mcp.reply`.
    ui: Mutex<HashMap<String, oneshot::Sender<UiReply>>>,
}

fn hub() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(|| Hub {
        backends: Mutex::new(Vec::new()),
        next_backend: AtomicU32::new(1),
        config: Mutex::new(McpConfig::default()),
        running: Mutex::new(None),
        error: Mutex::new(None),
        sessions: Mutex::new(HashMap::new()),
        ui: Mutex::new(HashMap::new()),
    })
}

/// The server runs on its own small runtime: the desktop app's backend is created outside one.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("mcp")
            .enable_all()
            .build()
            .expect("MCP runtime")
    })
}

fn new_id() -> String {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let mut bytes = [0u8; 16];
    // ring is already a dependency (common/secret.rs): a random, unguessable session id.
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    let random: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{random}{:x}{:x}",
        nanos & 0xffff,
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

// ---------- backends (one per UI: the desktop window, each browser client) ----------

/// A backend was created: its terminals become visible to MCP clients. The first one also
/// starts the server when settings.json says so.
pub fn register(backend: &Arc<Backend>) -> u32 {
    let hub = hub();
    let number = hub.next_backend.fetch_add(1, Ordering::Relaxed);
    {
        let mut backends = hub.backends.lock().unwrap();
        backends.retain(|(_, weak)| weak.strong_count() > 0);
        backends.push((number, Arc::downgrade(backend)));
    }
    if number == 1 {
        let saved = crate::common::config::load("settings")
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|doc| serde_json::from_value::<McpConfig>(doc.get("mcp")?.clone()).ok());
        if let Some(config) = saved {
            configure(config);
        }
    }
    number
}

/// Live backends, oldest first.
fn backends() -> Vec<(u32, Arc<Backend>)> {
    hub()
        .backends
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(number, weak)| Some((*number, weak.upgrade()?)))
        .collect()
}

/// MCP terminal id: the UI's session id (`tab-3#1`), prefixed with the backend's number from the
/// second browser client on (`2/tab-3#1`) — each browser client numbers its tabs itself.
fn terminal_id(backend: u32, session_id: &str) -> String {
    if backend == 1 {
        session_id.to_owned()
    } else {
        format!("{backend}/{session_id}")
    }
}

fn split_terminal_id(id: &str) -> (u32, &str) {
    match id.split_once('/') {
        Some((number, session)) if number.parse::<u32>().is_ok() => {
            (number.parse().unwrap(), session)
        }
        _ => (1, id),
    }
}

// ---------- configuration ----------

pub fn status() -> Status {
    let hub = hub();
    let config = hub.config.lock().unwrap().clone();
    let running = hub
        .running
        .lock()
        .unwrap()
        .as_ref()
        .map(|running| running.port);
    Status {
        enabled: config.enabled,
        running: running.is_some(),
        port: running.unwrap_or(config.port),
        url: running.map(|port| format!("http://127.0.0.1:{port}")),
        error: hub.error.lock().unwrap().clone(),
        clients: hub
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|session| session.events.is_some())
            .count(),
    }
}

/// Apply settings: start, stop or move the server. Returns the state afterwards (a port in use
/// is reported in `error`).
pub fn configure(mut config: McpConfig) -> Status {
    let hub = hub();
    config.token = config.token.trim().to_owned();
    if config.port == 0 {
        config.port = DEFAULT_PORT;
    }
    let previous = std::mem::replace(&mut *hub.config.lock().unwrap(), config.clone());
    let restart = previous.port != config.port || previous.token != config.token;
    let want = config.enabled && !config.token.is_empty();
    let mut running = hub.running.lock().unwrap();
    if running.is_some() && (!want || restart) {
        if let Some(old) = running.take() {
            let _ = old.stop.send(());
            log::info!("MCP server stopped (port {})", old.port);
        }
        // Clients of the old server are gone with it.
        hub.sessions.lock().unwrap().clear();
    }
    *hub.error.lock().unwrap() = None;
    if want && running.is_none() {
        let address = SocketAddr::from(([127, 0, 0, 1], config.port));
        match std::net::TcpListener::bind(address) {
            Ok(listener) => {
                let _ = listener.set_nonblocking(true);
                let (stop, stopped) = oneshot::channel();
                *running = Some(Running {
                    port: config.port,
                    stop,
                });
                runtime().spawn(serve(listener, stopped));
                log::info!("MCP server listening on http://{address} (/sse, /mcp)");
            }
            Err(error) => {
                let message = format!("Cannot listen on {address}: {error}");
                log::warn!("MCP server: {message}");
                *hub.error.lock().unwrap() = Some(message);
            }
        }
    } else if config.enabled && config.token.is_empty() {
        *hub.error.lock().unwrap() = Some("No access token".into());
    }
    drop(running);
    status()
}

/// The UI's answer to an `mcp.ui` request: its result, or (error code, message).
pub type UiReply = Result<Value, (String, String)>;

/// The UI answered an `mcp.ui` request (tools/ui.rs `ui_request`).
pub fn ui_reply(request_id: &str, result: UiReply) -> bool {
    match hub().ui.lock().unwrap().remove(request_id) {
        Some(waiter) => waiter.send(result).is_ok(),
        None => false,
    }
}

// ---------- HTTP ----------

#[derive(Clone)]
struct AppState {
    local: SocketAddr,
}

async fn serve(listener: std::net::TcpListener, stopped: oneshot::Receiver<()>) {
    let local = match listener.local_addr() {
        Ok(local) => local,
        Err(_) => return,
    };
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            log::warn!("MCP server: {error}");
            return;
        }
    };
    let state = AppState { local };
    let app = Router::new()
        .route("/sse", get(sse_open))
        .route("/messages", post(sse_message))
        .route("/mcp", post(http_post).get(http_get).delete(http_delete))
        .route("/", get(index))
        .layer(middleware::from_fn(guard))
        .with_state(state);
    let result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = stopped.await;
    })
    .await;
    if let Err(error) = result {
        log::warn!("MCP server: {error}");
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AuthQuery {
    token: Option<String>,
    session_id: Option<String>,
}

fn same_token(given: &str, expected: &str) -> bool {
    let (given, expected) = (given.as_bytes(), expected.as_bytes());
    // No early exit on the first different byte.
    given.len() == expected.len()
        && given
            .iter()
            .zip(expected)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn is_loopback_host(host: &str) -> bool {
    let name = match host.rsplit_once(':') {
        Some((name, port)) if port.chars().all(|c| c.is_ascii_digit()) => name,
        _ => host,
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "[::1]"
    )
}

/// Token, Host and Origin checks for every request.
async fn guard(request: Request, next: Next) -> Response {
    let headers = request.headers();
    let host_ok = headers
        .get(header::HOST)
        .and_then(|host| host.to_str().ok())
        .is_some_and(is_loopback_host);
    if !host_ok {
        return (StatusCode::FORBIDDEN, "Host not allowed").into_response();
    }
    // Agent CLIs send no Origin; a web page does — and must not reach this server.
    if headers.contains_key(header::ORIGIN) {
        return (StatusCode::FORBIDDEN, "Browser requests are not allowed").into_response();
    }
    let expected = hub().config.lock().unwrap().token.clone();
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
        })
        .map(str::trim);
    let query: AuthQuery = request
        .uri()
        .query()
        .and_then(serde_urlencoded_lite)
        .unwrap_or_default();
    let given = bearer.or(query.token.as_deref()).unwrap_or_default();
    if expected.is_empty() || !same_token(given, &expected) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "Missing or wrong MetroTerm MCP token",
        )
            .into_response();
    }
    next.run(request).await
}

/// `a=1&b=2` → AuthQuery (just the two fields; values percent-decoded).
fn serde_urlencoded_lite(query: &str) -> Option<AuthQuery> {
    let mut out = AuthQuery::default();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            "token" => out.token = Some(value),
            "sessionId" | "session_id" => out.session_id = Some(value),
            _ => {}
        }
    }
    Some(out)
}

fn percent_decode(text: &str) -> String {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                match (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                    (Some(high), Some(low)) => {
                        out.push(high * 16 + low);
                        index += 3;
                        continue;
                    }
                    _ => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn index() -> &'static str {
    "MetroTerm MCP server\n  SSE:             GET /sse  (messages: POST /messages?sessionId=…)\n  Streamable HTTP: POST /mcp\n"
}

/// The caller's terminal, looked up from its connection (blocking /proc reads off the runtime).
async fn identify(peer: SocketAddr, local: SocketAddr) -> Option<String> {
    let device = tokio::task::spawn_blocking(move || caller::client_tty(peer, local))
        .await
        .ok()
        .flatten()?;
    tools::terminal_on_device(device).await
}

// ----- SSE transport -----

/// Removes the session when the SSE stream is dropped (client gone).
struct SessionGuard(String);

impl Drop for SessionGuard {
    fn drop(&mut self) {
        hub().sessions.lock().unwrap().remove(&self.0);
        log::debug!("MCP client disconnected");
    }
}

async fn sse_open(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let id = new_id();
    let caller = identify(peer, state.local).await;
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    hub().sessions.lock().unwrap().insert(
        id.clone(),
        ClientSession {
            events: Some(tx),
            caller: caller.clone(),
        },
    );
    log::info!(
        "MCP client connected (SSE){}",
        caller
            .as_deref()
            .map(|caller| format!(", in terminal {caller}"))
            .unwrap_or_default()
    );
    // A client that authenticated with ?token= posts to this URL as given: keep the token in it.
    let endpoint = match query.get("token") {
        Some(token) => format!("/messages?sessionId={id}&token={}", url_encode(token)),
        None => format!("/messages?sessionId={id}"),
    };
    let first = SseEvent::default().event("endpoint").data(endpoint);
    let stream = futures_util::stream::unfold(
        (Some(first), rx, SessionGuard(id)),
        |(first, mut rx, guard)| async move {
            if let Some(first) = first {
                return Some((Ok::<_, Infallible>(first), (None, rx, guard)));
            }
            let message = rx.recv().await?;
            Some((
                Ok(SseEvent::default().event("message").data(message)),
                (None, rx, guard),
            ))
        },
    );
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

fn url_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn sse_message(Query(query): Query<HashMap<String, String>>, body: Bytes) -> Response {
    let Some(session_id) = query.get("sessionId").or_else(|| query.get("session_id")) else {
        return (StatusCode::BAD_REQUEST, "sessionId missing").into_response();
    };
    let (events, caller) = {
        let sessions = hub().sessions.lock().unwrap();
        match sessions.get(session_id) {
            Some(ClientSession {
                events: Some(events),
                caller,
            }) => (events.clone(), caller.clone()),
            _ => return (StatusCode::NOT_FOUND, "Unknown session").into_response(),
        }
    };
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(error) => {
            let reply = rpc_error(Value::Null, -32700, &format!("Parse error: {error}"));
            let _ = events.send(reply.to_string());
            return (StatusCode::BAD_REQUEST, "Parse error").into_response();
        }
    };
    let messages = match message {
        Value::Array(batch) => batch,
        single => vec![single],
    };
    for message in messages {
        let events = events.clone();
        let context = Context {
            caller: caller.clone(),
        };
        // Each request on its own: a long wait must not hold up the others.
        tokio::spawn(async move {
            if let Some(reply) = handle_message(message, &context).await {
                let _ = events.send(reply.to_string());
            }
        });
    }
    (StatusCode::ACCEPTED, "Accepted").into_response()
}

// ----- Streamable HTTP transport -----

const SESSION_HEADER: &str = "mcp-session-id";

async fn http_post(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(rpc_error(
                    Value::Null,
                    -32700,
                    &format!("Parse error: {error}"),
                )),
            )
                .into_response()
        }
    };
    let (messages, batch) = match message {
        Value::Array(batch) => (batch, true),
        single => (vec![single], false),
    };
    let initialize = messages
        .iter()
        .any(|message| message.get("method").and_then(Value::as_str) == Some("initialize"));
    let given = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    // A session: from `initialize` on (the caller's terminal looked up once).
    let (session_id, caller) = if initialize {
        let id = new_id();
        let caller = identify(peer, state.local).await;
        hub().sessions.lock().unwrap().insert(
            id.clone(),
            ClientSession {
                events: None,
                caller: caller.clone(),
            },
        );
        log::info!(
            "MCP client connected (HTTP){}",
            caller
                .as_deref()
                .map(|caller| format!(", in terminal {caller}"))
                .unwrap_or_default()
        );
        (Some(id), caller)
    } else {
        let known = given.as_ref().and_then(|id| {
            hub()
                .sessions
                .lock()
                .unwrap()
                .get(id)
                .map(|session| session.caller.clone())
        });
        match known {
            Some(caller) => (given.clone(), caller),
            // Unknown or no session id (stateless clients, or MetroTerm restarted): carry on.
            None => (None, identify(peer, state.local).await),
        }
    };
    let context = Context { caller };
    let mut replies = Vec::new();
    for message in messages {
        if let Some(reply) = handle_message(message, &context).await {
            replies.push(reply);
        }
    }
    let mut response = if replies.is_empty() {
        StatusCode::ACCEPTED.into_response()
    } else if batch {
        axum::Json(Value::Array(replies)).into_response()
    } else {
        axum::Json(replies.pop().unwrap()).into_response()
    };
    if let Some(id) = session_id.filter(|_| initialize) {
        if let Ok(value) = HeaderValue::from_str(&id) {
            response.headers_mut().insert(SESSION_HEADER, value);
        }
    }
    response
}

/// No server-initiated stream on /mcp (allowed by the spec): use POST, or the SSE transport.
async fn http_get() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST, DELETE")],
        "Use POST /mcp, or GET /sse for the SSE transport",
    )
        .into_response()
}

async fn http_delete(headers: HeaderMap) -> Response {
    if let Some(id) = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
    {
        hub().sessions.lock().unwrap().remove(id);
    }
    StatusCode::OK.into_response()
}

// ---------- JSON-RPC ----------

/// Who is asking.
pub(crate) struct Context {
    /// The MCP terminal id of the terminal the client runs in, when known.
    pub caller: Option<String>,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

const INSTRUCTIONS: &str = "MetroTerm is a terminal app (SSH, local shells, Telnet, serial). This server lets you work with \
its other open terminals and the coding agent CLIs running in them (Claude Code, Codex, opencode, Gemini CLI, Copilot CLI …).\n\
- Start with list_terminals. Terminal ids are opaque: take them from its result. The terminal marked `self` is the one you run in; never prompt or type into it.\n\
- An agent CLI's state (working, blocked, done, idle, unknown) is read from its screen. idle / done = ready for input. blocked = it shows an approval or question: \
read_terminal and ask the user before answering it with send_keys. unknown = an agent is there but its state is unclear.\n\
- To hand work to another agent: agent_prompt (waits until it settles by default), then read_terminal to see its answer. A timeout does not mean the prompt was lost: check with read_terminal / agent_wait before sending it again.\n\
- For ordinary commands: send_text with enter=true in a shell terminal, then wait_for_output and read_terminal.\n\
- Windows and split panes: list_windows shows MetroTerm's windows, how each splits into panes (ids like win-1:p-2, letters A, B …) and their tabs. \
open_terminal (a new tab, optionally in a given window / pane), split_pane (a new pane with a new terminal, e.g. to run a server beside an agent), \
new_window, move_terminal, resize_pane, zoom_pane, rename_window arrange them; everything opens in the background unless focus=true.\n\
- Tabs (as in MetroTerm's Session panel): list_terminals gives each tab's name, window and pane, also of disconnected tabs (connected: false). \
rename_terminal names a tab, move_terminal with before / last reorders tabs, open_terminal with terminal clones one, reconnect_terminal / disconnect_terminal \
restart / end a tab's session. A terminal id stays usable after its tab was reconnected.\n\
- Closing (close_terminal / close_pane / close_window): what you opened closes at once; anything else asks the user, so close only when the user wants it, \
and never your own terminal. Don't disturb terminals you did not open unless the user asks.";

async fn handle_message(message: Value, context: &Context) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?;
    // Notifications (no id) get no reply; responses to our requests (none are sent) are ignored.
    let id = message.get("id").cloned()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => {
            let asked = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version = PROTOCOL_VERSIONS
                .iter()
                .find(|version| **version == asked)
                .copied()
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "metroterm", "title": "MetroTerm", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => {
            let allow_input = hub().config.lock().unwrap().allow_input;
            rpc_result(id, json!({ "tools": tools::definitions(allow_input) }))
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_error(id, -32602, "Tool name missing"));
            };
            let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
            let allow_input = hub().config.lock().unwrap().allow_input;
            match tools::call(name, arguments, context, allow_input).await {
                Err(tools::CallError::UnknownTool) => {
                    rpc_error(id, -32602, &format!("Unknown tool: {name}"))
                }
                Err(tools::CallError::Failed(error)) => rpc_result(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": error.to_string() }],
                        "structuredContent": error,
                        "isError": true,
                    }),
                ),
                Ok(output) => {
                    // read_terminal: the screen text itself; else the JSON.
                    let text = output.text.unwrap_or_else(|| {
                        serde_json::to_string_pretty(&output.value).unwrap_or_default()
                    });
                    rpc_result(
                        id,
                        json!({
                            "content": [{ "type": "text", "text": text }],
                            "structuredContent": output.value,
                            "isError": false,
                        }),
                    )
                }
            }
        }
        "resources/list" => rpc_result(id, json!({ "resources": [] })),
        "resources/templates/list" => rpc_result(id, json!({ "resourceTemplates": [] })),
        "prompts/list" => rpc_result(id, json!({ "prompts": [] })),
        "logging/setLevel" => rpc_result(id, json!({})),
        _ => rpc_error(id, -32601, &format!("Method not found: {method}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert!(same_token("abc", "abc"));
        assert!(!same_token("abd", "abc"));
        assert!(!same_token("", "abc"));
        assert!(is_loopback_host("127.0.0.1:7690"));
        assert!(is_loopback_host("localhost:7690"));
        assert!(is_loopback_host("[::1]:7690"));
        assert!(!is_loopback_host("evil.example:7690"));
        assert!(!is_loopback_host("127.0.0.1.evil.example"));
        assert_eq!(percent_decode("a%2Fb+c%"), "a/b c%");
        assert_eq!(percent_decode("%中%2"), "%中%2");
        assert_eq!(url_encode("a/b c"), "a%2Fb%20c");
        assert_eq!(split_terminal_id("tab-3#1"), (1, "tab-3#1"));
        assert_eq!(split_terminal_id("2/tab-3#1"), (2, "tab-3#1"));
        assert_eq!(terminal_id(2, "tab-1#4"), "2/tab-1#4");
        let query = serde_urlencoded_lite("sessionId=x&token=t%2B1").unwrap();
        assert_eq!(query.token.as_deref(), Some("t+1"));
        assert_eq!(query.session_id.as_deref(), Some("x"));
    }

    #[tokio::test]
    async fn protocol() {
        let context = Context { caller: None };
        let reply = handle_message(
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } } }),
            &context,
        )
        .await
        .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(reply["result"]["serverInfo"]["name"], "metroterm");
        let reply = handle_message(
            json!({ "jsonrpc": "2.0", "id": 2, "method": "initialize", "params": { "protocolVersion": "2099-01-01" } }),
            &context,
        )
        .await
        .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
        // Notifications: no reply.
        assert!(handle_message(
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
            &context
        )
        .await
        .is_none());
        let reply = handle_message(
            json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
            &context,
        )
        .await
        .unwrap();
        let names: Vec<&str> = reply["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"list_terminals") && names.contains(&"agent_prompt"));
        let reply = handle_message(
            json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "list_terminals", "arguments": {} } }),
            &context,
        )
        .await
        .unwrap();
        assert_eq!(reply["result"]["isError"], false);
        assert_eq!(reply["result"]["structuredContent"]["terminals"], json!([]));
        let reply = handle_message(
            json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "read_terminal", "arguments": { "terminal": "nope" } } }),
            &context,
        )
        .await
        .unwrap();
        assert_eq!(reply["result"]["isError"], true);
        assert_eq!(
            reply["result"]["structuredContent"]["code"],
            "terminal_not_found"
        );
        let reply = handle_message(
            json!({ "jsonrpc": "2.0", "id": 6, "method": "nope" }),
            &context,
        )
        .await
        .unwrap();
        assert_eq!(reply["error"]["code"], -32601);
    }
}
