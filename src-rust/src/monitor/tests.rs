use super::{remote::*, *};

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
