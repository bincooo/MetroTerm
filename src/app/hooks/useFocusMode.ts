import { useRef, useState } from 'react';
import type { TitleBarMode } from '../../components/dialogs/SettingsDialog';
import { isDesktop, windowFrame, type WindowState } from '../../lib/platform/tauri';
import { keyHint } from '../../lib/settings/keybindings';
import { sanitizeFocusConfig, type FocusConfig } from '../../lib/workspace/focusMode';
import { log } from '../../lib/platform/log';
import { t } from '../../i18n';
import { readSettings } from '../settingsDoc';

/**
 * Focus Mode (menu bar → Focus Mode, Ctrl+Shift+F; settings.json → focus): the window state it
 * sets and restores. The layout part (which panels stay) is in App.
 */
export function useFocusMode(titleBar: TitleBarMode, syncWindowModes: () => void) {
  const [focusConfig, setFocusConfig] = useState(() => sanitizeFocusConfig(readSettings().focus));
  const [focusActive, setFocusActive] = useState(false);
  const [focusDialog, setFocusDialog] = useState(false);
  /** Window state before Focus Mode, restored when it ends. */
  const focusRestore = useRef<WindowState | null>(null);
  const applyFocusWindow = async (config: FocusConfig, entering: boolean) => {
    if (isDesktop()) {
      if (entering && !focusRestore.current) focusRestore.current = (await windowFrame.getState()) ?? null;
      const before = focusRestore.current ?? {};
      await windowFrame.setState({
        decorated: false,
        maximized: true,
        fullscreen: config.fullScreen === 'preserve' ? before.fullscreen : config.fullScreen === 'yes',
        alwaysOnTop: config.alwaysOnTop === 'preserve' ? before.alwaysOnTop : config.alwaysOnTop === 'yes',
      });
      return;
    }
    // Browser: full screen through the Fullscreen API (needs the click / key press that started it).
    const full = Boolean(document.fullscreenElement);
    if (entering && !focusRestore.current) focusRestore.current = { fullscreen: full };
    const want = config.fullScreen === 'preserve' ? (focusRestore.current?.fullscreen ?? full) : config.fullScreen === 'yes';
    if (want && !full) await document.documentElement.requestFullscreen?.().catch(() => undefined);
    else if (!want && full) await document.exitFullscreen?.().catch(() => undefined);
  };
  const enterFocus = (config: FocusConfig) => {
    setFocusConfig(config);
    setFocusDialog(false);
    setFocusActive(true);
    void applyFocusWindow(config, true)
      .catch(error => log.error(t('Focus Mode'), error))
      .finally(syncWindowModes);
    const leaveKeys = keyHint('focusMode');
    log(leaveKeys ? t('Focus Mode on — {{keys}} to leave', { keys: leaveKeys }) : t('Focus Mode on'));
  };
  const exitFocus = () => {
    const before = focusRestore.current;
    focusRestore.current = null;
    setFocusActive(false);
    if (isDesktop()) {
      void windowFrame
        .setState({
          fullscreen: before?.fullscreen ?? false,
          maximized: before?.maximized ?? false,
          decorated: before?.decorated ?? titleBar === 'native',
          alwaysOnTop: before?.alwaysOnTop ?? false,
        })
        .catch(error => log.error(t('Focus Mode'), error))
        .finally(syncWindowModes);
    } else if (document.fullscreenElement && !before?.fullscreen) void document.exitFullscreen?.().catch(() => undefined);
    log(t('Focus Mode off'));
  };
  const startFocus = () => {
    if (focusConfig.showDialog) setFocusDialog(true);
    else enterFocus(focusConfig);
  };
  const toggleFocus = () => {
    if (focusActive) exitFocus();
    else startFocus();
  };
  return {
    focusConfig,
    setFocusConfig,
    focusActive,
    focusDialog,
    setFocusDialog,
    applyFocusWindow,
    enterFocus,
    exitFocus,
    toggleFocus,
  };
}
