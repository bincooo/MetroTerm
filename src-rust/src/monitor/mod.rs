//! Monitor panel: one snapshot of a host's load per `monitor.sample` call.
//!
//! - Local sessions: this machine, read with `sysinfo` (Linux, macOS, Windows).
//! - SSH sessions: one POSIX `sh` script over an exec channel of the session's live connection
//!   (`/proc` on Linux; `sysctl`, `vm_stat`, `netstat` on macOS). It never connects by itself:
//!   a session without a live connection answers "not connected".
//!
//! Rates (CPU %, network and disk bytes/s) are the change since the previous sample of the same
//! connection, so the first sample of a host has none.
//!
//! `monitor.signal` stops (SIGTERM) or kills (SIGKILL) a process of the same host: kill(2) locally
//! (taskkill / TerminateProcess on Windows), `kill` over an exec channel on SSH hosts — with the
//! rights of the SSH user.

use crate::remote::ssh::{ConnectionSpec, SshHandle, Transport};
use russh::ChannelMsg;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Processes sent per sample (all of them on any normal host; the busiest first).
pub(super) const MAX_PROCESSES: usize = 4000;
/// Command lines are cut to this many characters (tooltip / filter only).
pub(super) const MAX_COMMAND: usize = 300;

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub host: String,
    pub os: String,
    pub kernel: String,
    /// Seconds since boot.
    pub uptime: u64,
    /// 1 / 5 / 15 minute load average (none on Windows).
    pub load: Option<[f64; 3]>,
    /// Total and per-core CPU use in percent (none on the first sample).
    pub cpu: Option<f64>,
    pub cores: Vec<f64>,
    pub core_count: usize,
    /// Bytes.
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// Network bytes/s (all interfaces except loopback and container bridges) and totals since boot.
    pub rx_rate: Option<f64>,
    pub tx_rate: Option<f64>,
    pub rx_total: u64,
    pub tx_total: u64,
    /// Disk bytes/s (whole disks).
    pub read_rate: Option<f64>,
    pub write_rate: Option<f64>,
    pub disks: Vec<DiskInfo>,
    pub processes: Vec<ProcessInfo>,
    pub process_count: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub fs: String,
    pub total: u64,
    pub used: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    /// Executable name (as `top` shows it).
    pub name: String,
    pub user: String,
    /// Percent of one core (can exceed 100 on multi-core hosts, like `ps` / `top`).
    pub cpu: f64,
    /// Resident memory, bytes.
    pub memory: u64,
    /// Full command line (empty when unknown, e.g. kernel threads or no permission).
    pub command: String,
}

/// `monitor.signal`: TERM asks the process to exit, KILL ends it at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum StopSignal {
    Term,
    Kill,
}

impl StopSignal {
    fn name(self) -> &'static str {
        match self {
            StopSignal::Term => "TERM",
            StopSignal::Kill => "KILL",
        }
    }
}

/// Cumulative counters of the previous sample of a connection.
#[derive(Clone, Debug, Default)]
pub(super) struct Counters {
    pub(super) at: Option<Instant>,
    /// (busy, total) jiffies: the whole CPU first, then each core.
    pub(super) cpu: Vec<(u64, u64)>,
    pub(super) rx: u64,
    pub(super) tx: u64,
    pub(super) read: u64,
    pub(super) write: u64,
    /// Linux hosts: CPU ticks per process (pid → utime + stime) and ticks per second.
    pub(super) ticks: HashMap<u32, u64>,
    pub(super) hz: u64,
}

pub(super) struct Local {
    pub(super) system: sysinfo::System,
    pub(super) networks: sysinfo::Networks,
    pub(super) disks: sysinfo::Disks,
    pub(super) users: sysinfo::Users,
    pub(super) at: Instant,
    pub(super) first: bool,
}

#[derive(Default)]
pub struct Monitor {
    local: Arc<Mutex<Option<Local>>>,
    previous: Mutex<HashMap<String, Counters>>,
}

impl Monitor {
    pub async fn sample(
        &self,
        spec: &ConnectionSpec,
        ssh: Option<Arc<SshHandle>>,
    ) -> Result<Snapshot, String> {
        match spec.transport {
            Transport::Local => {
                let local = self.local.clone();
                tokio::task::spawn_blocking(move || sample_local(&local))
                    .await
                    .map_err(|error| format!("Monitor failed: {error}"))
            }
            Transport::Ssh => {
                let ssh = ssh.ok_or("not connected")?;
                let output = run_script(&ssh).await?;
                let (mut snapshot, counters) = parse_remote(&output)?;
                let previous = self
                    .previous
                    .lock()
                    .unwrap()
                    .insert(spec.id.clone(), counters.clone());
                if let Some(previous) = &previous {
                    apply_rates(&mut snapshot, previous, &counters);
                    process_rates(&mut snapshot, previous, &counters);
                }
                Ok(snapshot)
            }
            _ => Err("The Monitor works with local and SSH sessions".into()),
        }
    }

    /// The session was disconnected: its next sample starts without rates.
    pub fn forget(&self, connection_id: &str) {
        self.previous.lock().unwrap().remove(connection_id);
    }

    /// Stop or kill process `pid` of the session's host.
    pub async fn signal(
        &self,
        spec: &ConnectionSpec,
        ssh: Option<Arc<SshHandle>>,
        pid: u32,
        signal: StopSignal,
    ) -> Result<(), String> {
        if pid == 0 {
            return Err("Invalid process id 0".into());
        }
        match spec.transport {
            Transport::Local => {
                if pid == std::process::id() {
                    return Err(format!("Process {pid} is MetroTerm itself"));
                }
                tokio::task::spawn_blocking(move || signal_local(pid, signal))
                    .await
                    .map_err(|error| format!("Cannot stop process {pid}: {error}"))?
            }
            Transport::Ssh => {
                let ssh = ssh.ok_or("not connected")?;
                // The pid is a number: nothing to quote. `kill` of sh prints the reason on stderr.
                let command = format!("kill -{} {pid}", signal.name());
                let (_, stderr, status) = run_remote(&ssh, &command, None).await?;
                match status {
                    Some(0) => Ok(()),
                    _ => {
                        let reason = stderr.trim();
                        Err(if reason.is_empty() {
                            format!("Cannot stop process {pid} (kill exited with {status:?})")
                        } else {
                            // "bash: line 1: kill: (123) - Operation not permitted" (bash),
                            // "sh: 1: kill: No such process" (dash) → the reason only.
                            let line = reason.lines().last().unwrap_or(reason);
                            let text = line
                                .rsplit_once(" - ")
                                .or_else(|| line.rsplit_once(": "))
                                .map_or(line, |(_, text)| text);
                            format!("Cannot stop process {pid}: {text}")
                        })
                    }
                }
            }
            _ => Err("The Monitor works with local and SSH sessions".into()),
        }
    }
}

#[cfg(unix)]
fn signal_local(pid: u32, signal: StopSignal) -> Result<(), String> {
    let number = match signal {
        StopSignal::Term => libc::SIGTERM,
        StopSignal::Kill => libc::SIGKILL,
    };
    let pid = libc::pid_t::try_from(pid).map_err(|_| format!("Invalid process id {pid}"))?;
    // SAFETY: kill(2) takes plain integers; a positive pid addresses exactly one process.
    if unsafe { libc::kill(pid, number) } == 0 {
        Ok(())
    } else {
        // "Operation not permitted (os error 1)" → "Operation not permitted"
        let error = std::io::Error::last_os_error().to_string();
        let reason = error.split(" (os error").next().unwrap_or(&error);
        Err(format!("Cannot stop process {pid}: {reason}"))
    }
}

#[cfg(windows)]
fn signal_local(pid: u32, signal: StopSignal) -> Result<(), String> {
    match signal {
        // No signals on Windows: TERM = taskkill without /F (asks the windows of the process to close).
        StopSignal::Term => {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let output = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|error| format!("Cannot run taskkill: {error}"))?;
            if output.status.success() {
                Ok(())
            } else {
                let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(format!(
                    "Cannot stop process {pid}: {text} (use Kill to end it)"
                ))
            }
        }
        StopSignal::Kill => {
            let mut system = sysinfo::System::new();
            let target = sysinfo::Pid::from_u32(pid);
            system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[target]), true);
            let process = system.process(target).ok_or(format!("No process {pid}"))?;
            if process.kill() {
                Ok(())
            } else {
                Err(format!("Cannot kill process {pid} (access denied?)"))
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn signal_local(pid: u32, _signal: StopSignal) -> Result<(), String> {
    Err(format!("Cannot stop process {pid} on this system"))
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(MAX_COMMAND) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// This machine (`sysinfo`).
mod local;
/// SSH hosts: the `sh` script and its parser.
mod remote;
#[cfg(test)]
mod tests;

use local::*;
use remote::*;
