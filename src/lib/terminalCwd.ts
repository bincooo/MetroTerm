import { backend } from './backend';

/**
 * Current directory of each terminal tab, for the Filer's "Terminal folder" button and its
 * "Follow terminal" mode.
 *
 * Two sources:
 * - OSC 7 (`ESC ] 7 ; file://host/path BEL`), sent by shells configured for it (fish by default,
 *   VTE's vte.sh, starship, many zsh / bash setups), and OSC 9;9 (`ESC ] 9 ; 9 ; C:\\path BEL`,
 *   MetroTerm's PowerShell prompt hook on Windows): known immediately, after every prompt.
 * - The backend (`terminal.cwd`): reads the shell's directory from the system — /proc for local
 *   shells (Linux), `lsof` (macOS), the process memory (Windows, see wincwd.rs), and for SSH a short exec channel on the same connection that finds the shell by the
 *   `LC_METROTERM_SESSION` variable sent with it. Asked when a command has finished (Enter, then
 *   the output went quiet), when a tab starts and on demand.
 */
type Entry = { sessionId: () => string; osc: string | null; cwd: string | null; seq: number };
type Listener = (tabId: string, cwd: string) => void;

const tabs = new Map<string, Entry>();
const listeners = new Set<Listener>();

const publish = (tabId: string, entry: Entry, cwd: string | null) => {
  if (!cwd || cwd === entry.cwd) return;
  entry.cwd = cwd;
  listeners.forEach(listener => listener(tabId, cwd));
};

/**
 * A directory as the Filer writes it. Windows paths arrive in several forms — `C:\\Users\\me\\`
 * (OSC 9;9), `/C:/Users/me` (the path of a `file:///C:/Users/me` URL) — and become `C:/Users/me`
 * (a drive root keeps its slash: `C:/`), the form `fs.list` answers with. Others pass unchanged.
 */
export function filerPath(path: string): string {
  const windows = /^\/?([A-Za-z]:)([\\/].*)?$/.exec(path) ?? (/^\\\\[^\\/]/.test(path) ? [path, '', path] : null);
  if (!windows) return path;
  const rest = (windows[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return windows[1] ? `${windows[1]}${rest || '/'}` : rest;
}

/** OSC 7 payload → path (`file://host/some%20dir` → `/some dir`, `file:///C:/x` → `C:/x`); null if not a file URL. */
export function parseOsc7(data: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/i.exec(data.trim());
  if (!match) return null;
  let path = match[1];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep it as sent
  }
  return filerPath(path);
}

/**
 * OSC 9;9 payload → path. ConEmu's / Windows Terminal's "current directory" sequence
 * (`ESC ] 9 ; 9 ; C:\\Users\\me BEL`, the path optionally in double quotes), sent by MetroTerm's
 * PowerShell prompt hook. xterm hands over everything after `9;` — `9;<path>`. Other OSC 9 uses
 * (`9;4;…` progress, `9;<text>` notifications) give null.
 */
export function parseOsc9(data: string): string | null {
  const match = /^9;(.+)$/s.exec(data);
  if (!match) return null;
  const path = match[1].trim().replace(/^"(.*)"$/s, '$1');
  return /^([A-Za-z]:[\\/]?|\\\\[^\\/]|\/)/.test(path) ? filerPath(path) : null;
}

/** Ask the backend; falls back to the last OSC 7 directory. Publishes a change. */
export async function queryCwd(tabId: string): Promise<string | null> {
  const entry = tabs.get(tabId);
  if (!entry) return null;
  const sessionId = entry.sessionId();
  const seq = ++entry.seq;
  let cwd: string | null = null;
  if (sessionId && backend.live) cwd = await backend.call<string | null>('terminal.cwd', { sessionId }).catch(() => null);
  if (tabs.get(tabId) !== entry || seq !== entry.seq) return entry.cwd; // a newer answer is on its way
  cwd = cwd ? filerPath(cwd) : entry.osc;
  publish(tabId, entry, cwd);
  return cwd ?? entry.cwd;
}

/** Last known directory of a tab (no request). */
export const knownCwd = (tabId: string) => tabs.get(tabId)?.cwd ?? null;

export function onCwdChange(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** After Enter: ask once the output has been quiet this long (the command has finished or waits for input). */
const QUIET = 250;
/** Continuous output (a build, `top`): ask at the latest after this long, then keep waiting for quiet. */
const BUSY = 3000;

/** Called by TerminalView for its tab. */
export function registerTerminal(tabId: string, sessionId: () => string) {
  const entry: Entry = { sessionId, osc: null, cwd: null, seq: 0 };
  tabs.set(tabId, entry);
  let pending = false;
  let quietTimer = 0;
  let busyTimer = 0;
  const ask = () => {
    window.clearTimeout(quietTimer);
    window.clearTimeout(busyTimer);
    quietTimer = busyTimer = 0;
    pending = false;
    if (listeners.size) void queryCwd(tabId); // only while something follows the terminal
  };
  const wait = () => {
    window.clearTimeout(quietTimer);
    quietTimer = window.setTimeout(ask, QUIET);
    if (!busyTimer) busyTimer = window.setTimeout(ask, BUSY);
  };
  return {
    /** Input sent to the shell: Enter ends a command line (`cd …`, `popd`, a script …). */
    input(data: string) {
      if (data.includes('\r') && listeners.size) {
        pending = true;
        wait();
      }
    },
    /** Output arrived: postpone the question until the command is done. */
    output() {
      if (pending) wait();
    },
    /** The shell reported its directory (OSC 7 / OSC 9;9). */
    osc(path: string) {
      entry.osc = path;
      entry.seq++;
      publish(tabId, entry, path);
    },
    /** The session (re)started: the directory is the new shell's. */
    started() {
      entry.osc = null;
      entry.seq++;
      window.setTimeout(() => {
        if (listeners.size) void queryCwd(tabId);
      }, 600);
    },
    dispose() {
      window.clearTimeout(quietTimer);
      window.clearTimeout(busyTimer);
      if (tabs.get(tabId) === entry) tabs.delete(tabId);
    },
  };
}
