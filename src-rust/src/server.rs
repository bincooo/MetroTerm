//! Browser backend: the same RPC as the desktop app over a WebSocket, plus streaming HTTP
//! endpoints for SFTP uploads / downloads.
//!
//! ```text
//! GET  /api/ws                                     WebSocket
//!        ← {"hello": {"clientId", "version", "home"}}
//!        → {"id": 1, "method": "terminal.start", "params": {...}}
//!        ← {"id": 1, "result": ...} | {"id": 1, "error": "..."}
//!        ← {"event": {"type": "terminal.data", ...}}
//! GET  /api/fs/download?client&connection&path     file body (attachment)
//! PUT  /api/fs/upload?client&connection&path&transfer   raw request body → file
//! ```
//! Every WebSocket client gets its own backend (terminals, SSH connections); everything is
//! closed when the socket closes. Bind to localhost (the default) — this server gives shell access.
//!
//! Web mode with a UI (`metroterm web`, [`serve_web`]) also serves it from the same address,
//! and then only accepts `/api` requests from its own pages: the Host must be `localhost` or an IP
//! address (no DNS rebinding) and a browser's Origin must be that same host (no other site can
//! open the WebSocket).

use crate::{
    backend::Backend,
    common::events::{Event, EventSink},
};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Query, Request as HttpRequest, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{hash_map::RandomState, HashMap},
    hash::{BuildHasher, Hasher},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::mpsc;
use tokio_util::io::{ReaderStream, StreamReader};

/// The UI's files for web mode: URL path ("/index.html", "/assets/…") → file contents.
pub type StaticFiles = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

#[derive(Default)]
struct AppState {
    clients: Mutex<HashMap<String, Arc<Backend>>>,
    /// Web mode: `/api` only for the UI's own pages (see the module docs).
    same_origin_only: bool,
}

struct WsSink(mpsc::UnboundedSender<String>);

impl EventSink for WsSink {
    fn emit(&self, event: Event) {
        if let Ok(text) = serde_json::to_string(&json!({ "event": event })) {
            let _ = self.0.send(text);
        }
    }
}

fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|time| time.as_nanos())
            .unwrap_or(0),
    );
    let mut second = RandomState::new().build_hasher();
    second.write_u64(hasher.finish());
    format!("{:016x}{:016x}", hasher.finish(), second.finish())
}

/// Backend only (`metroterm web --no-www`, or a build without a UI; the Vite dev / preview server
/// serves the UI), on an already bound listener.
pub async fn serve_backend(listener: tokio::net::TcpListener) -> Result<(), String> {
    axum::serve(listener, router(Arc::new(AppState::default())))
        .await
        .map_err(|error| error.to_string())
}

/// The UI's files from a folder on disk (`metroterm web --www DIR`, the browser package): the
/// built `dist/`. Only plain relative paths inside the folder are served — no `..`, no absolute or
/// drive-prefixed components — so a request can never read anything beside it.
pub fn dir_files(root: std::path::PathBuf) -> StaticFiles {
    Arc::new(move |path: &str| {
        let mut file = root.clone();
        for part in path.split('/').filter(|part| !part.is_empty()) {
            let plain = part != "."
                && part != ".."
                && !part.contains('\\')
                && !part.contains(':')
                && !part.starts_with('.');
            if !plain {
                return None;
            }
            file.push(part);
        }
        std::fs::read(file).ok()
    })
}

/// Web mode: the backend plus the UI, on an already bound listener.
pub async fn serve_web(
    listener: tokio::net::TcpListener,
    files: StaticFiles,
) -> Result<(), String> {
    let state = Arc::new(AppState {
        same_origin_only: true,
        ..AppState::default()
    });
    let app = router(state).fallback(move |uri: Uri| {
        let files = files.clone();
        async move { static_file(&files, uri.path()) }
    });
    axum::serve(listener, app)
        .await
        .map_err(|error| error.to_string())
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/ws", get(ws_handler))
        .route(
            "/api/health",
            get(|| async { Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") })) }),
        )
        .route("/api/fs/download", get(download))
        .route(
            "/api/fs/upload",
            put(upload).layer(DefaultBodyLimit::disable()),
        )
        .layer(middleware::from_fn_with_state(state.clone(), api_guard))
        .with_state(state)
}

/// Web mode: refuse `/api` requests that don't come from the UI's own pages.
async fn api_guard(
    State(state): State<Arc<AppState>>,
    request: HttpRequest,
    next: Next,
) -> Response {
    if state.same_origin_only && !same_origin(request.headers()) {
        return (
            StatusCode::FORBIDDEN,
            "MetroTerm: cross-origin request refused",
        )
            .into_response();
    }
    next.run(request).await
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    // Host name without the port ("[::1]:7681" → "::1").
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    if !name.eq_ignore_ascii_case("localhost") && name.parse::<std::net::IpAddr>().is_err() {
        return false; // a domain name pointing here: possibly DNS rebinding
    }
    match headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        None => true, // not a browser page (curl …)
        Some(origin) => origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
            .is_some_and(|rest| rest.eq_ignore_ascii_case(host)),
    }
}

/// A file of the UI; unknown paths without an extension get index.html (the app has one page).
fn static_file(files: &StaticFiles, path: &str) -> Response {
    let path = if path == "/" { "/index.html" } else { path };
    let (path, body) = match files(path) {
        Some(body) => (path, body),
        None if !path.rsplit('/').next().unwrap_or("").contains('.') => {
            match files("/index.html") {
                Some(body) => ("/index.html", body),
                None => return StatusCode::NOT_FOUND.into_response(),
            }
        }
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let kind = match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    // Vite's /assets/ names carry a content hash; index.html must always be fresh.
    let cache = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, cache)],
        body,
    )
        .into_response()
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.max_message_size(16 * 1024 * 1024)
        .on_upgrade(move |socket| client(socket, state))
}

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn client(socket: WebSocket, state: Arc<AppState>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let backend = Backend::new(Arc::new(WsSink(tx.clone())));
    let client_id = new_id();
    state
        .clients
        .lock()
        .unwrap()
        .insert(client_id.clone(), backend.clone());
    let home = dirs::home_dir().map(|home| home.display().to_string());
    let _ = tx.send(json!({ "hello": { "clientId": client_id, "version": env!("CARGO_PKG_VERSION"), "home": home } }).to_string());

    let (mut sender, mut receiver) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = receiver.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(request) = serde_json::from_str::<Request>(&text) else {
            continue;
        };
        let reply = |id: Value, result: Result<Value, String>| match result {
            Ok(result) => json!({ "id": id, "result": result }).to_string(),
            Err(error) => json!({ "id": id, "error": error }).to_string(),
        };
        // Keystrokes and resizes are handled in order; everything else runs concurrently.
        if matches!(
            request.method.as_str(),
            "terminal.write" | "terminal.resize"
        ) {
            let result = backend.dispatch(&request.method, request.params).await;
            let _ = tx.send(reply(request.id, result));
        } else {
            let backend = backend.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let result = backend.dispatch(&request.method, request.params).await;
                let _ = tx.send(reply(request.id, result));
            });
        }
    }

    state.clients.lock().unwrap().remove(&client_id);
    backend.shutdown().await;
    writer.abort();
}

#[derive(Deserialize)]
struct FileQuery {
    client: String,
    connection: String,
    path: String,
    #[serde(default)]
    transfer: Option<String>,
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn backend_for(state: &AppState, client: &str) -> Option<Arc<Backend>> {
    state.clients.lock().unwrap().get(client).cloned()
}

/// RFC 5987 `filename*` value.
fn encode_filename(name: &str) -> String {
    name.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn download(State(state): State<Arc<AppState>>, Query(query): Query<FileQuery>) -> Response {
    let Some(backend) = backend_for(&state, &query.client) else {
        return error(StatusCode::UNAUTHORIZED, "Unknown client");
    };
    let fs = match backend.fs_by_id(&query.connection).await {
        Ok(fs) => fs,
        Err(message) => return error(StatusCode::BAD_GATEWAY, message),
    };
    let (reader, size) = match fs.open_read(&query.path).await {
        Ok(opened) => opened,
        Err(message) => return error(StatusCode::NOT_FOUND, message),
    };
    let name = query
        .path
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
                encode_filename(name)
            ),
        )
        .header(header::CACHE_CONTROL, "no-store");
    if let Some(size) = size {
        response = response.header(header::CONTENT_LENGTH, size);
    }
    response
        .body(Body::from_stream(ReaderStream::with_capacity(
            reader,
            256 * 1024,
        )))
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "response error"))
}

async fn upload(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FileQuery>,
    headers: axum::http::HeaderMap,
    body: Body,
) -> Response {
    let Some(backend) = backend_for(&state, &query.client) else {
        return error(StatusCode::UNAUTHORIZED, "Unknown client");
    };
    let fs = match backend.fs_by_id(&query.connection).await {
        Ok(fs) => fs,
        Err(message) => return error(StatusCode::BAD_GATEWAY, message),
    };
    let writer = match fs.open_write(&query.path).await {
        Ok(writer) => writer,
        Err(message) => return error(StatusCode::FORBIDDEN, message),
    };
    let total = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    let stream = body.into_data_stream().map_err(std::io::Error::other);
    let reader = StreamReader::new(stream);
    let transfer = query.transfer.unwrap_or_else(new_id);
    match backend
        .files
        .copy(&backend.shared, &transfer, Box::pin(reader), writer, total)
        .await
    {
        Ok(bytes) => Json(json!({ "bytes": bytes })).into_response(),
        Err(message) => error(StatusCode::BAD_GATEWAY, message),
    }
}
