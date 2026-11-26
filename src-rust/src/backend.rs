//! Transport-independent backend: one JSON-RPC style entry point (`dispatch`) used by the
//! Tauri `rpc` command (desktop) and by the WebSocket server (browser).
//!
//! | method               | params                                                        | result |
//! |----------------------|---------------------------------------------------------------|--------|
//! | `terminal.start`     | `{sessionId, connection, cols, rows}`                         | `null` |
//! | `terminal.write`     | `{sessionId, data}`                                           | `null` |
//! | `terminal.resize`    | `{sessionId, cols, rows}`                                     | `null` |
//! | `terminal.cwd`       | `{sessionId}`                                                 | `string \| null` (current directory) |
//! | `terminal.close`     | `{sessionId}`                                                 | `null` |
//! | `connection.disconnect` | `{connectionId}`                                           | `null` |
//! | `auth.respond`       | `{requestId, answers: string[] \| null}`                      | `bool` |
//! | `fs.home`            | `{connection}`                                                | `string` |
//! | `fs.list`            | `{connection, path}`                                          | `{path, entries}` |
//! | `fs.mkdir`           | `{connection, path}`                                          | `null` |
//! | `fs.rename`          | `{connection, from, to}`                                      | `null` |
//! | `fs.copy` / `fs.move` | `{connection, from, to}` (recursive; `to` must not exist)     | `null` |
//! | `fs.remove`          | `{connection, path}`                                          | `null` |
//! | `fs.transfer`        | `{transferId, from: {connection, path}, to: {connection, path}}` | `bytes` |
//! | `fs.cancel`          | `{transferId}`                                                | `bool` |
//! | `config.dir` / `config.load` / `config.save` | see common/config.rs                         |        |
//! | `secret.seal` `{text}`                        | encrypted password for sessions.json  |        |
//! | `themes.list` / `themes.load` `{folder, name}` | terminal colour schemes (common/themes.rs) |  |
//! | `file.saveText`      | `{path, text}` — local file chosen in a Save dialog (terminal selection / output) | `bytes` |
//! | `monitor.sample`     | `{connection}` — CPU / memory / network / disks / processes (monitor/)   | snapshot |
//! | `tunnel.start`       | `{tunnel: {id, kind: "local" \| "remote" \| "dynamic", bindHost, bindPort, destHost, destPort}, connection}` | status |
//! | `tunnel.stop`        | `{id}`                                                        | `bool` |
//! | `tunnel.list`        | `{}` — running tunnels: state, bound port, connections, bytes (remote/tunnel.rs) | status[] |
//! | `monitor.signal`     | `{connection, pid, signal: "TERM" \| "KILL"}` — stop / kill a process of that host | `null` |
//! | `agent.focus`        | `{sessionId: string \| null}` — the terminal the user is looking at (agents/mod.rs) | `null` |
//! | `mcp.status`         | `{}` — the MCP server for agent CLIs (mcp/)                   | status |
//! | `mcp.configure`      | `{enabled, port, token, allowInput}` — start / stop / move it (also saved in settings.json by the UI) | status |
//! | `mcp.reply`          | `{requestId, result?, error?, code?}` — the UI's answer to an `mcp.ui` event | `bool` |

use crate::{
    agents::{Agents, Tap},
    common::config,
    common::events::{EventSink, Prompts},
    files::{FilePool, Fs},
    monitor::Monitor,
    remote::ssh::{ConnectionSpec, Shared, SshPool},
    remote::tunnel::{TunnelSpec, Tunnels},
    terminal::Terminals,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub struct Backend {
    pub shared: Arc<Shared>,
    pub ssh: SshPool,
    pub files: FilePool,
    pub terminals: Arc<Terminals>,
    /// Last spec seen per connection id (lets HTTP transfer endpoints refer to a connection by id).
    specs: Mutex<HashMap<String, ConnectionSpec>>,
    monitor: Monitor,
    tunnels: Tunnels,
    /// Agent CLI status of the terminals (fed by the event sink, see `agents::Tap`).
    pub(crate) agents: Arc<Agents>,
}

fn params<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("Invalid parameters: {error}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    session_id: String,
    connection: ConnectionSpec,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}
fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    32
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteParams {
    session_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeParams {
    session_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusParams {
    session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(feature = "server"), allow(dead_code))]
struct ReplyParams {
    request_id: String,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionIdParams {
    connection_id: String,
}

#[derive(Deserialize)]
struct SaveTextParams {
    path: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RespondParams {
    request_id: String,
    answers: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct FsParams {
    connection: ConnectionSpec,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct RenameParams {
    connection: ConnectionSpec,
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct Endpoint {
    connection: ConnectionSpec,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferParams {
    transfer_id: String,
    from: Endpoint,
    to: Endpoint,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelParams {
    transfer_id: String,
}

#[derive(Deserialize)]
struct ThemeParams {
    folder: String,
    name: String,
}
#[derive(Deserialize)]
struct ConfigParams {
    name: String,
    #[serde(default)]
    content: String,
}
#[derive(Deserialize)]
struct SealParams {
    text: String,
}

#[derive(Deserialize)]
struct LogWriteParams {
    level: String,
    message: String,
}

#[derive(Deserialize)]
struct MonitorParams {
    connection: ConnectionSpec,
}

#[derive(Deserialize)]
struct MonitorSignalParams {
    connection: ConnectionSpec,
    pid: u32,
    signal: crate::monitor::StopSignal,
}

#[derive(Deserialize)]
struct TunnelStartParams {
    tunnel: TunnelSpec,
    connection: ConnectionSpec,
}

#[derive(Deserialize)]
struct TunnelIdParams {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyTestParams {
    proxy: crate::remote::net::ProxySpec,
    host: String,
    port: u16,
    /// Set: send `GET <path>` over plain HTTP through the tunnel and report the status code
    /// (e.g. `/generate_204`). Unset: only open the tunnel.
    #[serde(default)]
    path: Option<String>,
}

impl Backend {
    pub fn new(sink: Arc<dyn EventSink>) -> Arc<Self> {
        crate::common::applog::init();
        // ~/.metroterm/themes/{black,white} with the default colour schemes on first start.
        if let Err(error) = crate::common::themes::ensure() {
            log::warn!("Terminal colour schemes: {error}");
        }
        // Terminal output passes the agent status screens on its way to the UI.
        let agents = Agents::new(sink.clone());
        let sink: Arc<dyn EventSink> = Arc::new(Tap {
            inner: sink,
            agents: agents.clone(),
        });
        let backend = Arc::new(Self {
            agents,
            shared: Arc::new(Shared {
                prompts: Prompts::new(sink.clone()),
                sink,
                forwards: Default::default(),
            }),
            ssh: SshPool::default(),
            files: FilePool::default(),
            terminals: Arc::new(Terminals::default()),
            specs: Mutex::new(HashMap::new()),
            monitor: Monitor::default(),
            tunnels: Tunnels::default(),
        });
        // Its terminals are open to MCP clients (when the server is on); the first backend also
        // starts the server from settings.json.
        #[cfg(feature = "server")]
        crate::mcp::register(&backend);
        backend
    }

    fn remember(&self, spec: &ConnectionSpec) {
        self.specs
            .lock()
            .unwrap()
            .insert(spec.id.clone(), spec.clone());
    }

    pub async fn fs(&self, spec: &ConnectionSpec) -> Result<Fs, String> {
        self.remember(spec);
        self.files.get(&self.shared, &self.ssh, spec).await
    }

    /// File access for a connection the UI has already used (by id).
    pub async fn fs_by_id(&self, connection_id: &str) -> Result<Fs, String> {
        let spec = self
            .specs
            .lock()
            .unwrap()
            .get(connection_id)
            .cloned()
            .ok_or("Unknown connection")?;
        self.fs(&spec).await
    }

    /// Run one UI request; failures go to the app log (Session → Log…).
    pub async fn dispatch(self: &Arc<Self>, method: &str, value: Value) -> Result<Value, String> {
        log::trace!("request {method}");
        let result = self.handle(method, value).await;
        if let Err(error) = &result {
            // Probes the UI expects to fail now and then stay at debug level.
            if matches!(method, "terminal.cwd" | "config.load" | "fs.home") {
                log::debug!("{method}: {error}");
            } else {
                log::warn!("{method}: {error}");
            }
        }
        result
    }

    async fn handle(self: &Arc<Self>, method: &str, value: Value) -> Result<Value, String> {
        match method {
            "terminal.start" => {
                let p: StartParams = params(value)?;
                self.remember(&p.connection);
                // Before the start: the shell's first output already goes to the screen model.
                self.agents.open(&p.session_id, p.cols, p.rows);
                let started = self
                    .terminals
                    .start(
                        &self.shared,
                        &self.ssh,
                        p.session_id.clone(),
                        &p.connection,
                        p.cols,
                        p.rows,
                    )
                    .await;
                if let Err(error) = started {
                    self.agents.close(&p.session_id);
                    return Err(error);
                }
                if let Some(probe) = self.terminals.agent_probe(&p.session_id).await {
                    self.agents.set_probe(&p.session_id, probe);
                }
                Ok(Value::Null)
            }
            "terminal.write" => {
                let p: WriteParams = params(value)?;
                self.terminals
                    .write(&p.session_id, p.data.as_bytes())
                    .await?;
                Ok(Value::Null)
            }
            "terminal.resize" => {
                let p: ResizeParams = params(value)?;
                self.terminals.resize(&p.session_id, p.cols, p.rows).await?;
                if p.cols > 0 && p.rows > 0 {
                    self.agents.resize(&p.session_id, p.cols, p.rows);
                }
                Ok(Value::Null)
            }
            "terminal.cwd" => {
                let p: SessionParams = params(value)?;
                Ok(json!(self.terminals.cwd(&p.session_id).await?))
            }
            "terminal.close" => {
                let p: SessionParams = params(value)?;
                self.terminals.close(&p.session_id).await;
                self.agents.close(&p.session_id);
                Ok(Value::Null)
            }
            "connection.disconnect" => {
                let p: ConnectionIdParams = params(value)?;
                for session in self.terminals.sessions_of(&p.connection_id) {
                    self.terminals.close(&session).await;
                    self.agents.close(&session);
                }
                self.files.drop_session(&p.connection_id).await;
                self.ssh.disconnect(&p.connection_id).await;
                self.monitor.forget(&p.connection_id);
                Ok(Value::Null)
            }
            "agent.focus" => {
                let p: FocusParams = params(value)?;
                self.agents.focus(p.session_id);
                Ok(Value::Null)
            }
            "auth.respond" => {
                let p: RespondParams = params(value)?;
                Ok(json!(self.shared.prompts.respond(&p.request_id, p.answers)))
            }
            "fs.home" => {
                let p: FsParams = params(value)?;
                Ok(json!(self.fs(&p.connection).await?.home().await?))
            }
            "fs.list" => {
                let p: FsParams = params(value)?;
                let fs = self.fs(&p.connection).await?;
                let path = if p.path.trim().is_empty() {
                    fs.home().await?
                } else {
                    fs.canonical(p.path.trim()).await?
                };
                let entries = fs.list(&path).await?;
                Ok(json!({ "path": path, "entries": entries }))
            }
            "fs.mkdir" => {
                let p: FsParams = params(value)?;
                self.fs(&p.connection).await?.mkdir(&p.path).await?;
                Ok(Value::Null)
            }
            "fs.rename" => {
                let p: RenameParams = params(value)?;
                self.fs(&p.connection).await?.rename(&p.from, &p.to).await?;
                Ok(Value::Null)
            }
            // Filer → Move to… / Copy to…: `to` is the full new path (destination folder + name).
            "fs.copy" | "fs.move" => {
                let p: RenameParams = params(value)?;
                let (from, to) = (p.from.trim(), p.to.trim());
                if from.is_empty() || to.is_empty() || from == "/" {
                    return Err("Refusing to use this path".into());
                }
                if to == from || to.starts_with(&format!("{}/", from.trim_end_matches('/'))) {
                    return Err(format!("Cannot put {from} inside itself"));
                }
                let fs = self.fs(&p.connection).await?;
                if fs.exists(to).await? {
                    return Err(format!("{to} already exists"));
                }
                if method == "fs.copy" {
                    fs.copy_tree(from, to).await?;
                } else {
                    fs.move_to(from, to).await?;
                }
                Ok(Value::Null)
            }
            "fs.remove" => {
                let p: FsParams = params(value)?;
                if p.path.trim().is_empty() || p.path.trim() == "/" {
                    return Err("Refusing to delete this path".into());
                }
                self.fs(&p.connection).await?.remove(&p.path).await?;
                Ok(Value::Null)
            }
            "fs.transfer" => {
                let p: TransferParams = params(value)?;
                let source = self.fs(&p.from.connection).await?;
                let target = self.fs(&p.to.connection).await?;
                let (reader, size) = source.open_read(&p.from.path).await?;
                let writer = target.open_write(&p.to.path).await?;
                let bytes = self
                    .files
                    .copy(&self.shared, &p.transfer_id, reader, writer, size)
                    .await?;
                Ok(json!(bytes))
            }
            "fs.cancel" => {
                let p: CancelParams = params(value)?;
                Ok(json!(self.files.cancel(&p.transfer_id)))
            }
            "config.dir" => Ok(json!(config::config_dir()?.display().to_string())),
            // Session dialog → Remember password: encrypted value stored as `savedPassword`.
            "secret.seal" => {
                let p: SealParams = params(value)?;
                Ok(json!(crate::common::secret::seal(&p.text)?))
            }
            "config.load" => {
                let p: ConfigParams = params(value)?;
                Ok(json!(config::load(&p.name)?))
            }
            "config.save" => {
                let p: ConfigParams = params(value)?;
                config::save(&p.name, &p.content)?;
                Ok(Value::Null)
            }
            // Settings → TERMINAL COLORS: the iTerm2 schemes in ~/.metroterm/themes/{black,white}.
            "themes.list" => Ok(json!(crate::common::themes::list()?)),
            "themes.load" => {
                let p: ThemeParams = params(value)?;
                Ok(json!(crate::common::themes::load(&p.folder, &p.name)?))
            }
            "config.open" => {
                // Session → Preferences → Profiles Directory…: show ~/.metroterm in the file manager.
                let dir = config::ensure_dir()?;
                open_in_file_manager(&dir)?;
                Ok(json!(dir.display().to_string()))
            }
            "file.saveText" => {
                // Session → Save Selection As… / Log → Save Output As…: the path comes from the
                // native Save dialog; written as UTF-8, replacing an existing file (the dialog asked).
                let p: SaveTextParams = params(value)?;
                let path = expand_home(&p.path);
                if let Some(parent) = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                {
                    if !parent.is_dir() {
                        return Err(format!("Folder does not exist: {}", parent.display()));
                    }
                }
                tokio::fs::write(&path, p.text.as_bytes())
                    .await
                    .map_err(|error| format!("Cannot write {}: {error}", path.display()))?;
                Ok(json!(p.text.len()))
            }
            "system.shells" => Ok(json!(crate::terminal::available_shells())),
            // "windows" | "macos" | "linux" …: the UI picks the built-in local shells by it.
            "system.os" => Ok(json!(std::env::consts::OS)),
            "system.serialPorts" => Ok(json!(tokio::task::spawn_blocking(
                crate::terminal::stream::serial_ports
            )
            .await
            .unwrap_or_default())),
            // Session → Log…: apply level / file / format (also saved in settings.json by the UI).
            "log.configure" => {
                let config: crate::common::applog::LogConfig = params(value)?;
                Ok(json!(crate::common::applog::configure(config)?))
            }
            "log.defaultPath" => Ok(json!(crate::common::applog::default_path()
                .display()
                .to_string())),
            "log.write" => {
                let p: LogWriteParams = params(value)?;
                crate::common::applog::write(&p.level, &p.message);
                Ok(Value::Null)
            }
            "log.open" => {
                // Show the folder of the log file in the file manager.
                let config: crate::common::applog::LogConfig = params(value)?;
                let file = config.file();
                let dir = file
                    .parent()
                    .map(|dir| dir.to_path_buf())
                    .unwrap_or_default();
                std::fs::create_dir_all(&dir)
                    .map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;
                open_in_file_manager(&dir)?;
                Ok(json!(dir.display().to_string()))
            }
            // Session → Proxy… → Test: open a tunnel to host:port through the proxy; with a path,
            // also send an HTTP GET through it and return the status code.
            "proxy.test" => {
                let p: ProxyTestParams = params(value)?;
                let started = std::time::Instant::now();
                let host = p.host.trim();
                let stream = crate::remote::net::connect(host, p.port, Some(&p.proxy)).await?;
                let status = match p.path.as_deref() {
                    Some(path) => {
                        Some(crate::remote::net::http_probe(stream, host, p.port, path).await?)
                    }
                    None => None,
                };
                Ok(json!({ "ms": started.elapsed().as_millis() as u64, "status": status }))
            }
            // Monitor panel: one snapshot of the session's host (never connects by itself).
            "monitor.sample" => {
                let p: MonitorParams = params(value)?;
                let ssh = self.ssh.connected(&p.connection.id);
                Ok(json!(self.monitor.sample(&p.connection, ssh).await?))
            }
            "monitor.signal" => {
                let p: MonitorSignalParams = params(value)?;
                let ssh = self.ssh.connected(&p.connection.id);
                self.monitor
                    .signal(&p.connection, ssh, p.pid, p.signal)
                    .await?;
                Ok(Value::Null)
            }
            "tunnel.start" => {
                let p: TunnelStartParams = params(value)?;
                self.remember(&p.connection);
                let status = self
                    .tunnels
                    .start(&self.shared, &self.ssh, p.tunnel, &p.connection)
                    .await?;
                Ok(json!(status))
            }
            "tunnel.stop" => {
                let p: TunnelIdParams = params(value)?;
                Ok(json!(self.tunnels.stop(&self.shared, &p.id).await))
            }
            "tunnel.list" => Ok(json!(self.tunnels.list())),
            #[cfg(feature = "server")]
            "mcp.status" => Ok(json!(crate::mcp::status())),
            #[cfg(feature = "server")]
            "mcp.configure" => {
                let config: crate::mcp::McpConfig = params(value)?;
                Ok(json!(crate::mcp::configure(config)))
            }
            #[cfg(feature = "server")]
            "mcp.reply" => {
                let p: ReplyParams = params(value)?;
                let result = match p.error {
                    None => Ok(p.result.unwrap_or(Value::Null)),
                    Some(error) => Err((p.code.unwrap_or_default(), error)),
                };
                Ok(json!(crate::mcp::ui_reply(&p.request_id, result)))
            }
            "ping" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
            _ => Err(format!("Unknown method: {method}")),
        }
    }

    /// Client went away: cancel prompts, close terminals and connections.
    pub async fn shutdown(&self) {
        self.shared.prompts.cancel_all();
        self.tunnels.stop_all(&self.shared).await;
        self.terminals.close_all().await;
        self.files.drop_all().await;
        self.ssh.disconnect_all().await;
    }
}

/// Open a directory in the system file manager (xdg-open / open / explorer), without waiting for it.
fn open_in_file_manager(dir: &std::path::Path) -> Result<(), String> {
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut child = std::process::Command::new(program)
        .arg(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("cannot run {program}: {error}"))?;
    // Reap it in the background so no zombie is left behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// `~/…` → the home directory (a path typed by hand); anything else unchanged.
fn expand_home(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path
        .strip_prefix("~/")
        .or(if path == "~" { Some("") } else { None })
    {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    std::path::PathBuf::from(path)
}
