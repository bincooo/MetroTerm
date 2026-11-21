//! Command line of the desktop app.
//!
//! ```text
//! metroterm                      desktop app
//! metroterm --web[=ADDR]         no window: serve the UI and the backend on ADDR and open it in
//!                                the default browser (default 127.0.0.1:7681, or a free port
//!                                when that one is taken)
//! metroterm --daemon[=ADDR]      web mode in the background: detached from the terminal, no browser
//!                                opened; prints the address and exits (state in ~/.metroterm/daemon.json)
//! metroterm --stop               stop the background web mode
//! metroterm --log DIR            write the log file (metroterm.log) to DIR for this run
//! metroterm --version | --help
//! ```

use crate::server::{serve_web, StaticFiles};
use std::{path::PathBuf, sync::Arc};

const DEFAULT_WEB: &str = "127.0.0.1:7681";

#[derive(Default)]
pub struct Options {
    /// `--web`: `Some(None)` = default address, `Some(Some(addr))` = `--web=ADDR`.
    pub web: Option<Option<String>>,
    /// `--log DIR`.
    pub log: Option<PathBuf>,
    /// `--daemon`: start web mode as a background process (this process only launches it).
    pub daemon: bool,
    /// `--stop`: stop the background web mode.
    pub stop: bool,
    /// `--daemon-child` (internal): this is the background process `--daemon` launched.
    pub daemon_child: bool,
}

pub enum Parsed {
    Run(Options),
    Exit(i32),
}

fn help() -> String {
    format!(
        "MetroTerm {version} — SSH, SFTP and terminal workspace

Usage: metroterm [OPTIONS]

Options:
  --web[=ADDR]     Start in web mode only: no desktop window; the UI is served at
                   http://ADDR/ and opened in the default browser. ADDR defaults to
                   {DEFAULT_WEB} (a free port is used when it is taken). The server
                   gives shell access: keep it on 127.0.0.1 unless you trust the network.
                   Stop it with Ctrl+C.
  --daemon[=ADDR]  Start web mode in the background: the server keeps running after the
                   terminal is closed and no browser is opened. Prints the address
                   (default as for --web; --daemon --web=ADDR works too) and returns.
                   A second --daemon reports the one already running.
  --stop           Stop the web mode started with --daemon.
  --log DIR        Write the log file (metroterm.log) to DIR for this run, instead of
                   the path in Session → Log → Log Settings (default ~/.metroterm/logs).
  -V, --version    Print the version and exit.
  -h, --help       Print this help and exit.
",
        version = env!("CARGO_PKG_VERSION")
    )
}

/// Parse `std::env::args()`. Prints help / version / errors itself.
pub fn parse() -> Parsed {
    let args: Vec<String> = std::env::args()
        .skip(1)
        // macOS adds -psn_… when the app is opened from Finder on old systems.
        .filter(|arg| !arg.starts_with("-psn_"))
        .collect();
    if args.is_empty() {
        return Parsed::Run(Options::default());
    }
    attach_console();
    let mut options = Options::default();
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_owned(), Some(value.to_owned()))
            }
            _ => (arg.clone(), None),
        };
        match name.as_str() {
            "-h" | "--help" => {
                print!("{}", help());
                return Parsed::Exit(0);
            }
            "-V" | "-v" | "--version" => {
                println!("MetroTerm {}", env!("CARGO_PKG_VERSION"));
                return Parsed::Exit(0);
            }
            "--web" => options.web = Some(inline.filter(|value| !value.is_empty())),
            "--daemon" => {
                options.daemon = true;
                if let Some(addr) = inline.filter(|value| !value.is_empty()) {
                    options.web = Some(Some(addr));
                }
            }
            "--daemon-child" => options.daemon_child = true,
            "--stop" => options.stop = true,
            "--log" => {
                let Some(dir) = inline
                    .or_else(|| iter.next())
                    .filter(|value| !value.is_empty())
                else {
                    eprintln!("metroterm: --log needs a directory (metroterm --log DIR)");
                    return Parsed::Exit(2);
                };
                options.log = Some(PathBuf::from(dir));
            }
            _ => {
                eprintln!("metroterm: unknown option {arg}\nTry 'metroterm --help'.");
                return Parsed::Exit(2);
            }
        }
    }
    if (options.daemon || options.daemon_child) && options.web.is_none() {
        options.web = Some(None);
    }
    Parsed::Run(options)
}

/// Windows release builds have no console of their own: write to the one they were started from.
#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}
#[cfg(not(windows))]
fn attach_console() {}

/// `--web`: serve the UI files (from the app bundle) and the backend until the process is stopped.
/// `daemon`: the background process of `--daemon` — no browser, the address goes to daemon.json.
pub fn run_web(addr: Option<String>, files: StaticFiles, daemon: bool) -> i32 {
    crate::applog::init();
    if files("/index.html").is_none() {
        eprintln!(
            "metroterm: this build has no embedded UI (debug build) — use a release build, or `npm run dev` with metroterm-server"
        );
        return 1;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("metroterm: {error}");
            return 1;
        }
    };
    let result = runtime.block_on(async move {
        let listener = match &addr {
            Some(addr) => tokio::net::TcpListener::bind(addr)
                .await
                .map_err(|error| format!("cannot listen on {addr}: {error}"))?,
            None => match tokio::net::TcpListener::bind(DEFAULT_WEB).await {
                Ok(listener) => listener,
                Err(_) => tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|error| format!("cannot listen on 127.0.0.1: {error}"))?,
            },
        };
        let local = listener.local_addr().map_err(|error| error.to_string())?;
        // A wildcard address is opened as the loopback one.
        let host = match local.ip() {
            ip if ip.is_unspecified() && ip.is_ipv4() => "127.0.0.1".to_owned(),
            ip if ip.is_unspecified() => "[::1]".to_owned(),
            std::net::IpAddr::V6(ip) => format!("[{ip}]"),
            ip => ip.to_string(),
        };
        let url = format!("http://{host}:{}/", local.port());
        println!("MetroTerm {} web mode: {url}", env!("CARGO_PKG_VERSION"));
        if !local.ip().is_loopback() {
            println!("Listening on {local} — anyone who can reach it gets shell access.");
        }
        log::info!(
            "Web mode on {local}{}",
            if daemon { " (background)" } else { "" }
        );
        if daemon {
            write_state(&DaemonState {
                pid: std::process::id(),
                url: url.clone(),
                addr: local.to_string(),
            });
        } else {
            println!("Press Ctrl+C to stop.");
            open_browser(&url);
        }
        serve_web(listener, files).await
    });
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("metroterm: {error}");
            log::error!("Web mode: {error}");
            1
        }
    }
}

fn open_browser(url: &str) {
    use std::process::{Command, Stdio};
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    match command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        // Reap the helper when it exits (xdg-open hands the URL over and quits).
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(_) => println!("Open {url} in a browser."),
    }
}

/// The UI files of the app bundle as [`StaticFiles`].
pub fn bundle_files(assets: Box<dyn tauri::Assets<tauri::Wry>>) -> StaticFiles {
    let assets: Arc<dyn tauri::Assets<tauri::Wry>> = Arc::from(assets);
    Arc::new(move |path: &str| {
        assets
            .get(&tauri::utils::assets::AssetKey::from(path))
            .map(|body| body.into_owned())
    })
}

// ---------- --daemon / --stop ----------

/// `~/.metroterm/daemon.json`: the background web mode that is (or was) running.
#[derive(serde::Serialize, serde::Deserialize)]
struct DaemonState {
    pid: u32,
    url: String,
    addr: String,
}

fn state_path() -> Option<PathBuf> {
    crate::config::ensure_dir()
        .ok()
        .map(|dir| dir.join("daemon.json"))
}

fn write_state(state: &DaemonState) {
    if let (Some(path), Ok(text)) = (state_path(), serde_json::to_string_pretty(state)) {
        if let Err(error) = std::fs::write(&path, text) {
            log::warn!("Cannot write {}: {error}", path.display());
        }
    }
}

fn read_state() -> Option<DaemonState> {
    serde_json::from_str(&std::fs::read_to_string(state_path()?).ok()?).ok()
}

/// The process is still there and something answers on its address (a stale file after a crash or
/// reboot does not count, nor another program that took the port since).
fn answers(state: &DaemonState) -> bool {
    pid_alive(state.pid) && listening(state)
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // Signal 0: only checks that the process exists (EPERM: it exists, owned by someone else).
    let sent = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
    sent || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true
}

fn listening(state: &DaemonState) -> bool {
    use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
    let Ok(mut addrs) = state.addr.to_socket_addrs() else {
        return false;
    };
    addrs.any(|addr: SocketAddr| {
        // A wildcard listener is reached on the loopback address.
        let addr = if addr.ip().is_unspecified() {
            SocketAddr::new(
                if addr.is_ipv4() {
                    std::net::Ipv4Addr::LOCALHOST.into()
                } else {
                    std::net::Ipv6Addr::LOCALHOST.into()
                },
                addr.port(),
            )
        } else {
            addr
        };
        TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)).is_ok()
    })
}

/// `--daemon`: launch this program again as a detached `--daemon-child --web…` process, wait until
/// it listens, print its address and return.
pub fn start_daemon(options: &Options) -> i32 {
    use std::process::{Command, Stdio};
    if let Some(state) = read_state().filter(answers) {
        println!(
            "MetroTerm is already running in the background (PID {}): {}",
            state.pid, state.url
        );
        return 0;
    }
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("metroterm: {error}");
            return 1;
        }
    };
    let mut command = Command::new(exe);
    command.arg("--daemon-child");
    match &options.web {
        Some(Some(addr)) => command.arg(format!("--web={addr}")),
        _ => command.arg("--web"),
    };
    if let Some(dir) = &options.log {
        command.arg("--log").arg(dir);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A session of its own: closing the terminal (SIGHUP) or Ctrl+C there does not stop it.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("metroterm: cannot start the background process: {error}");
            return 1;
        }
    };
    let pid = child.id();
    for _ in 0..100 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Some(state) = read_state().filter(|state| state.pid == pid) {
            println!(
                "MetroTerm {} is running in the background (PID {pid}): {}",
                env!("CARGO_PKG_VERSION"),
                state.url
            );
            println!("Stop it with: metroterm --stop");
            return 0;
        }
        if let Ok(Some(status)) = child.try_wait() {
            eprintln!(
                "metroterm: the background process stopped ({status}) — see the log ({})",
                crate::applog::default_path().display()
            );
            return 1;
        }
    }
    println!("MetroTerm started in the background (PID {pid}); its address is not known yet — see the log.");
    0
}

/// `--stop`: end the background web mode started with `--daemon`.
pub fn stop_daemon() -> i32 {
    let Some(state) = read_state() else {
        println!("No background MetroTerm is running.");
        return 1;
    };
    if !answers(&state) {
        println!("No background MetroTerm is running.");
        if let Some(path) = state_path() {
            let _ = std::fs::remove_file(path);
        }
        return 1;
    }
    #[cfg(unix)]
    let sent = unsafe { libc::kill(state.pid as libc::pid_t, libc::SIGTERM) } == 0;
    #[cfg(windows)]
    let sent = std::process::Command::new("taskkill")
        .args(["/PID", &state.pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !sent {
        eprintln!("metroterm: cannot stop PID {}", state.pid);
        return 1;
    }
    for _ in 0..50 {
        if !answers(&state) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if let Some(path) = state_path() {
        let _ = std::fs::remove_file(path);
    }
    println!("Stopped the background MetroTerm (PID {}).", state.pid);
    0
}
