import { useEffect } from 'react';
import type { TerminalTab, ThemeMode } from '../../types';
import type { TitleBarMode } from '../../components/dialogs/SettingsDialog';
import { writeConfig } from '../../lib/platform/config';
import { keyBindingOverrides, type KeyBindings } from '../../lib/settings/keybindings';
import { hasLockPassword, sanitizeLockSettings, type LockSettings } from '../../lib/settings/lockScreen';
import type { AppearancePrefs, LogPrefs, McpPrefs, ProxyPrefs, SessionDefaults, TerminalPrefs } from '../../lib/settings/preferences';
import type { SessionFolder } from '../../lib/sessions/tree';
import type { FocusConfig } from '../../lib/workspace/focusMode';
import { windowsDoc, type WorkWindow } from '../../lib/workspace/windows';
import type { Language } from '../../i18n';
import { collectLeaves } from '../helpers';
import type { ExplorerDoc, ManagedConnection, SessionsDoc } from '../sessionsDoc';
import type { PaneId, SettingsDoc } from '../settingsDoc';

/** Everything App saves in settings.json. */
type PersistedSettings = {
  theme: ThemeMode;
  language: Language;
  titleBar: TitleBarMode;
  swatches: Record<PaneId, string>;
  recent: string[];
  terminalPrefs: TerminalPrefs;
  sessionDefaults: SessionDefaults;
  lockSettings: LockSettings;
  locked: boolean;
  focusConfig: FocusConfig;
  appearance: AppearancePrefs;
  proxy: ProxyPrefs;
  logPrefs: LogPrefs;
  keyBindings: KeyBindings;
  mcpPrefs: McpPrefs;
};

/** Persist configuration to ~/.metroterm (windows.json · settings.json · sessions.json · explorer.json) on every change. */
export function usePersistence({
  windows,
  allTabs,
  windowId,
  connections,
  folders,
  explorerFolds,
  settings,
}: {
  windows: WorkWindow[];
  allTabs: TerminalTab[];
  windowId: string;
  connections: ManagedConnection[];
  folders: SessionFolder[];
  explorerFolds: Record<string, Record<string, boolean>>;
  settings: PersistedSettings;
}) {
  const {
    theme,
    language,
    titleBar,
    swatches,
    recent,
    terminalPrefs,
    sessionDefaults,
    lockSettings,
    locked,
    focusConfig,
    appearance,
    proxy,
    logPrefs,
    keyBindings,
    mcpPrefs,
  } = settings;
  useEffect(() => {
    writeConfig('windows', windowsDoc(windows, allTabs, windowId));
  }, [windows, allTabs, windowId]);
  useEffect(() => {
    // The locked state is kept only with a password (a lock without one is just a cover).
    const lock = sanitizeLockSettings({ ...lockSettings, locked: locked && hasLockPassword(lockSettings) });
    writeConfig('settings', {
      version: 1,
      theme,
      language,
      titleBar,
      swatches,
      recent,
      terminal: terminalPrefs,
      sessionDefaults,
      lock,
      focus: focusConfig,
      appearance,
      proxy,
      log: logPrefs,
      keys: keyBindingOverrides(keyBindings),
      mcp: mcpPrefs,
    } satisfies SettingsDoc);
  }, [
    theme,
    language,
    titleBar,
    swatches,
    recent,
    terminalPrefs,
    sessionDefaults,
    lockSettings,
    locked,
    focusConfig,
    appearance,
    proxy,
    logPrefs,
    keyBindings,
    mcpPrefs,
  ]);
  useEffect(() => {
    const sessions = connections.map(({ status: _status, ...config }) => config);
    writeConfig('sessions', { version: 4, folders, sessions } satisfies SessionsDoc);
  }, [connections, folders]);
  useEffect(() => {
    // Only panels (of any window) that still show an Explorer and folders that still exist.
    const panels = new Set(
      windows
        .flatMap(item => collectLeaves(item.layout))
        .filter(leaf => (leaf.tabs ?? []).includes('explorer'))
        .map(leaf => leaf.id),
    );
    const ids = new Set(folders.map(folder => folder.id));
    const kept = Object.fromEntries(
      Object.entries(explorerFolds)
        .filter(([panel]) => panels.has(panel))
        .map(([panel, folds]) => [panel, Object.fromEntries(Object.entries(folds).filter(([id]) => ids.has(id)))]),
    );
    writeConfig('explorer', { panels: kept } satisfies ExplorerDoc);
  }, [explorerFolds, windows, folders]);
}
