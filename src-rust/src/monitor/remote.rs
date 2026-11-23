//! Samples of an SSH host: one `sh` script over an exec channel, its output parsed (Linux, macOS).

use super::*;

/// Sections start with `@name`. LC_ALL=C keeps number formats and column names stable.
pub(super) const SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
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

pub(super) async fn run_script(ssh: &SshHandle) -> Result<String, String> {
    // `sh -s` reads the script from stdin: no quoting, and it works under any login shell.
    let (stdout, _, _) = run_remote(ssh, "sh -s", Some(SCRIPT)).await?;
    Ok(stdout)
}

/// Runs `command` on an exec channel (optionally feeding `stdin`): (stdout, stderr, exit status).
pub(super) async fn run_remote(
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

pub(super) fn sections(output: &str) -> HashMap<&str, Vec<&str>> {
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

pub(super) fn parse_remote(output: &str) -> Result<(Snapshot, Counters), String> {
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
pub(super) fn parse_names(lines: &[&str]) -> HashMap<u32, String> {
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
pub(super) fn parse_proc_stats(
    s: &HashMap<&str, Vec<&str>>,
    counters: &mut Counters,
) -> HashMap<u32, String> {
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
pub(super) fn process_rates(snap: &mut Snapshot, previous: &Counters, now: &Counters) {
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
pub(super) fn sort_processes(list: &mut Vec<ProcessInfo>) {
    list.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.memory.cmp(&a.memory)));
    list.truncate(MAX_PROCESSES);
}

pub(super) fn first_line<'a>(s: &HashMap<&str, Vec<&'a str>>, name: &str) -> &'a str {
    s.get(name)
        .and_then(|lines| lines.first().copied())
        .unwrap_or("")
        .trim()
}

pub(super) fn numbers(text: &str) -> Vec<f64> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter_map(|part| part.parse().ok())
        .collect()
}

pub(super) fn parse_linux(
    s: &HashMap<&str, Vec<&str>>,
    snap: &mut Snapshot,
    counters: &mut Counters,
) {
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

pub(super) fn parse_darwin(
    s: &HashMap<&str, Vec<&str>>,
    snap: &mut Snapshot,
    counters: &mut Counters,
) {
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
pub(super) fn parse_df(lines: &[&str]) -> Vec<DiskInfo> {
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
pub(super) fn parse_ps(lines: &[&str], names: &HashMap<u32, String>) -> Vec<ProcessInfo> {
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

pub(super) fn apply_rates(snap: &mut Snapshot, previous: &Counters, now: &Counters) {
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
