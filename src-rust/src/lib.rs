//! MetroTerm backend.
//!
//! - `backend`  — transport-independent RPC dispatcher (terminals, SSH, SFTP, config)
//! - `desktop`  — Tauri app (feature `desktop`, default)
//! - `server`   — WebSocket/HTTP server for running the UI in a browser (feature `server`; the
//!   desktop app includes it for `metroterm --web`)
//! - `cli`      — the desktop app's command line (`--web`, `--log`, `--version`, `--help`)

pub mod applog;
pub mod backend;
pub mod config;
pub mod events;
pub mod files;
pub mod locale;
pub mod monitor;
pub mod net;
pub mod secret;
pub mod ssh;
pub mod stream;
pub mod terminal;
pub mod tunnel;
pub mod utf8;
#[cfg(windows)]
mod wincwd;

#[cfg(feature = "desktop")]
mod cli;
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub use desktop::run;

#[cfg(feature = "server")]
pub mod server;
