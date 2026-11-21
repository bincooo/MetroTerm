//! SSH port forwarding (Tunnels), like OpenSSH `-L`, `-R` and `-D`.
//!
//! - **Local** (`-L`): listen on a local address; every accepted connection opens a
//!   `direct-tcpip` channel to `destination` as seen from the SSH server.
//! - **Remote** (`-R`): ask the server to listen (`tcpip-forward`); every `forwarded-tcpip`
//!   channel it opens is connected to `destination` as seen from this computer.
//! - **Dynamic** (`-D`): a local SOCKS 4 / 4a / 5 proxy (CONNECT, no authentication); each
//!   request opens a `direct-tcpip` channel to the host the client asked for.
//!
//! Tunnels share the session's SSH connection ([`crate::ssh::SshPool`]). When that connection
//! closes the tunnel stops listening and reports an error; Start brings it back.
//! The UI polls `tunnel.list` for state and traffic counters.

use crate::ssh::{ConnectionSpec, Shared, SshHandle, SshPool, Transport};
use russh::{client::Msg, Channel};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A SOCKS client must finish its request within this time.
const SOCKS_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelKind {
    Local,
    Remote,
    Dynamic,
}

/// One tunnel as configured in the UI (Tunnels dialog).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    pub id: String,
    pub kind: TunnelKind,
    /// Local / Dynamic: local address; Remote: address on the SSH server. Empty = loopback.
    #[serde(default)]
    pub bind_host: String,
    /// 0 = any free port (the one chosen is reported as `boundPort`).
    #[serde(default)]
    pub bind_port: u16,
    /// Local: host as seen from the server; Remote: host as seen from this computer.
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
}

#[derive(Default)]
pub struct Stats {
    active: AtomicU32,
    total: AtomicU64,
    /// Bytes from the forwarded side to the local side (received).
    rx: AtomicU64,
    /// Bytes from the local side to the forwarded side (sent).
    tx: AtomicU64,
}

/// State reported to the UI by `tunnel.list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub connection_id: String,
    pub kind: TunnelKind,
    /// "running" or "error" (stopped by itself, e.g. the SSH connection closed).
    pub state: &'static str,
    /// Error of the tunnel, or of its last failed connection while running.
    pub message: Option<String>,
    pub bound_host: String,
    pub bound_port: u16,
    pub active: u32,
    pub total: u64,
    pub rx: u64,
    pub tx: u64,
    /// Unix time (ms) the tunnel started.
    pub started: u64,
}

struct Running {
    connection_id: String,
    kind: TunnelKind,
    bound_host: String,
    bound_port: u16,
    started: u64,
    stats: Arc<Stats>,
    /// (state, message) — shared with the tasks of the tunnel.
    report: Arc<Mutex<(&'static str, Option<String>)>>,
    stop: watch::Sender<bool>,
    handle: Arc<SshHandle>,
}

/// Target of a remote forward, looked up by the SSH client handler when the server opens a
/// `forwarded-tcpip` channel. Keyed by (connection id, port listening on the server).
#[derive(Clone)]
pub struct RemoteTarget {
    dest_host: String,
    dest_port: u16,
    stats: Arc<Stats>,
    report: Arc<Mutex<(&'static str, Option<String>)>>,
    stop: watch::Receiver<bool>,
}

#[derive(Default)]
pub struct RemoteForwards(Mutex<HashMap<(String, u32), RemoteTarget>>);

impl RemoteForwards {
    /// Called by [`crate::ssh::ClientHandler`] for each `forwarded-tcpip` channel: connect it to
    /// the local destination. Returns false when no tunnel of this connection uses the port.
    pub fn open(&self, connection_id: &str, port: u32, channel: Channel<Msg>) -> bool {
        let target = self
            .0
            .lock()
            .unwrap()
            .get(&(connection_id.to_owned(), port))
            .cloned();
        let Some(target) = target else {
            return false;
        };
        tokio::spawn(async move {
            let address = format!("{}:{}", target.dest_host, target.dest_port);
            match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&address)).await {
                Ok(Ok(socket)) => {
                    let _ = socket.set_nodelay(true);
                    pipe(socket, channel.into_stream(), &target.stats, target.stop).await;
                }
                Ok(Err(error)) => {
                    note(
                        &target.report,
                        format!("Connect to {address} failed: {}", io_text(&error)),
                    );
                    let _ = channel.close().await;
                }
                Err(_) => {
                    note(&target.report, format!("Connect to {address} timed out"));
                    let _ = channel.close().await;
                }
            }
        });
        true
    }

    fn insert(&self, connection_id: &str, port: u32, target: RemoteTarget) {
        self.0
            .lock()
            .unwrap()
            .insert((connection_id.to_owned(), port), target);
    }

    fn remove(&self, connection_id: &str, port: u32) {
        self.0
            .lock()
            .unwrap()
            .remove(&(connection_id.to_owned(), port));
    }
}

/// Running tunnels by id.
#[derive(Default)]
pub struct Tunnels {
    running: Mutex<HashMap<String, Running>>,
}

/// Resolves once the tunnel is stopped (the `watch::Ref` is dropped here: it is not `Send`).
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|value| *value).await;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as u64)
        .unwrap_or(0)
}

/// Remember a failed connection of a running tunnel (shown in the Tunnels dialog).
fn note(report: &Mutex<(&'static str, Option<String>)>, message: String) {
    log::info!("tunnel: {message}");
    report.lock().unwrap().1 = Some(message);
}

/// `channel_open_direct_tcpip` errors in words (russh only prints the reason code).
fn open_error(error: &russh::Error) -> String {
    use russh::ChannelOpenFailure as Failure;
    match error {
        russh::Error::ChannelOpenFailure(Failure::ConnectFailed) => {
            "the server could not connect to it (refused or unreachable)".into()
        }
        russh::Error::ChannelOpenFailure(Failure::AdministrativelyProhibited) => {
            "the server does not allow port forwarding (AllowTcpForwarding)".into()
        }
        russh::Error::ChannelOpenFailure(Failure::ResourceShortage) => {
            "the server is out of resources".into()
        }
        other => other.to_string(),
    }
}

/// io::Error text without the " (os error N)" suffix.
fn io_text(error: &std::io::Error) -> String {
    let text = error.to_string();
    match text.rfind(" (os error ") {
        Some(at) => text[..at].to_owned(),
        None => text,
    }
}

fn loopback_or(host: &str, fallback: &str) -> String {
    let host = host.trim();
    if host.is_empty() {
        fallback.to_owned()
    } else {
        host.to_owned()
    }
}

impl Tunnels {
    pub fn list(&self) -> Vec<TunnelStatus> {
        let running = self.running.lock().unwrap();
        let mut list: Vec<TunnelStatus> = running
            .iter()
            .map(|(id, tunnel)| {
                let report = tunnel.report.lock().unwrap().clone();
                TunnelStatus {
                    id: id.clone(),
                    connection_id: tunnel.connection_id.clone(),
                    kind: tunnel.kind,
                    state: report.0,
                    message: report.1,
                    bound_host: tunnel.bound_host.clone(),
                    bound_port: tunnel.bound_port,
                    active: tunnel.stats.active.load(Ordering::Relaxed),
                    total: tunnel.stats.total.load(Ordering::Relaxed),
                    rx: tunnel.stats.rx.load(Ordering::Relaxed),
                    tx: tunnel.stats.tx.load(Ordering::Relaxed),
                    started: tunnel.started,
                }
            })
            .collect();
        list.sort_by(|a, b| a.started.cmp(&b.started));
        list
    }

    /// Start (or restart) a tunnel over the session's SSH connection (connects if needed —
    /// may ask for a password).
    pub async fn start(
        &self,
        shared: &Arc<Shared>,
        pool: &SshPool,
        spec: TunnelSpec,
        connection: &ConnectionSpec,
    ) -> Result<TunnelStatus, String> {
        if connection.transport != Transport::Ssh {
            return Err("Tunnels need an SSH session".into());
        }
        if spec.kind != TunnelKind::Dynamic
            && (spec.dest_host.trim().is_empty() || spec.dest_port == 0)
        {
            return Err("Destination host and port are required".into());
        }
        if spec.kind == TunnelKind::Remote && spec.bind_port == 0 {
            // Allowed by the protocol, but nobody could know which port to use.
            return Err("Remote forwarding needs a listen port".into());
        }
        self.stop(shared, &spec.id).await;
        let handle = pool.get(shared, connection).await?;
        let stats = Arc::new(Stats::default());
        let report = Arc::new(Mutex::new(("running", None)));
        let (stop, stop_rx) = watch::channel(false);
        let dest_host = spec.dest_host.trim().to_owned();

        let (bound_host, bound_port) = match spec.kind {
            TunnelKind::Local | TunnelKind::Dynamic => {
                let host = loopback_or(&spec.bind_host, "127.0.0.1");
                let listener = TcpListener::bind((host.as_str(), spec.bind_port))
                    .await
                    .map_err(|error| {
                        format!(
                            "Cannot listen on {host}:{}: {}",
                            spec.bind_port,
                            io_text(&error)
                        )
                    })?;
                let port = listener
                    .local_addr()
                    .map(|addr| addr.port())
                    .unwrap_or(spec.bind_port);
                let local = Forward {
                    handle: handle.clone(),
                    stats: stats.clone(),
                    report: report.clone(),
                    stop: stop_rx.clone(),
                };
                let target =
                    (spec.kind == TunnelKind::Local).then(|| (dest_host.clone(), spec.dest_port));
                tokio::spawn(local.accept_loop(listener, target));
                (host, port)
            }
            TunnelKind::Remote => {
                let host = loopback_or(&spec.bind_host, "localhost");
                let port = handle
                    .tcpip_forward(host.clone(), u32::from(spec.bind_port))
                    .await
                    .map_err(|error| {
                        match error {
                            russh::Error::RequestDenied => format!(
                                "The server refused to listen on {host}:{} (port in use, privileged, or remote forwarding disabled)",
                                spec.bind_port
                            ),
                            other => format!("Remote forward {host}:{} failed: {other}", spec.bind_port),
                        }
                    })?;
                // The reply carries a port only when 0 was requested.
                let port = if port == 0 {
                    u32::from(spec.bind_port)
                } else {
                    port
                };
                shared.forwards.insert(
                    &connection.id,
                    port,
                    RemoteTarget {
                        dest_host: dest_host.clone(),
                        dest_port: spec.dest_port,
                        stats: stats.clone(),
                        report: report.clone(),
                        stop: stop_rx.clone(),
                    },
                );
                (host, port as u16)
            }
        };
        log::info!(
            "tunnel {:?} {bound_host}:{bound_port} → {dest_host}:{} via {}",
            spec.kind,
            spec.dest_port,
            connection.label()
        );

        // Stop by itself when the SSH connection goes away.
        tokio::spawn(watch_connection(
            handle.clone(),
            report.clone(),
            stop.clone(),
            stop_rx,
            shared.clone(),
            connection.id.clone(),
            (spec.kind == TunnelKind::Remote).then_some(u32::from(bound_port)),
        ));

        let running = Running {
            connection_id: connection.id.clone(),
            kind: spec.kind,
            bound_host,
            bound_port,
            started: now_ms(),
            stats,
            report,
            stop,
            handle,
        };
        self.running
            .lock()
            .unwrap()
            .insert(spec.id.clone(), running);
        self.list()
            .into_iter()
            .find(|status| status.id == spec.id)
            .ok_or_else(|| "Tunnel stopped at once".into())
    }

    /// Stop a tunnel: close its listener and every connection through it.
    pub async fn stop(&self, shared: &Shared, id: &str) -> bool {
        let Some(tunnel) = self.running.lock().unwrap().remove(id) else {
            return false;
        };
        let _ = tunnel.stop.send(true);
        if tunnel.kind == TunnelKind::Remote {
            shared
                .forwards
                .remove(&tunnel.connection_id, u32::from(tunnel.bound_port));
            if !tunnel.handle.is_closed() {
                let _ = tunnel
                    .handle
                    .cancel_tcpip_forward(tunnel.bound_host.clone(), u32::from(tunnel.bound_port))
                    .await;
            }
        }
        log::info!("tunnel {id} stopped");
        true
    }

    pub async fn stop_all(&self, shared: &Shared) {
        let ids: Vec<String> = self.running.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop(shared, &id).await;
        }
    }
}

async fn watch_connection(
    handle: Arc<SshHandle>,
    report: Arc<Mutex<(&'static str, Option<String>)>>,
    stop: watch::Sender<bool>,
    mut stop_rx: watch::Receiver<bool>,
    shared: Arc<Shared>,
    connection_id: String,
    remote_port: Option<u32>,
) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = stopped(&mut stop_rx) => return,
            _ = tick.tick() => {
                if handle.is_closed() {
                    *report.lock().unwrap() = ("error", Some("SSH connection closed".into()));
                    if let Some(port) = remote_port {
                        shared.forwards.remove(&connection_id, port);
                    }
                    let _ = stop.send(true);
                    return;
                }
            }
        }
    }
}

/// Listener side of a Local or Dynamic tunnel.
struct Forward {
    handle: Arc<SshHandle>,
    stats: Arc<Stats>,
    report: Arc<Mutex<(&'static str, Option<String>)>>,
    stop: watch::Receiver<bool>,
}

impl Forward {
    /// `target`: fixed destination (Local), or None for SOCKS (Dynamic).
    async fn accept_loop(self, listener: TcpListener, target: Option<(String, u16)>) {
        let this = Arc::new(self);
        let mut stop = this.stop.clone();
        loop {
            tokio::select! {
                _ = stopped(&mut stop) => return,
                accepted = listener.accept() => {
                    let (socket, peer) = match accepted {
                        Ok(pair) => pair,
                        Err(error) => {
                            note(&this.report, format!("Accept failed: {error}"));
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            continue;
                        }
                    };
                    let _ = socket.set_nodelay(true);
                    let this = this.clone();
                    let target = target.clone();
                    tokio::spawn(async move {
                        match target {
                            Some((host, port)) => this.forward(socket, peer, &host, port).await,
                            None => this.socks(socket, peer).await,
                        }
                    });
                }
            }
        }
    }

    async fn open(&self, peer: SocketAddr, host: &str, port: u16) -> Result<Channel<Msg>, String> {
        let open = self.handle.channel_open_direct_tcpip(
            host,
            u32::from(port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        );
        match tokio::time::timeout(CONNECT_TIMEOUT, open).await {
            Ok(Ok(channel)) => Ok(channel),
            Ok(Err(error)) => Err(format!(
                "Connect to {host}:{port} through SSH failed: {}",
                open_error(&error)
            )),
            Err(_) => Err(format!("Connect to {host}:{port} through SSH timed out")),
        }
    }

    async fn forward(&self, socket: TcpStream, peer: SocketAddr, host: &str, port: u16) {
        match self.open(peer, host, port).await {
            Ok(channel) => {
                pipe(
                    socket,
                    channel.into_stream(),
                    &self.stats,
                    self.stop.clone(),
                )
                .await
            }
            Err(message) => note(&self.report, message),
        }
    }

    async fn socks(&self, mut socket: TcpStream, peer: SocketAddr) {
        let request = match tokio::time::timeout(SOCKS_TIMEOUT, socks_request(&mut socket)).await {
            Ok(Ok(request)) => request,
            Ok(Err(message)) => {
                note(
                    &self.report,
                    format!("SOCKS request from {peer} rejected: {message}"),
                );
                return;
            }
            Err(_) => return,
        };
        match self.open(peer, &request.host, request.port).await {
            Ok(channel) => {
                if socket.write_all(&request.reply(true)).await.is_ok() {
                    pipe(
                        socket,
                        channel.into_stream(),
                        &self.stats,
                        self.stop.clone(),
                    )
                    .await;
                }
            }
            Err(message) => {
                let _ = socket.write_all(&request.reply(false)).await;
                note(&self.report, message);
            }
        }
    }
}

/// A parsed SOCKS CONNECT request.
#[derive(Debug, PartialEq)]
struct SocksRequest {
    version: u8,
    host: String,
    port: u16,
}

impl SocksRequest {
    fn reply(&self, ok: bool) -> Vec<u8> {
        if self.version == 4 {
            // VN 0, CD 90 granted / 91 rejected, DSTPORT, DSTIP (ignored by clients).
            vec![0, if ok { 90 } else { 91 }, 0, 0, 0, 0, 0, 0]
        } else {
            // VER, REP (0 succeeded / 5 refused), RSV, ATYP IPv4, BND.ADDR 0.0.0.0, BND.PORT 0.
            vec![5, if ok { 0 } else { 5 }, 0, 1, 0, 0, 0, 0, 0, 0]
        }
    }
}

async fn read_until_nul<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let byte = stream.read_u8().await.map_err(|error| error.to_string())?;
        if byte == 0 {
            return Ok(bytes);
        }
        if bytes.len() >= 255 {
            return Err("field too long".into());
        }
        bytes.push(byte);
    }
}

/// Read a SOCKS 4 / 4a / 5 CONNECT request (SOCKS 5: "no authentication" only). Errors are
/// answered on the socket before returning.
async fn socks_request<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
) -> Result<SocksRequest, String> {
    let io = |error: std::io::Error| error.to_string();
    match stream.read_u8().await.map_err(io)? {
        4 => {
            let command = stream.read_u8().await.map_err(io)?;
            let port = stream.read_u16().await.map_err(io)?;
            let mut ip = [0u8; 4];
            stream.read_exact(&mut ip).await.map_err(io)?;
            read_until_nul(stream).await?; // user id
            if command != 1 {
                let _ = stream.write_all(&[0, 91, 0, 0, 0, 0, 0, 0]).await;
                return Err("only CONNECT is supported".into());
            }
            // SOCKS 4a: 0.0.0.x (x ≠ 0) means "host name follows".
            let host = if ip[..3] == [0, 0, 0] && ip[3] != 0 {
                String::from_utf8(read_until_nul(stream).await?).map_err(|_| "invalid host name")?
            } else {
                Ipv4Addr::from(ip).to_string()
            };
            Ok(SocksRequest {
                version: 4,
                host,
                port,
            })
        }
        5 => {
            let count = stream.read_u8().await.map_err(io)?;
            let mut methods = vec![0u8; usize::from(count)];
            stream.read_exact(&mut methods).await.map_err(io)?;
            if !methods.contains(&0) {
                let _ = stream.write_all(&[5, 0xff]).await;
                return Err("client requires authentication".into());
            }
            stream.write_all(&[5, 0]).await.map_err(io)?;
            let mut head = [0u8; 4];
            stream.read_exact(&mut head).await.map_err(io)?;
            let [version, command, _, kind] = head;
            if version != 5 {
                return Err("bad SOCKS 5 request".into());
            }
            let host = match kind {
                1 => {
                    let mut ip = [0u8; 4];
                    stream.read_exact(&mut ip).await.map_err(io)?;
                    IpAddr::from(ip).to_string()
                }
                3 => {
                    let length = stream.read_u8().await.map_err(io)?;
                    let mut name = vec![0u8; usize::from(length)];
                    stream.read_exact(&mut name).await.map_err(io)?;
                    String::from_utf8(name).map_err(|_| "invalid host name")?
                }
                4 => {
                    let mut ip = [0u8; 16];
                    stream.read_exact(&mut ip).await.map_err(io)?;
                    Ipv6Addr::from(ip).to_string()
                }
                _ => {
                    let _ = stream.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                    return Err("unsupported address type".into());
                }
            };
            let port = stream.read_u16().await.map_err(io)?;
            if command != 1 {
                let _ = stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                return Err("only CONNECT is supported".into());
            }
            Ok(SocksRequest {
                version: 5,
                host,
                port,
            })
        }
        other => Err(format!("not a SOCKS request (first byte {other})")),
    }
}

/// Copy both ways until both sides are done (half-close aware), counting bytes. `local` is the
/// socket on this computer, `remote` the SSH channel.
async fn pipe<L, R>(local: L, remote: R, stats: &Stats, mut stop: watch::Receiver<bool>)
where
    L: AsyncRead + AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin,
{
    stats.active.fetch_add(1, Ordering::Relaxed);
    stats.total.fetch_add(1, Ordering::Relaxed);
    let (mut local_read, mut local_write) = tokio::io::split(local);
    let (mut remote_read, mut remote_write) = tokio::io::split(remote);
    let up = copy_counting(&mut local_read, &mut remote_write, &stats.tx);
    let down = copy_counting(&mut remote_read, &mut local_write, &stats.rx);
    tokio::select! {
        _ = async { tokio::try_join!(up, down) } => {}
        _ = stopped(&mut stop) => {}
    }
    stats.active.fetch_sub(1, Ordering::Relaxed);
}

async fn copy_counting<R, W>(
    reader: &mut R,
    writer: &mut W,
    counter: &AtomicU64,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; 32 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            let _ = writer.shutdown().await;
            return Ok(());
        }
        writer.write_all(&buffer[..read]).await?;
        counter.fetch_add(read as u64, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn parse(bytes: &[u8]) -> (Result<SocksRequest, String>, Vec<u8>) {
        let (mut client, mut server) = tokio::io::duplex(1024);
        client.write_all(bytes).await.unwrap();
        let result = socks_request(&mut server).await;
        drop(server);
        let mut answer = Vec::new();
        client.read_to_end(&mut answer).await.unwrap();
        (result, answer)
    }

    #[tokio::test]
    async fn socks5_domain() {
        let mut bytes = vec![5, 1, 0, 5, 1, 0, 3, 11];
        bytes.extend_from_slice(b"example.com");
        bytes.extend_from_slice(&443u16.to_be_bytes());
        let (result, answer) = parse(&bytes).await;
        assert_eq!(
            result.unwrap(),
            SocksRequest {
                version: 5,
                host: "example.com".into(),
                port: 443
            }
        );
        assert_eq!(answer, vec![5, 0]);
    }

    #[tokio::test]
    async fn socks5_ipv4_and_ipv6() {
        let (result, _) = parse(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 22]).await;
        assert_eq!(result.unwrap().host, "10.0.0.7");
        let mut bytes = vec![5, 1, 0, 5, 1, 0, 4];
        bytes.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        bytes.extend_from_slice(&[0, 80]);
        let (result, _) = parse(&bytes).await;
        assert_eq!(
            result.unwrap(),
            SocksRequest {
                version: 5,
                host: "::1".into(),
                port: 80
            }
        );
    }

    #[tokio::test]
    async fn socks5_rejects_auth_only_and_bind() {
        let (result, answer) = parse(&[5, 1, 2]).await;
        assert!(result.is_err());
        assert_eq!(answer, vec![5, 0xff]);
        let (result, answer) = parse(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]).await;
        assert!(result.is_err());
        assert_eq!(answer[2..4], [5, 7]);
    }

    #[tokio::test]
    async fn socks4_and_4a() {
        let (result, _) = parse(&[4, 1, 0, 80, 192, 168, 1, 2, b'u', 0]).await;
        assert_eq!(
            result.unwrap(),
            SocksRequest {
                version: 4,
                host: "192.168.1.2".into(),
                port: 80
            }
        );
        let mut bytes = vec![4, 1, 1, 187, 0, 0, 0, 1, 0];
        bytes.extend_from_slice(b"db.internal\0");
        let (result, _) = parse(&bytes).await;
        assert_eq!(
            result.unwrap(),
            SocksRequest {
                version: 4,
                host: "db.internal".into(),
                port: 443
            }
        );
    }

    #[test]
    fn replies() {
        let v5 = SocksRequest {
            version: 5,
            host: String::new(),
            port: 0,
        };
        assert_eq!(v5.reply(true)[..2], [5, 0]);
        assert_eq!(v5.reply(false)[..2], [5, 5]);
        let v4 = SocksRequest {
            version: 4,
            host: String::new(),
            port: 0,
        };
        assert_eq!(v4.reply(true)[..2], [0, 90]);
    }
}
