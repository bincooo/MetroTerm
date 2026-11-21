import type { IDisposable, Terminal } from '@xterm/xterm';
import { activeRenderer } from './xtermInternals';

/**
 * Smooth scrolling with xterm's DOM renderer. Two patches on the renderer's prototypes (applied
 * once, they cover every terminal):
 *
 * 1. No second full redraw per scroll step.
 *
 * Every `scroll` event of the viewport makes xterm's selection service request a selection
 * redraw (`SelectionService.refresh` → `onRequestRedraw`). The DOM renderer answers that with
 * `handleSelectionChanged`, which clears the selection layer and re-renders *all* rows
 * synchronously — although the scroll itself already queues a full render of the rows for the
 * same frame. So each wheel step built the whole screen of DOM rows twice (profiled: about half of
 * the scripting time while scrolling), which made scrolling up and down through the scrollback stutter.
 *
 * The rows only depend on the selection's buffer coordinates, which don't change when the view
 * scrolls. Here the renderer's `handleSelectionChanged` is wrapped:
 * - no selection before and none now → nothing to do (the common case: just scrolling);
 * - the same selection as last time → only the selection layer is redrawn (its rectangles are in
 *   viewport coordinates and do move), the row re-render is left to the scroll's own refresh;
 * - anything else (selection made, changed or cleared) → xterm's original behaviour.
 *
 * 2. Fewer DOM nodes per row. The row factory never extends a span over a cell that carries a
 *    decoration, so every highlighted character (dates, IPs, paths, URLs, numbers … — see
 *    attachHighlighter) became a span of its own: a log line had ~100 spans, and laying them out
 *    again on every scroll step was most of the frame. Adjacent text spans with the same classes and
 *    the same inline style render exactly alike, so they are merged after each row is built (the
 *    cursor span is left alone). Copy, selection and the cell-grid alignment are unaffected: the text
 *    and each character's letter-spacing stay the same.
 *
 * 3. Scrolling does not re-render rows (row pool). xterm's DOM renderer has one element per screen
 *    row and rebuilds every row on each scroll step — all rows got new DOM, were laid out and
 *    painted again, frame after frame, while the scrollbar was dragged. Here each row element stays
 *    bound to the buffer line it shows and is positioned absolutely (`top` = screen row × row
 *    height, on the layout grid: see rowEdge). Scrolling only moves the elements (a position change, no re-layout of their text);
 *    lines that scroll out are hidden and kept (up to POOL_LINES), so scrolling back shows them
 *    again without building anything. A line is (re)built only when what xterm would draw for it
 *    changed: its cells (content + attributes), its coloured decorations (keyword colours, same-text
 *    marks), the cursor on it, the selection, focus, theme, font or cell size. `_rowElements[y]` is
 *    still the element shown on screen row y, which is all the rest of xterm relies on.
 */
type Range = [number, number] | undefined;

interface RowFactoryLike {
  createRow?: (...args: unknown[]) => HTMLSpanElement[];
}

interface RowMeta {
  epoch: number;
  row: number;
  data: Uint32Array;
  extra: string;
  deco: string;
  cursor: string;
}
type RowElement = HTMLElement & { __metro?: RowMeta | null; __metroTop?: number; __metroHeight?: number; __metroY?: number };
interface PoolState {
  epoch: number;
  pool: Map<number, RowElement>;
  lastYdisp: number;
  height: number;
  visible: Set<RowElement>;
  prerender: number;
}

interface DomRendererLike {
  _rowFactory?: RowFactoryLike & {
    _decorationService?: { _decorations?: { forEachByKey: (key: number, cb: (d: DecorationLike) => void) => void } };
    _selectionStart?: unknown;
    handleSelectionChanged?: (...args: unknown[]) => void;
  };
  _rowElements?: RowElement[];
  _rowContainer?: HTMLElement;
  _bufferService?: { cols: number; rows: number; buffer: BufferLike; buffers?: { normal: BufferLike } };
  _optionsService?: { rawOptions: { cursorBlink?: boolean; cursorStyle?: string; cursorInactiveStyle?: string } };
  _coreBrowserService?: { isFocused: boolean };
  _widthCache?: unknown;
  dimensions?: { css: { cell: { width: number; height: number }; canvas: { width: number } } };
  __metroPool?: PoolState;
  __metroEpoch?: number;
  /** Lines trimmed off the top of the normal buffer so far: row + trimmed = a line's lasting id. */
  __metroTrimmed?: number;
  handleSelectionChanged?: (start: Range, end: Range, columnSelectMode: boolean) => void;
  renderRows?: (start: number, end: number) => void;
  __metroSelection?: string;
  _selectionContainer?: HTMLElement;
  _selectionRenderModel?: { hasSelection: boolean };
}

interface BufferLike {
  ybase: number;
  y: number;
  x: number;
  ydisp: number;
  lines: { length: number; get(i: number): BufferLineLike | undefined };
}
interface DecorationLike {
  options: { x?: number; width?: number; layer?: string };
  backgroundColorRGB?: { rgba: number };
  foregroundColorRGB?: { rgba: number };
}
interface BufferLineLike {
  length: number;
  _data?: Uint32Array;
  _combined?: Record<number, string>;
  _extendedAttrs?: Record<number, { ext?: number; urlId?: number } | undefined>;
}

/** Lines kept rendered (hidden) besides the screen, for scrolling without rebuilding. */
const POOL_LINES = 5000;
/** Pre-rendering of the scrollback: starts this long after the last render, works in slices. */
const PRERENDER_DELAY = 300;
const PRERENDER_SLICE_MS = 8;

let patched = false;

const renderer = (terminal: Terminal) => activeRenderer<DomRendererLike>(terminal);

function mergeSpans(spans: HTMLSpanElement[]) {
  if (spans.length < 2) return spans;
  const out: HTMLSpanElement[] = [];
  let previous: HTMLSpanElement | null = null;
  let previousKey = '';
  let text = '';
  for (const span of spans) {
    const plain = span.childElementCount === 0 && !span.classList.contains('xterm-cursor');
    const key = plain ? `${span.className}\u0000${span.getAttribute('style') ?? ''}` : '';
    if (previous && key && key === previousKey) {
      text += span.textContent ?? '';
      continue;
    }
    if (previous && text !== previous.textContent) previous.textContent = text;
    out.push(span);
    previous = key ? span : null;
    previousKey = key;
    text = span.textContent ?? '';
  }
  if (previous && text !== previous.textContent) previous.textContent = text;
  return out;
}

/** The row elements in screen order (row 0 first) — DOM order is not screen order with the row pool. */
/**
 * Row geometry. Why there were gaps between rows (a hairline of terminal background across btop /
 * htop / mc, through selections, and one-pixel breaks in `│` borders):
 *
 * 1. Rows sat at `top: y × cell` with `height: cell`, but xterm's CSS cell height (18.675px) is rarely
 *    a multiple of the layout unit (1/64 px): the height laid out as 18.671875px while the tops
 *    advanced by 18.675px, so a row could end a sliver above the next one's top. `rowEdge` puts the
 *    edges on the layout grid and each row spans from its edge to the next.
 * 2. Even rows that meet exactly can leave a gap once painted at a fractional scale (110 %, 125 %,
 *    150 %, or WebKit's zoom): WebKit converts `top` and `height` to device units separately, so the
 *    two edges can round to different device pixels; Chromium rounds both to CSS pixels and then
 *    antialiases each half-covered edge on its own, which never adds up to a solid pixel.
 *
 * So each row reaches ROW_OVERLAP past the next row's top, and rows stack in screen order
 * (`z-index` = screen row; with the row pool, DOM order is not screen order): the next row covers the
 * extra pixel, and wherever its edge does not fully cover a device pixel, the previous row's own
 * colours are underneath instead of the terminal background. The row's `line-height` stays the cell
 * height, so text does not move; the cursor rules subtract `--xterm-row-overlap` to stay centred.
 */
const ROW_OVERLAP = 1;
const rowEdge = (y: number, height: number) => Math.round(y * height * 64) / 64;

export function screenRows(terminal: Terminal): HTMLElement[] {
  const current = renderer(terminal);
  const rows = current?._bufferService?.rows ?? 0;
  return (current?._rowElements ?? []).slice(0, rows);
}

/** Buffer line a row element was built for (-1: unknown), shown or kept hidden in the pool. */
export function bufferRowOf(terminal: Terminal, element: Element): number {
  const current = renderer(terminal);
  const meta = (element as RowElement).__metro;
  if (!current || !meta) return -1;
  const normal = current._bufferService?.buffer === current._bufferService?.buffers?.normal;
  return meta.row - (normal ? (current.__metroTrimmed ?? 0) : 0);
}

const bumpEpoch = (target: DomRendererLike) => {
  target.__metroEpoch = (target.__metroEpoch ?? 0) + 1;
};

/** Rows must be built again (e.g. the keyword colours changed); call terminal.refresh afterwards. */
export function invalidateRows(terminal: Terminal) {
  const current = renderer(terminal);
  if (current) bumpEpoch(current);
}

function lineExtra(line: BufferLineLike) {
  let extra = '';
  const combined = line._combined;
  if (combined) for (const key in combined) extra += `c${key}=${combined[key]};`;
  const attrs = line._extendedAttrs;
  if (attrs)
    for (const key in attrs) {
      const a = attrs[key];
      if (a) extra += `e${key}=${a.ext ?? 0},${a.urlId ?? 0};`;
    }
  return extra;
}

function sameData(stored: Uint32Array, data: Uint32Array, length: number) {
  if (stored.length !== length) return false;
  for (let i = 0; i < length; i++) if (stored[i] !== data[i]) return false;
  return true;
}

function renderRowsPooled(this: DomRendererLike, start: number, end: number, original: (start: number, end: number) => void) {
  const bufferService = this._bufferService;
  const rowElements = this._rowElements;
  const container = this._rowContainer;
  const factory = this._rowFactory;
  const dims = this.dimensions;
  if (!bufferService || !rowElements || !container || !factory?.createRow || !dims) {
    original.call(this, start, end);
    return;
  }
  const buffer = bufferService.buffer;
  const rows = bufferService.rows;
  const height = dims.css.cell.height;
  const epoch = this.__metroEpoch ?? 0;
  let state = this.__metroPool;
  if (!state) {
    state = { epoch, pool: new Map(), lastYdisp: buffer.ydisp, height: 0, visible: new Set(), prerender: 0 };
    this.__metroPool = state;
    container.style.position = 'relative';
    // Own stacking context for the rows' z-index (screen order), *above* xterm's selection layer
    // (z-index 1). xterm lifts selected cells over that opaque layer with .xterm-decoration-top
    // (z-index 2, painted in the selection colour); inside a stacking context at 0 they could no
    // longer get above it and the selected text disappeared. Selected cells carry the selection colour
    // themselves, so the layer showing only through the rest of the row changes nothing; decorations
    // (find, same-text marks: z-index 6+) stay on top.
    container.style.zIndex = '2';
    container.style.setProperty('--xterm-row-overlap', `${ROW_OVERLAP}px`);
  }
  // Theme / font / size / selection / clear changed: nothing rendered before can be reused.
  if (state.epoch !== epoch) {
    const onScreen = new Set(rowElements);
    for (const element of state.pool.values()) if (!onScreen.has(element)) element.remove();
    state.pool.clear();
    for (const element of rowElements) element.__metro = null;
    state.epoch = epoch;
  }
  // The view moved: every row may now show another line, so do them all (xterm does after a scroll).
  if (buffer.ydisp !== state.lastYdisp) {
    start = 0;
    end = rows - 1;
  }
  state.lastYdisp = buffer.ydisp;
  if (rows * height !== state.height) {
    state.height = rows * height;
    container.style.height = `${rowEdge(rows, height)}px`;
    for (const element of [...state.pool.values(), ...rowElements]) {
      element.__metroTop = undefined;
      element.__metroHeight = undefined;
    }
  }

  const raw = this._optionsService?.rawOptions ?? {};
  const focused = this._coreBrowserService?.isFocused ?? true;
  const cursorAbsoluteY = buffer.ybase + buffer.y;
  const cursorX = Math.min(buffer.x, bufferService.cols - 1);
  const decorations = factory._decorationService?._decorations;
  const width = dims.css.canvas.width;

  const place = (element: RowElement, y: number) => {
    const top = rowEdge(y, height);
    if (element.__metroTop !== top) {
      element.style.top = `${top}px`;
      element.style.zIndex = String(y);
      element.__metroTop = top;
    }
    const rowHeight = rowEdge(y + 1, height) - top + ROW_OVERLAP;
    if (element.__metroHeight !== rowHeight) {
      element.style.height = `${rowHeight}px`;
      element.__metroHeight = rowHeight;
    }
    if (element.style.display) element.style.display = '';
    if (element.parentNode !== container) container.appendChild(element);
    element.__metroY = y;
  };
  const styleRow = (element: RowElement) => {
    const style = element.style;
    style.position = 'absolute';
    style.left = '0';
    style.width = `${width}px`;
    style.lineHeight = `${height}px`;
    style.overflow = 'hidden';
  };
  const newElement = (): RowElement => {
    const element = document.createElement('div') as RowElement;
    styleRow(element);
    container.appendChild(element);
    return element;
  };

  const used = new Set<RowElement>();
  const offset = buffer === bufferService.buffers?.normal ? (this.__metroTrimmed ?? 0) : 0;
  for (let y = start; y <= end && y < rows; y++) {
    const row = y + buffer.ydisp;
    const id = row + offset;
    const line = buffer.lines.get(row);
    if (!line) break;
    const isCursorRow = row === cursorAbsoluteY;
    const cursor = isCursorRow
      ? `${cursorX}|${raw.cursorStyle}|${raw.cursorInactiveStyle}|${raw.cursorBlink ? 1 : 0}|${focused ? 1 : 0}`
      : '';
    let deco = selectionOfRow(factory as RowFactorySelection, row, focused);
    decorations?.forEachByKey(row, d => {
      if (!d.backgroundColorRGB && !d.foregroundColorRGB) return; // frames etc. don't change the row
      deco += `${d.options.x ?? 0}:${d.options.width ?? 1}:${d.backgroundColorRGB?.rgba ?? ''}:${d.foregroundColorRGB?.rgba ?? ''}:${d.options.layer ?? ''};`;
    });
    const data = line._data;
    const length = data ? Math.min(data.length, line.length * 3) : 0;
    const extra = lineExtra(line);

    // The element for this line: the one already showing it, else a fresh / recycled one.
    let element = state.pool.get(id);
    // Kept lines are detached (parentNode null); one that is somewhere else is no longer ours.
    if (element && element.parentNode && element.parentNode !== container) {
      state.pool.delete(id);
      element = undefined;
    }
    const meta = element?.__metro;
    const valid =
      !!element &&
      !!meta &&
      !!data &&
      meta.epoch === epoch &&
      meta.row === id &&
      meta.cursor === cursor &&
      meta.deco === deco &&
      meta.extra === extra &&
      sameData(meta.data, data, length);
    if (!valid) {
      if (!element) {
        // xterm's own elements (first render, after a resize or a new epoch) are used first.
        const here = rowElements[y];
        element = here && !here.__metro && !used.has(here) && here.parentNode === container ? here : newElement();
      }
      element.replaceChildren(
        ...(factory.createRow as (...args: unknown[]) => HTMLSpanElement[])(
          line,
          row,
          isCursorRow,
          raw.cursorStyle,
          raw.cursorInactiveStyle,
          cursorX,
          raw.cursorBlink,
          dims.css.cell.width,
          this._widthCache,
          -1,
          -1,
        ),
      );
      const stored = meta?.data && meta.data.length === length ? meta.data : new Uint32Array(length);
      if (data) stored.set(data.subarray(0, length));
      element.__metro = { epoch, row: id, data: stored, extra, deco, cursor };
    }
    const target = element as RowElement;
    used.add(target);
    state.pool.set(id, target);
    if (target.style.position !== 'absolute') styleRow(target);
    rowElements[y] = target;
    place(target, y);
  }

  // Rows no longer on screen are taken out of the document and kept for scrolling back. Not hidden
  // in place: rows left in the document (thousands, with the pre-rendered scrollback) were styled
  // and laid out again each time the terminal was shown — switching tabs took 120–200 ms with
  // `visibility: hidden`, and `display: none` still cost WebKit ~25 ms per switch. Elements xterm
  // still holds in `_rowElements` (it removes those itself) stay attached, with `display: none`.
  const visible = new Set(rowElements.slice(0, rows));
  const held = new Set(rowElements);
  for (const element of state.visible) {
    if (visible.has(element)) continue;
    if (held.has(element)) {
      if (element.style.display !== 'none') element.style.display = 'none';
    } else if (element.parentNode) element.remove();
  }
  // Spare elements xterm keeps beyond the last row stay out of the way too.
  for (let i = rows; i < rowElements.length; i++) {
    const spare = rowElements[i];
    if (!visible.has(spare)) spare.style.display = 'none';
  }
  state.visible = visible;
  schedulePrerender(this);
  if (state.pool.size > POOL_LINES + rows) {
    // Too many lines kept: drop the ones farthest from the view.
    const centre = buffer.ydisp + offset + rows / 2;
    const far = [...state.pool.entries()]
      .filter(([, element]) => !visible.has(element))
      .sort((x, y) => Math.abs(y[0] - centre) - Math.abs(x[0] - centre));
    for (const [id, element] of far) {
      if (state.pool.size <= POOL_LINES + rows) break;
      state.pool.delete(id);
      if (!held.has(element)) element.remove();
    }
  }
}

type RowFactorySelection = { _selectionStart?: [number, number]; _selectionEnd?: [number, number]; _columnSelectMode?: boolean };
/**
 * What the selection changes on one buffer line ('' = nothing): the selection's coordinates and
 * focus (selected cells use the inactive colour without focus) for lines it touches. A row is
 * rebuilt only when this changes, so selecting text or scrolling with a selection rebuilds only the
 * lines the old and the new selection cover.
 */
function selectionOfRow(factory: RowFactorySelection, row: number, focused: boolean): string {
  const start = factory._selectionStart;
  const end = factory._selectionEnd;
  if (!start || !end || row < Math.min(start[1], end[1]) || row > Math.max(start[1], end[1])) return '';
  return `${start[0]},${start[1]}|${end[0]},${end[1]}|${factory._columnSelectMode ? 1 : 0}|${focused ? 'S' : 's'}`;
}

/**
 * Builds the rows of the scrollback around the view in the background (hidden, in the pool), so
 * that scrolling — dragging the scrollbar across thousands of lines — only has to show rows that
 * already exist instead of building and laying out new ones in each frame.
 */
function schedulePrerender(target: DomRendererLike) {
  const state = target.__metroPool;
  if (!state) return;
  window.clearTimeout(state.prerender);
  state.prerender = window.setTimeout(() => prerenderSlice(target), PRERENDER_DELAY);
}

function prerenderSlice(target: DomRendererLike) {
  const state = target.__metroPool;
  const bufferService = target._bufferService;
  const container = target._rowContainer;
  const factory = target._rowFactory;
  const dims = target.dimensions;
  if (!state || !bufferService || !container || !factory?.createRow || !dims || !container.isConnected) return;
  const buffer = bufferService.buffer;
  if (buffer !== bufferService.buffers?.normal) return; // full-screen programs have no scrollback
  if (state.epoch !== (target.__metroEpoch ?? 0)) return; // the next render starts a new epoch first
  const rows = bufferService.rows;
  const offset = target.__metroTrimmed ?? 0;
  const total = buffer.lines.length;
  const height = dims.css.cell.height;
  const width = dims.css.canvas.width;
  const raw = target._optionsService?.rawOptions ?? {};
  const cursorAbsoluteY = buffer.ybase + buffer.y;
  const cursorX = Math.min(buffer.x, bufferService.cols - 1);
  const focused = target._coreBrowserService?.isFocused ?? true;
  const decorations = factory._decorationService?._decorations;
  const deadline = performance.now() + PRERENDER_SLICE_MS;
  const top = buffer.ydisp;
  // Nearest lines first: just above and below the view, then further out.
  for (let distance = 1; distance <= total; distance++) {
    if (state.pool.size >= POOL_LINES + rows) return;
    for (const row of [top - distance, top + rows - 1 + distance]) {
      if (row < 0 || row >= total || row === cursorAbsoluteY) continue;
      const id = row + offset;
      if (state.pool.has(id)) continue;
      const line = buffer.lines.get(row);
      const data = line?._data;
      if (!line || !data) continue;
      let deco = selectionOfRow(factory as RowFactorySelection, row, focused);
      decorations?.forEachByKey(row, d => {
        if (!d.backgroundColorRGB && !d.foregroundColorRGB) return;
        deco += `${d.options.x ?? 0}:${d.options.width ?? 1}:${d.backgroundColorRGB?.rgba ?? ''}:${d.foregroundColorRGB?.rgba ?? ''}:${d.options.layer ?? ''};`;
      });
      const element = document.createElement('div') as RowElement;
      const style = element.style;
      style.position = 'absolute';
      style.left = '0';
      style.top = '0';
      style.width = `${width}px`;
      style.height = `${height}px`; // set exactly by place() when it scrolls into view
      style.lineHeight = `${height}px`;
      style.overflow = 'hidden';
      element.__metroTop = 0;
      element.replaceChildren(
        ...(factory.createRow as (...args: unknown[]) => HTMLSpanElement[])(
          line,
          row,
          false,
          raw.cursorStyle,
          raw.cursorInactiveStyle,
          cursorX,
          raw.cursorBlink,
          dims.css.cell.width,
          target._widthCache,
          -1,
          -1,
        ),
      );
      const length = Math.min(data.length, line.length * 3);
      element.__metro = { epoch: state.epoch, row: id, data: data.slice(0, length), extra: lineExtra(line), deco, cursor: '' };
      state.pool.set(id, element); // detached until it scrolls into view

      if (performance.now() > deadline) {
        state.prerender = window.setTimeout(() => prerenderSlice(target), 16);
        return;
      }
    }
    if (top - distance < 0 && top + rows - 1 + distance >= total) return;
  }
}

export function attachDomRendererSpeedups(terminal: Terminal): IDisposable {
  const current = renderer(terminal);
  if (current?._rowFactory) ownerOf.set(current._rowFactory, current);
  // Lasting line ids across scrollback trimming, and a new epoch for the other screen (vim, less …).
  const subscriptions: IDisposable[] = [];
  if (current) {
    const lines = current._bufferService?.buffers?.normal.lines as unknown as
      { onTrim?: (cb: (amount: number) => void) => IDisposable } | undefined;
    const trim = lines?.onTrim?.(amount => {
      current.__metroTrimmed = (current.__metroTrimmed ?? 0) + amount;
    });
    if (trim) subscriptions.push(trim);
    subscriptions.push(terminal.buffer.onBufferChange(() => bumpEpoch(current)));
  }
  const disposeAll = {
    dispose: () => {
      subscriptions.forEach(item => item.dispose());
      const state = current?.__metroPool;
      if (state) window.clearTimeout(state.prerender);
    },
  };
  if (patched || !current || typeof current.handleSelectionChanged !== 'function') return disposeAll;
  const factory = current._rowFactory ? (Object.getPrototypeOf(current._rowFactory) as RowFactoryLike) : undefined;
  const createRow = factory?.createRow;
  if (factory && typeof createRow === 'function') {
    factory.createRow = function (this: RowFactoryLike, ...args: unknown[]) {
      return mergeSpans(createRow.apply(this, args));
    };
  }
  const proto = Object.getPrototypeOf(current) as DomRendererLike;
  const original = proto.handleSelectionChanged;
  if (typeof original !== 'function' || typeof proto.renderRows !== 'function') return disposeAll;
  // Row pool (3): replaces renderRows; anything that changes how every row is drawn starts a new epoch.
  const originalRenderRows = proto.renderRows;
  proto.renderRows = function (this: DomRendererLike, start: number, end: number) {
    renderRowsPooled.call(this, start, end, originalRenderRows);
  };
  const epochMethods = ['_injectCss', '_updateDimensions', '_handleOptionsChanged', 'clear', 'handleDevicePixelRatioChange'] as const;
  for (const name of epochMethods) {
    const method = (proto as Record<string, unknown>)[name];
    if (typeof method !== 'function') continue;
    (proto as Record<string, unknown>)[name] = function (this: DomRendererLike, ...args: unknown[]) {
      bumpEpoch(this);
      const result = (method as (...a: unknown[]) => unknown).apply(this, args);
      bumpEpoch(this);
      return result;
    };
  }
  // Link hover underlines are drawn into the row directly: those rows are rebuilt next time.
  const setUnderline = (proto as Record<string, unknown>)._setCellUnderline;
  if (typeof setUnderline === 'function') {
    (proto as Record<string, unknown>)._setCellUnderline = function (this: DomRendererLike, ...args: unknown[]) {
      const result = (setUnderline as (...a: unknown[]) => unknown).apply(this, args);
      for (const element of this._rowElements ?? []) element.__metro = null;
      return result;
    };
  }
  // The selection is drawn into the rows (colours): rows compare their part of it (selectionOfRow).
  proto.handleSelectionChanged = function (this: DomRendererLike, start: Range, end: Range, columnSelectMode: boolean) {
    const key = start && end ? `${start[0]},${start[1]}|${end[0]},${end[1]}|${columnSelectMode ? 1 : 0}` : '';
    const previous = this.__metroSelection ?? '';
    this.__metroSelection = key;
    if (!key && !previous) return;
    if (key && key === previous) {
      // Same selection, only the view moved: redraw the selection layer without the rows.
      this.renderRows = () => undefined;
      try {
        original.call(this, start, end, columnSelectMode);
      } finally {
        delete this.renderRows;
      }
    } else {
      original.call(this, start, end, columnSelectMode);
    }
    // xterm 5.5 bug: with the selection entirely outside the view, its render model is cleared
    // (rows 0..0) but the DOM renderer still draws a rectangle from it — on the first row, at the
    // selection's columns: a grey block at the top while scrolling away from selected text.
    if (key && this._selectionRenderModel && !this._selectionRenderModel.hasSelection) this._selectionContainer?.replaceChildren();
  };
  patched = true;
  return disposeAll;
}

/** Row factory → its renderer (to start a new epoch when the factory's selection changes). */
const ownerOf = new WeakMap<object, DomRendererLike>();
