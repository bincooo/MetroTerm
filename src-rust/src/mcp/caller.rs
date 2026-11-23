//! Which terminal an MCP client runs in, from its TCP connection alone (no environment variable
//! is put into the shells): Linux looks up the client's socket in `/proc/net/tcp{,6}`, the process
//! holding it (`/proc/<pid>/fd`), and that process's controlling terminal (`/proc/<pid>/stat`,
//! else its parents'); the terminal is the local MetroTerm terminal on that PTY. Other systems:
//! unknown (None) — the tools then simply can't mark "your own terminal".

use std::net::SocketAddr;

/// Device number (major, minor) of the controlling terminal of the process that owns the client
/// end of a connection to `server` from `peer`.
#[cfg(target_os = "linux")]
pub fn client_tty(peer: SocketAddr, server: SocketAddr) -> Option<(u64, u64)> {
    let inode = socket_inode(peer, server)?;
    let pid = socket_owner(inode)?;
    // The process itself, else the nearest parent with a terminal (a helper without one).
    let mut pid = pid;
    for _ in 0..8 {
        let (ppid, tty) = stat(pid)?;
        if tty != 0 {
            return Some(decode_kernel_dev(tty));
        }
        if ppid <= 1 {
            return None;
        }
        pid = ppid;
    }
    None
}

#[cfg(not(target_os = "linux"))]
pub fn client_tty(_peer: SocketAddr, _server: SocketAddr) -> Option<(u64, u64)> {
    None
}

/// (major, minor) of a device file's `st_rdev` (glibc's encoding).
#[cfg(unix)]
pub fn device_of(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let dev = std::fs::metadata(path).ok()?.rdev();
    let major = ((dev >> 8) & 0xfff) | ((dev >> 32) & !0xfff);
    let minor = (dev & 0xff) | ((dev >> 12) & !0xff);
    Some((major, minor))
}

#[cfg(not(unix))]
pub fn device_of(_path: &std::path::Path) -> Option<(u64, u64)> {
    None
}

/// `tty_nr` of /proc/<pid>/stat → (major, minor) (the kernel's `new_encode_dev`).
#[cfg(any(target_os = "linux", test))]
fn decode_kernel_dev(dev: u64) -> (u64, u64) {
    ((dev >> 8) & 0xfff, (dev & 0xff) | ((dev >> 12) & 0xfff00))
}

/// An address of /proc/net/tcp{,6}: `0100007F:1F90` (IPv4 as a native-endian u32, port big
/// endian) or 32 hex digits for IPv6 (four native-endian u32).
#[cfg(any(target_os = "linux", test))]
fn parse_proc_addr(text: &str) -> Option<SocketAddr> {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    let (ip, port) = text.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let ip = match ip.len() {
        8 => IpAddr::V4(Ipv4Addr::from(
            u32::from_str_radix(ip, 16).ok()?.to_ne_bytes(),
        )),
        32 => {
            let mut bytes = [0u8; 16];
            for (index, chunk) in bytes.chunks_mut(4).enumerate() {
                let word = u32::from_str_radix(&ip[index * 8..index * 8 + 8], 16).ok()?;
                chunk.copy_from_slice(&word.to_ne_bytes());
            }
            let v6 = Ipv6Addr::from(bytes);
            v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4)
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

#[cfg(any(target_os = "linux", test))]
fn normalized(addr: SocketAddr) -> SocketAddr {
    match addr {
        SocketAddr::V6(v6) => match v6.ip().to_ipv4_mapped() {
            Some(v4) => SocketAddr::new(v4.into(), v6.port()),
            None => addr,
        },
        _ => addr,
    }
}

/// The inode of the socket whose local end is `peer` and remote end `server`.
#[cfg(any(target_os = "linux", test))]
fn find_inode(table: &str, peer: SocketAddr, server: SocketAddr) -> Option<u64> {
    let (peer, server) = (normalized(peer), normalized(server));
    table.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let local = parse_proc_addr(fields.get(1)?)?;
        let remote = parse_proc_addr(fields.get(2)?)?;
        (local == peer && remote == server)
            .then(|| fields.get(9)?.parse().ok())
            .flatten()
    })
}

#[cfg(target_os = "linux")]
fn socket_inode(peer: SocketAddr, server: SocketAddr) -> Option<u64> {
    ["/proc/net/tcp", "/proc/net/tcp6"].iter().find_map(|path| {
        let table = std::fs::read_to_string(path).ok()?;
        find_inode(&table, peer, server).filter(|inode| *inode != 0)
    })
}

/// The process holding socket `inode` (only this user's processes are readable — enough).
#[cfg(target_os = "linux")]
fn socket_owner(inode: u64) -> Option<u32> {
    let wanted = format!("socket:[{inode}]");
    let own = std::process::id();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == own {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            if std::fs::read_link(fd.path())
                .is_ok_and(|target| target.as_os_str() == wanted.as_str())
            {
                return Some(pid);
            }
        }
    }
    None
}

/// (parent pid, tty_nr) of a process.
#[cfg(target_os = "linux")]
fn stat(pid: u32) -> Option<(u32, u64)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_stat(&text)
}

#[cfg(any(target_os = "linux", test))]
fn parse_stat(text: &str) -> Option<(u32, u64)> {
    // `pid (comm) state ppid pgrp session tty_nr …` — comm may contain spaces and ')'.
    let rest = &text[text.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some((
        fields.get(1)?.parse().ok()?,
        fields.get(4)?.parse::<i64>().ok()? as u64,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_net_tcp() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1E0A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:D431 0100007F:1E0A 01 00000000:00000000 00:00000000 00000000  1000        0 42424 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:1E0A 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 43333 1 0000000000000000 20 4 30 10 -1";
        if cfg!(target_endian = "little") {
            let server: SocketAddr = "127.0.0.1:7690".parse().unwrap();
            let peer: SocketAddr = "127.0.0.1:54321".parse().unwrap();
            assert_eq!(find_inode(table, peer, server), Some(42424));
            assert_eq!(find_inode(table, server, peer), Some(43333));
            // A v4-mapped client address matches too.
            let mapped: SocketAddr = "[::ffff:127.0.0.1]:54321".parse().unwrap();
            assert_eq!(find_inode(table, mapped, server), Some(42424));
            let v6 = parse_proc_addr("0000000000000000FFFF00000100007F:1E0A").unwrap();
            assert_eq!(v6, server);
        }
    }

    #[test]
    fn stat_and_devices() {
        let stat = "4242 (node (claude) x) S 4200 4242 4100 34821 4242 4194560 0 0";
        // tty_nr 34821 = major 136, minor 5 (/dev/pts/5)
        assert_eq!(parse_stat(stat), Some((4200, 34821)));
        assert_eq!(decode_kernel_dev(34821), (136, 5));
        // Large minors: /dev/pts/300.
        let dev = (136 << 8) | (300 & 0xff) | ((300 & !0xff) << 12);
        assert_eq!(decode_kernel_dev(dev), (136, 300));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn finds_its_own_connection() {
        // A client in this process can't be found (it skips itself); a child process can.
        use std::io::Read;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = listener.local_addr().unwrap();
        let mut child = std::process::Command::new("python3")
            .args([
                "-c",
                &format!(
                    "import socket,time;s=socket.create_connection(('127.0.0.1',{}));time.sleep(5)",
                    server.port()
                ),
            ])
            .stdin(std::process::Stdio::null())
            .spawn();
        let Ok(child) = child.as_mut() else { return };
        let (mut stream, peer) = listener.accept().unwrap();
        let inode = socket_inode(peer, server).expect("socket inode");
        assert_eq!(socket_owner(inode), Some(child.id()));
        let _ = child.kill();
        let _ = stream.read(&mut [0u8; 1]);
    }
}
