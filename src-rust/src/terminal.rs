//! Terminal sessions: local shells on a native PTY (`portable-pty`, ConPTY on Windows)
//! and remote shells on an SSH channel with a remote PTY; Telnet / TCP / Serial in stream.rs.

use crate::{
    events::Event,
    ssh::{ConnectionSpec, Shared, SshHandle, SshPool, Transport},
    stream::{self, Input, StreamHandle},
    utf8::Utf8Stream,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use russh::{client, ChannelMsg, ChannelWriteHalf};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};

pub const TERM: &str = "xterm-256color";

enum Handle {
    Local {
        writer: Box<dyn Write + Send>,
        master: Box<dyn MasterPty + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
        /// The shell's process id (current directory lookup).
        pid: Option<u32>,
    },
    Ssh {
        write: ChannelWriteHalf<client::Msg>,
        /// Connection the shell runs on (current directory lookup over a separate exec channel).
        ssh: Arc<SshHandle>,
        /// Value of `LC_METROTERM_SESSION` sent with the shell channel: identifies its processes.
        tag: String,
    },
    /// Telnet / raw TCP / serial port.
    Stream(StreamHandle),
}

/// Environment variable that marks a remote shell's processes, so the current directory of this
/// terminal's shell can be found among the user's processes (`terminal.cwd`). `LC_*` because
/// Debian / Ubuntu / RHEL servers accept those by default (`AcceptEnv LANG LC_*`), like iTerm2's
/// `LC_TERMINAL`. Programs ignore unknown `LC_` names.
const SESSION_ENV: &str = "LC_METROTERM_SESSION";

struct Terminal {
    connection_id: String,
    handle: tokio::sync::Mutex<Handle>,
}

#[derive(Default)]
pub struct Terminals {
    sessions: Mutex<HashMap<String, Arc<Terminal>>>,
    /// Open local / Telnet / TCP / Serial terminals per session config (drives their online/offline state).
    local_counts: Mutex<HashMap<String, usize>>,
}

impl Terminals {
    pub async fn start(
        self: &Arc<Self>,
        shared: &Arc<Shared>,
        pool: &SshPool,
        session_id: String,
        spec: &ConnectionSpec,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        self.close(&session_id).await;
        let (cols, rows) = (cols.max(2), rows.max(1));
        let handle = match spec.transport {
            Transport::Local => self.start_local(shared, &session_id, spec, cols, rows)?,
            Transport::Ssh => {
                self.start_ssh(shared, pool, &session_id, spec, cols, rows)
                    .await?
            }
            Transport::Telnet | Transport::Tcp | Transport::Serial => {
                self.start_stream(shared, &session_id, spec, cols, rows)
                    .await?
            }
        };
        self.sessions.lock().unwrap().insert(
            session_id,
            Arc::new(Terminal {
                connection_id: spec.id.clone(),
                handle: tokio::sync::Mutex::new(handle),
            }),
        );
        Ok(())
    }

    fn start_local(
        self: &Arc<Self>,
        shared: &Arc<Shared>,
        session_id: &str,
        spec: &ConnectionSpec,
        cols: u16,
        rows: u16,
    ) -> Result<Handle, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Cannot allocate a pseudo terminal: {error}"))?;
        let mut child = pair
            .slave
            .spawn_command(local_shell(spec)?)
            .map_err(|error| format!("Cannot start shell: {error}"))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let pid = child.process_id();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Cannot read terminal: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Cannot write terminal: {error}"))?;

        self.local_started(shared, &spec.id);
        let terminals = self.clone();
        let shared = shared.clone();
        let session_id = session_id.to_owned();
        let connection_id = spec.id.clone();
        thread::Builder::new()
            .name(format!("pty-{session_id}"))
            .spawn(move || {
                let mut decoder = Utf8Stream::default();
                let mut buffer = [0_u8; 16 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            let data = decoder.decode(&buffer[..read]);
                            if !data.is_empty() {
                                shared.sink.emit(Event::TerminalData {
                                    session_id: session_id.clone(),
                                    data,
                                });
                            }
                        }
                    }
                }
                let rest = decoder.finish();
                if !rest.is_empty() {
                    shared.sink.emit(Event::TerminalData {
                        session_id: session_id.clone(),
                        data: rest,
                    });
                }
                let code = child.wait().ok().map(|status| status.exit_code());
                terminals.finished(&shared, &session_id, &connection_id, true);
                shared.sink.emit(Event::TerminalExit {
                    session_id,
                    code,
                    reason: None,
                });
            })
            .map_err(|error| format!("Cannot start terminal reader: {error}"))?;
        Ok(Handle::Local {
            writer,
            master: pair.master,
            killer,
            pid,
        })
    }

    async fn start_stream(
        self: &Arc<Self>,
        shared: &Arc<Shared>,
        session_id: &str,
        spec: &ConnectionSpec,
        cols: u16,
        rows: u16,
    ) -> Result<Handle, String> {
        let first = !self.local_counts.lock().unwrap().contains_key(&spec.id);
        if first {
            shared.state(&spec.id, "connecting", None);
        }
        let terminals = self.clone();
        let exit_shared = shared.clone();
        let exit_session = session_id.to_owned();
        let connection_id = spec.id.clone();
        let label = spec.label();
        let on_exit: stream::OnExit = Box::new(move |reason| {
            log::info!(
                "{label} closed{}",
                reason
                    .as_deref()
                    .map(|r| format!(": {r}"))
                    .unwrap_or_default()
            );
            terminals.finished(&exit_shared, &exit_session, &connection_id, true);
            exit_shared.sink.emit(Event::TerminalExit {
                session_id: exit_session,
                code: None,
                reason,
            });
        });
        match stream::start(shared, session_id, spec, cols, rows, on_exit).await {
            Ok(handle) => {
                self.local_started(shared, &spec.id);
                Ok(Handle::Stream(handle))
            }
            Err(error) => {
                log::warn!("{}: {error}", spec.label());
                if first {
                    shared.state(&spec.id, "error", Some(error.clone()));
                }
                Err(error)
            }
        }
    }

    async fn start_ssh(
        self: &Arc<Self>,
        shared: &Arc<Shared>,
        pool: &SshPool,
        session_id: &str,
        spec: &ConnectionSpec,
        cols: u16,
        rows: u16,
    ) -> Result<Handle, String> {
        let ssh = pool.get(shared, spec).await?;
        let channel = ssh
            .channel_open_session()
            .await
            .map_err(|error| format!("Cannot open SSH channel: {error}"))?;
        channel
            .request_pty(false, TERM, cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|error| format!("PTY request failed: {error}"))?;
        // Like OpenSSH's SendEnv: a UTF-8 LANG for servers with `AcceptEnv LANG` (ignored otherwise).
        let _ = channel
            .set_env(false, "LANG", crate::locale::ssh_lang())
            .await;
        let tag: String = session_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        let _ = channel.set_env(false, SESSION_ENV, tag.as_str()).await;
        channel
            .request_shell(true)
            .await
            .map_err(|error| format!("Shell request failed: {error}"))?;
        let (mut read, write) = channel.split();

        let terminals = self.clone();
        let shared = shared.clone();
        let session_id = session_id.to_owned();
        let connection_id = spec.id.clone();
        tokio::spawn(async move {
            let mut stdout = Utf8Stream::default();
            let mut stderr = Utf8Stream::default();
            let mut code = None;
            let mut reason = None;
            while let Some(message) = read.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        let text = stdout.decode(&data);
                        if !text.is_empty() {
                            shared.sink.emit(Event::TerminalData {
                                session_id: session_id.clone(),
                                data: text,
                            });
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        let text = stderr.decode(&data);
                        if !text.is_empty() {
                            shared.sink.emit(Event::TerminalData {
                                session_id: session_id.clone(),
                                data: text,
                            });
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    ChannelMsg::ExitSignal {
                        signal_name,
                        error_message,
                        ..
                    } => {
                        reason = Some(
                            format!("killed by signal {signal_name:?} {error_message}")
                                .trim()
                                .to_owned(),
                        );
                    }
                    ChannelMsg::Failure => reason = Some("Shell request rejected by server".into()),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            let rest = stdout.finish();
            if !rest.is_empty() {
                shared.sink.emit(Event::TerminalData {
                    session_id: session_id.clone(),
                    data: rest,
                });
            }
            if code.is_none() && reason.is_none() {
                reason = Some("Connection closed".into());
            }
            terminals.finished(&shared, &session_id, &connection_id, false);
            shared.sink.emit(Event::TerminalExit {
                session_id,
                code,
                reason,
            });
        });
        Ok(Handle::Ssh { write, ssh, tag })
    }

    /// Current directory of the terminal's shell — of the program in the foreground if that is a
    /// different process (a nested shell) — or None when it cannot be determined (a shell inside
    /// WSL, a remote server without /proc or without `AcceptEnv LC_*`; the UI then relies on OSC 7).
    pub async fn cwd(&self, session_id: &str) -> Result<Option<String>, String> {
        let terminal = self.get(session_id)?;
        let probe = match &*terminal.handle.lock().await {
            Handle::Local { pid, .. } => Probe::Local(*pid),
            Handle::Ssh { ssh, tag, .. } => Probe::Remote(ssh.clone(), tag.clone()),
            Handle::Stream(_) => return Ok(None),
        };
        match probe {
            // Blocking system calls (lsof, process memory): off the async threads.
            Probe::Local(Some(pid)) => Ok(tokio::task::spawn_blocking(move || local_cwd(pid))
                .await
                .ok()
                .flatten()),
            Probe::Local(None) => Ok(None),
            Probe::Remote(ssh, tag) => Ok(remote_cwd(&ssh, &tag).await),
        }
    }

    fn get(&self, session_id: &str) -> Result<Arc<Terminal>, String> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| "Terminal session not found".into())
    }

    pub async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let terminal = self.get(session_id)?;
        let mut handle = terminal.handle.lock().await;
        match &mut *handle {
            Handle::Local { writer, .. } => writer
                .write_all(data)
                .and_then(|_| writer.flush())
                .map_err(|error| format!("Terminal input failed: {error}")),
            Handle::Ssh { write, .. } => write
                .data_bytes(data.to_vec())
                .await
                .map_err(|error| format!("Terminal input failed: {error}")),
            Handle::Stream(stream) => stream
                .input
                .send(Input::Data(data.to_vec()))
                .map_err(|_| "Connection closed".to_owned()),
        }
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }
        let terminal = self.get(session_id)?;
        let handle = terminal.handle.lock().await;
        match &*handle {
            Handle::Local { master, .. } => master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("Terminal resize failed: {error}")),
            Handle::Ssh { write, .. } => write
                .window_change(cols as u32, rows as u32, 0, 0)
                .await
                .map_err(|error| format!("Terminal resize failed: {error}")),
            Handle::Stream(stream) => {
                let _ = stream.input.send(Input::Resize(cols, rows));
                Ok(())
            }
        }
    }

    pub async fn close(&self, session_id: &str) {
        let terminal = self.sessions.lock().unwrap().remove(session_id);
        if let Some(terminal) = terminal {
            let mut handle = terminal.handle.lock().await;
            match &mut *handle {
                Handle::Local { killer, .. } => {
                    let _ = killer.kill();
                }
                Handle::Ssh { write, .. } => {
                    let _ = write.eof().await;
                    let _ = write.close().await;
                }
                Handle::Stream(stream) => {
                    let _ = stream.input.send(Input::Close);
                }
            }
        }
    }

    pub async fn close_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.close(&id).await;
        }
    }

    /// Terminal ids attached to a session config.
    pub fn sessions_of(&self, connection_id: &str) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, terminal)| terminal.connection_id == connection_id)
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn local_started(&self, shared: &Shared, connection_id: &str) {
        let mut counts = self.local_counts.lock().unwrap();
        let count = counts.entry(connection_id.to_owned()).or_default();
        *count += 1;
        if *count == 1 {
            shared.state(connection_id, "online", None);
        }
    }

    fn finished(&self, shared: &Shared, session_id: &str, connection_id: &str, local: bool) {
        self.sessions.lock().unwrap().remove(session_id);
        if local {
            let mut counts = self.local_counts.lock().unwrap();
            if let Some(count) = counts.get_mut(connection_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    counts.remove(connection_id);
                    shared.state(connection_id, "offline", None);
                }
            }
        }
    }
}

/// A shell installed on this machine (`system.shells`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShellInfo {
    /// Short name shown in the UI, e.g. "bash", "zsh", "pwsh".
    pub name: String,
    /// Absolute path of the executable.
    pub path: String,
}

/// Find `program` on PATH (a path containing a separator is checked as is).
fn find_program(program: &str) -> Option<std::path::PathBuf> {
    let candidate = std::path::Path::new(program);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.to_path_buf());
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).find_map(|dir| {
        let full = dir.join(program);
        if full.is_file() {
            return Some(full);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{program}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
        None
    })
}

/// Shells installed on this machine, preferred ones first (bash, zsh, fish …).
pub fn available_shells() -> Vec<ShellInfo> {
    let mut found: Vec<ShellInfo> = Vec::new();
    let mut push = |path: std::path::PathBuf| {
        let name = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty()
            || matches!(
                name.as_str(),
                "nologin" | "false" | "true" | "git-shell" | "rbash"
            )
            || found.iter().any(|shell| shell.name == name)
        {
            return;
        }
        found.push(ShellInfo {
            name,
            path: path.display().to_string(),
        });
    };
    #[cfg(not(windows))]
    {
        for name in ["bash", "zsh", "fish"] {
            if let Some(path) = find_program(name) {
                push(path);
            }
        }
        if let Ok(list) = std::fs::read_to_string("/etc/shells") {
            for line in list
                .lines()
                .map(str::trim)
                .filter(|line| line.starts_with('/'))
            {
                let path = std::path::PathBuf::from(line);
                if path.is_file() {
                    push(path);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        for name in ["pwsh", "powershell", "cmd", "wsl"] {
            if let Some(path) = find_program(name) {
                push(path);
            }
        }
        for git_bash in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            let path = std::path::PathBuf::from(git_bash);
            if path.is_file() {
                push(path);
            }
        }
    }
    found
}

/// Startup file for local bash terminals, `~/.metroterm/shell/bashrc` (rewritten on every launch).
/// It reads the same files a login shell reads (`-l` can't be combined with `--rcfile`), then:
/// - `shopt -u hostcomplete`: with it on, bash treats a word starting with `@` as a host name.
///   Tab then escapes the `@` (`cd @b` → `cd \@babel/`) and `node_modules/@types/n` doesn't
///   complete at all. Off, `@…` completes as a plain file name: `cd @babel/`.
/// - `enable-active-region off`: readline ≥ 8.1 shows pasted text in reverse video (a solid block
///   behind the text) until the next key; pasted text looks like the rest of the command line.
#[cfg(not(windows))]
const BASH_RCFILE: &str = r#"# MetroTerm: startup file for local bash terminals. Written by MetroTerm on every launch;
# put your own settings in ~/.bash_profile, ~/.profile or ~/.bashrc as usual.

# Same files as a login shell (bash -l).
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile
fi

# Tab completion of names starting with "@" (npm scopes such as @babel): complete them as file
# names, without a backslash in front ("cd @babel/", not "cd \@babel/").
shopt -u hostcomplete

# Pasted text is not highlighted (readline would show it in reverse video until the next key).
bind 'set enable-active-region off' 2>/dev/null
"#;

/// Startup files for local zsh terminals, `~/.metroterm/shell/zsh/` (rewritten on every launch).
/// zsh reads its files from `$ZDOTDIR`; MetroTerm points it here, and each file reads the user's
/// own file of the same name (from their `$ZDOTDIR`, or the home directory) — the user's
/// configuration works as before. After `.zshrc`, pasted text is no longer highlighted
/// (`zle_highlight` `paste:none`; zsh's default shows it in reverse video until the next key).
/// `.zlogin`, the last file of a login shell, gives the user's `$ZDOTDIR` back.
#[cfg(not(windows))]
const ZSH_FILES: [(&str, &str); 4] = [
    (
        ".zshenv",
        r#"# MetroTerm: written on every launch; put your own settings in your usual zsh files.
_metroterm_zdotdir=$ZDOTDIR
(( ${+METROTERM_USER_ZDOTDIR} )) && _metroterm_keep=1
ZDOTDIR=${METROTERM_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
[[ $ZDOTDIR != $HOME ]] && _metroterm_keep=1
METROTERM_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$_metroterm_zdotdir
# Give the user's ZDOTDIR back (or none, if they had none).
_metroterm_restore() {
  ZDOTDIR=$METROTERM_USER_ZDOTDIR
  [[ -z $_metroterm_keep ]] && unset ZDOTDIR
  unset _metroterm_zdotdir _metroterm_keep METROTERM_USER_ZDOTDIR
  unfunction _metroterm_restore
}
"#,
    ),
    (
        ".zprofile",
        r#"# MetroTerm: written on every launch.
ZDOTDIR=$METROTERM_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zprofile ]] && . $ZDOTDIR/.zprofile
METROTERM_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$_metroterm_zdotdir
"#,
    ),
    (
        ".zshrc",
        r#"# MetroTerm: written on every launch.
ZDOTDIR=$METROTERM_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc
METROTERM_USER_ZDOTDIR=$ZDOTDIR
# Pasted text is not highlighted (zsh shows it in reverse video until the next key by default).
zle_highlight=(${zle_highlight:#paste:*} paste:none)
if [[ -o login ]]; then ZDOTDIR=$_metroterm_zdotdir; else _metroterm_restore; fi
"#,
    ),
    (
        ".zlogin",
        r#"# MetroTerm: written on every launch.
_metroterm_user=$METROTERM_USER_ZDOTDIR
_metroterm_restore
[[ -r $_metroterm_user/.zlogin ]] && . $_metroterm_user/.zlogin
unset _metroterm_user
"#,
    ),
];

#[cfg(not(windows))]
fn zsh_dotdir(shell: &str) -> Option<std::path::PathBuf> {
    let name = std::path::Path::new(shell).file_name()?.to_str()?;
    if name != "zsh" {
        return None;
    }
    let dir = crate::config::ensure_dir().ok()?.join("shell").join("zsh");
    std::fs::create_dir_all(&dir).ok()?;
    for (file, content) in ZSH_FILES {
        let path = dir.join(file);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(content) {
            std::fs::write(&path, content).ok()?;
        }
    }
    Some(dir)
}

#[cfg(not(windows))]
fn bash_rcfile(shell: &str) -> Option<std::path::PathBuf> {
    let name = std::path::Path::new(shell).file_name()?.to_str()?;
    if name != "bash" {
        return None;
    }
    let dir = crate::config::ensure_dir().ok()?.join("shell");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("bashrc");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(BASH_RCFILE) {
        std::fs::write(&path, BASH_RCFILE).ok()?;
    }
    Some(path)
}

fn local_shell(spec: &ConnectionSpec) -> Result<CommandBuilder, String> {
    let configured = spec
        .shell
        .as_deref()
        .map(str::trim)
        .filter(|shell| !shell.is_empty());
    // A configured shell may be a bare name ("zsh"): resolve it so a missing shell gives a clear message.
    let resolved = match configured {
        Some(shell) => Some(
            find_program(shell)
                .ok_or_else(|| {
                    format!("{shell} is not installed on this computer (not found on PATH)")
                })?
                .display()
                .to_string(),
        ),
        None => None,
    };
    #[cfg(windows)]
    let mut command = {
        let shell = resolved.unwrap_or_else(|| {
            if which("pwsh.exe") {
                "pwsh.exe".into()
            } else {
                "powershell.exe".into()
            }
        });
        let mut command = CommandBuilder::new(&shell);
        let lower = shell.to_ascii_lowercase();
        if lower.ends_with("pwsh.exe") || lower.ends_with("powershell.exe") {
            command.arg("-NoLogo");
            command.arg("-NoExit");
            command.arg("-Command");
            command.arg(POWERSHELL_HOOK);
        } else if lower.ends_with("bash.exe") {
            command.arg("-l");
        }
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let shell = resolved
            .or_else(|| {
                std::env::var("SHELL")
                    .ok()
                    .filter(|shell| !shell.is_empty())
            })
            .unwrap_or_else(|| {
                if std::path::Path::new("/bin/bash").exists() {
                    "/bin/bash".into()
                } else {
                    "/bin/sh".into()
                }
            });
        let mut command = CommandBuilder::new(&shell);
        // bash: MetroTerm's startup file (login files + completion fix); `-l` when it can't be written.
        match bash_rcfile(&shell) {
            Some(rcfile) => {
                command.arg("--rcfile");
                command.arg(rcfile);
                command.arg("-i");
            }
            None => command.arg("-l"),
        }
        // zsh: MetroTerm's startup files in front of the user's own (see ZSH_FILES).
        if let Some(dotdir) = zsh_dotdir(&shell) {
            // The user's own ZDOTDIR, if they have one; without it the files are read from $HOME.
            if let Some(user) = std::env::var("ZDOTDIR").ok().filter(|dir| !dir.is_empty()) {
                command.env("METROTERM_USER_ZDOTDIR", user);
            }
            command.env("ZDOTDIR", dotdir);
        }
        // Programs started from this shell (and `$SHELL`) should see the shell actually running.
        command.env("SHELL", &shell);
        command
    };
    #[cfg(not(windows))]
    for (key, value) in crate::locale::local_shell_env() {
        command.env(key, value);
    }
    command.env("TERM", TERM);
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "MetroTerm");
    if let Some(home) = dirs::home_dir() {
        command.cwd(home);
    }
    Ok(command)
}

/// PowerShell prompt hook, run after the user's profile (`-NoExit -Command`), around whatever
/// prompt the profile set (oh-my-posh, starship …). At every prompt it
/// - sets the process's own current directory to the location: `cd` (Set-Location) only changes
///   PowerShell's location, and the Filer reads the process directory (`local_cwd`, wincwd.rs);
/// - reports the folder with OSC 9;9 in front of the prompt text (zero width), the sequence Windows
///   Terminal documents for PowerShell — the UI reads it where ConPTY passes it on.
///
/// Only FileSystem locations (not `HKLM:`, `Env:` …). One line without double quotes: an inline
/// command is not subject to the script execution policy, and the argument is passed as is.
#[cfg(windows)]
const POWERSHELL_HOOK: &str = "$global:MetroTermPrompt = $function:prompt; function global:prompt { $l = $executionContext.SessionState.Path.CurrentLocation; $o = ''; if ($l.Provider.Name -eq 'FileSystem') { try { [Environment]::CurrentDirectory = $l.ProviderPath } catch {}; $o = [string][char]27 + ']9;9;' + $l.ProviderPath + [char]7 }; $o + (-join (& $global:MetroTermPrompt)) }";

#[cfg(windows)]
fn which(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
        .unwrap_or(false)
}

enum Probe {
    Local(Option<u32>),
    Remote(Arc<SshHandle>, String),
}

/// Fields of /proc/<pid>/stat after the command name (which may contain spaces and parentheses):
/// 0 state, 1 ppid, 2 pgrp, 3 session, 4 tty_nr, 5 tpgid.
#[cfg(target_os = "linux")]
fn foreground_pid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.get(stat.rfind(')')? + 1..)?;
    rest.split_whitespace()
        .nth(5)?
        .parse::<i64>()
        .ok()
        .filter(|value| *value > 0)
        .map(|value| value as u32)
}

#[cfg(target_os = "linux")]
fn local_cwd(pid: u32) -> Option<String> {
    let read = |pid: u32| std::fs::read_link(format!("/proc/{pid}/cwd")).ok();
    let path = foreground_pid(pid).and_then(read).or_else(|| read(pid))?;
    Some(
        path.display()
            .to_string()
            .trim_end_matches(" (deleted)")
            .to_owned(),
    )
}

#[cfg(target_os = "macos")]
fn local_cwd(pid: u32) -> Option<String> {
    let output = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n').map(str::to_owned))
}

#[cfg(windows)]
fn local_cwd(pid: u32) -> Option<String> {
    crate::wincwd::terminal_cwd(pid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn local_cwd(_pid: u32) -> Option<String> {
    None
}

/// Finds the shell started for this terminal on the server (the topmost process carrying its
/// `LC_METROTERM_SESSION` value), then reads the current directory of the terminal's foreground
/// process (else the shell's) from /proc. One line of POSIX sh run through `sh -c '…'`, so it also
/// works when the login shell is fish or csh (no single quotes, newlines or `!` inside).
async fn remote_cwd(ssh: &SshHandle, tag: &str) -> Option<String> {
    let script = format!(
        concat!(
            "T=\"{env}={tag}\"; S=\"\"; ",
            "for f in $(grep -lzx \"$T\" /proc/[0-9]*/environ 2>/dev/null); do p=${{f#/proc/}}; S=\"$S ${{p%/environ}}\"; done; ",
            "top=\"\"; for p in $S; do pp=$(sed \"s/.*) //\" /proc/$p/stat 2>/dev/null | cut -d\" \" -f2); ",
            "case \" $S \" in *\" $pp \"*) ;; *) top=$p;; esac; done; ",
            "[ -n \"$top\" ] || exit 1; ",
            "fg=$(sed \"s/.*) //\" /proc/$top/stat | cut -d\" \" -f6); ",
            "readlink /proc/$fg/cwd 2>/dev/null || readlink /proc/$top/cwd"
        ),
        env = SESSION_ENV,
        tag = tag
    );
    let command = format!("sh -c '{script}'");
    let run = async {
        let mut channel = ssh.channel_open_session().await.ok()?;
        channel.exec(true, command.as_bytes()).await.ok()?;
        let mut out = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        let text = String::from_utf8_lossy(&out);
        let line = text
            .lines()
            .next()?
            .trim_end_matches(" (deleted)")
            .trim()
            .to_owned();
        line.starts_with('/').then_some(line)
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), run)
        .await
        .ok()
        .flatten()
}
