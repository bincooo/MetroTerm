import { isDesktop } from '../platform/tauri';

/**
 * Files dragged in from the system's file manager.
 *
 * - Desktop: Tauri's `onDragDropEvent` (paths + position; WebKitGTK gives the page no File objects).
 * - Browser: the page's own drag events (File objects, no paths).
 *
 * The element under the pointer with (or inside) `data-file-drop` gets `is-file-over`, a shared
 * overlay showing its `data-file-drop-label`, and a bubbling `metroterm:file-drop` event on drop.
 *
 * Tauri calls the position "physical", but only WebView2 reports device pixels; WebKitGTK / WKWebView
 * report CSS pixels. The page's own `dragover` coordinates win when available (exact).
 * The mask never outlives the drag: leaving the window, Esc, a drop or any mouse move (none happen
 * during an OS drag) hides it; in the browser also missing dragover (sent every ~50 ms).
 */
export type FileDrop = { paths: string[]; files: File[] };
export const FILE_DROP_EVENT = 'metroterm:file-drop';

let installed = false;
let hovered: HTMLElement | null = null;

let overlay: HTMLDivElement | null = null;

const targetAt = (x: number, y: number) => {
  const under = document.elementFromPoint(x, y);
  // The overlay itself ignores the pointer (pointer-events: none), so this finds the target under it.
  return under?.closest<HTMLElement>('[data-file-drop]') ?? null;
};
/** Show the overlay over `target` (null: hide it). */
const cover = (target: HTMLElement | null) => {
  if (!target) {
    if (overlay) overlay.hidden = true;
    return;
  }
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'file-drop-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.append(document.createElement('span'));
  }
  // In the app shell (theme class, fonts); on top of panels, tmux splitters and the terminal.
  const host = document.querySelector('.metroterm-shell') ?? document.body;
  if (overlay.parentElement !== host) host.append(overlay);
  const box = target.getBoundingClientRect();
  Object.assign(overlay.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  overlay.firstElementChild!.textContent = target.dataset.fileDropLabel ?? '';
  overlay.hidden = false;
};
const hover = (target: HTMLElement | null) => {
  if (target === hovered) return;
  hovered?.classList.remove('is-file-over');
  hovered = target;
  hovered?.classList.add('is-file-over');
  cover(target);
};
const deliver = (target: HTMLElement | null, detail: FileDrop) => {
  hover(null);
  if (target && (detail.paths.length || detail.files.length))
    target.dispatchEvent(new CustomEvent<FileDrop>(FILE_DROP_EVENT, { detail, bubbles: true }));
};

/** Safari-like WebKit: every dragleave has a null relatedTarget, even between two elements. */
const nullRelatedTarget = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
const outside = (event: DragEvent) =>
  !nullRelatedTarget ||
  event.clientX <= 0 ||
  event.clientY <= 0 ||
  event.clientX >= window.innerWidth - 1 ||
  event.clientY >= window.innerHeight - 1;

/** A drag that is over cannot leave its mask behind (see the header). */
const installSafetyNets = () => {
  const clear = () => {
    if (hovered) hover(null);
  };
  window.addEventListener('mousemove', clear, { capture: true, passive: true });
  window.addEventListener('mousedown', clear, true);
  window.addEventListener('blur', clear);
  window.addEventListener('keydown', event => event.key === 'Escape' && clear(), true);
  window.addEventListener('dragend', clear, true);
  return clear;
};

/** Start listening (once, at startup). */
export function installFileDrop() {
  if (installed) return;
  installed = true;
  const clear = installSafetyNets();
  // Capture phase on window: an element stopping a drag event's propagation cannot hide it from us.
  if (isDesktop()) {
    // Windows (WebView2) reports device pixels; WebKitGTK / WKWebView already report CSS pixels.
    const scale = /Windows/i.test(navigator.userAgent) ? () => window.devicePixelRatio || 1 : () => 1;
    let dragging = false;
    /** The page's own dragover (exact CSS coordinates), when the webview sends it. */
    let page: { x: number; y: number; at: number } | null = null;
    const fresh = () => (page && performance.now() - page.at < 250 ? page : null);
    window.addEventListener(
      'dragover',
      event => {
        if (!dragging) return;
        event.preventDefault();
        page = { x: event.clientX, y: event.clientY, at: performance.now() };
        hover(targetAt(event.clientX, event.clientY));
      },
      true,
    );
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(event => {
          const payload = event.payload;
          if (payload.type === 'leave') {
            dragging = false;
            page = null;
            clear();
            return;
          }
          dragging = payload.type !== 'drop';
          const known = fresh();
          const target = known ? targetAt(known.x, known.y) : targetAt(payload.position.x / scale(), payload.position.y / scale());
          if (payload.type === 'drop') {
            page = null;
            deliver(target, { paths: payload.paths, files: [] });
          } else if (!known) hover(target);
        }),
      )
      .catch(() => undefined);
    return;
  }
  const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
  let idle = 0;
  window.addEventListener(
    'dragover',
    event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const target = targetAt(event.clientX, event.clientY);
      event.dataTransfer!.dropEffect = target ? 'copy' : 'none';
      hover(target);
      window.clearTimeout(idle);
      idle = window.setTimeout(clear, 600);
    },
    true,
  );
  window.addEventListener(
    'dragleave',
    event => {
      // Left the page. WebKit gives every dragleave a null relatedTarget, so also check the pointer is at the edge.
      if (!event.relatedTarget && outside(event)) clear();
    },
    true,
  );
  window.addEventListener(
    'drop',
    event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      window.clearTimeout(idle);
      deliver(targetAt(event.clientX, event.clientY), { paths: [], files: Array.from(event.dataTransfer!.files) });
    },
    true,
  );
}

/**
 * A path as a shell word: unchanged when it only has safe characters, otherwise quoted —
 * `"…"` for Windows shells, POSIX single quotes everywhere else.
 */
export function shellQuote(path: string, windows = false): string {
  if ((windows ? /^[\w@%+=:,./\\~-]+$/ : /^[\w@%+=:,./~-]+$/).test(path)) return path;
  if (windows) return `"${path.replace(/"/g, '""')}"`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
