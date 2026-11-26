//! File access for the SFTP browser: remote files over SFTP (sharing the session's SSH
//! connection) or the local file system for local sessions — same API for both.

use crate::{
    common::events::Event,
    remote::ssh::{ConnectionSpec, Shared, SshPool, Transport},
};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// `dir` | `file` | `link`
    pub kind: &'static str,
    /// Directory, or a symlink pointing to one.
    pub is_dir: bool,
    pub size: u64,
    /// Unix seconds.
    pub modified: Option<u64>,
    /// `drwxr-xr-x` style.
    pub permissions: Option<String>,
    /// Owner user name (numeric uid when the name is unknown). None on Windows.
    pub owner: Option<String>,
    /// Owner group name (numeric gid when the name is unknown). None on Windows.
    pub group: Option<String>,
}

/// uid → user name and gid → group name, from `/etc/passwd` and `/etc/group`.
#[derive(Default)]
pub struct IdNames {
    users: HashMap<u32, String>,
    groups: HashMap<u32, String>,
}

impl IdNames {
    fn parse(passwd: &str, group: &str) -> Self {
        // name:password:id:...
        let table = |text: &str| {
            text.lines()
                .filter(|line| !line.starts_with('#'))
                .filter_map(|line| {
                    let mut fields = line.split(':');
                    let name = fields.next()?;
                    let id = fields.nth(1)?.parse().ok()?;
                    (!name.is_empty()).then(|| (id, name.to_owned()))
                })
                .fold(HashMap::new(), |mut map, (id, name)| {
                    map.entry(id).or_insert(name);
                    map
                })
        };
        Self {
            users: table(passwd),
            groups: table(group),
        }
    }
    fn user(&self, uid: u32) -> String {
        self.users
            .get(&uid)
            .cloned()
            .unwrap_or_else(|| uid.to_string())
    }
    fn group(&self, gid: u32) -> String {
        self.groups
            .get(&gid)
            .cloned()
            .unwrap_or_else(|| gid.to_string())
    }
    /// This computer's tables. Missing files (Windows, sandboxes) give numeric ids.
    #[allow(dead_code)]
    async fn local() -> Self {
        let passwd = tokio::fs::read_to_string("/etc/passwd")
            .await
            .unwrap_or_default();
        let group = tokio::fs::read_to_string("/etc/group")
            .await
            .unwrap_or_default();
        Self::parse(&passwd, &group)
    }
    /// The server's tables, read over SFTP (SFTP v3 only reports numeric ids).
    async fn remote(sftp: &SftpSession) -> Self {
        async fn read(sftp: &SftpSession, path: &str) -> String {
            match sftp.read(path).await {
                Ok(bytes) if bytes.len() < 4 * 1024 * 1024 => {
                    String::from_utf8_lossy(&bytes).into_owned()
                }
                _ => String::new(),
            }
        }
        Self::parse(
            &read(sftp, "/etc/passwd").await,
            &read(sftp, "/etc/group").await,
        )
    }
}

/// One SFTP session plus its lazily loaded uid / gid name tables.
pub struct SftpFs {
    pub session: SftpSession,
    names: tokio::sync::OnceCell<IdNames>,
}

impl std::ops::Deref for SftpFs {
    type Target = SftpSession;
    fn deref(&self) -> &SftpSession {
        &self.session
    }
}

#[derive(Clone)]
pub enum Fs {
    Local,
    Sftp(Arc<SftpFs>),
}

pub type Reader = Pin<Box<dyn AsyncRead + Send>>;
pub type Writer = Pin<Box<dyn AsyncWrite + Send>>;

/// POSIX join for remote paths; local paths use `/` as well (accepted on Windows too).
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') || dir.ends_with('\\') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn slashes(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    if cfg!(windows) {
        text.trim_start_matches(r"\\?\").replace('\\', "/")
    } else {
        text
    }
}

pub fn mode_string(mode: u32) -> String {
    let kind = match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        0o020000 => 'c',
        0o060000 => 'b',
        0o010000 => 'p',
        0o140000 => 's',
        _ => '-',
    };
    let mut text = String::with_capacity(10);
    text.push(kind);
    for shift in [6, 3, 0] {
        let bits = (mode >> shift) & 0o7;
        text.push(if bits & 4 != 0 { 'r' } else { '-' });
        text.push(if bits & 2 != 0 { 'w' } else { '-' });
        text.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    text
}

fn sort(entries: &mut [FileEntry]) {
    entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));
}

fn io_err(context: &'static str, path: &str) -> impl Fn(std::io::Error) -> String {
    let path = path.to_owned();
    move |error| format!("{context} {path}: {error}")
}

fn sftp_err(
    context: &'static str,
    path: &str,
) -> impl Fn(russh_sftp::client::error::Error) -> String {
    let path = path.to_owned();
    move |error| {
        // russh-sftp formats status errors as "<status>: <message>", usually the same text twice.
        let text = error.to_string();
        let text = match text.split_once(": ") {
            Some((status, message)) if status.eq_ignore_ascii_case(message.trim()) => {
                status.to_owned()
            }
            _ => text,
        };
        format!("{context} {path}: {text}")
    }
}

impl Fs {
    pub async fn home(&self) -> Result<String, String> {
        match self {
            Fs::Local => dirs::home_dir()
                .map(|home| slashes(&home))
                .ok_or_else(|| "Cannot resolve home directory".into()),
            Fs::Sftp(sftp) => sftp
                .canonicalize(".")
                .await
                .map_err(|error| format!("Cannot resolve remote home: {error}")),
        }
    }

    pub async fn canonical(&self, path: &str) -> Result<String, String> {
        match self {
            Fs::Local => tokio::fs::canonicalize(path)
                .await
                .map(|path| slashes(&path))
                .map_err(io_err("Cannot open", path)),
            Fs::Sftp(sftp) => sftp
                .canonicalize(path)
                .await
                .map_err(sftp_err("Cannot open", path)),
        }
    }

    pub async fn list(&self, path: &str) -> Result<Vec<FileEntry>, String> {
        let mut entries = Vec::new();
        match self {
            Fs::Local => {
                let mut dir = tokio::fs::read_dir(path)
                    .await
                    .map_err(io_err("Cannot list", path))?;
                #[cfg(unix)]
                let names = IdNames::local().await;
                while let Some(entry) = dir
                    .next_entry()
                    .await
                    .map_err(io_err("Cannot list", path))?
                {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let Ok(meta) = tokio::fs::symlink_metadata(entry.path()).await else {
                        continue;
                    };
                    let is_link = meta.file_type().is_symlink();
                    let is_dir = if is_link {
                        tokio::fs::metadata(entry.path())
                            .await
                            .map(|meta| meta.is_dir())
                            .unwrap_or(false)
                    } else {
                        meta.is_dir()
                    };
                    #[cfg(unix)]
                    let permissions = {
                        use std::os::unix::fs::PermissionsExt;
                        Some(mode_string(meta.permissions().mode()))
                    };
                    #[cfg(not(unix))]
                    let permissions = Some(if meta.permissions().readonly() {
                        "r--".to_owned()
                    } else {
                        "rw-".to_owned()
                    });
                    #[cfg(unix)]
                    let (owner, group) = {
                        use std::os::unix::fs::MetadataExt;
                        (Some(names.user(meta.uid())), Some(names.group(meta.gid())))
                    };
                    #[cfg(not(unix))]
                    let (owner, group): (Option<String>, Option<String>) = (None, None);
                    entries.push(FileEntry {
                        path: join(path, &name),
                        name,
                        kind: if is_link {
                            "link"
                        } else if meta.is_dir() {
                            "dir"
                        } else {
                            "file"
                        },
                        is_dir,
                        size: if meta.is_dir() { 0 } else { meta.len() },
                        modified: meta
                            .modified()
                            .ok()
                            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                            .map(|time| time.as_secs()),
                        permissions,
                        owner,
                        group,
                    });
                }
            }
            Fs::Sftp(sftp) => {
                let listing = sftp
                    .read_dir(path)
                    .await
                    .map_err(sftp_err("Cannot list", path))?;
                let names = sftp
                    .names
                    .get_or_init(|| IdNames::remote(&sftp.session))
                    .await;
                for entry in listing {
                    let name = entry.file_name();
                    if name == "." || name == ".." {
                        continue;
                    }
                    let meta = entry.metadata();
                    let file_type = entry.file_type();
                    let full = join(path, &name);
                    let is_link = file_type.is_symlink();
                    let is_dir = if is_link {
                        sftp.metadata(full.clone())
                            .await
                            .map(|meta| meta.is_dir())
                            .unwrap_or(false)
                    } else {
                        file_type.is_dir()
                    };
                    entries.push(FileEntry {
                        name,
                        path: full,
                        kind: if is_link {
                            "link"
                        } else if file_type.is_dir() {
                            "dir"
                        } else {
                            "file"
                        },
                        is_dir,
                        size: if file_type.is_dir() {
                            0
                        } else {
                            meta.size.unwrap_or(0)
                        },
                        modified: meta.mtime.map(u64::from),
                        permissions: meta.permissions.map(mode_string),
                        owner: meta
                            .user
                            .clone()
                            .or_else(|| meta.uid.map(|uid| names.user(uid))),
                        group: meta
                            .group
                            .clone()
                            .or_else(|| meta.gid.map(|gid| names.group(gid))),
                    });
                }
            }
        }
        sort(&mut entries);
        Ok(entries)
    }

    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        match self {
            Fs::Local => tokio::fs::create_dir(path)
                .await
                .map_err(io_err("Cannot create", path)),
            Fs::Sftp(sftp) => sftp
                .create_dir(path)
                .await
                .map_err(sftp_err("Cannot create", path)),
        }
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Fs::Local => tokio::fs::rename(from, to)
                .await
                .map_err(io_err("Cannot rename", from)),
            Fs::Sftp(sftp) => sftp
                .rename(from, to)
                .await
                .map_err(sftp_err("Cannot rename", from)),
        }
    }

    /// Delete a file, link or (recursively) a directory.
    pub fn remove<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            match self {
                Fs::Local => {
                    let meta = tokio::fs::symlink_metadata(path)
                        .await
                        .map_err(io_err("Cannot delete", path))?;
                    if meta.is_dir() {
                        tokio::fs::remove_dir_all(path)
                            .await
                            .map_err(io_err("Cannot delete", path))
                    } else {
                        tokio::fs::remove_file(path)
                            .await
                            .map_err(io_err("Cannot delete", path))
                    }
                }
                Fs::Sftp(sftp) => {
                    let meta = sftp
                        .symlink_metadata(path)
                        .await
                        .map_err(sftp_err("Cannot delete", path))?;
                    if meta.is_dir() {
                        for entry in self.list(path).await? {
                            self.remove(&entry.path).await?;
                        }
                        sftp.remove_dir(path)
                            .await
                            .map_err(sftp_err("Cannot delete", path))
                    } else {
                        sftp.remove_file(path)
                            .await
                            .map_err(sftp_err("Cannot delete", path))
                    }
                }
            }
        })
    }

    /// Whether something (file, folder, link — even a broken one) exists at `path`.
    pub async fn exists(&self, path: &str) -> Result<bool, String> {
        match self {
            Fs::Local => match tokio::fs::symlink_metadata(path).await {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(format!("Cannot check {path}: {error}")),
            },
            Fs::Sftp(sftp) => Ok(sftp.symlink_metadata(path).await.is_ok()),
        }
    }

    /// Copy a file, link or (recursively) a folder to `to`, which must not exist yet. Files keep
    /// their permissions; links are copied as links (not followed).
    pub fn copy_tree<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            match self {
                Fs::Local => {
                    let meta = tokio::fs::symlink_metadata(from)
                        .await
                        .map_err(io_err("Cannot copy", from))?;
                    if meta.file_type().is_symlink() {
                        let target = tokio::fs::read_link(from)
                            .await
                            .map_err(io_err("Cannot copy", from))?;
                        #[cfg(unix)]
                        return tokio::fs::symlink(&target, to)
                            .await
                            .map_err(io_err("Cannot create", to));
                        #[cfg(not(unix))]
                        {
                            let _ = target;
                            return Err(format!("Cannot copy link {from} on this system"));
                        }
                    }
                    if meta.is_dir() {
                        tokio::fs::create_dir(to)
                            .await
                            .map_err(io_err("Cannot create", to))?;
                        let mut dir = tokio::fs::read_dir(from)
                            .await
                            .map_err(io_err("Cannot list", from))?;
                        while let Some(entry) = dir
                            .next_entry()
                            .await
                            .map_err(io_err("Cannot list", from))?
                        {
                            let name = entry.file_name().to_string_lossy().to_string();
                            self.copy_tree(&join(from, &name), &join(to, &name)).await?;
                        }
                        // Permissions last: a read-only folder must still accept its contents.
                        let _ = tokio::fs::set_permissions(to, meta.permissions()).await;
                        Ok(())
                    } else {
                        // create_new: never overwrite something that appeared in the meantime.
                        tokio::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(to)
                            .await
                            .map_err(io_err("Cannot create", to))?;
                        tokio::fs::copy(from, to)
                            .await
                            .map(|_| ())
                            .map_err(io_err("Cannot copy", from))
                    }
                }
                Fs::Sftp(sftp) => {
                    let meta = sftp
                        .symlink_metadata(from)
                        .await
                        .map_err(sftp_err("Cannot copy", from))?;
                    if meta.file_type().is_symlink() {
                        let target = sftp
                            .read_link(from)
                            .await
                            .map_err(sftp_err("Cannot copy", from))?;
                        return self.sftp_symlink(sftp, &target, to).await;
                    }
                    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
                    attrs.permissions = meta.permissions.map(|mode| mode & 0o7777);
                    if meta.is_dir() {
                        sftp.create_dir(to)
                            .await
                            .map_err(sftp_err("Cannot create", to))?;
                        for entry in self.list(from).await? {
                            self.copy_tree(&entry.path, &join(to, &entry.name)).await?;
                        }
                    } else {
                        let mut reader = sftp
                            .open(from)
                            .await
                            .map_err(sftp_err("Cannot open", from))?;
                        let mut writer = sftp
                            .open_with_flags(
                                to,
                                russh_sftp::protocol::OpenFlags::CREATE
                                    | russh_sftp::protocol::OpenFlags::EXCLUDE
                                    | russh_sftp::protocol::OpenFlags::WRITE,
                            )
                            .await
                            .map_err(sftp_err("Cannot create", to))?;
                        tokio::io::copy(&mut reader, &mut writer)
                            .await
                            .map_err(io_err("Cannot copy", from))?;
                        writer
                            .shutdown()
                            .await
                            .map_err(io_err("Cannot write", to))?;
                    }
                    if attrs.permissions.is_some() {
                        let _ = sftp.set_metadata(to, attrs).await;
                    }
                    Ok(())
                }
            }
        })
    }

    /// SSH_FXP_SYMLINK's two paths are swapped by OpenSSH's server (and kept by others): try the
    /// standard order, check where the link points, and fall back to the other order.
    async fn sftp_symlink(&self, sftp: &SftpFs, target: &str, link: &str) -> Result<(), String> {
        if sftp.symlink(link, target).await.is_ok() {
            if sftp.read_link(link).await.ok().as_deref() == Some(target) {
                return Ok(());
            }
            let _ = sftp.remove_file(link).await;
        }
        sftp.symlink(target, link)
            .await
            .map_err(sftp_err("Cannot create", link))?;
        match sftp.read_link(link).await {
            Ok(points) if points == target => Ok(()),
            _ => {
                let _ = sftp.remove_file(link).await;
                Err(format!("Cannot create link {link}"))
            }
        }
    }

    /// Move a file or folder to `to` (which must not exist). A rename where possible; across
    /// file systems (local) a copy followed by deleting the original.
    pub async fn move_to(&self, from: &str, to: &str) -> Result<(), String> {
        match self {
            Fs::Local => match tokio::fs::rename(from, to).await {
                Ok(()) => Ok(()),
                // EXDEV (18 on Linux and macOS): another file system.
                Err(error) if error.raw_os_error() == Some(18) => {
                    self.copy_tree(from, to).await?;
                    self.remove(from).await
                }
                Err(error) => Err(format!("Cannot move {from}: {error}")),
            },
            Fs::Sftp(sftp) => sftp
                .rename(from, to)
                .await
                .map_err(sftp_err("Cannot move", from)),
        }
    }

    /// Open for reading → (reader, size).
    pub async fn open_read(&self, path: &str) -> Result<(Reader, Option<u64>), String> {
        match self {
            Fs::Local => {
                let file = tokio::fs::File::open(path)
                    .await
                    .map_err(io_err("Cannot open", path))?;
                let size = file
                    .metadata()
                    .await
                    .ok()
                    .filter(|meta| meta.is_file())
                    .map(|meta| meta.len());
                Ok((Box::pin(file), size))
            }
            Fs::Sftp(sftp) => {
                let file = sftp
                    .open(path)
                    .await
                    .map_err(sftp_err("Cannot open", path))?;
                let size = file.metadata().await.ok().and_then(|meta| meta.size);
                Ok((Box::pin(file), size))
            }
        }
    }

    /// Create / truncate for writing.
    pub async fn open_write(&self, path: &str) -> Result<Writer, String> {
        match self {
            Fs::Local => Ok(Box::pin(
                tokio::fs::File::create(path)
                    .await
                    .map_err(io_err("Cannot create", path))?,
            )),
            Fs::Sftp(sftp) => Ok(Box::pin(
                sftp.create(path)
                    .await
                    .map_err(sftp_err("Cannot create", path))?,
            )),
        }
    }
}

/// Open SFTP sessions per session config.
#[derive(Default)]
pub struct FilePool {
    sftp: tokio::sync::Mutex<HashMap<String, Arc<SftpFs>>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl FilePool {
    pub async fn get(
        &self,
        shared: &Arc<Shared>,
        ssh: &SshPool,
        spec: &ConnectionSpec,
    ) -> Result<Fs, String> {
        match spec.transport {
            Transport::Local => return Ok(Fs::Local),
            Transport::Ssh => {}
            _ => return Err("No file browser for this session type (only Local and SSH)".into()),
        }
        let mut sessions = self.sftp.lock().await;
        if let Some(sftp) = sessions.get(&spec.id) {
            if ssh.is_connected(&spec.id) {
                return Ok(Fs::Sftp(sftp.clone()));
            }
            sessions.remove(&spec.id);
        }
        let handle = ssh.get(shared, spec).await?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| format!("Cannot open SFTP channel: {error}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| format!("SFTP subsystem request failed: {error}"))?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| format!("Cannot start SFTP: {error}"))?;
        sftp.set_timeout(30);
        let sftp = Arc::new(SftpFs {
            session: sftp,
            names: tokio::sync::OnceCell::new(),
        });
        sessions.insert(spec.id.clone(), sftp.clone());
        Ok(Fs::Sftp(sftp))
    }

    pub async fn drop_session(&self, connection_id: &str) {
        if let Some(sftp) = self.sftp.lock().await.remove(connection_id) {
            let _ = sftp.close().await;
        }
    }

    pub async fn drop_all(&self) {
        let sessions: Vec<_> = self
            .sftp
            .lock()
            .await
            .drain()
            .map(|(_, sftp)| sftp)
            .collect();
        for sftp in sessions {
            let _ = sftp.close().await;
        }
    }

    pub fn cancel(&self, transfer_id: &str) -> bool {
        match self.cancels.lock().unwrap().get(transfer_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Stream `reader` → `writer`, emitting throttled `transfer.progress` events.
    pub async fn copy(
        &self,
        shared: &Shared,
        transfer_id: &str,
        mut reader: Reader,
        mut writer: Writer,
        total: Option<u64>,
    ) -> Result<u64, String> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .unwrap()
            .insert(transfer_id.to_owned(), cancel.clone());
        let result = async {
            let mut buffer = vec![0_u8; 256 * 1024];
            let mut done = 0_u64;
            let mut last = Instant::now() - Duration::from_secs(1);
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Transfer cancelled".to_owned());
                }
                let read = reader
                    .read(&mut buffer)
                    .await
                    .map_err(|error| format!("Read failed: {error}"))?;
                if read == 0 {
                    break;
                }
                writer
                    .write_all(&buffer[..read])
                    .await
                    .map_err(|error| format!("Write failed: {error}"))?;
                done += read as u64;
                if last.elapsed() >= Duration::from_millis(120) {
                    last = Instant::now();
                    shared.sink.emit(Event::TransferProgress {
                        transfer_id: transfer_id.to_owned(),
                        done,
                        total,
                    });
                }
            }
            writer
                .flush()
                .await
                .map_err(|error| format!("Write failed: {error}"))?;
            writer
                .shutdown()
                .await
                .map_err(|error| format!("Close failed: {error}"))?;
            shared.sink.emit(Event::TransferProgress {
                transfer_id: transfer_id.to_owned(),
                done,
                total: Some(total.unwrap_or(done)),
            });
            Ok(done)
        }
        .await;
        self.cancels.lock().unwrap().remove(transfer_id);
        result
    }
}
