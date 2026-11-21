/**
 * User preferences kept in ~/.metroterm/settings.json next to the theme
 * (Session → Preferences → Settings… / Default Session Settings…).
 */

import { t } from '../i18n';
import type { Transport } from '../types';
import { isTransport } from './transports';

export type CursorShape = 'block' | 'bar' | 'underline';

/** Terminal options applied to every terminal (open ones update in place). */
export type TerminalPrefs = {
  fontSize: number;
  /** Lines kept above the screen. */
  scrollback: number;
  cursorBlink: boolean;
  /** Cursor shape (Settings → CURSOR); unfocused: block → hollow box, bar / underline keep their shape. */
  cursorStyle: CursorShape;
  /** Left gutter: `[time]` column (terminal toolbar ⋮). */
  gutterTime: boolean;
  /** Left gutter: line-number column (terminal toolbar ⋮). */
  gutterLine: boolean;
  /** Terminal font family (Settings → FONTS); empty = the built-in stack (RobotoMono Nerd Font …). */
  fontFamily: string;
  /**
   * Mode menu → Local / Remote Mode. local: MetroTerm handles its shortcuts in the terminal
   * (Ctrl+C with a selection copies, Ctrl+V pastes, Ctrl+F finds, Alt+N …). remote: every key in the
   * terminal goes to the remote side as typed.
   */
  keyMode: KeyMode;
};
export type KeyMode = 'local' | 'remote';

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 13,
  scrollback: 10000,
  cursorBlink: true,
  cursorStyle: 'block',
  gutterTime: true,
  gutterLine: true,
  fontFamily: '',
  keyMode: 'local',
};
export const FONT_SIZE_RANGE = { min: 8, max: 32 } as const;
export const SCROLLBACK_RANGE = { min: 0, max: 1000000 } as const;

/** One font family name as typed (no quotes / commas / CSS syntax). */
const cleanFamily = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replace(/["';{}<>\\]/g, '')
        .split(',')[0]
        .trim()
        .slice(0, 80)
    : '';

/** Built-in font stacks (styles.css uses the same). */
export const TERMINAL_FONT_STACK = '"RobotoMono Nerd Font", Consolas, "SFMono-Regular", "Cascadia Mono", monospace';
export const UI_FONT_STACK = '"RobotoMono Nerd Font", "Cascadia Mono", "SFMono-Regular", Consolas, monospace';
/** A chosen family first, the built-in stack as fallback (missing glyphs, font not installed). */
export const withFallback = (family: string, stack: string) => (family ? `"${family}", ${stack}` : stack);

/** Window and interface (Settings → WINDOW / FONTS). */
export type AppearancePrefs = {
  /** Window opacity in percent (desktop app). */
  windowOpacity: number;
  /** Interface font family (menus, panels, dialogs); empty = built-in stack. */
  uiFontFamily: string;
};
export const OPACITY_PERCENT_RANGE = { min: 30, max: 100 } as const;
export const DEFAULT_APPEARANCE: AppearancePrefs = { windowOpacity: 100, uiFontFamily: '' };
export function sanitizeAppearance(value: unknown): AppearancePrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof AppearancePrefs, unknown>>;
  return {
    windowOpacity: num(raw.windowOpacity, 100, OPACITY_PERCENT_RANGE.min, OPACITY_PERCENT_RANGE.max),
    uiFontFamily: cleanFamily(raw.uiFontFamily),
  };
}

/** Session → Proxy…: used by SSH / Telnet / TCP sessions (read by the backend from settings.json). */
export type ProxyPrefs = {
  type: 'none' | 'socks5' | 'http';
  host: string;
  port: number;
  username: string;
  /** Encrypted by the backend (`secret.seal`), never plain text. */
  savedPassword?: string;
};
export const DEFAULT_PROXY: ProxyPrefs = { type: 'none', host: '', port: 1080, username: '' };
export function sanitizeProxy(value: unknown): ProxyPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof ProxyPrefs, unknown>>;
  const type = raw.type === 'socks5' || raw.type === 'http' ? raw.type : 'none';
  return {
    type,
    host: str(raw.host, '').trim(),
    port: num(raw.port, type === 'http' ? 8080 : 1080, 1, 65535),
    username: str(raw.username, ''),
    ...(typeof raw.savedPassword === 'string' && raw.savedPassword ? { savedPassword: raw.savedPassword } : {}),
  };
}
export const proxyActive = (proxy: ProxyPrefs) => proxy.type !== 'none' && Boolean(proxy.host);
export const describeProxy = (proxy: ProxyPrefs) =>
  proxyActive(proxy) ? `${proxy.type === 'socks5' ? 'SOCKS5' : 'HTTP'} ${proxy.host}:${proxy.port}` : t('No proxy');

/** Session → Log…: the application log written by the backend (settings.json → log). */
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogPrefs = {
  level: LogLevel;
  /** Log file; empty = ~/.metroterm/logs/metroterm.log. */
  path: string;
  format: 'text' | 'json';
  /** Start a new file past this size (MB, 0 = never). */
  maxSizeMb: number;
  /** Older files kept (metroterm.log.1 …). */
  keep: number;
};
export const LOG_LEVELS: LogLevel[] = ['off', 'error', 'warn', 'info', 'debug', 'trace'];
export const LOG_SIZE_RANGE = { min: 0, max: 1024 } as const;
export const LOG_KEEP_RANGE = { min: 0, max: 20 } as const;
export const DEFAULT_LOG: LogPrefs = { level: 'info', path: '', format: 'text', maxSizeMb: 10, keep: 3 };
export function sanitizeLog(value: unknown): LogPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof LogPrefs, unknown>>;
  const d = DEFAULT_LOG;
  return {
    level: LOG_LEVELS.includes(raw.level as LogLevel) ? (raw.level as LogLevel) : d.level,
    path: str(raw.path, d.path).trim(),
    format: raw.format === 'json' ? 'json' : 'text',
    maxSizeMb: num(raw.maxSizeMb, d.maxSizeMb, LOG_SIZE_RANGE.min, LOG_SIZE_RANGE.max),
    keep: num(raw.keep, d.keep, LOG_KEEP_RANGE.min, LOG_KEEP_RANGE.max),
  };
}

/** Values a new session starts with (New Session dialog). */
export type SessionDefaults = {
  transport: Transport;
  username: string;
  port: number;
  auth: 'auto' | 'password' | 'key' | 'agent';
  identityFile: string;
  /** Local shell; empty = $SHELL / PowerShell. */
  shell: string;
};

const DEFAULT_SESSION_DEFAULTS: SessionDefaults = {
  transport: 'ssh',
  username: 'root',
  port: 22,
  auth: 'auto',
  identityFile: '',
  shell: '',
};

const num = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const str = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

export function sanitizeTerminalPrefs(value: unknown): TerminalPrefs {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof TerminalPrefs, unknown>>;
  return {
    fontSize: num(raw.fontSize, DEFAULT_TERMINAL_PREFS.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max),
    scrollback: num(raw.scrollback, DEFAULT_TERMINAL_PREFS.scrollback, SCROLLBACK_RANGE.min, SCROLLBACK_RANGE.max),
    cursorBlink: typeof raw.cursorBlink === 'boolean' ? raw.cursorBlink : DEFAULT_TERMINAL_PREFS.cursorBlink,
    cursorStyle: raw.cursorStyle === 'bar' || raw.cursorStyle === 'underline' ? raw.cursorStyle : 'block',
    gutterTime: typeof raw.gutterTime === 'boolean' ? raw.gutterTime : DEFAULT_TERMINAL_PREFS.gutterTime,
    gutterLine: typeof raw.gutterLine === 'boolean' ? raw.gutterLine : DEFAULT_TERMINAL_PREFS.gutterLine,
    fontFamily: cleanFamily(raw.fontFamily),
    keyMode: raw.keyMode === 'remote' ? 'remote' : 'local',
  };
}

export function sanitizeSessionDefaults(value: unknown): SessionDefaults {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof SessionDefaults, unknown>>;
  const d = DEFAULT_SESSION_DEFAULTS;
  return {
    transport: isTransport(raw.transport) ? raw.transport : 'ssh',
    username: str(raw.username, d.username),
    port: num(raw.port, d.port, 1, 65535),
    auth: raw.auth === 'password' || raw.auth === 'key' || raw.auth === 'agent' ? raw.auth : 'auto',
    identityFile: str(raw.identityFile, d.identityFile),
    shell: str(raw.shell, d.shell),
  };
}
