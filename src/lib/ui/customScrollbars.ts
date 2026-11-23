/**
 * Custom scrollbars drawn by the app instead of the browser.
 *
 * `::-webkit-scrollbar` styling is ignored by Firefox, and macOS / GTK overlay scrollbars
 * keep their own thin look, so CSS alone cannot guarantee one design everywhere. This module
 * hides the native scrollbar of every known scrolling area and draws its own square
 * track + thumb on top, positioned with `position: fixed` in one layer under <body>.
 *
 * - Supports vertical and horizontal bars, thumb dragging, paging by clicking the track and
 *   the mouse wheel over the bar.
 * - Geometry is refreshed on scroll, element/content resize, DOM changes, window resize and
 *   theme changes. Bars disappear when their element is hidden or removed.
 * - The z-index follows the element's stacking (menus, dialogs) so bars stay on their surface.
 * - Sizes and colours come from CSS variables (`--sb-*`), see styles/controls.css.
 */

/** Scrolling areas that get a custom scrollbar. Add `data-scrollbar` to opt in anything else. */
const SCROLL_SELECTOR = [
  '.tree-list',
  '.filer-list',
  '.file-dest-list',
  '.sender-editor textarea',
  '.ui-select-menu',
  '.command-palette-list',
  // Dialogs (New / Properties, Settings, password prompts, Filer and Explorer dialogs) scroll as a
  // whole when the window is too low for them.
  '.connection-dialog',
  // The terminal's scrollback (xterm scrolls `.xterm-viewport`; FitAddon keeps its right edge free).
  '.xterm-viewport',
  '[data-scrollbar]',
].join(', ');

const SHELL_SELECTOR = '.metroterm-shell';
/** Bars of areas on the main surface: above the panels' content (z ≤ 1), below split handles (4) and
 *  in-panel overlays (Filer file dialog 5), which therefore keep covering them. */
const DEFAULT_Z = 3;
const MIN_THUMB = 32;

type Axis = 'y' | 'x';

interface AxisParts {
  track: HTMLDivElement;
  thumb: HTMLDivElement;
  /** Track length and thumb length/offset from the last update, used while dragging. */
  trackLength: number;
  thumbLength: number;
  visible: boolean;
  /** Scroll size / viewport size of the last full update: a scroll with the same ones only moves the thumb. */
  content: number;
  viewport: number;
  /** Thumb offset last written (transform), to skip identical writes. */
  offset: number;
}

function px(value: string, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Highest explicit z-index on the element or its ancestors (the surface it lives on). */
function surfaceZ(el: Element) {
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    const z = getComputedStyle(node).zIndex;
    if (z !== 'auto' && Number.isFinite(Number(z)) && Number(z) > 1) return Number(z) + 1;
  }
  return DEFAULT_Z;
}

/** Height of a header pinned to the top of the scroll area (e.g. the Filer column header). */
function stickyHeaderHeight(el: HTMLElement) {
  for (const child of Array.from(el.children).slice(0, 3)) {
    const cs = getComputedStyle(child);
    if (cs.position === 'sticky' && cs.top !== 'auto' && px(cs.top) === 0) return child.getBoundingClientRect().height;
  }
  return 0;
}
/** Same at the bottom: a sticky footer (a dialog's button row) — the vertical bar ends above it. */
function stickyFooterHeight(el: HTMLElement) {
  for (const child of Array.from(el.children).slice(-2)) {
    const cs = getComputedStyle(child);
    if (cs.position === 'sticky' && cs.bottom !== 'auto' && px(cs.bottom) === 0) return child.getBoundingClientRect().height;
  }
  return 0;
}

/** Track → the element it scrolls. The bars live in one layer under <body>, outside their element. */
const trackOwners = new WeakMap<Element, HTMLElement>();

/**
 * The node a press "happened on" for outside-click checks: a press on a custom scrollbar counts as a
 * press on the element it scrolls (otherwise clicking a popup's own scrollbar would close the popup).
 */
export function pressTarget(event: Event): Node | null {
  const target = event.target;
  if (!(target instanceof Element)) return target instanceof Node ? target : null;
  const track = target.closest('.sb-track');
  return (track && trackOwners.get(track)) || target;
}

/**
 * WebKit (macOS WKWebView, Safari, WebKitGTK) decides whether a scrollbar is the system one or one
 * styled by `::-webkit-scrollbar` (here: hidden) when it creates it, and keeps that decision. An
 * area that already overflowed before it got `sb-custom` — the Filer list with wide saved columns
 * has its horizontal bar from the very first layout — kept the system bar under the custom one on
 * macOS. Turning overflow off and on again makes the engine drop its scrollbars and create them anew
 * with the current style. Only areas that overflow have a scrollbar to replace; the scroll position
 * is put back. Chromium / Firefox restyle existing scrollbars anyway, for them this changes nothing.
 */
function recreateNativeScrollbars(el: HTMLElement) {
  if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) return;
  const { scrollTop, scrollLeft } = el;
  const inline = el.getAttribute('style');
  el.style.setProperty('overflow', 'hidden', 'important');
  void el.offsetWidth; // layout without scrollbars
  if (inline === null) el.removeAttribute('style');
  else el.setAttribute('style', inline);
  void el.offsetWidth; // and with new ones
  if (el.scrollTop !== scrollTop) el.scrollTop = scrollTop;
  if (el.scrollLeft !== scrollLeft) el.scrollLeft = scrollLeft;
}

class CustomScrollbar {
  readonly el: HTMLElement;
  private readonly parts: Record<Axis, AxisParts>;
  private readonly resize: ResizeObserver;
  private readonly cleanups: Array<() => void> = [];
  private drag: { axis: Axis; start: number; startScroll: number; pointerId: number } | null = null;
  private scrollFrame = 0;
  /** z-index of the surface the area lives on, re-read on full updates (not on every scroll step). */
  private z = '';

  constructor(el: HTMLElement, layer: HTMLElement) {
    this.el = el;
    el.classList.add('sb-custom');
    recreateNativeScrollbars(el);
    this.parts = { y: this.makeAxis('y', layer), x: this.makeAxis('x', layer) };

    const update = () => this.update();
    // Scrolling: one geometry update per frame, however many scroll events arrive (a fast wheel or
    // trackpad fires several per frame; each update reads layout and styles).
    this.listen(el, 'scroll', () => this.scheduleScrollUpdate(), { passive: true });
    this.listen(el, 'input', update);
    this.listen(el, 'pointerenter', () => this.setNear(true));
    this.listen(el, 'pointerleave', () => this.setNear(false));

    this.resize = new ResizeObserver(update);
    this.resize.observe(el);
    // Content growth (new terminal lines, longer lists) shows up as a size change of the children.
    for (const child of Array.from(el.children).slice(0, 2)) this.resize.observe(child);
    this.update();
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, handler as EventListener, options);
    this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
  }

  private makeAxis(axis: Axis, layer: HTMLElement): AxisParts {
    const track = document.createElement('div');
    track.className = `sb-track sb-${axis}`;
    track.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'sb-thumb';
    track.appendChild(thumb);
    layer.appendChild(track);
    trackOwners.set(track, this.el);
    const parts: AxisParts = { track, thumb, trackLength: 0, thumbLength: 0, visible: false, content: 0, viewport: 0, offset: -1 };

    this.listen(thumb, 'pointerdown', event => this.startDrag(axis, event));
    this.listen(track, 'pointerdown', event => this.page(axis, event));
    this.listen(track, 'wheel', event => this.wheel(event), { passive: false });
    this.listen(track, 'pointerenter', () => this.setNear(true));
    this.listen(track, 'pointerleave', () => this.setNear(false));
    // Keep the custom context menu / focus behaviour of the app away from the bar.
    this.listen(track, 'contextmenu', event => event.preventDefault());
    return parts;
  }

  private setNear(near: boolean) {
    this.parts.y.track.classList.toggle('is-near', near);
    this.parts.x.track.classList.toggle('is-near', near);
  }

  private startDrag(axis: Axis, event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const { thumb, track } = this.parts[axis];
    thumb.setPointerCapture(event.pointerId);
    track.classList.add('is-dragging');
    document.body.classList.add('is-scrollbar-dragging');
    this.drag = {
      axis,
      start: axis === 'y' ? event.clientY : event.clientX,
      startScroll: axis === 'y' ? this.el.scrollTop : this.el.scrollLeft,
      pointerId: event.pointerId,
    };
    const move = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      const p = this.parts[this.drag.axis];
      const range = this.drag.axis === 'y' ? this.el.scrollHeight - this.el.clientHeight : this.el.scrollWidth - this.el.clientWidth;
      const free = Math.max(1, p.trackLength - p.thumbLength);
      const delta = (this.drag.axis === 'y' ? e.clientY : e.clientX) - this.drag.start;
      const next = Math.min(range, Math.max(0, this.drag.startScroll + delta * (range / free)));
      // Nothing to do while the pointer moves within the same pixel of scroll position.
      const current = this.drag.axis === 'y' ? this.el.scrollTop : this.el.scrollLeft;
      if (Math.abs(next - current) < 0.5) return;
      if (this.drag.axis === 'y') this.el.scrollTop = next;
      else this.el.scrollLeft = next;
      // The thumb follows the pointer in this frame (no wait for the scroll event's update).
      if (p.content) this.placeThumb(this.drag.axis, next);
    };
    const end = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      track.classList.remove('is-dragging');
      document.body.classList.remove('is-scrollbar-dragging');
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', end);
      thumb.removeEventListener('pointercancel', end);
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', end);
    thumb.addEventListener('pointercancel', end);
  }

  /** Clicking the empty track scrolls one page towards the pointer. */
  private page(axis: Axis, event: PointerEvent) {
    if (event.button !== 0 || event.target !== this.parts[axis].track) return;
    event.preventDefault();
    const thumbRect = this.parts[axis].thumb.getBoundingClientRect();
    const before = axis === 'y' ? event.clientY < thumbRect.top : event.clientX < thumbRect.left;
    const pageSize = (axis === 'y' ? this.el.clientHeight : this.el.clientWidth) * 0.9;
    this.el.scrollBy(axis === 'y' ? { top: before ? -pageSize : pageSize } : { left: before ? -pageSize : pageSize });
  }

  private wheel(event: WheelEvent) {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.el.clientHeight : 1;
    const dx = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
    const dy = (event.shiftKey ? 0 : event.deltaY) * unit;
    this.el.scrollBy({ left: dx, top: dy });
  }

  private scheduleScrollUpdate() {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      if (!this.moveThumbs()) this.update(false);
    });
  }

  /**
   * Scroll only (same scroll size and viewport as at the last full update): move the thumbs and
   * nothing else. The full update reads the element's rect and computed style and rewrites the
   * track's position — on every scroll frame that cost a forced style/layout pass, the main part of
   * the lag when dragging a long list's scrollbar in WebKitGTK. Returns false when a full update
   * is needed.
   */
  private moveThumbs() {
    const el = this.el;
    const { y, x } = this.parts;
    if (y.visible && (el.scrollHeight !== y.content || el.clientHeight !== y.viewport)) return false;
    if (x.visible && (el.scrollWidth !== x.content || el.clientWidth !== x.viewport)) return false;
    if (!y.visible && !x.visible) return false;
    if (y.visible) this.placeThumb('y', el.scrollTop);
    if (x.visible) this.placeThumb('x', el.scrollLeft);
    return true;
  }

  private placeThumb(axis: Axis, position: number) {
    const p = this.parts[axis];
    const dpr = window.devicePixelRatio || 1;
    const range = Math.max(1, p.content - p.viewport);
    const offset = Math.round((p.trackLength - p.thumbLength) * Math.min(1, Math.max(0, position / range)) * dpr) / dpr;
    if (offset === p.offset) return;
    p.offset = offset;
    p.thumb.style.transform = axis === 'y' ? `translate(0, ${offset}px)` : `translate(${offset}px, 0)`;
  }

  update(full = true) {
    const el = this.el;
    // A popup fading out (lib/ui/popupMotion) drops its bar right away instead of leaving it on screen.
    if (!el.isConnected || el.closest('.is-leaving')) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const shown = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    const scrollableY = /(auto|scroll)/.test(style.overflowY);
    const scrollableX = /(auto|scroll)/.test(style.overflowX);
    const hasY = shown && scrollableY && el.scrollHeight - el.clientHeight > 1;
    const hasX = shown && scrollableX && el.scrollWidth - el.clientWidth > 1;
    // Reserving the bar's space grows the scroll range; stay pinned to the end if we were there.
    const atBottom = el.scrollTop > 0 && el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
    const atRight = el.scrollLeft > 0 && el.scrollWidth - el.clientWidth - el.scrollLeft <= 2;
    const changed = el.classList.contains('sb-has-y') !== hasY || el.classList.contains('sb-has-x') !== hasX;
    el.classList.toggle('sb-has-y', hasY);
    el.classList.toggle('sb-has-x', hasX);
    // Typing / pasting at the end of the Sender: the caret was revealed before the space was reserved.
    const caretAtEnd = el instanceof HTMLTextAreaElement && document.activeElement === el && el.selectionEnd === el.value.length;
    if (changed) {
      if (atBottom || caretAtEnd) el.scrollTop = el.scrollHeight;
      if (atRight) el.scrollLeft = el.scrollWidth;
    }

    const size = px(style.getPropertyValue('--sb-size'), 14);
    const insetTop = style.getPropertyValue('--sb-inset-top').trim()
      ? px(style.getPropertyValue('--sb-inset-top'))
      : stickyHeaderHeight(el);
    const insetBottom = stickyFooterHeight(el);
    // Exact (fractional) geometry. clientWidth / clientHeight / clientLeft are rounded to whole
    // pixels and drift up to a pixel from the element's real edges, so use the rect and borders.
    const box = el.getBoundingClientRect(); // re-measured: the reserved border was just toggled
    const bl = px(style.borderLeftWidth),
      bt = px(style.borderTopWidth);
    const br = px(style.borderRightWidth),
      bb = px(style.borderBottomWidth);
    const innerLeft = box.left + bl;
    const innerTop = box.top + bt;
    const innerRight = box.right - br;
    const innerBottom = box.bottom - bb;
    // Areas marked `--sb-reserve: 1` (styles/) reserve the bar's space with a transparent border:
    // the bar fills that border exactly as rendered. Browsers round border widths to device pixels
    // (a 10px border can be 9.33px at 75 % zoom), so never infer this from the width itself.
    // Other areas (menus, dialogs) get the bar overlaid on their edge.
    const reserve = style.getPropertyValue('--sb-reserve').trim() === '1';
    const outY = hasY && reserve && br > 0;
    const outX = hasX && reserve && bb > 0;
    // `--sb-outset-right` (styles/): an overlaid vertical bar moved this far right of the area's
    // edge, e.g. over the terminal host's padding so it sits on the pane's edge.
    const outset = outY ? 0 : px(style.getPropertyValue('--sb-outset-right'));
    const yRight = outY ? box.right : innerRight + outset;
    const xBottom = outX ? box.bottom : innerBottom;
    const yWidth = outY ? br : size;
    const xHeight = outX ? bb : size;
    if (full || !this.z) this.z = hasY || hasX ? String(surfaceZ(el)) : '';
    const z = this.z;

    this.layoutAxis(
      'y',
      hasY,
      z,
      {
        left: yRight - yWidth,
        top: innerTop + insetTop,
        right: yRight,
        bottom: (hasX && !outX ? innerBottom - xHeight : innerBottom) - insetBottom,
      },
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
    );
    this.layoutAxis(
      'x',
      hasX,
      z,
      {
        left: innerLeft,
        top: xBottom - xHeight,
        right: hasY && !outY ? Math.min(innerRight, yRight - yWidth) : innerRight,
        bottom: xBottom,
      },
      el.scrollLeft,
      el.scrollWidth,
      el.clientWidth,
    );
    return true;
  }

  private layoutAxis(
    axis: Axis,
    visible: boolean,
    z: string,
    edges: { left: number; top: number; right: number; bottom: number },
    position: number,
    content: number,
    viewport: number,
  ) {
    const p = this.parts[axis];
    // Snap every edge to the device pixel grid the same way the browser snaps element edges, so
    // the bar lines up with the panel at any display scaling (125 %, 150 %, browser zoom …).
    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const left = snap(edges.left),
      top = snap(edges.top),
      right = snap(edges.right),
      bottom = snap(edges.bottom);
    const length = axis === 'y' ? bottom - top : right - left;
    if (!visible || length < MIN_THUMB / 2) {
      if (p.visible) {
        p.track.style.display = 'none';
        p.visible = false;
      }
      return;
    }
    const thumbLength = snap(Math.min(length, Math.max(MIN_THUMB, (length * viewport) / content)));
    const range = Math.max(1, content - viewport);
    const offset = snap((length - thumbLength) * Math.min(1, Math.max(0, position / range)));
    p.trackLength = length;
    p.thumbLength = thumbLength;
    const s = p.track.style;
    s.display = 'block';
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${right - left}px`;
    s.height = `${bottom - top}px`;
    s.zIndex = z;
    const t = p.thumb.style;
    // The offset is a transform (a scroll then only moves a composited layer, see moveThumbs).
    if (axis === 'y') {
      t.top = '0px';
      t.height = `${thumbLength}px`;
    } else {
      t.left = '0px';
      t.width = `${thumbLength}px`;
    }
    p.content = content;
    p.viewport = viewport;
    p.offset = offset;
    t.transform = axis === 'y' ? `translate(0, ${offset}px)` : `translate(${offset}px, 0)`;
    p.visible = true;
  }

  destroy() {
    cancelAnimationFrame(this.scrollFrame);
    this.resize.disconnect();
    for (const cleanup of this.cleanups) cleanup();
    this.parts.y.track.remove();
    this.parts.x.track.remove();
    this.el.classList.remove('sb-custom', 'sb-has-y', 'sb-has-x');
  }
}

/** Installs custom scrollbars for the whole document. Returns an uninstall function. */
export function installCustomScrollbars(): () => void {
  const layer = document.createElement('div');
  layer.className = 'sb-layer';
  document.body.appendChild(layer);
  const bars = new Map<HTMLElement, CustomScrollbar>();
  let frame = 0;
  let themeTarget: Element | null = null;

  const themeObserver = new MutationObserver(() => syncTheme());
  const syncTheme = () => {
    const shell = document.querySelector(SHELL_SELECTOR);
    if (shell !== themeTarget) {
      themeObserver.disconnect();
      themeTarget = shell;
      if (shell) themeObserver.observe(shell, { attributes: true, attributeFilter: ['class'] });
    }
    layer.classList.toggle('light', !!shell?.classList.contains('light'));
    layer.classList.toggle('gold', !!shell?.classList.contains('gold'));
  };

  /**
   * Finding the areas: the whole document once, afterwards only the subtrees that were added. A
   * `querySelectorAll` over the whole document on every DOM change, click or tab switch walked the
   * thousands of terminal rows (pre-rendered scrollback of every tab) each time — ~6 ms per tab switch.
   * Areas that left the document are noticed through `isConnected`.
   */
  let searchAll = true;
  const added = new Set<Element>();
  const adopt = (el: HTMLElement) => {
    if (bars.has(el) || el.closest('.sb-layer')) return;
    bars.set(el, new CustomScrollbar(el, layer));
  };
  const scan = () => {
    frame = 0;
    syncTheme();
    if (searchAll) {
      searchAll = false;
      added.clear();
      document.querySelectorAll<HTMLElement>(SCROLL_SELECTOR).forEach(adopt);
    } else if (added.size) {
      for (const root of added) {
        if (!root.isConnected) continue;
        if (root.matches(SCROLL_SELECTOR)) adopt(root as HTMLElement);
        root.querySelectorAll<HTMLElement>(SCROLL_SELECTOR).forEach(adopt);
      }
      added.clear();
    }
    for (const [el, bar] of bars) {
      if (!el.isConnected || !bar.update()) {
        bar.destroy();
        bars.delete(el);
      }
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(scan);
  };

  // Child-list changes only: cheap enough even with the terminal rendering rows.
  const domObserver = new MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      const target = record.target as Element;
      if (target.closest?.('.sb-layer, .xterm-screen, .xterm-accessibility, .terminal-gutter')) continue;
      changed = true;
      record.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) added.add(node as Element);
      });
    }
    if (changed) schedule();
  });
  domObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  // Layout changes that resize nothing we observe (e.g. a panel moving) settle after these.
  const settle = () => schedule();
  document.addEventListener('pointerup', settle, true);
  document.addEventListener('transitionend', settle, true);
  document.addEventListener('animationend', settle, true);
  // An ancestor that scrolls (e.g. a container scrolled by focus) moves its areas without resizing them.
  const onScroll = (event: Event) => {
    if (!bars.has(event.target as HTMLElement)) schedule();
  };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  scan();

  return () => {
    cancelAnimationFrame(frame);
    domObserver.disconnect();
    themeObserver.disconnect();
    window.removeEventListener('resize', schedule);
    document.removeEventListener('pointerup', settle, true);
    document.removeEventListener('transitionend', settle, true);
    document.removeEventListener('animationend', settle, true);
    document.removeEventListener('scroll', onScroll, true);
    for (const bar of bars.values()) bar.destroy();
    bars.clear();
    layer.remove();
  };
}
