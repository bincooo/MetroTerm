//! MetroTerm backend.
//!
//! Entry points and transports:
//! - `cli`      — the `metroterm` command line (`src/bin/metroterm.rs`): the desktop app, or
//!   `metroterm web [--daemon | --stop | --listen ADDR …]`
//! - `desktop`  — Tauri app (feature `desktop`, default)
//! - `server`   — WebSocket/HTTP server for running the UI in a browser (feature `server`; the
//!   desktop app includes it for `metroterm web`)
//! - `backend`  — transport-independent RPC dispatcher used by both (terminals, SSH, SFTP, config)
//!
//! Features:
//! - `terminal` — terminal sessions: local PTY, SSH shell, Telnet / TCP / Serial (`terminal::stream`)
//! - `remote`   — SSH connections, proxies / jump hosts, port forwarding (Tunnels)
//! - `files`    — the Filer: SFTP or the local file system
//! - `monitor`  — the Monitor panel: CPU / memory / network / disks / processes of a host
//! - `agents`   — agent CLI status of each terminal (Claude Code, Codex, opencode …)
//! - `mcp`      — MCP server (SSE / Streamable HTTP) for agent CLIs to use the terminals (feature `server`)
//!
//! Shared infrastructure:
//! - `common`   — config files, UI events, app log, locale, remembered passwords, colour schemes

pub mod agents;
pub mod backend;
pub mod common;
pub mod files;
pub mod monitor;
pub mod remote;
pub mod terminal;

#[cfg(feature = "server")]
pub mod cli;
#[cfg(feature = "desktop")]
mod desktop;
#[cfg(feature = "desktop")]
pub use desktop::run;

#[cfg(feature = "server")]
pub mod mcp;
#[cfg(feature = "server")]
pub mod server;
