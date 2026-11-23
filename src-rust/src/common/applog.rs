//! Application log (Session → Log…): level, output file, line format and size limit.
//!
//! Settings live in settings.json under `"log"` (the UI writes them and calls `log.configure`);
//! the backend reads them once at start-up. Records come from the `log` crate macros in the
//! backend and from the UI (`log.write`, target "ui").
//!
//! `metroterm [web] --log <dir>` puts the log file in that directory for this run, whatever the
//! settings say ([`set_dir`]).

use serde::{Deserialize, Serialize};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

/// `--log <dir>`: the log directory for this run (overrides the saved path).
static DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// Use `dir` for the log file (command line `--log`); call before anything is logged.
pub fn set_dir(dir: PathBuf) -> Result<PathBuf, String> {
    let dir = if dir.is_absolute() {
        dir
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(dir)
    };
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create log directory {}: {error}", dir.display()))?;
    let file = dir.join("metroterm.log");
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|error| format!("cannot write {}: {error}", file.display()))?;
    let _ = DIR_OVERRIDE.set(dir.clone());
    Ok(file)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LogConfig {
    /// off | error | warn | info | debug | trace
    pub level: String,
    /// Log file; empty = ~/.metroterm/logs/metroterm.log
    pub path: String,
    /// text | json
    pub format: String,
    /// Rotate when the file grows past this many MB (0 = never).
    pub max_size_mb: u64,
    /// Rotated files kept next to it (metroterm.log.1 … .N).
    pub keep: u32,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: "info".into(),
            path: String::new(),
            format: "text".into(),
            max_size_mb: 10,
            keep: 3,
        }
    }
}

impl LogConfig {
    fn filter(&self) -> log::LevelFilter {
        match self.level.as_str() {
            "off" => log::LevelFilter::Off,
            "error" => log::LevelFilter::Error,
            "warn" => log::LevelFilter::Warn,
            "debug" => log::LevelFilter::Debug,
            "trace" => log::LevelFilter::Trace,
            _ => log::LevelFilter::Info,
        }
    }

    pub fn file(&self) -> PathBuf {
        let path = self.path.trim();
        if let Some(dir) = DIR_OVERRIDE.get() {
            dir.join("metroterm.log")
        } else if path.is_empty() {
            default_path()
        } else if let Some(rest) = path.strip_prefix("~/") {
            dirs::home_dir().unwrap_or_default().join(rest)
        } else {
            PathBuf::from(path)
        }
    }
}

pub fn default_path() -> PathBuf {
    if let Some(dir) = DIR_OVERRIDE.get() {
        return dir.join("metroterm.log");
    }
    crate::common::config::config_dir()
        .unwrap_or_else(|_| PathBuf::from(".metroterm"))
        .join("logs")
        .join("metroterm.log")
}

struct State {
    config: LogConfig,
    file: Option<File>,
    size: u64,
}

struct AppLogger {
    state: Mutex<Option<State>>,
}

static LOGGER: AppLogger = AppLogger {
    state: Mutex::new(None),
};

impl log::Log for AppLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // Dependencies (russh, tokio …) only from debug on, so `info` stays about MetroTerm itself.
        let target = record.target();
        let ours = target.starts_with("metroterm") || target == "ui";
        if !ours && record.level() > log::Level::Warn && log::max_level() < log::LevelFilter::Debug
        {
            return;
        }
        let mut guard = self.state.lock().unwrap();
        let Some(state) = guard.as_mut() else { return };
        let line = format_line(&state.config.format, record);
        if state.file.is_none() {
            open(state);
        }
        if let Some(file) = state.file.as_mut() {
            if file.write_all(line.as_bytes()).is_ok() {
                state.size += line.len() as u64;
            }
        }
        let limit = state.config.max_size_mb.saturating_mul(1024 * 1024);
        if limit > 0 && state.size >= limit {
            rotate(state);
        }
    }

    fn flush(&self) {
        if let Some(file) = self
            .state
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|s| s.file.as_mut())
        {
            let _ = file.flush();
        }
    }
}

fn format_line(format: &str, record: &log::Record) -> String {
    let now = chrono::Local::now();
    let message = record.args().to_string();
    if format == "json" {
        let value = serde_json::json!({
            "time": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, false),
            "level": record.level().as_str(),
            "target": record.target(),
            "message": message,
        });
        format!("{value}\n")
    } else {
        format!(
            "{} {:<5} [{}] {}\n",
            now.format("%Y-%m-%d %H:%M:%S%.3f"),
            record.level(),
            record.target(),
            message
        )
    }
}

fn open(state: &mut State) {
    let path = state.config.file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    state.file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok();
    state.size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
}

/// metroterm.log → .1 → .2 …, the oldest beyond `keep` is dropped; then a fresh file.
fn rotate(state: &mut State) {
    state.file = None;
    let path = state.config.file();
    let numbered = |n: u32| PathBuf::from(format!("{}.{n}", path.display()));
    let keep = state.config.keep;
    if keep == 0 {
        let _ = std::fs::remove_file(&path);
    } else {
        let _ = std::fs::remove_file(numbered(keep));
        for n in (1..keep).rev() {
            let _ = std::fs::rename(numbered(n), numbered(n + 1));
        }
        let _ = std::fs::rename(&path, numbered(1));
    }
    open(state);
}

/// Settings saved in settings.json (`"log"`), defaults when missing.
fn saved_config() -> LogConfig {
    crate::common::config::load("settings")
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|doc| doc.get("log").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

/// Install the logger with the saved settings (once per process).
pub fn init() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(install);
}

fn install() {
    let config = saved_config();
    log::set_max_level(config.filter());
    *LOGGER.state.lock().unwrap() = Some(State {
        config,
        file: None,
        size: 0,
    });
    let _ = log::set_logger(&LOGGER);
    log::info!("MetroTerm {} started", env!("CARGO_PKG_VERSION"));
}

/// Apply new settings (`log.configure`); returns the log file in use.
pub fn configure(config: LogConfig) -> Result<String, String> {
    let path = config.file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("Cannot write {}: {error}", path.display()))?;
    log::set_max_level(config.filter());
    let mut guard = LOGGER.state.lock().unwrap();
    *guard = Some(State {
        config,
        file: None,
        size: 0,
    });
    drop(guard);
    log::info!("Log settings changed");
    Ok(path.display().to_string())
}

/// A line from the UI (`log.write`).
pub fn write(level: &str, message: &str) {
    let level = match level {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "debug" => log::Level::Debug,
        _ => log::Level::Info,
    };
    log::log!(target: "ui", level, "{message}");
}
