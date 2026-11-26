//! Samples of this machine (`sysinfo`).

use super::*;

pub(super) fn sample_local(slot: &Mutex<Option<Local>>) -> Snapshot {
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
pub(super) fn skip_interface(name: &str) -> bool {
    name == "lo"
        || name.starts_with("lo0")
        || [
            "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "kube",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}
