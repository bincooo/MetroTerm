/**
 * settings.json (~/.metroterm/settings.json, see src/lib/platform/config.ts): its shape, and the
 * panel title swatches kept in it.
 */
import type { ThemeMode } from '../types';
import type { TitleBarMode } from '../components/dialogs/SettingsDialog';
import type { AppearancePrefs, LogPrefs, McpPrefs, ProxyPrefs, SessionDefaults, TerminalPrefs } from '../lib/settings/preferences';
import type { KeyBindings } from '../lib/settings/keybindings';
import type { LockSettings } from '../lib/settings/lockScreen';
import type { FocusConfig } from '../lib/workspace/focusMode';
import type { Language } from '../i18n';
import { readConfig } from '../lib/platform/config';

export type SettingsDoc = {
  version: 1;
  theme: ThemeMode;
  titleBar?: TitleBarMode;
  swatches: Record<PaneId, string>;
  recent?: string[];
  terminal?: TerminalPrefs;
  sessionDefaults?: SessionDefaults;
  lock?: LockSettings;
  focus?: FocusConfig;
  /** Settings → WINDOW OPACITY / FONTS (interface font). */
  appearance?: AppearancePrefs;
  /** Settings → LANGUAGE: 'en' (default) | 'zh'. */
  language?: Language;
  /** Session → Proxy… (read by the backend for SSH / Telnet / TCP). */
  proxy?: ProxyPrefs;
  /** Session → Log… (read by the backend at start-up, applied live with `log.configure`). */
  log?: LogPrefs;
  /** Preferences → Keyboard Shortcuts…: only the bindings changed from the defaults ('' = none). */
  keys?: Partial<KeyBindings>;
  /** Settings → MCP SERVER (read by the backend at start-up, applied live with `mcp.configure`). */
  mcp?: McpPrefs;
};
/** Session menu → Open Recent: most recently opened session configs (ids), newest first. */
export const RECENT_MAX = 10;
export const readSettings = () => readConfig<Partial<SettingsDoc>>('settings') ?? {};

// Panel title swatches: one random color per panel type, generated once and saved in
// settings.json so it stays stable across restarts. Hues are spread apart so panels differ;
// saturation / lightness are kept moderate to sit well on both dark and light themes.
export type PaneId = 'explorer' | 'filer' | 'sender' | 'sessions' | 'monitor';
export function initialSwatches(): Record<PaneId, string> {
  const saved = readSettings().swatches;
  if (saved?.explorer && saved.filer && saved.sender && saved.sessions && saved.monitor) return saved as Record<PaneId, string>;
  const start = Math.random() * 360;
  const ids: PaneId[] = ['explorer', 'filer', 'sender', 'sessions', 'monitor'];
  const colors = Object.fromEntries(
    ids.map((id, index) => {
      const hue = Math.round((start + index * (72 + Math.random() * 20 - 10)) % 360);
      const saturation = Math.round(45 + Math.random() * 20);
      const lightness = Math.round(52 + Math.random() * 10);
      return [id, `hsl(${hue} ${saturation}% ${lightness}%)`];
    }),
  ) as Record<PaneId, string>;
  return colors;
}
