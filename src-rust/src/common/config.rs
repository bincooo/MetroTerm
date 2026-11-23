//! Persistent configuration stored as JSON files in `~/.metroterm/` (a portable copy — the
//! [`PORTABLE_MARKER`] file beside the executable — uses `data/` beside it instead).
//!
//! ```text
//! ~/.metroterm/
//!   settings.json   theme, title bar, panel title colors, terminal preferences
//!   sessions.json   Explorer folders + session configs, open terminal tabs (`tabs`),
//!                   panel layout (`layout`) and the window size (`window`, written by the
//!                   desktop app). Remembered passwords are stored encrypted (see common/secret.rs).
//!   known_hosts     SSH host keys accepted in MetroTerm (OpenSSH format)
//! ```
//! Files are written atomically (temp file + rename). On Unix the directory is 0700
//! and files are 0600, because sessions.json contains hosts and user names.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Serialises writes, so the UI's sessions.json and the desktop app's `window` entry never race.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Files merged into sessions.json by this version; removed once sessions.json has been written.
const MERGED_INTO_SESSIONS: [&str; 3] = ["layout", "tabs", "window"];
/// Keys of sessions.json owned by the desktop app (Rust), kept when the UI saves the file.
const SESSIONS_OWNED_KEYS: [&str; 1] = ["window"];

pub const CONFIG_DIR_NAME: &str = ".metroterm";

/// Directory name used by an earlier build; moved to `.metroterm` on first access
/// (only matters on case-sensitive file systems — elsewhere they are the same directory).
const LEGACY_DIR_NAME: &str = ".MetroTerm";

/// Marker file of a portable copy: beside the executable, it moves the configuration (settings,
/// sessions, known hosts, logs) into a `data` folder next to it instead of the home directory.
/// The Windows portable zip of the release workflow ships it.
pub const PORTABLE_MARKER: &str = "portable.metroterm";

/// `<exe dir>/data` when the executable has the portable marker beside it (looked up once).
fn portable_dir() -> Option<&'static PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        dir.join(PORTABLE_MARKER)
            .is_file()
            .then(|| dir.join("data"))
    })
    .as_ref()
}

pub fn config_dir() -> Result<PathBuf, String> {
    if let Some(dir) = portable_dir() {
        return Ok(dir.clone());
    }
    let home = dirs::home_dir().ok_or("cannot resolve home directory")?;
    let dir = home.join(CONFIG_DIR_NAME);
    let legacy = home.join(LEGACY_DIR_NAME);
    if !dir.exists() && legacy.is_dir() {
        let _ = fs::rename(&legacy, &dir);
    }
    Ok(dir)
}

pub fn ensure_dir() -> Result<PathBuf, String> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Only plain names like `layout` / `sessions` are accepted → `<name>.json` inside the config dir.
fn file_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(format!("invalid config name: {name}"));
    }
    Ok(dir.join(format!("{name}.json")))
}

/// Read `~/.metroterm/<name>.json`; `None` when the file doesn't exist yet.
pub fn load(name: &str) -> Result<Option<String>, String> {
    let path = file_path(&config_dir()?, name)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
}

/// Save `~/.metroterm/<name>.json`. sessions.json keeps the desktop-owned keys and replaces the old layout / tabs / window files.
pub fn save(name: &str, content: &str) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if name != "sessions" {
        return write_file(name, content);
    }
    // sessions.json from the UI: keep the keys the desktop app owns (window size).
    let mut doc: serde_json::Value =
        serde_json::from_str(content).map_err(|error| format!("invalid sessions.json: {error}"))?;
    if let (Some(object), Some(Ok(serde_json::Value::Object(current)))) = (
        doc.as_object_mut(),
        load("sessions")?.map(|text| serde_json::from_str::<serde_json::Value>(&text)),
    ) {
        for key in SESSIONS_OWNED_KEYS {
            match current.get(key) {
                Some(value) => {
                    object.insert(key.to_owned(), value.clone());
                }
                None => {
                    object.remove(key);
                }
            }
        }
    }
    write_file(
        name,
        &serde_json::to_string_pretty(&doc).unwrap_or_else(|_| content.to_owned()),
    )?;
    remove_merged_files();
    Ok(())
}

/// Set one top-level key of sessions.json (desktop app: `window`), keeping everything else.
pub fn set_sessions_key(key: &str, value: serde_json::Value) -> Result<(), String> {
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut doc = load("sessions")?
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({ "version": 3, "folders": [], "sessions": [] }));
    doc.as_object_mut()
        .expect("object")
        .insert(key.to_owned(), value);
    write_file(
        "sessions",
        &serde_json::to_string_pretty(&doc).map_err(|error| error.to_string())?,
    )?;
    remove_merged_files();
    Ok(())
}

/// One top-level key of sessions.json, else the old separate `<key>.json` (before the merge).
pub fn sessions_key(key: &str) -> Option<serde_json::Value> {
    let from_sessions = load("sessions")
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|doc| doc.get(key).cloned());
    from_sessions.or_else(|| {
        load(key)
            .ok()
            .flatten()
            .and_then(|text| serde_json::from_str(&text).ok())
    })
}

fn remove_merged_files() {
    if let Ok(dir) = config_dir() {
        for name in MERGED_INTO_SESSIONS {
            let _ = fs::remove_file(dir.join(format!("{name}.json")));
        }
    }
}

/// Write `~/.metroterm/<name>.json` atomically.
fn write_file(name: &str, content: &str) -> Result<(), String> {
    let dir = ensure_dir()?;
    let path = file_path(&dir, name)?;
    let temp = dir.join(format!(".{name}.json.tmp"));
    {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("cannot write {}: {error}", temp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        }
        file.write_all(content.as_bytes())
            .map_err(|error| format!("cannot write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("cannot flush {}: {error}", temp.display()))?;
    }
    fs::rename(&temp, &path).map_err(|error| format!("cannot replace {}: {error}", path.display()))
}
