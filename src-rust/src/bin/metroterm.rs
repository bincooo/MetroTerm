//! The `metroterm` program.
//!
//! ```text
//! metroterm                                  desktop app (default `desktop` feature)
//! metroterm web [--daemon | --stop] [--listen ADDR] [--www DIR | --no-www] …
//! cargo run --bin metroterm -- web --daemon …
//! cargo run --no-default-features --features server --bin metroterm -- web --no-www
//!                                            backend only, for the Vite dev / preview server
//! ```
//! A server-only build (the browser package: no GTK / WebKit) has web mode only; with a `www`
//! folder beside it, `metroterm web` serves that UI. All options: `metroterm --help`, `cli.rs`.

// No extra console window for the desktop app in Windows release builds (`cli.rs` attaches to the
// console it was started from when there are arguments).
#![cfg_attr(
    all(not(debug_assertions), feature = "desktop"),
    windows_subsystem = "windows"
)]

fn main() {
    std::process::exit(metroterm_lib::cli::main());
}
