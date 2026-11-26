# Changelog

All notable changes to MetroTerm are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) — numbers and periods only; a candidate is a GitHub
prerelease of the version, not a suffix. The Chinese changelog is
[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); both need a section before a version is tagged
(`node scripts/release-notes.mjs vX.Y.Z --check`).

## [Unreleased]

### Added

- Inline images in the terminal: SIXEL and the iTerm2 image protocol (`imgcat`), up to 32 MB of images per terminal (older ones are dropped first).
- Emoji sequences (👨‍👩‍👧), flags and combining marks are measured as one character (Unicode 15 grapheme clusters) instead of one cell width per code point.
- Terminal right-click → Save Output As ANSI…: saves the output with its colours and styles as an `.ansi` file that `cat` / `less -R` show as it was (keyword highlighting is left out).
- A sound plays when an agent CLI (Claude Code, Codex …) finishes a turn you started (you sent it a message, then it finished — not when it starts up or works on its own), so you hear it from another tab, window or application; several finishing together ring once. Settings → AGENT DONE SOUND picks one of six sounds (Ding, Chime, Bell, Marimba, Pop, Crystal), with PLAY to listen; View → Agent Done Sound turns it off (on by default).
- Ctrl+PgUp / Ctrl+PgDn switch to the previous / next tab in the focused pane's tab bar (wrapping around; rebindable in Keyboard Shortcuts; Ctrl+B p / n still work).
- Session → Preferences → Keyboard Shortcuts…: change the default shortcuts (click a shortcut, press the new keys). A combination another command already uses is refused with the name of that command, and REASSIGN moves it over; fixed keys (Ctrl+Shift+1…9, Ctrl+C, Ctrl+V, Alt+F4) cannot be taken. Menus and tooltips show the shortcuts in use. Saved in settings.json (`keys`, only the changed ones).
- Ctrl+Shift+L clears the terminal's scrollback (also shown on the terminal's right-click menu).
- Terminal colour schemes are iTerm2 `.itermcolors` files: `~/.metroterm/themes/black/` holds the schemes for the Dark and Gold themes, `~/.metroterm/themes/white/` those for the Light theme. MetroTerm's own three schemes are put there on first start; more can be added by downloading iTerm2 themes (for example from terminalthemes.com) into these folders. Settings → TERMINAL COLORS picks the scheme of the theme selected above it, from a list (not typed): Default (the theme's own scheme) or a scheme from that theme's folder (Dark / Gold: `black`, Light: `white`); a saved scheme whose file was removed shows as "file not found". Keyword highlighting keeps the app theme's colours.
- Session Settings for SSH, Telnet and TCP sessions: a PROXY choice per session — the global proxy (Session → Proxy…), no proxy, its own SOCKS5 or HTTP CONNECT proxy, or **jump hosts**: saved SSH sessions the connection is tunnelled through one after the other, in the order listed (add, reorder with ↑ ↓, remove; like `ssh -J a,b`). The first one connects by its own settings; loops are refused.
- Only one MetroTerm runs at a time: starting it again (menu, desktop icon, command line) brings the open window to the front and gives it the keyboard focus (the terminal of the current tab, unless a dialog field had it) instead of opening a second one.
- Closing MetroTerm (Session → Exit, the window's close button, Alt+F4 / ⌘Q, taskbar or Dock) while terminals are open asks first; in the browser the page asks before it is left.
- Session panel: agent CLI status. When Claude Code, Codex, opencode or another coding agent CLI runs in a terminal (Gemini CLI, Copilot CLI, Cursor Agent, Qwen Code, Kimi Code, Amp …), its row gets a second line under the tab with the agent's name and, at the right edge, its state as a flat Metro tag (WORKING in amber, NEEDS INPUT as a solid red block, DONE in green, IDLE outlined), plus an icon for the state — a turning spark while it works, a nudging speech box when it needs your answer, a check drawn in when it is done — Working, Needs input, Done (finished while you were looking at another terminal), Idle. The backend works it out from the terminal output with detection rules (a screen model of each terminal, per-agent TOML manifests); local terminals name the agent from their foreground process (also when it is started through Node, Python or a symbolic link: Pi's npm package, cursor-agent's own Node, the Hermes launcher), SSH / Telnet / serial terminals from the screen or from the window title the agent sets (Devin, Kiro, Amp and Grok as well as Claude Code, Codex and opencode). Everything is read from the terminal output — screen text, window title (OSC 0/2) and progress (OSC 9) — with no plugins or hooks installed into the agents. Rules can be overridden in `~/.metroterm/agents/`.
- MCP server for agent CLIs (Session → Preferences → Settings… → MCP SERVER, off by default): Claude Code, Codex, Gemini CLI and other MCP clients can list MetroTerm's terminals and the state of the agents in them, read a terminal's screen or recent lines, wait for some output, prompt an agent in another terminal and wait until it is done, type text or keys, focus a terminal and open new tabs. It listens on 127.0.0.1 only (port 7690 by default) and needs the access token generated in Settings; requests from web pages are refused. Transports: SSE (`/sse`) and Streamable HTTP (`/mcp`); Settings shows a ready-to-copy setup for each CLI. Turning off "Allow agents to type, open and arrange tabs" leaves it read-only, and an agent running inside one of MetroTerm's terminals cannot type into its own terminal. Agent states still come only from the terminal output.
- MCP server: windows and split panes. `list_windows` shows MetroTerm's windows, how each splits its terminal area into panes (with the letters A, B … of their tab bars) and the tabs in each pane; `split_pane` splits a pane right / down / left / up with a new terminal in the new pane (optionally running a command), `resize_pane`, `zoom_pane`, `move_terminal` (to another pane or window, or into a new pane), `new_window`, `rename_window`, `focus_window`, and `open_terminal` can name a window or pane. They work in the background unless asked to focus. `close_terminal`, `close_pane` and `close_window` close what an agent opened at once and ask the user first about anything else (the agent gets `cancelled` when the user says no); an agent's own terminal, pane or window and the last window are never closed.
- MCP server: the Session panel's tab actions. `list_terminals` gives each tab's name as shown on it, its window and pane, in the order of the tab bars, and lists disconnected tabs too; `rename_terminal` renames a tab (or gives it its default name back), `move_terminal` reorders tabs (`before`, `last`), `open_terminal` clones a tab, `reconnect_terminal` and `disconnect_terminal` restart or end a tab's session (disconnecting asks the user unless an agent opened the tab), and `close_terminal` closes several tabs at once. A terminal id keeps working after its tab was reconnected.
- Terminal links: `http://` / `https://` addresses are underlined under the pointer and open in the default browser with Ctrl+click (⌘+click on macOS); a plain click still selects. Uses xterm's `@xterm/addon-web-links`.
- Programs that use the mouse in the terminal (herdr, opencode, vim with `mouse=a`, tmux with `mouse on` …) get the right click for their own menus; the terminal menu opens with Shift+right-click (Option+right-click on macOS, where Option+drag also selects text in such programs).

### Fixed

- Output highlighting colours the cells in the terminal buffer itself instead of using decorations: much smoother with heavy output and while scrolling, and text a program overwrites never keeps a stale colour. The uncoloured text of vim, less, htop and other full-screen programs is coloured too (also switched by View → Highlight Keywords).
- Dialogs: in a dialog opened by a shortcut (such as Ctrl+Shift+W, close tab) ← / → move between the footer buttons and Enter presses the focused one even while Ctrl / Shift are still held.
- Linux desktop app: text typed with an input method (Chinese pinyin with fcitx5 or IBus, and other IMEs) is sent to the terminal once; with fcitx5 a word appeared several times, together with stray pinyin letters and earlier text.
- Many split panes or tabs no longer use a lot of CPU and memory: the terminals' WebGL renderers no longer drop and recreate each other in a loop once the browser's limit of live WebGL contexts is reached. Hidden terminals (background tabs, other windows, hidden panes) give their WebGL context back after 5 seconds and get it again when shown; at most 12 contexts are used, and a terminal beyond that is drawn by xterm's DOM renderer until one is free. Terminal output no longer re-renders the whole app for the status bar's Ln / Ch, and Gold's light on the active tab no longer repaints every frame.
- Terminal find: the match colours now visibly change with the theme (Dark teal, Light yellow, Gold amber; Dark and Gold used almost the same amber).
- Sender: the line numbers line up with the text again (they were 2–3 px low) and stay aligned when scrolled to the end.
- Keyword highlighting now also colours lines scrolled into view with the mouse wheel or scrollbar, and lines rewrapped after a pane is resized by dragging its divider (both stayed uncoloured). It only touches text with the default foreground and background, so anything an SGR code coloured (16 colours, xterm-256color palette, true colour) keeps its own colour, and it does less work per update.
- The terminal's time / line-number column no longer shows numbers for rows that hold no output, in particular after a pane is resized.
- Terminal line numbers count lines, not screen rows: a long line wrapped over several rows keeps one number and the next line gets the next number (before, numbers were skipped after every wrapped line). The status bar's Ln uses the same numbers.
- Reconnect (the pane toolbar's ↻, the terminal's right-click menu, Session → Reconnect Session) reconnects only the current terminal; other tabs and split panes with the same session stay connected.
- Dialogs: the text caret of a field no longer stays visible over the sticky title / button row or outside the dialog when the field is scrolled out of view; it shows again when the field is back.
- macOS, app title bar: double-clicking the title bar maximizes / restores the window again; the maximize button enters full screen.

- Windows: the Filer's Terminal folder button and Follow terminal now find the terminal's folder (cmd, PowerShell, Git Bash; PowerShell `cd` included). `file:///C:/…` paths from OSC 7 open correctly, and OSC 9;9 is understood.
- macOS: the app no longer opens to an empty window on Macs with an older system WebKit (common on Intel Macs). If the interface still fails to start, the window shows the error.

- Windows installer: choosing a folder without write permission (for example under Program Files when installing for the current user) no longer fails half-way with "Error opening file for writing"; the folder page explains the problem and keeps Next disabled.
- macOS: the app icon is no longer larger than other apps' icons in the Dock and Launchpad.
- macOS: the system's horizontal scrollbar no longer shows under the app's own scrollbar (seen in the Filer with wide columns).
- macOS: with the app's own title bar, Minimize works again and the Maximize button enters macOS full screen in its own Space, like the green button, instead of stretching the window over the desktop.
- Windows: a first start now sets up cmd and PowerShell in Explorer instead of bash and zsh.

### Changed

- The terminal is now xterm.js 6.0 (from 5.5), with all its addons updated. The mouse wheel scrolls about 3 lines per notch, like VS Code's terminal. Alt+← / Alt+→ still move by a word.
- One program for the desktop app and web mode: web mode is now `metroterm web` (instead of `metroterm --web`), with `metroterm web --daemon` / `metroterm web --stop` for the background server (instead of `--daemon` / `--stop`) and `--listen ADDR` for the address. The browser package runs `./metroterm web` instead of `./metroterm-server`. A leading `--` is ignored (`metroterm -- web --daemon`).
- Session panel: tidier rows — every tab's first line is the same 28 px height, so titles, the right-aligned user@host / shell and the connection dots line up down the list; three text sizes (tab title; agent name and user@host / shell 1 px smaller, the latter fainter); the agent line sits 18 px under it with its state tag flush with the dots; the OPEN TABS count is uppercase with a little letter-spacing.

- Dialogs: clicking a field's title no longer focuses or opens the field (check boxes and radio buttons still toggle from their text), and clicking the dimmed area around a dialog no longer closes it.
- Terminal find now uses xterm's `@xterm/addon-search`: the current match is also selected, at most 1000 matches are counted and coloured ("1000+"), and Find all colours every match up to that limit instead of only those near the view. Web addresses are no longer coloured by keyword highlighting.
- A clicked (highlighted) terminal line also highlights its time and line number in the gutter in a bright colour (the cursor's line keeps its red / gold).
- The terminal's time / line-number column follows the terminal's font size, one size smaller (Settings → TERMINAL FONT SIZE and View → Zoom), instead of a fixed 12 px; it widens and narrows with it, and the numbers sit in the vertical middle of each row whatever the font.
- The terminal's right-click menu no longer has Move Tab to New Pane, Zoom Pane and Close Pane; they stay on the tab's right-click menu (Move Tab to New Pane), the pane's ⋮ menu (Zoom Pane, Close Pane) and the Ctrl+B keys (`!`, `z`, `x`).

- Windows: the default interface font is Microsoft YaHei.
- Linux and macOS: the default interface font is DejaVu Sans Mono (the built-in fonts when it is not installed).
- The default terminal font (Settings → TERMINAL FONT → Default) is DejaVu Sans Mono; Sarasa Mono SC and the other built-in fonts fill in for characters it lacks (Chinese) and on systems without it.
- Dialogs are at most 640 px tall; a longer one scrolls between its title and its buttons.
- Session → Preferences: Keyboard Shortcuts… is below Default Session Settings….

- Terminal output highlighting: command-line options (`--help`, `-f`) are orange.
- A panel's Settings menu is narrower and no longer shows "In another panel" next to views open elsewhere.
- Terminal: output highlighting is back — times, log levels, errors / warnings / outcomes, numbers, quoted strings, brackets, addresses, URLs, options, `ls -l` modes and the prompt symbol get colours of their own (per theme), only where the program did not colour the text itself. It no longer patches the renderer; View → Highlight Keywords turns it off.
- Terminal: find matches get a block of colour (the current one brighter) instead of a frame.
- Status bar: the Window columns × rows follow a splitter or window drag live instead of updating after it stops.
- Terminal: find is back — the magnifier right of the pane toolbar's fullscreen button, Ctrl+F (Local Mode) or right-click → Find… opens a find bar that searches the whole scrollback (case-insensitive), marks the current match and highlights its line; Enter / Shift+Enter step through matches, Find all marks every match.
- Terminal: the scrollbar sits on the pane's right edge.
- Terminal: selecting text (one line) gives every other occurrence a light background, drawn by the terminal renderer into the cells so it lines up exactly with the selection; it follows scrolling and new output and handles wide (CJK) characters.
- Terminal: bold text is drawn in the regular weight by default (its bright colour stays); Settings → BOLD TEXT switches back to bold.
- Terminal: no cursor while the terminal is not focused (xterm drew a hollow box), and the scrollback scrollbar is the app's own square scrollbar, the same as everywhere else.
- Terminal: the time / line-number gutter (View → Show Time / Show Line Number) and the clicked-line highlight (only on lines that have been written; clicking the blank rows below the cursor clears it) are rebuilt on xterm's public API, so they work with the WebGL renderer and line up exactly at every display scale; the gutter's width no longer changes as output grows.
- Terminal: thicker bar and underline cursors — the bar is 2 px wide and the underline 3 px high (both were 1 px).
- Terminal: Chinese and other CJK text lines up better — the default terminal font now starts with Sarasa Mono SC and Source Code Pro (when installed), one-cell characters whose glyph would overlap the next cell (Ⅰ Ⅱ Ⅲ …) are squeezed into their cell, and text colours keep at least 4.5:1 contrast against their background. The terminal is drawn with WebGL only: when WebGL is not available the error is reported and shown in place of the terminal (no DOM-renderer fallback); a lost WebGL context is restarted.
- Dialog footer buttons (OK / Cancel …) are smaller: 26 px high instead of 32 px, and the dialogs' inputs, dropdowns, number fields and switches now have the same 26 px height.
- Password fields have an eye button on the right that shows the password in clear (click again to hide it).
- Explorer, Filer, Sender, Session and Monitor can each be open in only one panel: opening one in another panel closes it where it was. Layouts saved with duplicates keep the first one.
- Settings → THEME: the Gold option no longer shows a "PRO MAX" badge.
- macOS: the minimum version is now 10.15 (the oldest version Tauri 2 supports).
- Windows installer: choose between installing for the current user or for all users (Program Files); the installer is shown in Chinese on Chinese systems.

### Removed

- Compatibility with development builds: older `sessions.json` versions, `layout.json` / `tabs.json`, the `~/.MetroTerm` folder, the retired "MetroTerm Gold" scheme file and the hints for `--web` / `--daemon` / `--stop` are no longer handled (codebase cleanup, no change in features).
- Terminal: back to plain xterm.js rendering — only the font, cursor, scrollback and theme colours are set. Removed: web-address underlines and Ctrl+click, the custom input-method handling, the reshaped cursor and all row-spacing / character-width / box-glyph adjustments.

## [0.0.1] - 2026-11-16

The first release.

### Added

- Terminal workspace: Explorer (sessions) and Filer on the left, tabbed
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
- Installers for Linux (deb, rpm, AppImage), Windows (setup.exe, msi, portable zip, and for x64 an
  offline installer with WebView2) and macOS (dmg), x86_64 and ARM64.
