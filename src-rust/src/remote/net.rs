//! Outgoing connections for SSH, Telnet and raw TCP sessions: directly, through a proxy — SOCKS5
//! (RFC 1928, user/password RFC 1929) or HTTP CONNECT — or through a jump host (an SSH session
//! whose server opens the connection: a `direct-tcpip` channel, like `ssh -J`).
//!
//! Which way a session goes ([`crate::remote::ssh::ConnectionSpec::route`]): the session's own proxy
//! setting (Session Settings → PROXY) when it has one, else the app-wide one (Session → Proxy…).

use crate::remote::ssh::{ConnectionSpec, Shared, SshHandle, SshPool};
use base64::Engine;
use serde::Deserialize;
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};

const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxySpec {
    /// none | socks5 | http | jump (sessions only)
    #[serde(rename = "type")]
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Sealed with common/secret.rs (never plain text in the config).
    pub saved_password: Option<String>,
    /// `jump`: the jump host's SSH session config, resolved by the UI (it may have a jump host itself).
    pub jump: Option<Box<ConnectionSpec>>,
}

/// How a session reaches its host.
pub enum Route {
    Direct,
    Proxy(ProxySpec),
    Jump(Box<ConnectionSpec>),
}

/// A connected byte stream: a TCP socket, or an SSH channel through a jump host.
pub trait Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Socket for T {}
pub type BoxSocket = Box<dyn Socket>;

/// Connection to `host:port` for the session `spec`, the way its [`Route`] says.
///
/// A boxed `Send` future rather than an `async fn`: through a jump host this calls
/// [`SshPool::get`], which connects that host with this function again (its own route), and the
/// explicit type is what lets the compiler see that the recursion stays `Send`.
pub fn open<'a>(
    shared: &'a Arc<Shared>,
    pool: &'a SshPool,
    spec: &'a ConnectionSpec,
    host: &'a str,
    port: u16,
) -> Pin<Box<dyn Future<Output = Result<BoxSocket, String>> + Send + 'a>> {
    Box::pin(async move {
        match spec.route()? {
            Route::Direct => Ok(Box::new(connect(host, port, None).await?) as BoxSocket),
            Route::Proxy(proxy) => {
                Ok(Box::new(connect(host, port, Some(&proxy)).await?) as BoxSocket)
            }
            Route::Jump(jump) => {
                let via = jump.label();
                log::info!("Connecting to {host}:{port} through jump host {via}");
                let handle: Arc<SshHandle> = pool
                    .get(shared, &jump)
                    .await
                    .map_err(|error| format!("Jump host {via}: {error}"))?;
                let open = handle.channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0);
                let channel = tokio::time::timeout(TIMEOUT, open)
                    .await
                    .map_err(|_| {
                        format!("Connection to {host}:{port} through jump host {via} timed out")
                    })?
                    .map_err(|error| {
                        format!(
                            "Jump host {via} cannot reach {host}:{port}: {}",
                            crate::remote::tunnel::open_error(&error)
                        )
                    })?;
                Ok(Box::new(channel.into_stream()) as BoxSocket)
            }
        }
    })
}

impl ProxySpec {
    pub fn active(&self) -> bool {
        matches!(self.kind.as_str(), "socks5" | "http") && !self.host.trim().is_empty()
    }
    fn password(&self) -> String {
        self.saved_password
            .as_deref()
            .and_then(crate::common::secret::open)
            .unwrap_or_default()
    }
}

/// TCP connection to `host:port`, through `proxy` when one is set.
pub async fn connect(
    host: &str,
    port: u16,
    proxy: Option<&ProxySpec>,
) -> Result<TcpStream, String> {
    let work = async {
        match proxy.filter(|proxy| proxy.active()) {
            None => TcpStream::connect((host, port))
                .await
                .map_err(|error| format!("Cannot connect to {host}:{port}: {error}")),
            Some(proxy) => {
                let via = format!("{}:{}", proxy.host.trim(), proxy.port);
                log::info!(
                    "Connecting to {host}:{port} through {} proxy {via}",
                    proxy.kind
                );
                let mut stream = TcpStream::connect((proxy.host.trim(), proxy.port))
                    .await
                    .map_err(|error| format!("Cannot connect to proxy {via}: {error}"))?;
                if proxy.kind == "socks5" {
                    socks5(&mut stream, host, port, proxy).await
                } else {
                    http_connect(&mut stream, host, port, proxy).await
                }
                .map_err(|error| format!("Proxy {via}: {error}"))?;
                Ok(stream)
            }
        }
    };
    let stream = tokio::time::timeout(TIMEOUT, work)
        .await
        .map_err(|_| format!("Connection to {host}:{port} timed out"))??;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

async fn socks5(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    proxy: &ProxySpec,
) -> Result<(), String> {
    let io = |error: std::io::Error| error.to_string();
    let with_login = !proxy.username.is_empty();
    // Greeting: no authentication, plus username / password when configured.
    let methods: &[u8] = if with_login { &[0x00, 0x02] } else { &[0x00] };
    let mut hello = vec![0x05, methods.len() as u8];
    hello.extend_from_slice(methods);
    stream.write_all(&hello).await.map_err(io)?;
    let mut reply = [0_u8; 2];
    stream.read_exact(&mut reply).await.map_err(io)?;
    if reply[0] != 0x05 {
        return Err("not a SOCKS5 proxy".into());
    }
    match reply[1] {
        0x00 => {}
        0x02 => {
            let password = proxy.password();
            let (user, pass) = (proxy.username.as_bytes(), password.as_bytes());
            if user.len() > 255 || pass.len() > 255 {
                return Err("user name or password too long".into());
            }
            let mut login = vec![0x01, user.len() as u8];
            login.extend_from_slice(user);
            login.push(pass.len() as u8);
            login.extend_from_slice(pass);
            stream.write_all(&login).await.map_err(io)?;
            let mut status = [0_u8; 2];
            stream.read_exact(&mut status).await.map_err(io)?;
            if status[1] != 0 {
                return Err("user name or password rejected".into());
            }
        }
        0xff => return Err("no accepted authentication method (user name required?)".into()),
        other => return Err(format!("unsupported authentication method {other}")),
    }
    // CONNECT by host name (the proxy resolves it).
    if host.len() > 255 {
        return Err("host name too long".into());
    }
    let mut request = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(io)?;
    let mut head = [0_u8; 4];
    stream.read_exact(&mut head).await.map_err(io)?;
    if head[1] != 0x00 {
        let reason = match head[1] {
            0x01 => "general failure",
            0x02 => "connection not allowed by ruleset",
            0x03 => "network unreachable",
            0x04 => "host unreachable",
            0x05 => "connection refused",
            0x06 => "TTL expired",
            0x07 => "command not supported",
            0x08 => "address type not supported",
            _ => "request rejected",
        };
        return Err(format!("cannot reach {host}:{port}: {reason}"));
    }
    // Bound address (ignored) + port.
    let skip = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len).await.map_err(io)?;
            len[0] as usize
        }
        _ => return Err("malformed reply".into()),
    };
    let mut rest = vec![0_u8; skip + 2];
    stream.read_exact(&mut rest).await.map_err(io)?;
    Ok(())
}

async fn http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    proxy: &ProxySpec,
) -> Result<(), String> {
    let io = |error: std::io::Error| error.to_string();
    let target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if !proxy.username.is_empty() {
        let token = base64::engine::general_purpose::STANDARD.encode(format!(
            "{}:{}",
            proxy.username,
            proxy.password()
        ));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.map_err(io)?;
    // Response head, byte by byte so nothing after it (the tunnel's first bytes) is consumed.
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.map_err(io)? == 0 {
            return Err("closed the connection".into());
        }
        head.push(byte[0]);
        if head.len() > 16 * 1024 {
            return Err("response too long".into());
        }
    }
    let head = String::from_utf8_lossy(&head);
    let status = head.lines().next().unwrap_or_default();
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(()),
        Some("407") => Err("proxy authentication required / rejected".into()),
        _ => Err(format!("CONNECT refused: {status}")),
    }
}

/// Proxy test: `GET path` over plain HTTP on an open connection; returns the response status code.
pub async fn http_probe(
    mut stream: TcpStream,
    host: &str,
    port: u16,
    path: &str,
) -> Result<u16, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let authority = if port == 80 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nUser-Agent: MetroTerm/{}\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        env!("CARGO_PKG_VERSION")
    );
    let work = async {
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|error| format!("Cannot send the HTTP request: {error}"))?;
        // Only the status line is needed: "HTTP/1.1 204 No Content".
        let mut head = Vec::new();
        let mut buf = [0u8; 512];
        while !head.contains(&b'\n') && head.len() < 4096 {
            let n = stream
                .read(&mut buf)
                .await
                .map_err(|error| format!("Cannot read the HTTP response: {error}"))?;
            if n == 0 {
                break;
            }
            head.extend_from_slice(&buf[..n]);
        }
        parse_status_line(&head)
            .ok_or_else(|| format!("{host} did not answer with HTTP (is the port right?)"))
    };
    tokio::time::timeout(TIMEOUT, work).await.map_err(|_| {
        format!(
            "No HTTP response from {authority}{path} within {} s",
            TIMEOUT.as_secs()
        )
    })?
}

fn parse_status_line(head: &[u8]) -> Option<u16> {
    let line = head.split(|byte| *byte == b'\n').next()?;
    let line = std::str::from_utf8(line).ok()?;
    let mut parts = line.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::parse_status_line;

    #[test]
    fn status_line() {
        assert_eq!(
            parse_status_line(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n"),
            Some(204)
        );
        assert_eq!(parse_status_line(b"HTTP/1.0 404 Not Found\r\n"), Some(404));
        assert_eq!(parse_status_line(b"SSH-2.0-OpenSSH_8.9\r\n"), None);
        assert_eq!(parse_status_line(b""), None);
    }
}
