import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { lineRows, lineStart } from './buffer';
import { pad2 } from '../format';

/**
 * Gutter left of the terminal (`[time]` + line number per row) and the clicked-line highlight.
 * Built only on xterm's public API (buffer, markers, events) and changes nothing inside xterm:
 *
 * - Row geometry: the row height is the rendered screen's height / rows (`.xterm-screen` is sized by
 *   the renderer to rows × cell height), the gutter rows are moved to the screen's top edge. Gutter
 *   rows and the highlight bands use the same numbers, so they line up at every zoom level.
 * - Times: each buffer line gets the time it was written; a line that is drawn again (a progress bar,
 *   a prompt redrawn after a resize) keeps the newest time. In the alternate screen (vim, htop …)
 *   each screen row shows the time of its last change and the screen row number.
 *   Lines are keyed by an absolute number (buffer row + lines trimmed off the top of the scrollback);
 *   the trimmed count comes from markers (`anchors`), which xterm moves up when lines are trimmed.
 * - Line numbers: logical lines — a line longer than the terminal is wide takes several rows but one
 *   number, so the numbers never skip (the status bar's Ln is the same number); its continuation
 *   rows show nothing. The cursor's line is highlighted. The column width follows the buffer capacity (scrollback +
 *   rows), not the current line count, so it never changes while output grows (no refit / reflow).
 * - Clicked line: a click on a terminal row (no drag, no selection) or on a gutter row highlights the
 *   whole logical line (all its wrapped rows) in the terminal and the gutter; a marker keeps it on
 *   that line while output scrolls. Not in the alternate screen.
 */

type GutterColumns = { time: boolean; line: boolean };

type Options = {
  gutter: HTMLElement;
  host: HTMLElement;
  columns: GutterColumns;
};

const clock = (time: number) => {
  const date = new Date(time);
  return `[${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}]`;
};

/** Ink of the digits 0–9 above / below the baseline, in em, by font family (canvas scan at 200px). */
const inkCache = new Map<string, { ascent: number; descent: number }>();
function digitInk(family: string) {
  const cached = inkCache.get(family);
  if (cached) return cached;
  const SIZE = 200;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * 7;
  canvas.height = SIZE * 2;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.font = `${SIZE}px ${family}`;
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#000';
  const baseline = SIZE * 1.5;
  context.fillText('0123456789', 4, baseline);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 127) {
        if (top < 0) top = y;
        bottom = y + 1;
        break;
      }
    }
  }
  if (top < 0) return null;
  const ink = { ascent: (baseline - top) / SIZE, descent: (bottom - baseline) / SIZE };
  if (!document.fonts || document.fonts.check(`12px ${family}`, '0')) inkCache.set(family, ink);
  return ink;
}

export function attachGutter(terminal: Terminal, { gutter, host, columns: initial }: Options) {
  let columns = initial;
  let disposed = false;
  const listeners: IDisposable[] = [];

  // ---------- line times ----------
  /** Markers with the absolute line number they were created on: trimmed = abs − marker.line. */
  let anchors: { marker: IMarker; abs: number }[] = [];
  const times = new Map<number, number>(); // absolute line → time (normal buffer)
  let screenText = new Map<number, string>(); // absolute line → text, rows of the bottom screen
  let stampedUpTo = -1; // last absolute line stamped as "new"
  let altTimes: number[] = [];
  let altText: string[] = [];

  const normal = () => terminal.buffer.active.type === 'normal';

  // ---------- logical line numbers ----------
  /**
   * Line starts (rows that are not a soft-wrap continuation) in normal-buffer rows [0, row): the
   * number of the logical line before `row`. Scrollback rows (above `baseY`) never change except by
   * a reflow (resize), trimming (the offset changes) or a clear (the buffer gets shorter), so the
   * count up to there is kept and only the rows after it are walked.
   */
  let startsCache = { row: 0, count: 0, offset: -1, length: 0, epoch: -1 };
  let startsEpoch = 0; // bumped on resize / Clear Scrollback: the cache is void
  const startsBefore = (row: number) => {
    const buffer = terminal.buffer.normal;
    const offset = trimmed() ?? 0;
    const cached = startsCache;
    const valid = cached.epoch === startsEpoch && cached.offset === offset && cached.length <= buffer.length && cached.row <= row;
    let r = valid ? cached.row : 0;
    let count = valid ? cached.count : 0;
    const fixedUpTo = Math.min(row, buffer.baseY); // rows before this are scrollback
    for (; r < fixedUpTo; r++) if (!buffer.getLine(r)?.isWrapped) count++;
    if (r === fixedUpTo) startsCache = { row: r, count, offset, length: buffer.length, epoch: startsEpoch };
    for (; r < row; r++) if (!buffer.getLine(r)?.isWrapped) count++;
    return count;
  };
  const capacity = () => terminal.rows + (terminal.options.scrollback ?? 1000);

  const resetClock = () => {
    anchors.forEach(anchor => anchor.marker.dispose());
    anchors = [];
    times.clear();
    screenText = new Map();
    stampedUpTo = -1;
  };
  /** Lines trimmed off the top so far, from the newest anchor still in the buffer. */
  const trimmed = (): number | null => {
    const buffer = terminal.buffer.normal;
    for (let i = anchors.length - 1; i >= 0; i--) {
      const { marker, abs } = anchors[i];
      if (!marker.isDisposed && marker.line >= 0 && marker.line < buffer.length) return abs - marker.line;
    }
    return null;
  };
  /** Keeps an anchor near the cursor, so one survives however many lines are trimmed. */
  const keepAnchor = (offset: number) => {
    const buffer = terminal.buffer.normal;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const spacing = Math.max(1, Math.min(1000, Math.floor(capacity() / 4)));
    const newest = anchors[anchors.length - 1];
    if (newest && !newest.marker.isDisposed && cursorRow - newest.marker.line < spacing) return;
    const marker = terminal.registerMarker(0);
    if (!marker) return;
    anchors = anchors.filter(anchor => !anchor.marker.isDisposed);
    anchors.push({ marker, abs: cursorRow + offset });
  };

  /** After a resize: take the screen's text as it is now, without stamping the rows the reflow changed. */
  let rebase = false;
  const stampNormal = (now: number) => {
    const buffer = terminal.buffer.normal;
    let offset = trimmed();
    if (offset === null) {
      // First run, or every anchor is gone (Clear Scrollback, reset): start over.
      resetClock();
      offset = 0;
    }
    keepAnchor(offset);
    // New lines the cursor has reached since the last pass.
    const cursorAbs = buffer.baseY + buffer.cursorY + offset;
    for (let abs = Math.max(stampedUpTo + 1, offset); abs <= cursorAbs; abs++) if (!times.has(abs)) times.set(abs, now);
    stampedUpTo = Math.max(stampedUpTo, cursorAbs);
    // Rows of the bottom screen whose text changed (drawn again): newest time.
    const next = new Map<number, string>();
    for (let row = buffer.baseY; row < buffer.baseY + terminal.rows && row < buffer.length; row++) {
      const text = buffer.getLine(row)?.translateToString(true) ?? '';
      const abs = row + offset;
      const before = screenText.get(abs);
      if (before !== undefined && before !== text) {
        if (!rebase) times.set(abs, now);
      } else if (before === undefined && text && !times.has(abs)) times.set(abs, now);
      next.set(abs, text);
    }
    screenText = next;
    rebase = false;
    // Drop times of lines that left the scrollback.
    if (times.size > capacity() + terminal.rows * 2) for (const abs of times.keys()) if (abs < offset) times.delete(abs);
  };
  const stampAlt = (now: number) => {
    const buffer = terminal.buffer.alternate;
    for (let row = 0; row < terminal.rows; row++) {
      const text = buffer.getLine(row)?.translateToString(true) ?? '';
      if (altText[row] !== text) {
        if (altText[row] !== undefined || text) altTimes[row] = now;
        altText[row] = text;
      }
    }
    altText.length = terminal.rows;
    altTimes.length = terminal.rows;
  };

  // ---------- gutter rows ----------
  const rowsBox = document.createElement('div');
  rowsBox.className = 'terminal-gutter-rows';
  const gutterBand = document.createElement('div');
  gutterBand.className = 'terminal-gutter-band';
  gutterBand.hidden = true;
  gutter.textContent = ''; // not replaceChildren(): Safari < 14
  gutter.append(gutterBand, rowsBox);
  const lineBand = document.createElement('div');
  lineBand.className = 'terminal-line-highlight';
  lineBand.hidden = true;
  host.append(lineBand);

  type Row = { el: HTMLDivElement; time: HTMLElement; line: HTMLElement; key: string };
  let rows: Row[] = [];
  const syncRowCount = () => {
    while (rows.length < terminal.rows) {
      const el = document.createElement('div');
      const time = document.createElement('time');
      const line = document.createElement('span');
      el.append(time, line);
      rowsBox.append(el);
      rows.push({ el, time, line, key: '' });
    }
    while (rows.length > terminal.rows) rows.pop()?.el.remove();
  };

  /** Row height and the screen's top edge relative to the gutter / host (CSS px). */
  let geometry = { rowHeight: 0, gutterTop: 0, hostTop: 0, screenHeight: 0 };
  const measure = () => {
    const screen = host.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || !host.clientHeight || !terminal.rows) return false;
    const screenRect = screen.getBoundingClientRect();
    if (!screenRect.height) return false;
    const gutterRect = gutter.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    geometry = {
      rowHeight: screenRect.height / terminal.rows,
      gutterTop: screenRect.top - gutterRect.top,
      hostTop: screenRect.top - hostRect.top,
      screenHeight: screenRect.height,
    };
    gutter.style.setProperty('--gutter-row-h', `${geometry.rowHeight}px`);
    rowsBox.style.transform = `translateY(${geometry.gutterTop}px)`;
    centerText();
    return true;
  };

  /**
   * Time / line number in the vertical middle of their row. `line-height` = row height centres the
   * font's ascent + descent box, but fonts put their digits at different heights in that box (the
   * fallback monospace font of each system differs), so the text could sit high or low. The digits'
   * ink is put in the row's middle instead (`--gutter-text-dy` moves the text):
   * - ink above / below the baseline: the digits drawn large (200px) on a canvas and scanned
   *   (canvas `actualBoundingBox*` is rounded to whole px — too coarse at 12px);
   * - the baseline's place in the row: a hidden probe in the gutter (same font, same line-height)
   *   with a zero-size inline-block on the baseline.
   * Measured again when the font or the row height changes; not cached while the font is loading.
   */
  let inkKey = '';
  const probe = document.createElement('div');
  probe.className = 'terminal-gutter-probe';
  probe.setAttribute('aria-hidden', 'true');
  probe.append('0', document.createElement('i'));
  gutter.append(probe);
  const centerText = () => {
    const style = getComputedStyle(gutter);
    const key = `${style.fontSize} ${style.fontFamily} ${geometry.rowHeight}`;
    if (key === inkKey) return;
    const ink = digitInk(style.fontFamily);
    if (!ink) return;
    const size = parseFloat(style.fontSize);
    const baseline = probe.lastElementChild!.getBoundingClientRect().top - probe.getBoundingClientRect().top;
    const inkMiddle = baseline - ((ink.ascent - ink.descent) * size) / 2;
    gutter.style.setProperty('--gutter-text-dy', `${(geometry.rowHeight / 2 - inkMiddle).toFixed(2)}px`);
    if (!document.fonts || document.fonts.check(`${style.fontSize} ${style.fontFamily}`, '0')) inkKey = key;
  };

  // ---------- clicked line ----------
  /** A normal-buffer row shows a line number (and can be picked) once written: the cursor has reached it or it has a time. */
  const isRendered = (bufferRow: number, offset: number) => {
    const buffer = terminal.buffer.normal;
    if (bufferRow >= buffer.length) return false;
    if (bufferRow <= buffer.baseY + buffer.cursorY) return true;
    // Below the cursor: only rows that really hold text (a program drew there). A time alone is not
    // enough — after a resize reflows the buffer, rows below the cursor are blank but their
    // absolute numbers can still have times from before.
    return times.has(bufferRow + offset) && Boolean(buffer.getLine(bufferRow)?.translateToString(true));
  };

  let picked: { marker: IMarker; onDispose: IDisposable } | null = null;
  const unpick = () => {
    if (!picked) return;
    picked.onDispose.dispose();
    picked.marker.dispose();
    picked = null;
    lineBand.hidden = true;
    gutterBand.hidden = true;
    schedule(false); // the time / number of the line lose their highlight
  };
  const pickRow = (viewportRow: number) => {
    if (!normal()) return;
    pickBufferRow(terminal.buffer.normal.viewportY + Math.max(0, Math.min(terminal.rows - 1, viewportRow)));
  };
  const pickBufferRow = (row: number) => {
    if (!normal()) return;
    const buffer = terminal.buffer.normal;
    const start = lineStart(buffer, row);
    // Rows not written yet (below the cursor, blank): nothing to highlight; the click just clears the pick.
    if (!isRendered(start, trimmed() ?? 0)) {
      unpick();
      return;
    }
    if (picked && picked.marker.line === start) return;
    unpick();
    const marker = terminal.registerMarker(start - (buffer.baseY + buffer.cursorY));
    if (!marker) return;
    picked = { marker, onDispose: marker.onDispose(() => unpick()) };
    schedule(false);
  };
  const placeBands = () => {
    if (!picked || !normal() || !geometry.rowHeight) {
      lineBand.hidden = true;
      gutterBand.hidden = true;
      return;
    }
    const buffer = terminal.buffer.normal;
    // The picked line was erased below the cursor (reset, a redrawn prompt): hide until it is written again.
    if (!isRendered(picked.marker.line, trimmed() ?? 0)) {
      lineBand.hidden = true;
      gutterBand.hidden = true;
      return;
    }
    const first = picked.marker.line - buffer.viewportY;
    const count = lineRows(buffer, picked.marker.line);
    // Clip to the screen: a line partly scrolled out shows only its visible rows.
    const from = Math.max(0, first);
    const to = Math.min(terminal.rows, first + count);
    if (to <= from) {
      lineBand.hidden = true;
      gutterBand.hidden = true;
      return;
    }
    const top = from * geometry.rowHeight;
    const height = (to - from) * geometry.rowHeight;
    lineBand.style.top = `${geometry.hostTop + top}px`;
    lineBand.style.height = `${height}px`;
    gutterBand.style.top = `${geometry.gutterTop + top}px`;
    gutterBand.style.height = `${height}px`;
    lineBand.hidden = false;
    gutterBand.hidden = false;
  };

  // ---------- rendering ----------
  const render = () => {
    const visible = columns.time || columns.line;
    if (!host.clientHeight) return; // hidden tab
    if (!measure()) return;
    placeBands();
    if (!visible) return;
    syncRowCount();
    const buffer = terminal.buffer.active;
    const isNormal = buffer.type === 'normal';
    const offset = isNormal ? (trimmed() ?? 0) : 0;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const currentStart = isNormal ? lineStart(buffer, cursorRow) : buffer.cursorY;
    // The clicked line's time and number are highlighted along with the line (`is-picked`).
    const pickedStart = isNormal && picked && isRendered(picked.marker.line, offset) ? picked.marker.line : -1;
    let logical = isNormal ? startsBefore(buffer.viewportY) : 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let time = '';
      let number = '';
      let current = false;
      let pickedRow = false;
      if (isNormal) {
        const bufferRow = buffer.viewportY + i;
        const line = bufferRow < buffer.length ? buffer.getLine(bufferRow) : undefined;
        if (line && !line.isWrapped) {
          logical++;
          const stamp = times.get(bufferRow + offset);
          if (isRendered(bufferRow, offset)) {
            number = String(logical);
            if (stamp !== undefined) time = clock(stamp);
          }
          current = bufferRow === currentStart;
          pickedRow = bufferRow === pickedStart;
        }
      } else {
        number = String(i + 1);
        if (altTimes[i] !== undefined) time = clock(altTimes[i]);
        current = i === currentStart;
      }
      const key = `${time}|${number}|${current ? 1 : 0}|${pickedRow ? 1 : 0}`;
      if (key === row.key) continue;
      row.key = key;
      row.time.textContent = time;
      row.line.textContent = number;
      row.el.classList.toggle('is-current', current);
      row.el.classList.toggle('is-picked', pickedRow);
    }
  };

  let frame = 0;
  let stampPending = false;
  const schedule = (stamp: boolean) => {
    if (stamp) stampPending = true;
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed) return;
      if (stampPending) {
        stampPending = false;
        const now = Date.now();
        if (normal()) stampNormal(now);
        else stampAlt(now);
      }
      render();
    });
  };

  const applyColumns = () => {
    gutter.hidden = !columns.time && !columns.line;
    gutter.classList.toggle('no-time', !columns.time);
    gutter.classList.toggle('no-line', !columns.line);
    gutter.style.setProperty('--line-digits', String(Math.max(3, String(capacity()).length)));
    rows.forEach(row => (row.key = ''));
  };
  applyColumns();

  listeners.push(
    terminal.onWriteParsed(() => schedule(true)),
    terminal.onRender(() => schedule(false)),
    terminal.onResize(() => {
      applyColumns();
      // The reflow may have moved the cursor up (a wider terminal unwraps lines): times of absolute
      // lines below it now belong to no line, and must not number / date the blank rows there.
      if (normal()) {
        const buffer = terminal.buffer.normal;
        const offset = trimmed();
        if (offset !== null) {
          const cursorAbs = buffer.baseY + buffer.cursorY + offset;
          for (const abs of [...times.keys()])
            if (abs > cursorAbs && !buffer.getLine(abs - offset)?.translateToString(true)) times.delete(abs);
          stampedUpTo = Math.min(stampedUpTo, cursorAbs);
        }
      }
      rebase = true;
      startsEpoch++;
      rows.forEach(row => (row.key = ''));
      schedule(true);
    }),
    terminal.buffer.onBufferChange(buffer => {
      if (buffer.type === 'alternate') {
        altTimes = [];
        altText = [];
      }
      rows.forEach(row => (row.key = ''));
      schedule(true);
    }),
  );

  // Clicks: a plain click on a terminal row (not a drag, nothing selected) picks its line.
  let down: { x: number; y: number } | null = null;
  const onDown = (event: MouseEvent) => {
    down = event.button === 0 && !event.shiftKey ? { x: event.clientX, y: event.clientY } : null;
  };
  const onUp = (event: MouseEvent) => {
    const start = down;
    down = null;
    if (!start || event.button !== 0 || Math.abs(event.clientX - start.x) > 3 || Math.abs(event.clientY - start.y) > 3) return;
    if (terminal.hasSelection() || !(event.target as Element | null)?.closest?.('.xterm-screen')) return;
    if (!measure()) return;
    pickRow(Math.floor((event.clientY - (host.getBoundingClientRect().top + geometry.hostTop)) / geometry.rowHeight));
  };
  const onGutterClick = (event: MouseEvent) => {
    if (event.button !== 0 || !measure()) return;
    pickRow(Math.floor((event.clientY - (gutter.getBoundingClientRect().top + geometry.gutterTop)) / geometry.rowHeight));
    terminal.focus();
  };
  // The wheel over the gutter scrolls the terminal.
  const onGutterWheel = (event: WheelEvent) => {
    event.preventDefault();
    const lines = event.deltaMode === 1 ? event.deltaY : event.deltaY / (geometry.rowHeight || 18);
    terminal.scrollLines(Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines))));
  };
  host.addEventListener('mousedown', onDown, true);
  host.addEventListener('mouseup', onUp, true);
  gutter.addEventListener('click', onGutterClick);
  gutter.addEventListener('wheel', onGutterWheel, { passive: false });
  const resize = new ResizeObserver(() => schedule(false));
  resize.observe(host);
  resize.observe(gutter);
  schedule(true);

  return {
    /** View → Show Time / Show Line Number. The caller refits the terminal (its width changed). */
    setColumns(next: GutterColumns) {
      columns = next;
      applyColumns();
      schedule(false);
    },
    /** Scrollback setting changed: the line-number column width follows the capacity. */
    refresh() {
      applyColumns();
      schedule(false);
    },
    /** Highlight the logical line containing buffer row `row` (Find: the current match's line). */
    pickLine(row: number) {
      pickBufferRow(row);
    },
    /** Logical line number of normal-buffer row `row` (the status bar's Ln; wrapped rows: their line's). */
    lineNumber(row: number) {
      return startsBefore(row + 1);
    },
    /** Clear Scrollback: the remaining line starts a new clock. */
    reset() {
      startsEpoch++;
      resetClock();
      unpick();
      schedule(true);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      listeners.forEach(listener => listener.dispose());
      host.removeEventListener('mousedown', onDown, true);
      host.removeEventListener('mouseup', onUp, true);
      gutter.removeEventListener('click', onGutterClick);
      gutter.removeEventListener('wheel', onGutterWheel);
      resize.disconnect();
      unpick();
      resetClock();
      lineBand.remove();
      gutter.textContent = '';
    },
  };
}
