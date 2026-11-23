import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { TitleBarMode } from '../../components/dialogs/SettingsDialog';
import { isDesktop, windowFrame } from '../../lib/platform/tauri';
import { log } from '../../lib/platform/log';
import { isMacHost } from '../../lib/platform/hostOs';
import { t } from '../../i18n';
import { readSettings } from '../settingsDoc';

/** The app window: title bar style (Settings → TITLE BAR), maximized, full screen and always on top. */
export function useWindowFrame() {
  const [titleBar, setTitleBar] = useState<TitleBarMode>(() => (readSettings().titleBar === 'native' ? 'native' : 'frameless'));
  // The desktop window opens with the saved style already (src-rust/src/desktop.rs); this follows later changes.
  const firstTitleBar = useRef(true);
  useEffect(() => {
    if (firstTitleBar.current) {
      firstTitleBar.current = false;
      return;
    }
    void windowFrame.setNativeFrame(titleBar === 'native').catch(error => log.error(t('Title bar'), error));
  }, [titleBar]);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const sync = () => {
      void windowFrame
        .isMaximized()
        .then(value => {
          if (typeof value === 'boolean') setMaximized(value);
        })
        .catch(() => undefined);
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  // Mode → Full Screen / Always On Top: the window's current state (Focus Mode changes it too).
  const [fullScreen, setFullScreen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const syncWindowModes = useCallback(() => {
    if (!isDesktop()) {
      setFullScreen(Boolean(document.fullscreenElement));
      return;
    }
    void windowFrame
      .getState()
      .then(state => {
        if (!state) return;
        setFullScreen(Boolean(state.fullscreen));
        setAlwaysOnTop(Boolean(state.alwaysOnTop));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    syncWindowModes();
    window.addEventListener('resize', syncWindowModes);
    document.addEventListener('fullscreenchange', syncWindowModes);
    return () => {
      window.removeEventListener('resize', syncWindowModes);
      document.removeEventListener('fullscreenchange', syncWindowModes);
    };
  }, [syncWindowModes]);
  const minimizeWindow = async () => {
    if (!isDesktop()) {
      log(t('Minimize is only available in the desktop app'));
      return;
    }
    try {
      await windowFrame.minimize();
    } catch (error) {
      log.error(t('Cannot minimize'), error);
    }
  };
  /** Desktop: maximize ⇄ restore (macOS: full-screen Space ⇄ window, like the green button). Browser: full screen ⇄ window. */
  const toggleMaximize = async () => {
    if (!isDesktop()) {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        log(t('Full screen is not available here'));
      }
      window.setTimeout(() => setMaximized(Boolean(document.fullscreenElement)), 100);
      return;
    }
    try {
      const next = await windowFrame.toggleMaximize();
      if (typeof next === 'boolean') setMaximized(next);
      // macOS animates into / out of the full-screen Space: read the state again once it settled.
      if (isMacHost())
        window.setTimeout(() => {
          void windowFrame
            .isMaximized()
            .then(value => typeof value === 'boolean' && setMaximized(value))
            .catch(() => undefined);
        }, 900);
    } catch (error) {
      log.error(t('Cannot maximize'), error);
    }
  };
  /** macOS frameless title bar double-click: maximize ⇄ restore (zoom), like a native title bar. */
  const zoomWindow = async () => {
    try {
      await windowFrame.toggleZoom();
    } catch (error) {
      log.error(t('Cannot maximize'), error);
    }
  };
  /** Frameless title bar: drag the window from any empty part of it (not the buttons); double-click maximizes / restores. */
  const startWindowDrag = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.detail > 1 || (event.target as HTMLElement).closest('button, .window-controls')) return;
    // The move starts only once the pointer really moves: handing the pointer to the window manager
    // on the press itself would swallow the second click of a double-click.
    const x = event.screenX,
      y = event.screenY;
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    const move = (moveEvent: MouseEvent) => {
      if (!(moveEvent.buttons & 1)) {
        stop();
        return;
      }
      if (Math.abs(moveEvent.screenX - x) + Math.abs(moveEvent.screenY - y) < 4) return;
      stop();
      void windowFrame.startDragging().catch(() => undefined);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };
  const toggleFullScreen = async () => {
    try {
      if (!isDesktop()) {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
        return;
      }
      const next = !(await windowFrame.getState())?.fullscreen;
      await windowFrame.setState({ fullscreen: next });
      setFullScreen(next);
    } catch {
      log(t('Full screen is not available here'));
    }
  };
  const toggleAlwaysOnTop = async () => {
    try {
      const next = !(await windowFrame.getState())?.alwaysOnTop;
      await windowFrame.setState({ alwaysOnTop: next });
      setAlwaysOnTop(next);
      log(next ? t('Always on top') : t('Always on top off'));
    } catch (error) {
      log.error(t('Cannot change always on top'), error);
    }
  };
  return {
    titleBar,
    setTitleBar,
    maximized,
    fullScreen,
    alwaysOnTop,
    syncWindowModes,
    minimizeWindow,
    toggleMaximize,
    zoomWindow,
    startWindowDrag,
    toggleFullScreen,
    toggleAlwaysOnTop,
  };
}
