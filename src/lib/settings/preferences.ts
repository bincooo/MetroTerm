/**
 * User preferences kept in ~/.metroterm/settings.json next to the theme
 * (Session → Preferences → Settings… / Default Session Settings…).
 */

import { t } from '../../i18n';
import type { ThemeMode, Transport } from '../../types';
import { isTransport } from '../sessions/transports';
import { fieldsOf } from './fields';

export type CursorShape = 'block' | 'bar' | 'underline';

/** Terminal options applied to every terminal (open ones update in place). */
export type TerminalPrefs = {
  fontSize: number;
  /** Lines kept above the screen. */
  scrollback: number;
  cursorBlink: boolean;
  /** Cursor shape (Settings → CURSOR); no cursor while the terminal is not focused. */
  cursorStyle: CursorShape;
  /** Terminal font family (Settings → FONTS); empty = the built-in stack (DejaVu Sans Mono, then Sarasa Mono SC, Source Code Pro … for what it lacks). */
  fontFamily: string;
  /** Bold text (SGR 1) drawn in the bold weight (Settings → FONTS → BOLD TEXT). Off: the regular weight; bold text keeps its bright colour. */
  boldText: boolean;
  /**
   * Mode menu → Local / Remote Mode. local: MetroTerm handles its shortcuts in the terminal
   * (Ctrl+C with a selection copies, Ctrl+V pastes, Ctrl+F finds, Alt+N …). remote: every key in the
   * terminal goes to the remote side as typed.
   */
  keyMode: KeyMode;
  /** Gutter left of the terminal: `[time]` column (View → Show Time). */
  gutterTime: boolean;
  /** Gutter left of the terminal: line-number column (View → Show Line Number). */
  gutterLine: boolean;
  /** Output highlighting: keywords, times, numbers … in a colour, full-screen programs included (View → Highlight Keywords). */
  highlight: boolean;
  /**
   * Terminal colour scheme per app theme (Settings → TERMINAL COLORS): the name of an iTerm2 scheme
   * in ~/.metroterm/themes/black (dark, gold) or …/white (light), without `.itermcolors` (lib/terminal/palettes).
   * '' = Default: that theme's own scheme (DEFAULT_COLOR_SCHEMES; the built-in palette if its file is gone).
   */
  colorSchemes: Record<ThemeMode, string>;
};
export const DEFAULT_COLOR_SCHEMES: Record<ThemeMode, string> = {
  dark: 'MetroTerm Dark',
  gold: 'MetroTerm Dark', // the dark and Gold themes share one default scheme
  light: 'MetroTerm Light',
};
/** A scheme name as stored: a plain file name (no path); '' (Default) for anything else and for the theme's own default. */
const schemeName = (value: unknown, mode: ThemeMode) => {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && !/[\\/\0]/.test(name) && name.length <= 200 && name !== DEFAULT_COLOR_SCHEMES[mode] ? name : '';
};
export type KeyMode = 'local' | 'remote';

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 13,
  scrollback: 10000,
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: '',
  boldText: false,
  keyMode: 'local',
  gutterTime: true,
  gutterLine: true,
  highlight: true,
  colorSchemes: { dark: '', gold: '', light: '' },
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

/**
 * Built-in font stacks: the terminal — DejaVu Sans Mono (Settings → TERMINAL FONT → Default), then
 * Sarasa Mono SC / Source Code Pro for CJK text and for systems without it — and the UI (styles/base.css
 * uses the same).
 */
export const TERMINAL_FONT_STACK =
  '"DejaVu Sans Mono", "Sarasa Mono SC", "Source Code Pro", "RobotoMono Nerd Font", Consolas, "SFMono-Regular", "Cascadia Mono", monospace';
export const UI_FONT_STACK = '"RobotoMono Nerd Font", "Cascadia Mono", "SFMono-Regular", Consolas, monospace';
/**
 * Interface font when none is chosen: Microsoft YaHei (微软雅黑) on Windows — the system's own UI
 * font there, with Chinese glyphs — and DejaVu Sans Mono on Linux and macOS (the built-in stack
 * behind it when it is not installed); other systems get the built-in stack alone. The font is
 * drawn by the browser / webview, so this is the browser's system (web mode included), not the
 * backend's.
 */
export const defaultUiFamily = () => {
  const agent = navigator.userAgent;
  if (/Windows/i.test(agent)) return 'Microsoft YaHei';
  // Android user agents say "Linux" too, iPhone / iPad ones "like Mac OS X".
  if (/Android|iPhone|iPad|iPod/i.test(agent)) return '';
  return /Macintosh|Mac OS X|Linux|X11/i.test(agent) ? 'DejaVu Sans Mono' : '';
};
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
export function sanitizeAppearance(value: unknown): AppearancePrefs {
  const raw = fieldsOf<AppearancePrefs>(value);
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
export function sanitizeProxy(value: unknown): ProxyPrefs {
  const raw = fieldsOf<ProxyPrefs>(value);
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
const DEFAULT_LOG: LogPrefs = { level: 'info', path: '', format: 'text', maxSizeMb: 10, keep: 3 };
export function sanitizeLog(value: unknown): LogPrefs {
  const raw = fieldsOf<LogPrefs>(value);
  const d = DEFAULT_LOG;
  return {
    level: LOG_LEVELS.includes(raw.level as LogLevel) ? (raw.level as LogLevel) : d.level,
    path: str(raw.path, d.path).trim(),
    format: raw.format === 'json' ? 'json' : 'text',
    maxSizeMb: num(raw.maxSizeMb, d.maxSizeMb, LOG_SIZE_RANGE.min, LOG_SIZE_RANGE.max),
    keep: num(raw.keep, d.keep, LOG_KEEP_RANGE.min, LOG_KEEP_RANGE.max),
  };
}

/**
 * Settings → MCP SERVER (settings.json `mcp`, read by the backend at start-up, applied live with
 * `mcp.configure`): the MCP server agent CLIs use to see and drive the other terminals (src-rust/src/mcp).
 */
export type McpPrefs = {
  enabled: boolean;
  /** 127.0.0.1:<port>. */
  port: number;
  /** Required by every request (Authorization: Bearer …). */
  token: string;
  /** Tools that type into terminals or open them; off = read-only (list, read, wait). */
  allowInput: boolean;
};
export const MCP_DEFAULT_PORT = 7690;
export const MCP_PORT_RANGE = { min: 1024, max: 65535 };
/** A new random access token (32 hex digits). */
export const newMcpToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
export function sanitizeMcp(value: unknown): McpPrefs {
  const raw = fieldsOf<McpPrefs>(value);
  const token = str(raw.token, '').trim();
  return {
    enabled: raw.enabled === true,
    port: num(raw.port, MCP_DEFAULT_PORT, MCP_PORT_RANGE.min, MCP_PORT_RANGE.max),
    token: /^[A-Za-z0-9._~-]{16,128}$/.test(token) ? token : '',
    allowInput: raw.allowInput !== false,
  };
}
/** What the backend reports (`mcp.status` / `mcp.configure`). */
export type McpStatus = { enabled: boolean; running: boolean; port: number; url: string | null; error: string | null; clients: number };

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
  const raw = fieldsOf<TerminalPrefs>(value);
  return {
    fontSize: num(raw.fontSize, DEFAULT_TERMINAL_PREFS.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max),
    scrollback: num(raw.scrollback, DEFAULT_TERMINAL_PREFS.scrollback, SCROLLBACK_RANGE.min, SCROLLBACK_RANGE.max),
    cursorBlink: typeof raw.cursorBlink === 'boolean' ? raw.cursorBlink : DEFAULT_TERMINAL_PREFS.cursorBlink,
    cursorStyle: raw.cursorStyle === 'bar' || raw.cursorStyle === 'underline' ? raw.cursorStyle : 'block',
    fontFamily: cleanFamily(raw.fontFamily),
    boldText: typeof raw.boldText === 'boolean' ? raw.boldText : DEFAULT_TERMINAL_PREFS.boldText,
    keyMode: raw.keyMode === 'remote' ? 'remote' : 'local',
    gutterTime: typeof raw.gutterTime === 'boolean' ? raw.gutterTime : DEFAULT_TERMINAL_PREFS.gutterTime,
    gutterLine: typeof raw.gutterLine === 'boolean' ? raw.gutterLine : DEFAULT_TERMINAL_PREFS.gutterLine,
    highlight: typeof raw.highlight === 'boolean' ? raw.highlight : DEFAULT_TERMINAL_PREFS.highlight,
    colorSchemes: (() => {
      const schemes = fieldsOf<Record<ThemeMode, string>>(raw.colorSchemes);
      return {
        dark: schemeName(schemes.dark, 'dark'),
        gold: schemeName(schemes.gold, 'gold'),
        light: schemeName(schemes.light, 'light'),
      };
    })(),
  };
}

export function sanitizeSessionDefaults(value: unknown): SessionDefaults {
  const raw = fieldsOf<SessionDefaults>(value);
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
