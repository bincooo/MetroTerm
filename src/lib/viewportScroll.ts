import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * Called when the visible part of the buffer moves because of the viewport — dragging the
 * scrollbar, the wheel, Shift+PageUp … (xterm's own `onScroll` is *not* fired for those: the
 * viewport scrolls with `suppressScrollEvent`). xterm handles the DOM scroll event first (its
 * listener was added in `open`), so `buffer.viewportY` is already the new line here, and xterm's
 * render for it is still pending (next animation frame): decorations registered now are drawn in
 * that same render, together with the rows.
 */
export function onViewportScroll(terminal: Terminal, callback: () => void): IDisposable {
  const viewport = terminal.element?.querySelector<HTMLElement>('.xterm-viewport');
  if (!viewport)
    return {
      dispose() {
        /* not opened */
      },
    };
  let last = terminal.buffer.active.viewportY;
  const listener = () => {
    const now = terminal.buffer.active.viewportY;
    if (now === last) return;
    last = now;
    callback();
  };
  viewport.addEventListener('scroll', listener, { passive: true });
  return { dispose: () => viewport.removeEventListener('scroll', listener) };
}
