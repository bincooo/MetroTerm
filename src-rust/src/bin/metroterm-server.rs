//! Headless backend for the browser UI.
//!
//! ```text
//! cargo run --no-default-features --features server --bin metroterm-server -- --listen 127.0.0.1:7681
//! metroterm-server --www ./www              # also serve the built UI (the browser package)
//! ```
//! Without a UI folder this is the backend only: the Vite dev / preview server proxies `/api`
//! (HTTP + WebSocket) to this address. With one (`--www DIR`, or a `www` folder beside the
//! executable — the layout of the browser package) it serves the UI itself, like `metroterm --web`,
//! and then only accepts `/api` requests from its own pages (see `server.rs`).

use std::path::PathBuf;

const USAGE: &str = "metroterm-server [--listen 127.0.0.1:7681] [--www DIR | --no-www]

  --listen, -l ADDR   address to listen on (default 127.0.0.1:7681). Anyone who can reach it gets
                      shell access as this user: keep it on localhost, or behind an SSH tunnel.
  --www DIR           serve the browser UI from DIR (the built dist/ folder). Default: the `www`
                      folder beside this executable, when it has an index.html.
  --no-www            backend only, even when a `www` folder exists (development with Vite).
  --version, -V       print the version";

#[tokio::main]
async fn main() {
    let mut listen = "127.0.0.1:7681".to_owned();
    let mut www: Option<PathBuf> = None;
    let mut no_www = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--listen" | "-l" => listen = args.next().expect("--listen needs an address"),
            "--www" => www = Some(args.next().expect("--www needs a folder").into()),
            "--no-www" => no_www = true,
            "--version" | "-V" => {
                println!("metroterm-server {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--help" | "-h" => {
                println!("{USAGE}");
                return;
            }
            other => {
                eprintln!("unknown argument: {other}\n\n{USAGE}");
                std::process::exit(2);
            }
        }
    }
    let www = if no_www {
        None
    } else {
        www.or_else(default_www)
    };
    let result = match www {
        None => metroterm_lib::server::serve(&listen).await,
        Some(dir) => {
            if !dir.join("index.html").is_file() {
                eprintln!("metroterm-server: {} has no index.html", dir.display());
                std::process::exit(2);
            }
            serve_ui(&listen, dir).await
        }
    };
    if let Err(error) = result {
        eprintln!("metroterm-server: {error}");
        std::process::exit(1);
    }
}

/// `www` beside the executable, when it holds a UI.
fn default_www() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("www");
    dir.join("index.html").is_file().then_some(dir)
}

async fn serve_ui(listen: &str, dir: PathBuf) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|error| format!("cannot listen on {listen}: {error}"))?;
    let local = listener.local_addr().map_err(|error| error.to_string())?;
    println!(
        "MetroTerm {} (browser): http://{local}/  — UI from {}",
        env!("CARGO_PKG_VERSION"),
        dir.display()
    );
    if !local.ip().is_loopback() {
        println!("Listening on {local} — anyone who can reach it gets shell access.");
    }
    metroterm_lib::server::serve_web(listener, metroterm_lib::server::dir_files(dir)).await
}
