import { useSyncExternalStore } from 'react';
import type { CursorInfo } from '../components/terminal/TerminalView';
import { t } from '../i18n';

/**
 * The status bar's Window cols×rows and Ln, Ch of the visible terminal. Reported on every cursor
 * move / line feed, so it is kept out of App state: only <StatusCursor> re-renders, once a frame.
 */
export const cursorStore = (() => {
  let value: (CursorInfo & { tabId: string }) | null = null;
  let frame = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: CursorInfo & { tabId: string }) {
      value = next;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        listeners.forEach(listener => listener());
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

export function StatusCursor({ tabId }: { tabId: string }) {
  const info = useSyncExternalStore(cursorStore.subscribe, cursorStore.get);
  if (!info || info.tabId !== tabId) return null;
  return (
    <>
      <span>{t('Window {{cols}}×{{rows}}', { cols: info.cols, rows: info.rows })}</span>
      <span>
        Ln {info.line}, Ch {info.column}
      </span>
    </>
  );
}
