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

use crate::ssh::{ConnectionSpec, SshHandle, Transport};
use russh::ChannelMsg;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Processes sent per sample (all of them on any normal host; the busiest first).
const MAX_PROCESSES: usize = 4000;
/// Command lines are cut to this many characters (tooltip / filter only).
const MAX_COMMAND: usize = 300;

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
struct Counters {
    at: Option<Instant>,
    /// (busy, total) jiffies: the whole CPU first, then each core.
    cpu: Vec<(u64, u64)>,
    rx: u64,
    tx: u64,
    read: u64,
    write: u64,
    /// Linux hosts: CPU ticks per process (pid → utime + stime) and ticks per second.
    ticks: HashMap<u32, u64>,
    hz: u64,
}

struct Local {
    system: sysinfo::System,
    networks: sysinfo::Networks,
    disks: sysinfo::Disks,
    users: sysinfo::Users,
    at: Instant,
    first: bool,
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

// ---------- local machine ----------

fn sample_local(slot: &Mutex<Option<Local>>) -> Snapshot {
    use sysinfo::{
        CpuRefreshKind, MemoryRefreshKind, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
        System, UpdateKind,
    };
    let mut guard = slot.lock().unwrap();
    let local = guard.get_or_insert_with(|| Local {
        system: System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
                .with_memory(MemoryRefreshKind::everything()),
        ),
        networks: sysinfo::Networks::new_with_refreshed_list(),
        disks: sysinfo::Disks::new_with_refreshed_list(),
        users: sysinfo::Users::new_with_refreshed_list(),
        at: Instant::now(),
        first: true,
    });
    let elapsed = local.at.elapsed().as_secs_f64().max(0.001);
    local.at = Instant::now();
    let first = std::mem::replace(&mut local.first, false);
    let system = &mut local.system;
    system.refresh_cpu_usage();
    system.refresh_memory();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_user(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
    local.networks.refresh(true);
    local.disks.refresh(true);

    let rate = |bytes: u64| (!first).then_some(bytes as f64 / elapsed);
    let (mut rx, mut tx, mut rx_total, mut tx_total) = (0, 0, 0, 0);
    for (name, data) in &local.networks {
        if skip_interface(name) {
            continue;
        }
        rx += data.received();
        tx += data.transmitted();
        rx_total += data.total_received();
        tx_total += data.total_transmitted();
    }
    let mut seen = std::collections::HashSet::new();
    let (mut read, mut write) = (0, 0);
    let mut disks = Vec::new();
    for disk in local.disks.list() {
        let usage = disk.usage();
        // The same device mounted twice (bind mounts) counts once.
        if !seen.insert(disk.name().to_os_string()) {
            continue;
        }
        read += usage.read_bytes;
        write += usage.written_bytes;
        if disk.total_space() == 0 {
            continue;
        }
        disks.push(DiskInfo {
            mount: disk.mount_point().display().to_string(),
            fs: disk.file_system().to_string_lossy().into_owned(),
            total: disk.total_space(),
            used: disk.total_space().saturating_sub(disk.available_space()),
        });
    }
    disks.sort_by(|a, b| a.mount.cmp(&b.mount));

    // Linux lists the threads of a process as tasks too: processes only, like `ps -e`.
    let processes: Vec<_> = system
        .processes()
        .values()
        .filter(|process| process.thread_kind() != Some(sysinfo::ThreadKind::Userland))
        .collect();
    let process_count = processes.len();
    let mut top = processes;
    top.sort_by(|a, b| b.cpu_usage().total_cmp(&a.cpu_usage()));
    let processes_list = top
        .into_iter()
        .take(MAX_PROCESSES)
        .map(|process| ProcessInfo {
            pid: process.pid().as_u32(),
            name: process.name().to_string_lossy().into_owned(),
            user: process
                .user_id()
                .and_then(|uid| local.users.get_user_by_id(uid))
                .map(|user| user.name().to_string())
                .unwrap_or_default(),
            cpu: if first {
                0.0
            } else {
                process.cpu_usage() as f64
            },
            memory: process.memory(),
            command: clip(
                &process
                    .cmd()
                    .iter()
                    .map(|part| part.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
        })
        .collect();

    let load = System::load_average();
    Snapshot {
        host: System::host_name().unwrap_or_default(),
        os: System::long_os_version()
            .or_else(System::name)
            .unwrap_or_default(),
        kernel: System::kernel_version().unwrap_or_default(),
        uptime: System::uptime(),
        load: (!cfg!(windows)).then_some([load.one, load.five, load.fifteen]),
        cpu: (!first).then(|| system.global_cpu_usage() as f64),
        cores: if first {
            Vec::new()
        } else {
            system
                .cpus()
                .iter()
                .map(|cpu| cpu.cpu_usage() as f64)
                .collect()
        },
        core_count: system.cpus().len(),
        mem_total: system.total_memory(),
        mem_used: system.used_memory(),
        swap_total: system.total_swap(),
        swap_used: system.used_swap(),
        rx_rate: rate(rx),
        tx_rate: rate(tx),
        rx_total,
        tx_total,
        read_rate: rate(read),
        write_rate: rate(write),
        disks,
        process_count,
        processes: processes_list,
    }
}

/// Loopback and virtual bridges / veth pairs of containers would count traffic twice.
fn skip_interface(name: &str) -> bool {
    name == "lo"
        || name.starts_with("lo0")
        || [
            "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "kube",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

// ---------- SSH host ----------

/// Sections start with `@name`. LC_ALL=C keeps number formats and column names stable.
const SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
echo @sys; uname -s; uname -r; hostname 2>/dev/null || uname -n
case "$(uname -s)" in
Linux)
  echo @os; (. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-Linux}")
  echo @uptime; cut -d' ' -f1 /proc/uptime
  echo @load; cut -d' ' -f1-3 /proc/loadavg
  echo @cpu; grep '^cpu' /proc/stat
  echo @mem; cat /proc/meminfo
  echo @net; cat /proc/net/dev
  echo @blocks; ls /sys/block 2>/dev/null
  echo @io; cat /proc/diskstats 2>/dev/null
  echo @df; df -kP 2>/dev/null
  echo @count; ls -d /proc/[0-9]* 2>/dev/null | wc -l
  echo @hz; getconf CLK_TCK 2>/dev/null
  echo @ps; ps -eo pid=,user=,pcpu=,rss=,args= 2>/dev/null
  echo @pstat; cat /proc/[0-9]*/stat 2>/dev/null
  ;;
Darwin)
  echo @os; echo "macOS $(sw_vers -productVersion 2>/dev/null)"
  echo @boot; sysctl -n kern.boottime; date +%s
  echo @load; sysctl -n vm.loadavg
  echo @ncpu; sysctl -n hw.ncpu
  echo @pscpu; ps -A -o %cpu= | awk '{s+=$1} END {print s+0}'
  echo @memsize; sysctl -n hw.memsize
  echo @vmstat; vm_stat
  echo @swap; sysctl -n vm.swapusage
  echo @netstat; netstat -ibn
  echo @df; df -kP 2>/dev/null
  echo @pscomm; ps -Ao pid=,comm=
  echo @ps; ps -Ao pid=,user=,%cpu=,rss=,args=
  echo @count; ps -A -o pid= | wc -l
  ;;
esac
"#;

async fn run_script(ssh: &SshHandle) -> Result<String, String> {
    // `sh -s` reads the script from stdin: no quoting, and it works under any login shell.
    let (stdout, _, _) = run_remote(ssh, "sh -s", Some(SCRIPT)).await?;
    Ok(stdout)
}

/// Runs `command` on an exec channel (optionally feeding `stdin`): (stdout, stderr, exit status).
async fn run_remote(
    ssh: &SshHandle,
    command: &str,
    stdin: Option<&str>,
) -> Result<(String, String, Option<u32>), String> {
    let run = async {
        let mut channel = ssh
            .channel_open_session()
            .await
            .map_err(|error| format!("Cannot open an SSH channel: {error}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| format!("Cannot run {command}: {error}"))?;
        if let Some(input) = stdin {
            channel
                .data(input.as_bytes())
                .await
                .map_err(|error| format!("Cannot send the monitor script: {error}"))?;
        }
        channel.eof().await.ok();
        let (mut out, mut err, mut status) = (Vec::new(), Vec::new(), None);
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok((
            String::from_utf8_lossy(&out).into_owned(),
            String::from_utf8_lossy(&err).into_owned(),
            status,
        ))
    };
    tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .map_err(|_| "The host did not answer within 10 s".to_string())?
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(MAX_COMMAND) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

fn sections(output: &str) -> HashMap<&str, Vec<&str>> {
    let mut map: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut current = "";
    for line in output.lines() {
        if let Some(name) = line.strip_prefix('@') {
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()) {
                current = name;
                map.entry(current).or_default();
                continue;
            }
        }
        map.entry(current).or_default().push(line);
    }
    map
}

fn parse_remote(output: &str) -> Result<(Snapshot, Counters), String> {
    let s = sections(output);
    let sys = s.get("sys").cloned().unwrap_or_default();
    let kind = sys.first().copied().unwrap_or("").trim();
    let mut snapshot = Snapshot {
        kernel: format!("{} {}", kind, sys.get(1).copied().unwrap_or("").trim())
            .trim()
            .to_string(),
        host: sys.get(2).copied().unwrap_or("").trim().to_string(),
        os: first_line(&s, "os").to_string(),
        ..Snapshot::default()
    };
    let mut counters = Counters {
        at: Some(Instant::now()),
        ..Counters::default()
    };
    match kind {
        "Linux" => parse_linux(&s, &mut snapshot, &mut counters),
        "Darwin" => parse_darwin(&s, &mut snapshot, &mut counters),
        "" => return Err("No answer from the host (is it a Unix system with sh?)".into()),
        other => {
            return Err(format!(
                "The Monitor supports Linux and macOS hosts, not {other}"
            ))
        }
    }
    snapshot.disks = parse_df(s.get("df").map(Vec::as_slice).unwrap_or(&[]));
    // Names: /proc/<pid>/stat on Linux (what `top` shows), `ps -o comm` on macOS.
    let names = if kind == "Linux" {
        parse_proc_stats(&s, &mut counters)
    } else {
        parse_names(s.get("pscomm").map(Vec::as_slice).unwrap_or(&[]))
    };
    snapshot.processes = parse_ps(s.get("ps").map(Vec::as_slice).unwrap_or(&[]), &names);
    snapshot.process_count = first_line(&s, "count").trim().parse().unwrap_or(0);
    Ok((snapshot, counters))
}

/// macOS `ps -Ao pid=,comm=`: the executable path (may contain spaces) → its file name.
fn parse_names(lines: &[&str]) -> HashMap<u32, String> {
    lines
        .iter()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, path) = line.split_once(char::is_whitespace)?;
            let path = path.trim();
            Some((
                pid.parse().ok()?,
                path.rsplit('/').next().unwrap_or(path).to_string(),
            ))
        })
        .collect()
}

/// Linux: `/proc/<pid>/stat` of every process — "pid (comm) state ppid … utime stime … rss …".
/// The command name may contain spaces and parentheses, so fields are counted after the last ')'.
fn parse_proc_stats(s: &HashMap<&str, Vec<&str>>, counters: &mut Counters) -> HashMap<u32, String> {
    counters.hz = first_line(s, "hz").parse().unwrap_or(0);
    let mut names = HashMap::new();
    for line in s.get("pstat").map(Vec::as_slice).unwrap_or(&[]) {
        let (Some(open), Some(close)) = (line.find('('), line.rfind(')')) else {
            continue;
        };
        let Ok(pid) = line[..open].trim().parse::<u32>() else {
            continue;
        };
        let fields: Vec<&str> = line[close + 1..].split_whitespace().collect();
        if fields.len() < 13 {
            continue;
        }
        let number = |index: usize| fields[index].parse::<u64>().unwrap_or(0);
        counters.ticks.insert(pid, number(11) + number(12));
        names.insert(pid, line[open + 1..close].to_string());
    }
    names
}

/// Linux hosts: CPU use of each process since the previous sample (`ps` only knows the lifetime
/// average, which the first sample shows). Processes started since then count from their start.
fn process_rates(snap: &mut Snapshot, previous: &Counters, now: &Counters) {
    let (Some(then), Some(at)) = (previous.at, now.at) else {
        return;
    };
    let seconds = at.duration_since(then).as_secs_f64();
    if now.ticks.is_empty() || now.hz == 0 || seconds <= 0.0 {
        return;
    }
    for process in &mut snap.processes {
        let Some(&ticks) = now.ticks.get(&process.pid) else {
            continue;
        };
        let before = previous.ticks.get(&process.pid).copied().unwrap_or(0);
        process.cpu = ticks.saturating_sub(before) as f64 / now.hz as f64 / seconds * 100.0;
    }
    sort_processes(&mut snap.processes);
}

/// Busiest first, then the largest.
fn sort_processes(list: &mut Vec<ProcessInfo>) {
    list.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.memory.cmp(&a.memory)));
    list.truncate(MAX_PROCESSES);
}

fn first_line<'a>(s: &HashMap<&str, Vec<&'a str>>, name: &str) -> &'a str {
    s.get(name)
        .and_then(|lines| lines.first().copied())
        .unwrap_or("")
        .trim()
}

fn numbers(text: &str) -> Vec<f64> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter_map(|part| part.parse().ok())
        .collect()
}

fn parse_linux(s: &HashMap<&str, Vec<&str>>, snap: &mut Snapshot, counters: &mut Counters) {
    snap.uptime = first_line(s, "uptime").parse::<f64>().unwrap_or(0.0) as u64;
    let load = numbers(first_line(s, "load"));
    if load.len() >= 3 {
        snap.load = Some([load[0], load[1], load[2]]);
    }
    // cpu  user nice system idle iowait irq softirq steal (guest time is already in user)
    for line in s.get("cpu").map(Vec::as_slice).unwrap_or(&[]) {
        let values: Vec<u64> = line
            .split_whitespace()
            .skip(1)
            .take(8)
            .filter_map(|v| v.parse().ok())
            .collect();
        if values.len() < 4 {
            continue;
        }
        let total: u64 = values.iter().sum();
        let idle = values[3] + values.get(4).copied().unwrap_or(0);
        counters.cpu.push((total - idle, total));
    }
    snap.core_count = counters.cpu.len().saturating_sub(1);

    let mut mem = HashMap::new();
    for line in s.get("mem").map(Vec::as_slice).unwrap_or(&[]) {
        if let Some((key, rest)) = line.split_once(':') {
            let kb: u64 = rest
                .split_whitespace()
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            mem.insert(key.trim(), kb * 1024);
        }
    }
    let get = |key: &str| mem.get(key).copied().unwrap_or(0);
    snap.mem_total = get("MemTotal");
    let available = mem
        .get("MemAvailable")
        .copied()
        .unwrap_or_else(|| get("MemFree") + get("Buffers") + get("Cached"));
    snap.mem_used = snap.mem_total.saturating_sub(available);
    snap.swap_total = get("SwapTotal");
    snap.swap_used = snap.swap_total.saturating_sub(get("SwapFree"));

    // Inter-|   Receive bytes ... (8 receive columns) | Transmit bytes ...
    for line in s.get("net").map(Vec::as_slice).unwrap_or(&[]) {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if skip_interface(name.trim()) {
            continue;
        }
        let values: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if values.len() >= 9 {
            counters.rx += values[0];
            counters.tx += values[8];
        }
    }
    snap.rx_total = counters.rx;
    snap.tx_total = counters.tx;

    // Whole disks only (partitions would count twice); device mapper / md / loop / RAM disks skipped.
    let blocks: std::collections::HashSet<&str> = s
        .get("blocks")
        .map(|lines| {
            lines
                .iter()
                .flat_map(|line| line.split_whitespace())
                .collect()
        })
        .unwrap_or_default();
    for line in s.get("io").map(Vec::as_slice).unwrap_or(&[]) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        let name = fields[2];
        let virtual_device = ["loop", "ram", "zram", "dm-", "md", "sr", "fd", "nbd"]
            .iter()
            .any(|prefix| name.starts_with(prefix));
        if virtual_device || (!blocks.is_empty() && !blocks.contains(name)) {
            continue;
        }
        // Sectors are always 512 bytes in /proc/diskstats.
        counters.read += fields[5].parse::<u64>().unwrap_or(0) * 512;
        counters.write += fields[9].parse::<u64>().unwrap_or(0) * 512;
    }
}

fn parse_darwin(s: &HashMap<&str, Vec<&str>>, snap: &mut Snapshot, counters: &mut Counters) {
    // kern.boottime: "{ sec = 1700000000, usec = 0 } Tue Nov 14 …", then `date +%s`.
    let boot = s.get("boot").cloned().unwrap_or_default();
    let boot_sec = boot
        .first()
        .map(|l| numbers(l))
        .and_then(|n| n.first().copied());
    let now = boot.get(1).and_then(|l| l.trim().parse::<f64>().ok());
    if let (Some(boot_sec), Some(now)) = (boot_sec, now) {
        snap.uptime = (now - boot_sec).max(0.0) as u64;
    }
    let load = numbers(first_line(s, "load"));
    if load.len() >= 3 {
        snap.load = Some([load[0], load[1], load[2]]);
    }
    snap.core_count = first_line(s, "ncpu").parse().unwrap_or(1).max(1);
    // No cumulative CPU counters without extra tools: the sum of the processes' %CPU over the cores.
    let ps_cpu: f64 = first_line(s, "pscpu").parse().unwrap_or(0.0);
    snap.cpu = Some((ps_cpu / snap.core_count as f64).clamp(0.0, 100.0));
    snap.mem_total = first_line(s, "memsize").parse().unwrap_or(0);
    // vm_stat: "Mach Virtual Memory Statistics: (page size of 16384 bytes)", "Pages free: 1234."
    let vm = s.get("vmstat").cloned().unwrap_or_default();
    let page = vm
        .first()
        .map(|l| numbers(l))
        .and_then(|n| n.first().copied())
        .unwrap_or(4096.0) as u64;
    let pages = |key: &str| {
        vm.iter()
            .find(|line| line.starts_with(key))
            .and_then(|line| numbers(line).last().copied())
            .unwrap_or(0.0) as u64
    };
    // Activity Monitor's "Memory Used": app memory (anonymous) + wired + compressed.
    let used = pages("Anonymous pages").saturating_sub(pages("Pages purgeable"))
        + pages("Pages wired down")
        + pages("Pages occupied by compressor");
    snap.mem_used = (used * page).min(snap.mem_total);
    // vm.swapusage: "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)"
    let swap = numbers(first_line(s, "swap"));
    if swap.len() >= 2 {
        snap.swap_total = (swap[0] * 1048576.0) as u64;
        snap.swap_used = (swap[1] * 1048576.0) as u64;
    }
    // netstat -ibn: Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    // (one row per address; the <Link#n> row has the interface counters).
    for line in s.get("netstat").map(Vec::as_slice).unwrap_or(&[]) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || !fields[2].starts_with("<Link") || skip_interface(fields[0]) {
            continue;
        }
        let n = fields.len();
        counters.rx += fields[n - 5].parse::<u64>().unwrap_or(0);
        counters.tx += fields[n - 2].parse::<u64>().unwrap_or(0);
    }
    snap.rx_total = counters.rx;
    snap.tx_total = counters.tx;
}

/// `df -kP`: Filesystem 1024-blocks Used Available Capacity Mounted-on (the mount point may contain spaces).
fn parse_df(lines: &[&str]) -> Vec<DiskInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut disks = Vec::new();
    for line in lines.iter().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 6 {
            continue;
        }
        let device = fields[0];
        let mount = fields[5..].join(" ");
        let real = device.starts_with("/dev/") || device.contains(":/") || mount == "/";
        let skipped = device.starts_with("/dev/loop")
            || mount.starts_with("/snap/")
            || mount.starts_with("/System/Volumes/")
            || mount.starts_with("/Library/Developer/");
        if !real || skipped || !seen.insert(device.to_string()) {
            continue;
        }
        let total: u64 = fields[1].parse().unwrap_or(0);
        let used: u64 = fields[2].parse().unwrap_or(0);
        if total == 0 {
            continue;
        }
        disks.push(DiskInfo {
            mount,
            fs: device.to_string(),
            total: total * 1024,
            used: used * 1024,
        });
    }
    disks
}

/// `ps … pid= user= pcpu= rss= args=` (rss in KiB; the command line may contain spaces).
/// The name comes from `names`, else from the command line (`[kthreadd]` → kthreadd).
fn parse_ps(lines: &[&str], names: &HashMap<u32, String>) -> Vec<ProcessInfo> {
    let mut list: Vec<ProcessInfo> = lines
        .iter()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let user = parts.next()?.to_string();
            let cpu = parts.next()?.parse().ok()?;
            let rss: u64 = parts.next()?.parse().ok()?;
            let command = parts.collect::<Vec<_>>().join(" ");
            let name = names.get(&pid).cloned().unwrap_or_else(|| {
                let first = command.split_whitespace().next().unwrap_or("");
                let first = first.trim_start_matches('[').trim_end_matches(']');
                first.rsplit('/').next().unwrap_or(first).to_string()
            });
            Some(ProcessInfo {
                pid,
                name,
                user,
                cpu,
                memory: rss * 1024,
                command: clip(&command),
            })
        })
        .collect();
    sort_processes(&mut list);
    list
}

fn apply_rates(snap: &mut Snapshot, previous: &Counters, now: &Counters) {
    let (Some(then), Some(at)) = (previous.at, now.at) else {
        return;
    };
    let seconds = at.duration_since(then).as_secs_f64();
    if seconds <= 0.0 {
        return;
    }
    let percent = |(busy, total): (u64, u64), (busy0, total0): (u64, u64)| {
        let total = total.saturating_sub(total0);
        (total > 0)
            .then(|| (busy.saturating_sub(busy0) as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
    };
    if now.cpu.len() == previous.cpu.len() && !now.cpu.is_empty() {
        snap.cpu = percent(now.cpu[0], previous.cpu[0]);
        snap.cores = now.cpu[1..]
            .iter()
            .zip(&previous.cpu[1..])
            .map(|(a, b)| percent(*a, *b).unwrap_or(0.0))
            .collect();
    }
    let rate = |a: u64, b: u64| Some(a.saturating_sub(b) as f64 / seconds);
    snap.rx_rate = rate(now.rx, previous.rx);
    snap.tx_rate = rate(now.tx, previous.tx);
    // macOS hosts report no disk counters: no disk rates rather than a false 0.
    if now.read > 0 || now.write > 0 {
        snap.read_rate = rate(now.read, previous.read);
        snap.write_rate = rate(now.write, previous.write);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX: &str = "@sys\nLinux\n6.8.0-45-generic\nweb-1\n@os\nUbuntu 24.04.1 LTS\n@uptime\n90061.52\n@load\n0.52 0.40 0.31\n@cpu\ncpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\ncpu1 50 0 25 400 25 0 0 0 0 0\n@mem\nMemTotal:       16000000 kB\nMemFree:         2000000 kB\nMemAvailable:   10000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n@net\nInter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0\n  eth0: 5000 10 0 0 0 0 0 0 3000 8 0 0 0 0 0 0\nveth1a: 777 1 0 0 0 0 0 0 777 1 0 0 0 0 0 0\n@blocks\nloop0\nsda\n@io\n   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0\n   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0\n   7       0 loop0 1 0 8 0 0 0 0 0 0 0 0\n@df\nFilesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1         50000000  20000000  30000000      40% /\ntmpfs              1000000         0   1000000       0% /run\n/dev/loop0           60000     60000         0     100% /snap/core/1\n/dev/sdb1         10000000   1000000   9000000      10% /mnt/my data\n@ps\n  1234 www-data 12.5 204800 nginx: worker process\n     1 root      0.0  12000 /sbin/init splash\n     2 root      0.0      0 [kthreadd]\n  2001 alice     3.0   4000 /usr/lib/firefox/firefox -contentproc -isForBrowser\n@count\n183\n@hz\n100\n@pstat\n1234 (nginx) S 1 1234 1234 0 -1 4194560 100 0 0 0 50 25 0 0 20 0 1 0 100 1000000 50 18446744073709551615\n2001 (Web Content (x)) R 1 2001 2001 0 -1 4194560 100 0 0 0 300 100 0 0 20 0 9 0 200 9000000 1000 18446744073709551615\n";

    #[test]
    fn linux_snapshot() {
        let (snap, counters) = parse_remote(LINUX).unwrap();
        assert_eq!(snap.host, "web-1");
        assert_eq!(counters.ticks[&2001], 300 + 100);
        assert_eq!(counters.hz, 100);
        assert_eq!(snap.os, "Ubuntu 24.04.1 LTS");
        assert_eq!(snap.kernel, "Linux 6.8.0-45-generic");
        assert_eq!(snap.uptime, 90061);
        assert_eq!(snap.load, Some([0.52, 0.40, 0.31]));
        assert_eq!(snap.core_count, 2);
        assert_eq!(snap.mem_total, 16_000_000 * 1024);
        assert_eq!(snap.mem_used, 6_000_000 * 1024);
        assert_eq!(snap.swap_used, 500_000 * 1024);
        assert_eq!((counters.rx, counters.tx), (5000, 3000));
        assert_eq!((counters.read, counters.write), (2000 * 512, 4000 * 512));
        assert_eq!(counters.cpu[0], (150, 1000));
        let mounts: Vec<_> = snap.disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/mnt/my data"]);
        // All processes, busiest first (ps lifetime %CPU on the first sample).
        let pids: Vec<_> = snap.processes.iter().map(|p| p.pid).collect();
        assert_eq!(pids, [1234, 2001, 1, 2]);
        let nginx = &snap.processes[0];
        assert_eq!(
            (nginx.name.as_str(), nginx.user.as_str()),
            ("nginx", "www-data")
        );
        assert_eq!(nginx.command, "nginx: worker process");
        assert_eq!(nginx.memory, 204800 * 1024);
        assert_eq!(snap.processes[1].name, "Web Content (x)");
        assert_eq!(snap.processes[2].name, "init");
        assert_eq!(snap.processes[3].name, "kthreadd");
        assert_eq!(snap.process_count, 183);
        assert_eq!(snap.cpu, None);
    }

    #[test]
    fn rates_from_previous_sample() {
        let (_, mut before) = parse_remote(LINUX).unwrap();
        let (mut snap, mut after) = parse_remote(LINUX).unwrap();
        let start = Instant::now();
        before.at = Some(start);
        after.at = Some(start + Duration::from_secs(2));
        after.cpu[0] = (150 + 50, 1000 + 100);
        after.cpu[1] = (75 + 30, 500 + 50);
        after.cpu[2] = (75 + 20, 500 + 50);
        after.rx += 2000;
        after.write += 1024;
        apply_rates(&mut snap, &before, &after);
        assert_eq!(snap.cpu, Some(50.0));
        assert_eq!(snap.cores, [60.0, 40.0]);
        assert_eq!(snap.rx_rate, Some(1000.0));
        assert_eq!(snap.tx_rate, Some(0.0));
        assert_eq!(snap.write_rate, Some(512.0));
        // 2001 used 100 ticks (1 s at 100 Hz) in 2 s; 1234 none.
        after.ticks.insert(2001, 400 + 100);
        process_rates(&mut snap, &before, &after);
        assert_eq!(snap.processes[0].pid, 2001);
        assert_eq!(snap.processes[0].cpu, 50.0);
        assert_eq!(snap.processes[1].pid, 1234);
        assert_eq!(snap.processes[1].cpu, 0.0);
    }

    #[test]
    fn darwin_snapshot() {
        let out = "@sys\nDarwin\n24.5.0\nmac-mini\n@os\nmacOS 15.5\n@boot\n{ sec = 1700000000, usec = 0 } Tue Nov 14 22:13:20 2023\n1700086400\n@load\n{ 1.50 1.25 1.00 }\n@ncpu\n8\n@pscpu\n200\n@memsize\n17179869184\n@vmstat\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10000.\nPages wired down:                        100000.\nPages purgeable:                          10000.\nAnonymous pages:                         310000.\nPages occupied by compressor:             50000.\n@swap\ntotal = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)\n@netstat\nName  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\nlo0   16384 <Link#1>                        100     0      9999      100     0      9999     0\nen0   1500  <Link#6>    a0:b1:c2:d3:e4:f5   500     0     123456    400     0      65432     0\nen0   1500  192.168.1     192.168.1.20      500     -     123456    400     -      65432     -\n@df\nFilesystem     1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1s1   482797652  10000000 300000000     4%    /\n/dev/disk3s5     482797652 150000000 300000000    34%    /System/Volumes/Data\n@pscomm\n  501 /Applications/Safari.app/Contents/MacOS/Safari\n  612 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent\n@ps\n  501 alice  45.0 512000 /Applications/Safari.app/Contents/MacOS/Safari -psn_0\n  612 alice  10.0 100000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent\n@count\n412\n";
        let (snap, counters) = parse_remote(out).unwrap();
        assert_eq!(snap.uptime, 86400);
        assert_eq!(snap.core_count, 8);
        assert_eq!(snap.cpu, Some(25.0));
        assert_eq!(snap.mem_used, (300000 + 100000 + 50000) * 16384);
        assert_eq!(snap.swap_total, 2048 * 1048576);
        assert_eq!((counters.rx, counters.tx), (123456, 65432));
        assert_eq!(snap.disks.len(), 1);
        assert_eq!(snap.processes[0].name, "Safari");
        assert_eq!(
            snap.processes[0].command,
            "/Applications/Safari.app/Contents/MacOS/Safari -psn_0"
        );
        assert_eq!(snap.processes[1].name, "com.apple.WebKit.WebContent");
        assert_eq!(snap.load, Some([1.5, 1.25, 1.0]));
    }

    #[test]
    fn local_sample() {
        let slot = Mutex::new(None);
        let first = sample_local(&slot);
        assert!(first.mem_total > 0 && first.core_count > 0);
        assert_eq!(first.cpu, None);
        std::thread::sleep(Duration::from_millis(300));
        let second = sample_local(&slot);
        assert!(second.cpu.is_some());
        assert_eq!(second.cores.len(), second.core_count);
        assert!(second.rx_rate.is_some());
        // Every process, including this test process with its command line.
        let me = second
            .processes
            .iter()
            .find(|p| p.pid == std::process::id())
            .unwrap();
        assert!(!me.command.is_empty());
        assert_eq!(second.processes.len(), second.process_count);
    }

    #[test]
    fn clip_command() {
        assert_eq!(clip("short"), "short");
        let long = "é".repeat(MAX_COMMAND + 5);
        assert_eq!(clip(&long).chars().count(), MAX_COMMAND + 1);
    }

    #[cfg(unix)]
    #[test]
    fn stop_local_process() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        signal_local(child.id(), StopSignal::Term).unwrap();
        let status = child.wait().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(libc::SIGTERM));
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        signal_local(child.id(), StopSignal::Kill).unwrap();
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        // Gone now: the error names the reason.
        let error = signal_local(child.id(), StopSignal::Term).unwrap_err();
        assert!(error.contains("No such process"), "{error}");
    }
}
