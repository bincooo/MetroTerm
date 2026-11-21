//! Windows: the current directory of a terminal's shell (`terminal.cwd`, the Filer's
//! "Terminal folder" / "Follow terminal").
//!
//! Windows has no /proc and no `lsof`; a process's current directory lives in its own memory:
//! PEB → `ProcessParameters` (RTL_USER_PROCESS_PARAMETERS) → `CurrentDirectory.DosPath`, a
//! UNICODE_STRING. It is read with `NtQueryInformationProcess(ProcessBasicInformation)` and
//! `ReadProcessMemory` — what Process Explorer shows as "Current directory". Any process of the same
//! user can be read this way.
//!
//! Like `/proc/<pid>/stat`'s foreground process on Linux, the directory is taken from the newest
//! program the shell started, if it is still running (a nested `cmd` or `pwsh`), else from the
//! shell. PowerShell's own `cd` (Set-Location) does not change the process directory, so the shell
//! hook in terminal.rs sets `[Environment]::CurrentDirectory` at every prompt — and also reports the
//! folder with OSC 9;9, which the UI reads directly.

use std::ffi::c_void;
use std::mem::{size_of, MaybeUninit};
use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, IsWow64Process, OpenProcess, PROCESS_QUERY_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
};

/// Console hosts are children of the shell's console, not programs the user started.
const NOT_PROGRAMS: [&str; 2] = ["conhost.exe", "openconsole.exe"];
/// Their own process directory says nothing about the folder the user is in (a Linux shell inside
/// `wsl.exe`): no answer rather than a wrong one.
const NO_FOLDER: [&str; 2] = ["wsl.exe", "wslhost.exe"];
/// Nested programs followed at most (a shell in a shell in …).
const MAX_DEPTH: usize = 8;

/// PROCESS_BASIC_INFORMATION (winternl.h), declared here so no extra windows-sys feature is needed.
#[repr(C)]
struct BasicInformation {
    exit_status: i32,
    peb: usize,
    affinity_mask: usize,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

/// Offsets in the 64-bit PEB / RTL_USER_PROCESS_PARAMETERS (stable since Windows XP x64; the same
/// for x64 programs emulated on ARM64).
const PEB_PROCESS_PARAMETERS: usize = 0x20;
const PARAMETERS_CURRENT_DIRECTORY: usize = 0x38;

/// UNICODE_STRING: Length and MaximumLength in bytes, then (aligned) the buffer address.
#[repr(C)]
#[derive(Clone, Copy)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: usize,
}

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

impl Handle {
    fn open(pid: u32, access: u32) -> Option<Handle> {
        let handle = unsafe { OpenProcess(access, 0, pid) };
        (!handle.is_null()).then_some(Handle(handle))
    }
}

/// Current directory of the terminal whose shell is `pid`, with forward slashes (`C:/Users/me`),
/// like the paths of the Filer.
pub fn terminal_cwd(pid: u32) -> Option<String> {
    let processes = snapshot();
    let mut current = pid;
    let mut current_name = processes
        .iter()
        .find(|process| process.pid == pid)
        .map(|process| process.name.clone())
        .unwrap_or_default();
    for _ in 0..MAX_DEPTH {
        let Some(started) = created(current) else {
            break;
        };
        // Children are matched by parent id *and* start time: a parent id may belong to an older,
        // exited process whose number was reused.
        let newest = processes
            .iter()
            .filter(|process| process.parent == current && process.pid != current)
            .filter(|process| !NOT_PROGRAMS.contains(&process.name.as_str()))
            .filter_map(|process| created(process.pid).map(|time| (time, process)))
            .filter(|(time, _)| *time >= started)
            .max_by_key(|(time, _)| *time);
        match newest {
            Some((_, process)) => {
                current = process.pid;
                current_name = process.name.clone();
            }
            None => break,
        }
    }
    if NO_FOLDER.contains(&current_name.as_str()) {
        return None;
    }
    process_cwd(current).or_else(|| (current != pid).then(|| process_cwd(pid)).flatten())
}

struct Process {
    pid: u32,
    parent: u32,
    /// Executable name, lower case.
    name: String,
}

fn snapshot() -> Vec<Process> {
    let mut list = Vec::new();
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap.is_null() || snap == INVALID_HANDLE_VALUE {
        return list;
    }
    let snap = Handle(snap);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut more = unsafe { Process32FirstW(snap.0, &mut entry) } != 0;
    while more {
        let end = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        list.push(Process {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase(),
        });
        more = unsafe { Process32NextW(snap.0, &mut entry) } != 0;
    }
    list
}

/// Start time (100 ns since 1601), or None when the process cannot be opened.
fn created(pid: u32) -> Option<u64> {
    let process = Handle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
    let ok =
        unsafe { GetProcessTimes(process.0, &mut creation, &mut exit, &mut kernel, &mut user) };
    (ok != 0)
        .then(|| (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

/// Reads a `T` at `address` in the other process.
fn read<T: Copy>(process: &Handle, address: usize) -> Option<T> {
    let mut value = MaybeUninit::<T>::uninit();
    let mut done = 0usize;
    let ok = unsafe {
        ReadProcessMemory(
            process.0,
            address as *const c_void,
            value.as_mut_ptr().cast(),
            size_of::<T>(),
            &mut done,
        )
    };
    (ok != 0 && done == size_of::<T>()).then(|| unsafe { value.assume_init() })
}

#[cfg(target_pointer_width = "64")]
fn process_cwd(pid: u32) -> Option<String> {
    let process = Handle::open(pid, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)
        .or_else(|| Handle::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ))?;
    // A 32-bit program (WOW64) has a 32-bit PEB with other offsets; shells are 64-bit.
    let mut wow64 = 0;
    if unsafe { IsWow64Process(process.0, &mut wow64) } != 0 && wow64 != 0 {
        return None;
    }
    let mut info = MaybeUninit::<BasicInformation>::zeroed();
    let mut length = 0u32;
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            ProcessBasicInformation,
            info.as_mut_ptr().cast(),
            size_of::<BasicInformation>() as u32,
            &mut length,
        )
    };
    if status < 0 {
        return None;
    }
    let peb = unsafe { info.assume_init() }.peb;
    if peb == 0 {
        return None;
    }
    let parameters: usize = read(&process, peb + PEB_PROCESS_PARAMETERS)?;
    let dos_path: UnicodeString = read(&process, parameters + PARAMETERS_CURRENT_DIRECTORY)?;
    let units = usize::from(dos_path.length) / 2;
    if units == 0 || dos_path.buffer == 0 {
        return None;
    }
    let mut buffer = vec![0u16; units];
    let mut done = 0usize;
    let ok = unsafe {
        ReadProcessMemory(
            process.0,
            dos_path.buffer as *const c_void,
            buffer.as_mut_ptr().cast(),
            units * 2,
            &mut done,
        )
    };
    if ok == 0 || done != units * 2 {
        return None;
    }
    Some(filer_path(&String::from_utf16_lossy(&buffer)))
}

#[cfg(not(target_pointer_width = "64"))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
}

/// `C:\Users\me\` → `C:/Users/me`; a drive root keeps its slash (`C:/`); `\\?\` is dropped.
pub fn filer_path(raw: &str) -> String {
    let path = raw
        .trim_start_matches(r"\\?\UNC\")
        .trim_start_matches(r"\\?\")
        .replace('\\', "/");
    // `\\?\UNC\server\share` → `server/share` above: put the UNC slashes back.
    let path = if raw.starts_with(r"\\?\UNC\") {
        format!("//{path}")
    } else {
        path
    };
    let trimmed = path.trim_end_matches('/');
    if trimmed.len() == 2 && trimmed.ends_with(':') {
        format!("{trimmed}/")
    } else if trimmed.is_empty() {
        path
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::filer_path;

    #[test]
    fn paths_look_like_the_filer_s() {
        assert_eq!(filer_path(r"C:\Users\me\"), "C:/Users/me");
        assert_eq!(filer_path(r"C:\"), "C:/");
        assert_eq!(filer_path(r"\\?\D:\work"), "D:/work");
        assert_eq!(filer_path(r"\\server\share\dir\"), "//server/share/dir");
        assert_eq!(filer_path(r"\\?\UNC\server\share\"), "//server/share");
    }
}
