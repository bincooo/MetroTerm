//! SSH transport (pure Rust, `russh`).
//!
//! One SSH connection per saved session config is shared by every terminal tab and the
//! SFTP browser of that session (multiplexed channels — like WindTerm / OpenSSH ControlMaster).
//!
//! Authentication order (OpenSSH-like): `none` → SSH agent → private keys
//! (configured file, or ~/.ssh/id_ed25519 · id_ecdsa · id_rsa) → password → keyboard-interactive.
//! Secrets are requested from the UI through [`Prompts`] and never stored.
//!
//! Host keys are verified against `~/.ssh/known_hosts` and `~/.metroterm/known_hosts`.
//! Unknown hosts are confirmed by the user; accepted keys are saved to `~/.metroterm/known_hosts`.
//! A changed key aborts the connection.

use crate::{
    config,
    events::{Event, EventSink, PromptField, Prompts},
};
use russh::{
    client::{self, AuthResult, DisconnectReason, KeyboardInteractiveAuthResponse},
    keys::{
        self, agent::client::AgentClient, known_hosts, HashAlg, PrivateKeyWithHashAlg, PublicKey,
        PublicKeyOrCertificate,
    },
    MethodKind, MethodSet,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite};

/// Saved session config as sent by the UI (no secrets).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSpec {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub transport: Transport,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth: AuthMethod,
    #[serde(default)]
    pub identity_file: Option<String>,
    /// Local sessions: shell executable (default: $SHELL / PowerShell).
    #[serde(default)]
    pub shell: Option<String>,
    /// "Remember password": encrypted with secret.rs (never plain text).
    #[serde(default)]
    pub saved_password: Option<String>,
    /// SSH / Telnet / TCP: bypass the proxy of Session → Proxy… for this session.
    #[serde(default)]
    pub no_proxy: bool,
    /// Telnet / TCP / Serial: show typed input locally (for peers that don't echo).
    #[serde(default)]
    pub local_echo: bool,
    /// Serial sessions.
    #[serde(default)]
    pub serial: SerialSpec,
}

/// Serial line settings (Serial sessions).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SerialSpec {
    /// /dev/ttyUSB0, COM3 …
    pub device: String,
    pub baud_rate: u32,
    /// 5 | 6 | 7 | 8
    pub data_bits: u8,
    /// none | odd | even
    pub parity: String,
    /// 1 | 2
    pub stop_bits: u8,
    /// none | software | hardware
    pub flow_control: String,
}

impl Default for SerialSpec {
    fn default() -> Self {
        Self {
            device: String::new(),
            baud_rate: 115_200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow_control: "none".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Local,
    Ssh,
    Telnet,
    Tcp,
    Serial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    #[default]
    Auto,
    Password,
    Key,
    Agent,
}

impl ConnectionSpec {
    pub fn user(&self) -> String {
        let user = self.username.trim();
        if !user.is_empty() {
            return user.to_owned();
        }
        std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_else(|_| "root".into())
    }
    pub fn port(&self) -> u16 {
        if self.port != 0 {
            return self.port;
        }
        match self.transport {
            Transport::Telnet => 23,
            _ => 22,
        }
    }
    pub fn label(&self) -> String {
        match self.transport {
            Transport::Ssh => format!("{}@{}:{}", self.user(), self.host.trim(), self.port()),
            Transport::Serial => format!("{} {}", self.serial.device, self.serial.baud_rate),
            _ => format!("{}:{}", self.host.trim(), self.port()),
        }
    }
    /// Proxy for SSH / Telnet / TCP (Session → Proxy…, saved in settings.json), unless bypassed.
    pub fn proxy(&self) -> Option<crate::net::ProxySpec> {
        if self.no_proxy {
            return None;
        }
        config::load("settings")
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|doc| doc.get("proxy").cloned())
            .and_then(|value| serde_json::from_value(value).ok())
    }
}

/// Shared context: event sink + prompt broker.
pub struct Shared {
    pub sink: Arc<dyn EventSink>,
    pub prompts: Prompts,
    /// Remote port forwards (Tunnels): where `forwarded-tcpip` channels go.
    pub forwards: crate::tunnel::RemoteForwards,
}

impl Shared {
    pub fn state(&self, connection_id: &str, state: &'static str, message: Option<String>) {
        self.sink.emit(Event::ConnectionState {
            connection_id: connection_id.to_owned(),
            state,
            message,
        });
    }
}

pub type SshHandle = client::Handle<ClientHandler>;

pub struct ClientHandler {
    shared: Arc<Shared>,
    connection_id: String,
    host: String,
    port: u16,
    /// Why the host key was rejected — reported instead of russh's generic error.
    rejection: Arc<Mutex<Option<String>>>,
}

fn known_hosts_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Some(home) = dirs::home_dir() {
        files.push(home.join(".ssh").join("known_hosts"));
    }
    if let Ok(dir) = config::config_dir() {
        files.push(dir.join("known_hosts"));
    }
    files
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key: PublicKey = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        for file in known_hosts_files() {
            match known_hosts::check_known_hosts_path(&self.host, self.port, &key, &file) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(keys::Error::KeyChanged { line }) => {
                    *self.rejection.lock().unwrap() = Some(format!(
                        "HOST KEY CHANGED for {}:{} ({} line {line}). Possible man-in-the-middle attack — connection refused. Remove the old entry if the change is expected.",
                        self.host, self.port, file.display()
                    ));
                    return Ok(false);
                }
                Err(_) => {}
            }
        }
        let fingerprint = key.fingerprint(HashAlg::Sha256);
        let message = format!(
            "The authenticity of host '{}:{}' can't be established.\n{} key fingerprint is {}.\nAre you sure you want to continue connecting?",
            self.host, self.port, key.algorithm().as_str(), fingerprint
        );
        let answer = self
            .shared
            .prompts
            .ask(
                &self.connection_id,
                "hostkey",
                "Unknown host key",
                message,
                Vec::new(),
            )
            .await;
        match answer
            .as_ref()
            .and_then(|answers| answers.first())
            .map(String::as_str)
        {
            Some("save") => {
                if let Ok(dir) = config::ensure_dir() {
                    let _ = known_hosts::learn_known_hosts_path(
                        &self.host,
                        self.port,
                        &key,
                        dir.join("known_hosts"),
                    );
                }
                Ok(true)
            }
            Some("once") => Ok(true),
            _ => {
                *self.rejection.lock().unwrap() = Some("Host key not accepted".into());
                Ok(false)
            }
        }
    }

    /// Remote forwarding (Tunnels): the server accepted a connection on a forwarded port.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        log::debug!(
            "forwarded-tcpip {connected_address}:{connected_port} from {originator_address}:{originator_port}"
        );
        // Accept first so the session loop never waits for the local connect.
        reply.accept().await;
        if !self
            .shared
            .forwards
            .open(&self.connection_id, connected_port, channel)
        {
            log::warn!("forwarded-tcpip for unknown port {connected_port}");
        }
        Ok(())
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let banner = banner.trim();
        if !banner.is_empty() {
            self.shared
                .state(&self.connection_id, "connecting", Some(banner.to_owned()));
        }
        Ok(())
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let message = match reason {
            DisconnectReason::ReceivedDisconnect(info) => {
                Some(info.message).filter(|text| !text.is_empty())
            }
            DisconnectReason::Error(error) => Some(error.to_string()),
        };
        self.shared.state(&self.connection_id, "offline", message);
        Ok(())
    }
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<SshHandle>>>>;

/// Live SSH connections keyed by session-config id.
#[derive(Default)]
pub struct SshPool {
    slots: Mutex<HashMap<String, Slot>>,
}

impl SshPool {
    /// Existing live connection or a new one (concurrent callers wait for the same connect).
    pub async fn get(
        &self,
        shared: &Arc<Shared>,
        spec: &ConnectionSpec,
    ) -> Result<Arc<SshHandle>, String> {
        let slot = self
            .slots
            .lock()
            .unwrap()
            .entry(spec.id.clone())
            .or_default()
            .clone();
        let mut guard = slot.lock().await;
        if let Some(handle) = guard.as_ref() {
            if !handle.is_closed() {
                return Ok(handle.clone());
            }
        }
        *guard = None;
        shared.state(&spec.id, "connecting", None);
        match connect(shared, spec).await {
            Ok(handle) => {
                let handle = Arc::new(handle);
                *guard = Some(handle.clone());
                shared.state(&spec.id, "online", None);
                Ok(handle)
            }
            Err(error) => {
                shared.state(&spec.id, "error", Some(error.clone()));
                Err(error)
            }
        }
    }

    /// The live connection of a session, without connecting (Monitor: never prompts for a password).
    pub fn connected(&self, id: &str) -> Option<Arc<SshHandle>> {
        let slot = self.slots.lock().unwrap().get(id).cloned()?;
        let guard = slot.try_lock().ok()?;
        guard.as_ref().filter(|handle| !handle.is_closed()).cloned()
    }

    pub fn is_connected(&self, id: &str) -> bool {
        let slot = self.slots.lock().unwrap().get(id).cloned();
        slot.and_then(|slot| {
            slot.try_lock()
                .ok()
                .and_then(|guard| guard.as_ref().map(|handle| !handle.is_closed()))
        })
        .unwrap_or(false)
    }

    pub async fn disconnect(&self, id: &str) {
        let slot = self.slots.lock().unwrap().remove(id);
        if let Some(slot) = slot {
            if let Some(handle) = slot.lock().await.take() {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            }
        }
    }

    pub async fn disconnect_all(&self) {
        let ids: Vec<String> = self.slots.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.disconnect(&id).await;
        }
    }
}

async fn connect(shared: &Arc<Shared>, spec: &ConnectionSpec) -> Result<SshHandle, String> {
    let host = spec.host.trim().to_owned();
    if host.is_empty() {
        return Err("SSH session has no host".into());
    }
    let port = spec.port();
    log::info!("SSH connect {}", spec.label());
    let socket = crate::net::connect(&host, port, spec.proxy().as_ref()).await?;

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let rejection = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        shared: shared.clone(),
        connection_id: spec.id.clone(),
        host: host.clone(),
        port,
        rejection: rejection.clone(),
    };
    let mut handle = client::connect_stream(config, socket, handler)
        .await
        .map_err(|error| {
            rejection
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| format!("SSH handshake with {host}:{port} failed: {error}"))
        })?;
    authenticate(&mut handle, shared, spec).await?;
    Ok(handle)
}

fn allows(methods: &MethodSet, kind: MethodKind) -> bool {
    methods.is_empty() || methods.contains(&kind)
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

async fn authenticate(
    handle: &mut SshHandle,
    shared: &Arc<Shared>,
    spec: &ConnectionSpec,
) -> Result<(), String> {
    let user = spec.user();
    let err = |error: russh::Error| format!("Authentication failed: {error}");

    let methods = match handle.authenticate_none(user.clone()).await.map_err(err)? {
        AuthResult::Success => return Ok(()),
        AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };

    // 1. SSH agent
    if matches!(spec.auth, AuthMethod::Auto | AuthMethod::Agent)
        && allows(&methods, MethodKind::PublicKey)
        && agent_auth(handle, &user).await
    {
        return Ok(());
    }

    // 2. Private key files
    if matches!(spec.auth, AuthMethod::Auto | AuthMethod::Key)
        && allows(&methods, MethodKind::PublicKey)
    {
        let configured = spec
            .identity_file
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty());
        let files: Vec<PathBuf> = match configured {
            Some(path) => vec![expand_home(path)],
            None => dirs::home_dir()
                .map(|home| {
                    ["id_ed25519", "id_ecdsa", "id_rsa"]
                        .iter()
                        .map(|name| home.join(".ssh").join(name))
                        .filter(|path| path.is_file())
                        .collect()
                })
                .unwrap_or_default(),
        };
        if spec.auth == AuthMethod::Key && files.is_empty() {
            return Err("Public key authentication selected, but no key file was found".into());
        }
        for file in files {
            if key_auth(handle, shared, spec, &user, &file, configured.is_some()).await? {
                return Ok(());
            }
        }
    }

    // 3. Password / keyboard-interactive
    if matches!(spec.auth, AuthMethod::Auto | AuthMethod::Password) {
        // Remembered password first; asked only when there is none or the server rejects it.
        let saved = spec.saved_password.as_deref().and_then(crate::secret::open);
        let mut saved_rejected = false;
        if let Some(password) = saved
            .as_ref()
            .filter(|_| allows(&methods, MethodKind::Password))
        {
            if handle
                .authenticate_password(user.clone(), password.clone())
                .await
                .map_err(err)?
                .success()
            {
                return Ok(());
            }
            saved_rejected = true;
        }
        if allows(&methods, MethodKind::Password) {
            for attempt in 0..3 {
                let title = if attempt == 0 && saved_rejected {
                    "Saved password was rejected".to_owned()
                } else if attempt == 0 {
                    "Password".to_owned()
                } else {
                    "Permission denied, please try again".to_owned()
                };
                let answer = shared
                    .prompts
                    .ask(
                        &spec.id,
                        "password",
                        title,
                        format!("{}'s password:", spec.label()),
                        vec![PromptField {
                            label: "Password".into(),
                            secret: true,
                        }],
                    )
                    .await;
                let Some(password) = answer.and_then(|answers| answers.into_iter().next()) else {
                    return Err("Authentication cancelled".into());
                };
                if handle
                    .authenticate_password(user.clone(), password)
                    .await
                    .map_err(err)?
                    .success()
                {
                    return Ok(());
                }
            }
        } else if methods.contains(&MethodKind::KeyboardInteractive)
            && keyboard_auth(handle, shared, spec, &user, saved.as_deref()).await?
        {
            return Ok(());
        }
    }

    let offered: Vec<&str> = methods.iter().map(<&str>::from).collect();
    Err(format!(
        "Permission denied ({})",
        if offered.is_empty() {
            "no methods".into()
        } else {
            offered.join(",")
        }
    ))
}

async fn agent_auth(handle: &mut SshHandle, user: &str) -> bool {
    #[cfg(unix)]
    let agent = AgentClient::connect_env().await;
    #[cfg(windows)]
    let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await;
    match agent {
        Ok(agent) => agent_auth_with(handle, user, agent).await,
        Err(_) => false,
    }
}

async fn agent_auth_with<S>(handle: &mut SshHandle, user: &str, mut agent: AgentClient<S>) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Ok(identities) = agent.request_identities().await else {
        return false;
    };
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    for identity in identities {
        if let keys::agent::AgentIdentity::PublicKey { key, .. } = identity {
            if let Ok(result) = handle
                .authenticate_publickey_with(user.to_owned(), key, hash, &mut agent)
                .await
            {
                if result.success() {
                    return true;
                }
            }
        }
    }
    false
}

async fn key_auth(
    handle: &mut SshHandle,
    shared: &Arc<Shared>,
    spec: &ConnectionSpec,
    user: &str,
    file: &PathBuf,
    explicit: bool,
) -> Result<bool, String> {
    let key = match keys::load_secret_key(file, None) {
        Ok(key) => key,
        Err(keys::Error::KeyIsEncrypted) => {
            let mut loaded = None;
            for attempt in 0..3 {
                let title = if attempt == 0 {
                    "Key passphrase"
                } else {
                    "Wrong passphrase, try again"
                };
                let answer = shared
                    .prompts
                    .ask(
                        &spec.id,
                        "passphrase",
                        title,
                        format!("Enter passphrase for key '{}':", file.display()),
                        vec![PromptField {
                            label: "Passphrase".into(),
                            secret: true,
                        }],
                    )
                    .await;
                let Some(passphrase) = answer.and_then(|answers| answers.into_iter().next()) else {
                    return Ok(false);
                };
                if let Ok(key) = keys::load_secret_key(file, Some(&passphrase)) {
                    loaded = Some(key);
                    break;
                }
            }
            match loaded {
                Some(key) => key,
                None => return Ok(false),
            }
        }
        Err(error) if explicit => {
            return Err(format!("Cannot load key {}: {error}", file.display()))
        }
        Err(_) => return Ok(false),
    };
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    let result = handle
        .authenticate_publickey(
            user.to_owned(),
            PrivateKeyWithHashAlg::new(Arc::new(key), hash),
        )
        .await
        .map_err(|error| format!("Public key authentication failed: {error}"))?;
    Ok(result.success())
}

async fn keyboard_auth(
    handle: &mut SshHandle,
    shared: &Arc<Shared>,
    spec: &ConnectionSpec,
    user: &str,
    mut saved: Option<&str>,
) -> Result<bool, String> {
    let err = |error: russh::Error| format!("Keyboard-interactive authentication failed: {error}");
    let mut response = handle
        .authenticate_keyboard_interactive_start(user.to_owned(), None::<String>)
        .await
        .map_err(err)?;
    for _ in 0..8 {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if saved.is_some() && prompts.len() == 1 && !prompts[0].echo {
                    // A single hidden prompt is the password: answer it once with the remembered one.
                    vec![saved.take().unwrap_or_default().to_owned()]
                } else {
                    let fields = prompts
                        .iter()
                        .map(|prompt| PromptField {
                            label: prompt.prompt.trim().to_owned(),
                            secret: !prompt.echo,
                        })
                        .collect();
                    let title = if name.trim().is_empty() {
                        "Authentication".to_owned()
                    } else {
                        name
                    };
                    let message = if instructions.trim().is_empty() {
                        spec.label()
                    } else {
                        instructions
                    };
                    shared
                        .prompts
                        .ask(&spec.id, "keyboard", title, message, fields)
                        .await
                        .ok_or("Authentication cancelled")?
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(err)?;
            }
        }
    }
    Ok(false)
}
