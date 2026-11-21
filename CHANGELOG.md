# Changelog

All notable changes to MetroTerm are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) — numbers and periods only; a candidate is a GitHub
prerelease of the version, not a suffix. The Chinese changelog is
[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); both need a section before a version is tagged
(`node scripts/release-notes.mjs vX.Y.Z --check`).

## [Unreleased]

### Fixed

- Windows: the Filer's Terminal folder button and Follow terminal now find the terminal's folder (cmd, PowerShell, Git Bash; PowerShell `cd` included). `file:///C:/…` paths from OSC 7 open correctly, and OSC 9;9 is understood.
- macOS: the app no longer opens to an empty window on Macs with an older system WebKit (common on Intel Macs). If the interface still fails to start, the window shows the error.

- Windows installer: choosing a folder without write permission (for example under Program Files when installing for the current user) no longer fails half-way with "Error opening file for writing"; the folder page explains the problem and keeps Next disabled.
- macOS: the app icon is no longer larger than other apps' icons in the Dock and Launchpad.
- macOS: the system's horizontal scrollbar no longer shows under the app's own scrollbar (seen in the Filer with wide columns).
- macOS: with the app's own title bar, Minimize works again and Maximize (or double-clicking the title bar) enters macOS full screen in its own Space, like the green button, instead of stretching the window over the desktop.
- Windows: a first start now sets up cmd and PowerShell in Explorer instead of bash and zsh. Unchanged bash / zsh sessions created by earlier versions on Windows are switched to cmd / PowerShell.

### Changed

- macOS: the minimum version is now 10.15 (the oldest version Tauri 2 supports).
- Windows installer: choose between installing for the current user or for all users (Program Files); the installer is shown in Chinese on Chinese systems.

## [0.0.1] - 2026-11-16

The first release.

### Added

- Terminal workspace in a WindTerm-style layout: Explorer (sessions) and Filer on the left, tabbed
  terminals and the Sender on the right, Monitor panel; every panel can be moved, resized and closed.
- Sessions: local shell (bash, zsh …), SSH, Telnet, raw TCP and serial ports, organised in folders;
  SOCKS5 / HTTP proxies for SSH, Telnet and TCP.
- SSH: password and key authentication, remembered passwords (encrypted), host key checking,
  local / remote / dynamic tunnels (Tool → Tunnels).
- Filer: SFTP and local files — multi-select, drag-and-drop upload, transfers with progress and
  notifications, move / copy / rename / permissions.
- Terminal: split panes with tmux shortcuts (Ctrl+B) and per-pane tab groups, find, zoom, pane
  fullscreen, time and line-number gutter, block / bar / underline cursor, dropping files writes
  their paths.
- Several windows in one program window (Window menu, Ctrl+Shift+1…9).
- Sender: send text line by line or character by character to one or many sessions.
- Menu search (Ctrl+Shift+P), Focus Mode, lock screen, dark / light / Gold themes, English and
  Chinese interface.
- Browser mode: `metroterm --web` / `--daemon`, and the standalone browser package
  (`metroterm-server` with the UI in `www/`).
- Installers for Linux (deb, rpm, AppImage), Windows (setup.exe, msi, offline installer with
  WebView2, portable zip) and macOS (dmg), x86_64 and ARM64.
