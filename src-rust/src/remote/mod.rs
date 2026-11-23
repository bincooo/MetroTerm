//! Connections to other hosts.
//!
//! - `ssh`    — SSH transport (`russh`): one shared connection per saved session, authentication,
//!   host keys
//! - `net`    — outgoing TCP connections: direct, SOCKS5 / HTTP CONNECT proxy or SSH jump host
//! - `tunnel` — SSH port forwarding (`-L`, `-R`, `-D`)

pub mod net;
pub mod ssh;
pub mod tunnel;
