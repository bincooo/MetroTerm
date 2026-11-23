//! The `metroterm` command line (`src/bin/metroterm.rs`).
//!
//! ```text
//! metroterm [--log DIR]            desktop app (builds with the `desktop` feature)
//! metroterm web [OPTIONS]          web mode: the backend (and the UI) on one address, no window
//!   -l, --listen ADDR              default 127.0.0.1:7681 (the UI moves to a free port when it is taken)
//!   --daemon                       in the background: detached, no browser; prints the address and
//!                                  returns (state in ~/.metroterm/daemon.json)
//!   --stop                         stop the background web mode
//!   --www DIR | --no-www           the UI from DIR / backend only (development with Vite)
//!   --no-browser                   do not open the browser
//!   --log DIR                      write the log file (metroterm.log) to DIR for this run
//! metroterm --version | --help
//! ```
//! A bare `--` is skipped, so `cargo run --bin metroterm -- web --daemon …` and
//! `metroterm -- web --daemon …` mean the same as `metroterm web --daemon …`.
//!
//! The UI of web mode: `--www DIR`, else a `www` folder beside the executable (the browser
//! package), else the UI built into the desktop app (release builds), else none — the backend only,
//! for the Vite dev / preview server, which proxies `/api` to it.

use crate::server::{serve_backend, serve_web, StaticFiles};
use std::path::PathBuf;

const DEFAULT_LISTEN: &str = "127.0.0.1:7681";

/// `metroterm web …`.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct WebOptions {
    /// `--listen ADDR` (None = the default address).
    pub listen: Option<String>,
    /// `--www DIR`.
    pub www: Option<PathBuf>,
    /// `--no-www`: the backend only.
    pub no_www: bool,
    /// `--no-browser`.
    pub no_browser: bool,
    /// `--daemon`: start web mode as a background process (this process only launches it).
    pub daemon: bool,
    /// `--stop`: stop the background web mode.
    pub stop: bool,
    /// `--daemon-child` (internal): this is the background process `--daemon` launched.
    pub daemon_child: bool,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Desktop,
    Web(WebOptions),
}

#[derive(Debug, PartialEq)]
pub struct Invocation {
    pub command: Command,
    /// `--log DIR`.
    pub log: Option<PathBuf>,
}

fn help() -> String {
    format!(
        "MetroTerm {version} — SSH, SFTP and terminal workspace

Usage: metroterm [--log DIR]          Start the desktop app
       metroterm web [OPTIONS]        Start in web mode (no window)

Web mode serves MetroTerm at http://ADDR/ for a browser. The server gives shell access as
this user: keep it on 127.0.0.1 unless you trust the network.

Web options:
  -l, --listen ADDR  Address to listen on (default {DEFAULT_LISTEN}; when it is taken and
                     no address was given, the UI moves to a free port).
  --daemon           Run in the background: the server keeps running after the terminal
                     is closed and no browser is opened. Prints the address and returns;
                     a second --daemon reports the one already running.
  --stop             Stop the web mode started with --daemon.
  --www DIR          Serve the UI from DIR (a built dist/ folder). Default: the www
                     folder beside this program, else the UI built into the app.
  --no-www           Backend only (/api), for the Vite dev / preview server.
  --no-browser       Do not open the default browser.

Options:
  --log DIR          Write the log file (metroterm.log) to DIR for this run, instead of
                     the path in Session → Log → Log Settings (default ~/.metroterm/logs).
  -V, --version      Print the version and exit.
  -h, --help         Print this help and exit.

Examples:
  metroterm web                         web mode, opened in the default browser
  metroterm web --listen 0.0.0.0:8080   on all addresses, port 8080
  metroterm web --daemon                in the background
  metroterm web --stop
",
        version = env!("CARGO_PKG_VERSION")
    )
}

/// Parse `std::env::args()`; prints help / version / errors itself (`Err` = exit code).
pub fn parse() -> Result<Invocation, i32> {
    let args: Vec<String> = std::env::args()
        .skip(1)
        // macOS adds -psn_… when the app is opened from Finder on old systems.
        .filter(|arg| !arg.starts_with("-psn_"))
        .collect();
    if !args.is_empty() {
        attach_console();
    }
    parse_args(args)
}

fn parse_args(args: Vec<String>) -> Result<Invocation, i32> {
    let mut log = None;
    let mut web: Option<WebOptions> = None;
    let mut iter = args.into_iter().filter(|arg| arg != "--");
    while let Some(arg) = iter.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_owned(), Some(value.to_owned()))
            }
            _ => (arg.clone(), None),
        };
        // An option's value: `--name=VALUE` or `--name VALUE`.
        let mut value = |what: &str| -> Result<String, i32> {
            match inline
                .clone()
                .or_else(|| iter.next())
                .filter(|value| !value.is_empty())
            {
                Some(value) => Ok(value),
                None => {
                    eprintln!("metroterm: {name} needs {what}\nTry 'metroterm --help'.");
                    Err(2)
                }
            }
        };
        match (name.as_str(), web.as_mut()) {
            ("-h" | "--help", _) => {
                print!("{}", help());
                return Err(0);
            }
            ("-V" | "-v" | "--version", _) => {
                println!("MetroTerm {}", env!("CARGO_PKG_VERSION"));
                return Err(0);
            }
            ("--log", _) => log = Some(PathBuf::from(value("a directory")?)),
            ("web", None) => web = Some(WebOptions::default()),
            ("-l" | "--listen", Some(options)) => options.listen = Some(value("an address")?),
            ("--www", Some(options)) => options.www = Some(PathBuf::from(value("a folder")?)),
            ("--no-www", Some(options)) => options.no_www = true,
            ("--no-browser", Some(options)) => options.no_browser = true,
            ("--daemon", Some(options)) => options.daemon = true,
            ("--stop", Some(options)) => options.stop = true,
            ("--daemon-child", Some(options)) => options.daemon_child = true,
            ("--web" | "--daemon" | "--stop", None) => {
                let sub = &name[2..];
                let hint = match sub {
                    "web" => "metroterm web".to_owned(),
                    _ => format!("metroterm web --{sub}"),
                };
                eprintln!("metroterm: {name} is now `{hint}`\nTry 'metroterm --help'.");
                return Err(2);
            }
            _ => {
                eprintln!("metroterm: unknown argument {arg}\nTry 'metroterm --help'.");
                return Err(2);
            }
        }
    }
    if let Some(options) = &web {
        if options.www.is_some() && options.no_www {
            eprintln!("metroterm: --www and --no-www cannot be used together");
            return Err(2);
        }
    }
    Ok(Invocation {
        command: web.map_or(Command::Desktop, Command::Web),
        log,
    })
}

/// The `metroterm` program: returns the exit code.
pub fn main() -> i32 {
    let invocation = match parse() {
        Ok(invocation) => invocation,
        Err(code) => return code,
    };
    let set_log = |log: &Option<PathBuf>| match log {
        Some(dir) => crate::common::applog::set_dir(dir.clone())
            .map(|_| ())
            .map_err(|error| {
                eprintln!("metroterm: {error}");
                1
            }),
        None => Ok(()),
    };
    match invocation.command {
        Command::Web(options) if options.stop => stop_daemon(),
        Command::Web(options) if options.daemon && !options.daemon_child => {
            start_daemon(&options, invocation.log.as_deref())
        }
        Command::Web(options) => match set_log(&invocation.log) {
            Ok(()) => run_web(options),
            Err(code) => code,
        },
        Command::Desktop => {
            if let Err(code) = set_log(&invocation.log) {
                return code;
            }
            desktop()
        }
    }
}

#[cfg(feature = "desktop")]
fn desktop() -> i32 {
    crate::desktop::run();
    0
}

#[cfg(not(feature = "desktop"))]
fn desktop() -> i32 {
    eprintln!("metroterm: this build has no desktop app — start web mode with `metroterm web` (see `metroterm --help`)");
    2
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

/// What web mode serves besides `/api`.
enum Ui {
    /// The backend only (the Vite dev / preview server serves the UI).
    None,
    /// The UI's files, and where they come from (for the start message).
    Files(StaticFiles, String),
}

fn choose_ui(options: &WebOptions) -> Result<Ui, String> {
    if options.no_www {
        return Ok(Ui::None);
    }
    if let Some(dir) = &options.www {
        let dir = std::path::absolute(dir).unwrap_or_else(|_| dir.clone());
        if !dir.join("index.html").is_file() {
            return Err(format!("{} has no index.html", dir.display()));
        }
        let from = format!("UI from {}", dir.display());
        return Ok(Ui::Files(crate::server::dir_files(dir), from));
    }
    if let Some(dir) = default_www() {
        let from = format!("UI from {}", dir.display());
        return Ok(Ui::Files(crate::server::dir_files(dir), from));
    }
    #[cfg(feature = "desktop")]
    {
        let files = crate::desktop::bundle_files();
        if files("/index.html").is_some() {
            return Ok(Ui::Files(files, "built-in UI".to_owned()));
        }
    }
    Ok(Ui::None)
}

/// `www` beside the executable, when it holds a UI (the browser package).
fn default_www() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("www");
    dir.join("index.html").is_file().then_some(dir)
}

/// `metroterm web`: serve until the process is stopped. As the background process of `--daemon`
/// (`daemon_child`): no browser, the address goes to daemon.json.
pub fn run_web(options: WebOptions) -> i32 {
    crate::common::applog::init();
    let ui = match choose_ui(&options) {
        Ok(ui) => ui,
        Err(error) => {
            eprintln!("metroterm: {error}");
            return 2;
        }
    };
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
        let bind = |addr: String| async move {
            tokio::net::TcpListener::bind(&addr)
                .await
                .map_err(|error| format!("cannot listen on {addr}: {error}"))
        };
        let listener = match (&options.listen, &ui) {
            (Some(addr), _) => bind(addr.clone()).await?,
            // The backend alone stays where the Vite proxy expects it.
            (None, Ui::None) => bind(DEFAULT_LISTEN.to_owned()).await?,
            (None, Ui::Files(..)) => match bind(DEFAULT_LISTEN.to_owned()).await {
                Ok(listener) => listener,
                Err(_) => bind("127.0.0.1:0".to_owned()).await?,
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
        let version = env!("CARGO_PKG_VERSION");
        match &ui {
            Ui::None => println!(
                "MetroTerm {version} backend: {url}  (/api only — the UI comes from the Vite dev / preview server)"
            ),
            Ui::Files(_, from) => println!("MetroTerm {version} web mode: {url}  ({from})"),
        }
        if !local.ip().is_loopback() {
            println!("Listening on {local} — anyone who can reach it gets shell access.");
        }
        log::info!(
            "Web mode on {local}{}{}",
            if matches!(ui, Ui::None) { ", backend only" } else { "" },
            if options.daemon_child { " (background)" } else { "" }
        );
        if options.daemon_child {
            write_state(&DaemonState {
                pid: std::process::id(),
                url: url.clone(),
                addr: local.to_string(),
            });
        } else {
            println!("Press Ctrl+C to stop.");
            // The desktop app opens its web mode in the browser; the browser package (often on a
            // server without a desktop) and the backend alone do not.
            let browser = cfg!(feature = "desktop")
                && !options.no_browser
                && matches!(ui, Ui::Files(..));
            if browser && open_browser(&url).is_err() {
                println!("Open {url} in a browser.");
            }
        }
        match ui {
            Ui::None => serve_backend(listener).await,
            Ui::Files(files, _) => serve_web(listener, files).await,
        }
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

/// Open `url` with the system's default handler (browser), without waiting for it. Also used by
/// the desktop app's `open_url` (terminal links).
pub(crate) fn open_browser(url: &str) -> std::io::Result<()> {
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
    let mut child = command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    // Reap the helper when it exits (xdg-open hands the URL over and quits).
    std::thread::spawn(move || child.wait());
    Ok(())
}

// ---------- web --daemon / web --stop ----------

/// `~/.metroterm/daemon.json`: the background web mode that is (or was) running.
#[derive(serde::Serialize, serde::Deserialize)]
struct DaemonState {
    pid: u32,
    url: String,
    addr: String,
}

fn state_path() -> Option<PathBuf> {
    crate::common::config::ensure_dir()
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

/// `web --daemon`: launch this program again as a detached `web --daemon-child …` process, wait
/// until it listens, print its address and return.
pub fn start_daemon(options: &WebOptions, log: Option<&std::path::Path>) -> i32 {
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
    command.args(["web", "--daemon-child"]);
    if let Some(addr) = &options.listen {
        command.arg(format!("--listen={addr}"));
    }
    if options.no_www {
        command.arg("--no-www");
    }
    // Paths as seen from here (the background process starts in the same folder, but be sure).
    let absolute =
        |path: &std::path::Path| std::path::absolute(path).unwrap_or_else(|_| path.to_owned());
    if let Some(dir) = &options.www {
        command.arg("--www").arg(absolute(dir));
    }
    if let Some(dir) = log {
        command.arg("--log").arg(absolute(dir));
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
            println!("Stop it with: metroterm web --stop");
            return 0;
        }
        if let Ok(Some(status)) = child.try_wait() {
            eprintln!(
                "metroterm: the background process stopped ({status}) — see the log ({})",
                crate::common::applog::default_path().display()
            );
            return 1;
        }
    }
    println!("MetroTerm started in the background (PID {pid}); its address is not known yet — see the log.");
    0
}

/// `web --stop`: end the background web mode started with `web --daemon`.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Invocation, i32> {
        parse_args(args.iter().map(|arg| arg.to_string()).collect())
    }

    fn web(args: &[&str]) -> WebOptions {
        match parse(args) {
            Ok(Invocation {
                command: Command::Web(options),
                ..
            }) => options,
            other => panic!("{args:?}: {other:?}"),
        }
    }

    #[test]
    fn commands() {
        assert_eq!(
            parse(&[]),
            Ok(Invocation {
                command: Command::Desktop,
                log: None
            })
        );
        assert_eq!(
            parse(&["--log", "/tmp/x"]).unwrap().log,
            Some(PathBuf::from("/tmp/x"))
        );
        assert_eq!(web(&["web"]), WebOptions::default());
        // `cargo run --bin metroterm -- web --daemon` and `metroterm -- web --daemon`.
        let daemon = WebOptions {
            daemon: true,
            ..Default::default()
        };
        assert_eq!(web(&["--", "web", "--daemon"]), daemon);
        assert_eq!(web(&["web", "--", "--daemon"]), daemon);
        let options = web(&[
            "web",
            "--daemon",
            "-l",
            "0.0.0.0:8080",
            "--www=/srv/ui",
            "--no-browser",
        ]);
        assert_eq!(options.listen.as_deref(), Some("0.0.0.0:8080"));
        assert_eq!(options.www, Some(PathBuf::from("/srv/ui")));
        assert!(options.daemon && options.no_browser && !options.stop);
        assert_eq!(
            web(&["web", "--listen=127.0.0.1:9000"]).listen.as_deref(),
            Some("127.0.0.1:9000")
        );
        let both = parse(&["web", "--log=/tmp/l", "--stop"]).unwrap();
        assert_eq!(both.log, Some(PathBuf::from("/tmp/l")));
        assert!(matches!(
            both.command,
            Command::Web(WebOptions { stop: true, .. })
        ));
    }

    #[test]
    fn errors() {
        for args in [
            &["--web"][..],
            &["--daemon"],
            &["--stop"],
            &["--listen", "1.2.3.4:1"],
            &["web", "web"],
            &["web", "--listen"],
            &["web", "--www", "a", "--no-www"],
            &["serve"],
        ] {
            assert_eq!(parse(args), Err(2), "{args:?}");
        }
        assert_eq!(parse(&["web", "--help"]), Err(0));
    }
}
