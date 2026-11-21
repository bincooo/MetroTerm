/** True inside the Tauri desktop app. Backend calls go through src/lib/backend.ts. */
export const isDesktop = () => Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

/**
 * Session → Close Window / Exit. Desktop: closes the window / ends the app (Rust commands in
 * src-rust/src/desktop.rs). Browser: a page may only close a tab that a script opened, so this
 * usually does nothing there; returns false when the page is still open afterwards.
 */
export async function closeApp(kind: 'window' | 'exit'): Promise<boolean> {
  if (isDesktop()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(kind === 'window' ? 'close_window' : 'exit_app');
    return true;
  }
  window.close();
  await new Promise(resolve => window.setTimeout(resolve, 150));
  return window.closed;
}

/**
 * Page and window background for the theme. html/body get the theme colour (the browser paints
 * them in the area uncovered while the window is resized); the desktop app also sets the native
 * window/webview background (src-rust/src/desktop.rs), which shows before the page repaints.
 */
export function applyWindowBackground(theme: 'dark' | 'light' | 'gold') {
  const root = document.documentElement;
  root.classList.toggle('theme-light', theme === 'light');
  root.classList.toggle('theme-dark', theme !== 'light');
  root.classList.toggle('theme-gold', theme === 'gold');
  if (isDesktop())
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('set_window_background', { dark: theme !== 'light' }))
      .catch(() => undefined);
}

/** Desktop window frame (Rust commands in src-rust/src/desktop.rs). In the browser these do nothing. */
async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!isDesktop()) return undefined;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}
export const windowFrame = {
  minimize: () => invokeDesktop<void>('window_minimize'),
  /** Returns whether the window is maximized afterwards. */
  toggleMaximize: () => invokeDesktop<boolean>('window_toggle_maximize'),
  isMaximized: () => invokeDesktop<boolean>('window_is_maximized'),
  startDragging: () => invokeDesktop<void>('window_start_dragging'),
  setTitle: (title: string) => invokeDesktop<void>('window_set_title', { title }),
  setNativeFrame: (native: boolean) => invokeDesktop<void>('window_set_native_frame', { native }),
  /** Focus Mode: read / apply the window state (desktop only; undefined in the browser). */
  getState: () => invokeDesktop<WindowState>('window_get_state'),
  setState: (state: WindowState) => invokeDesktop<void>('window_set_state', { state }),
};
export type WindowState = { maximized?: boolean; fullscreen?: boolean; decorated?: boolean; alwaysOnTop?: boolean; opacity?: number };
