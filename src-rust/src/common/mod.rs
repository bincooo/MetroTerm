//! Infrastructure shared by every part of the backend.
//!
//! - `config`  — the JSON files in `~/.metroterm/` (settings, sessions, explorer, windows …)
//! - `events`  — events pushed to the UI and the interactive prompt broker
//! - `applog`  — the application log (Session → Log…)
//! - `locale`  — a UTF-8 locale for shells
//! - `secret`  — remembered SSH passwords (sealed in sessions.json)
//! - `themes`  — terminal colour schemes (`.itermcolors` files)

pub mod applog;
pub mod config;
pub mod events;
pub mod locale;
pub mod secret;
pub mod themes;
