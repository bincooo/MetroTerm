//! Which agent CLI runs in the foreground of a local terminal: the terminal's foreground process
//! group (`tcgetpgrp` on the PTY), its leader first, then the other processes of the group.
//! Programs started through a runtime or a shell (`node …/cli.js`,
//! `bun x`, `sh -c codex`) are named after their script / package.

// Windows has no foreground process group: only the tests use the name lookup there.
#![cfg_attr(not(unix), allow(dead_code))]

use super::AGENTS;

/// What the terminal's foreground process group is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Foreground {
    /// The terminal's own shell, waiting at its prompt: no agent runs.
    Shell,
    /// An agent CLI (index into `AGENTS`).
    Agent(usize),
    /// Some other program (an editor, `ssh host`, `docker exec` …): the screen may still show an
    /// agent running elsewhere.
    Other,
}

/// Looks up the foreground process group of one local terminal.
#[cfg(unix)]
pub struct Probe {
    /// Our own copy of the PTY master (closed with the probe).
    fd: std::os::fd::OwnedFd,
    /// The shell started for the terminal.
    shell: Option<u32>,
}

#[cfg(unix)]
impl Probe {
    pub fn new(master: std::os::fd::RawFd, shell: Option<u32>) -> Option<Self> {
        use std::os::fd::FromRawFd;
        // SAFETY: duplicating an open descriptor; the copy is owned by the probe.
        let copy = unsafe { libc::fcntl(master, libc::F_DUPFD_CLOEXEC, 0) };
        (copy >= 0).then(|| Self {
            // SAFETY: `copy` is a fresh descriptor nobody else owns.
            fd: unsafe { std::os::fd::OwnedFd::from_raw_fd(copy) },
            shell,
        })
    }

    pub fn foreground(&self) -> Option<Foreground> {
        use std::os::fd::AsRawFd;
        // SAFETY: plain ioctl on a descriptor we own.
        let group = unsafe { libc::tcgetpgrp(self.fd.as_raw_fd()) };
        if group <= 0 {
            return None;
        }
        let group = group as u32;
        if Some(group) == self.shell {
            return Some(Foreground::Shell);
        }
        Some(identify_group(group).map_or(Foreground::Other, Foreground::Agent))
    }
}

/// Not available (Windows): agents are recognised from the screen only.
#[cfg(not(unix))]
pub struct Probe(());

#[cfg(not(unix))]
impl Probe {
    pub fn foreground(&self) -> Option<Foreground> {
        None
    }
}

/// Agent of a program name (alias table): the basename, lower case, without `.exe` /
/// `.cmd` / `.bat` / `.ps1` / `.js` / `.mjs`.
pub fn agent_by_name(name: &str) -> Option<usize> {
    let name = normalized(basename(name));
    if name.is_empty() {
        return None;
    }
    if name
        .strip_prefix("muse-bin-")
        .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    {
        return AGENTS.iter().position(|agent| agent.id == "muse");
    }
    AGENTS
        .iter()
        .position(|agent| agent.id == name || agent.processes.contains(&name.as_str()))
}

fn basename(path: &str) -> &str {
    let path = path.trim_matches(|c| c == '"' || c == '\'');
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn normalized(name: &str) -> String {
    let mut name = name.trim().to_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1", ".mjs", ".js"] {
        if let Some(stem) = name.strip_suffix(suffix) {
            name = stem.to_owned();
            break;
        }
    }
    name
}

fn is_python(name: &str) -> bool {
    name.strip_prefix("python").is_some_and(|version| {
        version.is_empty()
            || version
                .split('.')
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    })
}

/// A runtime or shell that runs the actual program given as an argument.
fn is_runtime(name: &str) -> bool {
    is_python(name)
        || matches!(
            name,
            "node" | "nodejs" | "bun" | "deno" | "sh" | "bash" | "zsh" | "fish" | "dash" | "env"
        )
}

/// Entry scripts of npm packages whose package name is not the agent's: the path ends with these
/// components.
const KNOWN_ENTRIES: &[(&[&str], &str)] = &[
    (
        &["@earendil-works", "pi-coding-agent", "dist", "cli.js"],
        "pi",
    ),
    (
        &[
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "bundle",
            "cli.js",
        ],
        "pi",
    ),
    // The package's earlier scope.
    (
        &["@mariozechner", "pi-coding-agent", "dist", "cli.js"],
        "pi",
    ),
];

/// Agent of a script / package path: its basename, a known entry script, the npm package it
/// belongs to (`…/node_modules/@anthropic-ai/claude-code/cli.js` → claude), or what a symbolic
/// link points to.
fn agent_by_path(path: &str) -> Option<usize> {
    let path = path.trim_matches(|c| c == '"' || c == '\'');
    if path.is_empty() || path.starts_with('-') {
        return None;
    }
    let parts: Vec<&str> = path
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    agent_by_name(path)
        .or_else(|| {
            KNOWN_ENTRIES.iter().find_map(|(suffix, agent)| {
                let tail = parts.len().checked_sub(suffix.len() + 1)?;
                (parts[tail] == "node_modules"
                    && parts[tail + 1..]
                        .iter()
                        .zip(suffix.iter())
                        .all(|(part, expected)| part.eq_ignore_ascii_case(expected)))
                .then(|| AGENTS.iter().position(|info| info.id == *agent))
                .flatten()
            })
        })
        .or_else(|| {
            let at = parts.iter().rposition(|part| *part == "node_modules")?;
            let mut package = *parts.get(at + 1)?;
            if package.starts_with('@') {
                package = parts.get(at + 2)?;
            }
            agent_by_name(package)
        })
        .or_else(|| {
            // `~/.local/bin/cc` → …/claude: only paths, not bare words looked up on PATH.
            if parts.len() < 2 {
                return None;
            }
            let resolved = std::fs::canonicalize(path).ok()?;
            agent_by_name(resolved.file_name()?.to_str()?)
        })
}

/// Runtime options that take the next argument as their value (`node -r ./hook.js cli.js`).
fn takes_value(arg: &str) -> bool {
    matches!(
        arg,
        "-r" | "--require"
            | "--loader"
            | "--import"
            | "--experimental-loader"
            | "--inspect-port"
            | "-W"
            | "-X"
    )
}

/// cursor-agent's own Node: `…/cursor-agent/versions/<version>/node …/index.js` (same folder).
fn cursor_bundled_node(argv: &[String]) -> Option<usize> {
    let runtime = std::path::Path::new(argv.first()?);
    let script = argv
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(std::path::Path::new)?;
    let name = runtime.file_name()?.to_str()?.to_ascii_lowercase();
    if !matches!(name.as_str(), "node" | "node.exe")
        || !script
            .file_name()?
            .to_str()?
            .eq_ignore_ascii_case("index.js")
        || runtime.parent()? != script.parent()?
    {
        return None;
    }
    let mut dirs = runtime
        .parent()?
        .iter()
        .rev()
        .filter_map(|part| part.to_str());
    let (_version, versions, package) = (dirs.next()?, dirs.next()?, dirs.next()?);
    (versions == "versions" && package.eq_ignore_ascii_case("cursor-agent"))
        .then(|| AGENTS.iter().position(|agent| agent.id == "cursor"))
        .flatten()
}

/// The Hermes installer's launcher: `python -I -c "<code>"`, the code importing Hermes's CLI
/// (without an exact-source match). Not its helper modes.
fn hermes_launcher(args: &[String]) -> Option<usize> {
    let [isolation, flag, code, rest @ ..] = args else {
        return None;
    };
    (isolation == "-I"
        && flag == "-c"
        && code.contains("import hermes_bootstrap")
        && code.contains("from hermes_cli.main import main")
        && !rest
            .first()
            .is_some_and(|arg| arg == "--run-module" || arg == "--print-runtime-command"))
    .then(|| AGENTS.iter().position(|agent| agent.id == "hermes"))
    .flatten()
}

/// Agent of one process from its command line (and its kernel name).
pub fn agent_of_command(argv: &[String], name: &str) -> Option<usize> {
    let Some(first) = argv.first() else {
        return agent_by_name(name);
    };
    if let Some(agent) = agent_by_path(first) {
        return Some(agent);
    }
    let runtime = normalized(basename(first));
    if runtime == "node" {
        if let Some(agent) = cursor_bundled_node(argv) {
            return Some(agent);
        }
    }
    if is_python(&runtime) {
        if let Some(agent) = hermes_launcher(&argv[1..]) {
            return Some(agent);
        }
    }
    if is_runtime(&runtime) {
        // `-e` / `-c` code, `-m module`: the program is not a file argument.
        let shell = matches!(runtime.as_str(), "sh" | "bash" | "zsh" | "fish" | "dash");
        let mut args = argv.iter().skip(1);
        while let Some(arg) = args.next() {
            if arg == "--" {
                return args.next().and_then(|token| agent_by_path(token));
            }
            if runtime == "env" && arg.contains('=') {
                continue;
            }
            if shell && (arg == "-c" || arg == "-lc") {
                // sh -c "codex --flag": the first word of the command.
                return args
                    .next()
                    .and_then(|command| command.split_whitespace().next().and_then(agent_by_path));
            }
            if matches!(
                arg.as_str(),
                "-e" | "--eval" | "-p" | "--print" | "-c" | "-m"
            ) {
                return None;
            }
            if arg.starts_with('-') {
                if takes_value(arg) {
                    args.next();
                }
                continue;
            }
            return agent_by_path(arg);
        }
        return None;
    }
    agent_by_name(name)
}

// ---------- Linux: /proc ----------

#[cfg(target_os = "linux")]
fn read_process(pid: u32) -> Option<(Vec<String>, String)> {
    let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let argv = cmdline
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect();
    let name = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
    Some((argv, name.trim().to_owned()))
}

#[cfg(target_os = "linux")]
fn identify_group(group: u32) -> Option<usize> {
    if let Some((argv, name)) = read_process(group) {
        if let Some(agent) = agent_of_command(&argv, &name) {
            return Some(agent);
        }
    }
    // The leader is a wrapper (`npx codex`, a script): look at the rest of the group.
    let entries = std::fs::read_dir("/proc").ok()?;
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| *pid != group)
        .filter(|pid| process_group(*pid) == Some(group))
        .find_map(|pid| {
            let (argv, name) = read_process(pid)?;
            agent_of_command(&argv, &name)
        })
}

/// Fields of /proc/<pid>/stat after the command name: 0 state, 1 ppid, 2 pgrp.
#[cfg(target_os = "linux")]
fn process_group(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.get(stat.rfind(')')? + 1..)?
        .split_whitespace()
        .nth(2)?
        .parse()
        .ok()
}

// ---------- macOS / BSD: sysinfo ----------

#[cfg(all(unix, not(target_os = "linux")))]
fn identify_group(group: u32) -> Option<usize> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let command = |process: &sysinfo::Process| {
        let argv: Vec<String> = process
            .cmd()
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        agent_of_command(&argv, &process.name().to_string_lossy())
    };
    let kind = ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always);
    let mut system = System::new();
    let leader = Pid::from_u32(group);
    system.refresh_processes_specifics(ProcessesToUpdate::Some(&[leader]), true, kind);
    if let Some(agent) = system.process(leader).and_then(command) {
        return Some(agent);
    }
    // The leader is a wrapper: its children (same process group in practice).
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    system
        .processes()
        .values()
        .filter(|process| process.parent() == Some(leader))
        .find_map(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(agent: Option<usize>) -> Option<&'static str> {
        agent.map(|index| AGENTS[index].id)
    }

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn names() {
        assert_eq!(id(agent_by_name("claude")), Some("claude"));
        assert_eq!(id(agent_by_name("/usr/local/bin/Codex.EXE")), Some("codex"));
        assert_eq!(id(agent_by_name("opencode")), Some("opencode"));
        assert_eq!(id(agent_by_name("muse-bin-0.1.0")), Some("muse"));
        assert_eq!(id(agent_by_name("bash")), None);
        assert_eq!(id(agent_by_name("")), None);
    }

    #[test]
    fn commands() {
        let of = |words: &[&str], name: &str| id(agent_of_command(&argv(words), name));
        assert_eq!(of(&["claude", "--resume"], "claude"), Some("claude"));
        assert_eq!(
            of(
                &[
                    "node",
                    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"
                ],
                "node"
            ),
            Some("claude")
        );
        assert_eq!(
            of(
                &[
                    "node",
                    "--no-warnings",
                    "/home/u/.npm/_npx/1/node_modules/@openai/codex/bin/codex.js"
                ],
                "node"
            ),
            Some("codex")
        );
        assert_eq!(of(&["node", "-e", "x", "/tmp/codex"], "node"), None);
        assert_eq!(of(&["python3", "-c", "x", "codex"], "python3"), None);
        assert_eq!(
            of(&["sh", "-c", "opencode --continue"], "sh"),
            Some("opencode")
        );
        assert_eq!(
            of(&["bun", "/x/node_modules/opencode-ai/bin/opencode"], "bun"),
            Some("opencode")
        );
        assert_eq!(of(&["vim", "codex.txt"], "vim"), None);
        assert_eq!(of(&["node", "/home/u/src/codex/app.js"], "node"), None);
        assert_eq!(of(&[], "gemini"), Some("gemini"));
    }

    /// Launch forms of the supported agents whose process is not simply named after them.
    #[test]
    fn wrapped_launchers() {
        let of = |words: &[&str], name: &str| id(agent_of_command(&argv(words), name));
        // Plain executables and aliases.
        for (exe, agent) in [
            ("copilot", "copilot"),
            ("ghcs", "copilot"),
            ("cursor-agent", "cursor"),
            ("pi", "pi"),
            ("agy", "agy"),
            ("antigravity-cli", "agy"),
            ("devin", "devin"),
            ("droid", "droid"),
            ("amp", "amp"),
            ("grok", "grok"),
            ("hermes", "hermes"),
            ("kilo", "kilo"),
            ("kimi", "kimi"),
            ("kiro-cli", "kiro"),
            ("cline", "cline"),
            ("gemini", "gemini"),
            ("opencode", "opencode"),
        ] {
            assert_eq!(of(&[exe], exe), Some(agent), "{exe}");
        }
        // Pi from its npm package (the package is not named "pi").
        assert_eq!(
            of(
                &[
                    "node",
                    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
                ],
                "node"
            ),
            Some("pi")
        );
        assert_eq!(
            of(
                &[
                    "node",
                    "/home/u/.local/pi-node/current/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
                    "--continue"
                ],
                "node"
            ),
            Some("pi")
        );
        // …but not its build scripts.
        assert_eq!(
            of(
                &[
                    "node",
                    "/usr/lib/node_modules/@earendil-works/pi-coding-agent/scripts/build.js"
                ],
                "node"
            ),
            None
        );
        // Kimi Code from its npm package.
        assert_eq!(
            of(
                &[
                    "node",
                    "/usr/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"
                ],
                "node"
            ),
            Some("kimi")
        );
        // cursor-agent's bundled Node.
        assert_eq!(
            of(
                &[
                    "/home/u/.local/share/cursor-agent/versions/2026.08.11-e8db854/node",
                    "--use-system-ca",
                    "/home/u/.local/share/cursor-agent/versions/2026.08.11-e8db854/index.js"
                ],
                "node"
            ),
            Some("cursor")
        );
        assert_eq!(
            of(
                &["node", "/home/u/work/cursor-agent/versions/x/index.js"],
                "node"
            ),
            None
        );
        // A runtime option with a value before the script.
        assert_eq!(
            of(
                &[
                    "node",
                    "-r",
                    "/opt/hook.js",
                    "/usr/lib/node_modules/@openai/codex/bin/codex.js"
                ],
                "node"
            ),
            Some("codex")
        );
        // The Hermes installer's launcher (python -I -c …), not its helper modes.
        let code = "import os, re, sys\nsys.path.insert(0, '/home/u/.hermes/hermes-agent')\nimport hermes_bootstrap\nfrom hermes_cli.main import main\nsys.exit(main())\n";
        assert_eq!(
            of(&["python3", "-I", "-c", code], "python3"),
            Some("hermes")
        );
        assert_eq!(
            of(
                &[
                    "/home/u/.hermes/venv/bin/python3.12",
                    "-I",
                    "-c",
                    code,
                    "chat"
                ],
                "python3.12"
            ),
            Some("hermes")
        );
        assert_eq!(
            of(
                &["python3", "-I", "-c", code, "--print-runtime-command"],
                "python3"
            ),
            None
        );
        assert_eq!(of(&["python3", "-I", "-c", "print(1)"], "python3"), None);
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_to_an_agent() {
        let dir = std::env::temp_dir().join(format!("metroterm-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("claude");
        std::fs::write(&target, "").unwrap();
        let link = dir.join("cc");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let link = link.to_str().unwrap().to_owned();
        assert_eq!(
            id(agent_of_command(&argv(&["node", &link]), "node")),
            Some("claude")
        );
        assert_eq!(id(agent_of_command(&argv(&[&link]), "cc")), Some("claude"));
        // A bare word is not looked up.
        assert_eq!(id(agent_by_path("cc")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn foreground_of_a_pty() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("sleep");
        command.arg("5");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let fd = pair.master.as_raw_fd().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        // The started program leads the foreground group: as "the shell" it means "no agent".
        let shell = Probe::new(fd, child.process_id()).unwrap();
        assert_eq!(shell.foreground(), Some(Foreground::Shell));
        let other = Probe::new(fd, None).unwrap();
        assert_eq!(other.foreground(), Some(Foreground::Other));
        child.kill().unwrap();
    }
}
