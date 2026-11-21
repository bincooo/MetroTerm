import { onViewportScroll } from './viewportScroll';
import type { IBufferCell, IDecoration, IMarker, Terminal } from '@xterm/xterm';

/**
 * Find in the terminal (Ctrl+F / the Find button in the terminal header).
 *
 * - Searches the whole buffer (scrollback + screen) of the active screen, case-insensitive, on
 *   logical lines: soft-wrapped rows are joined, so a match may continue on the next row.
 * - The current match is framed (a soft 1px border around its cells, no fill) and scrolled into view;
 *   `onFocusLine` gets its line so the view can highlight the line like a click does.
 * - "Find all" frames every match (a fainter border) — only around the viewport, refreshed while
 *   scrolling, so a huge number of matches costs nothing. No result list.
 * - Output that arrives while the find bar is open is searched again (debounced); the current
 *   match stays on the same text when it still exists.
 * - Wide (CJK) characters: string offsets are mapped back to cell columns.
 */
export type FindColors = { current: string; other: string };
export type FindState = { query: string; count: number; index: number; capped: boolean; all: boolean; version: number };
type Segment = { line: number; x: number; width: number };
/** `start` = first row of its logical line, `logical` = line number as in the gutter, `offset` = index in its text. */
type Match = { line: number; x: number; segments: Segment[]; start: number; logical: number; offset: number };

const MAX_MATCHES = 10000;
const RESEARCH_DELAY = 250;

export function attachFind(
  terminal: Terminal,
  options: { colors: FindColors; onFocusLine?: (line: number) => void; onChange?: (state: FindState) => void },
) {
  let colors = options.colors;
  let query = '';
  let matches: Match[] = [];
  let index = -1;
  let capped = false;
  let all = false;
  let active = false;
  /** +1 per search: the result list is rebuilt only then. */
  let version = 0;
  /** Top row of the view when the find bar opened: typing searches from there, not from the last jump. */
  let anchor = 0;
  let frame = 0;
  let researchTimer = 0;
  let cell: IBufferCell | undefined;
  /** Decorations drawn now, by `${kind}:${line}:${x}`. */
  const drawn = new Map<string, { marker: IMarker; decoration: IDecoration }>();

  const emit = () => options.onChange?.({ query, count: matches.length, index, capped, all, version });

  const undraw = (key: string) => {
    const item = drawn.get(key);
    if (!item) return;
    item.decoration.dispose();
    item.marker.dispose();
    drawn.delete(key);
  };
  const undrawAll = () => {
    for (const key of [...drawn.keys()]) undraw(key);
  };

  const frameSegment = (segment: Segment, kind: 'current' | 'other') => {
    const key = `${kind}:${segment.line}:${segment.x}`;
    if (drawn.has(key)) return key;
    const buffer = terminal.buffer.active;
    const marker = terminal.registerMarker(segment.line - (buffer.baseY + buffer.cursorY));
    if (!marker) return key;
    const decoration = terminal.registerDecoration({ marker, x: segment.x, width: segment.width, layer: 'top' });
    if (!decoration) {
      marker.dispose();
      return key;
    }
    const color = kind === 'current' ? colors.current : colors.other;
    decoration.onRender(element => {
      element.classList.add('terminal-find-match');
      if (kind === 'current') element.classList.add('is-current');
      element.style.border = `1px solid ${color}`;
    });
    drawn.set(key, { marker, decoration });
    return key;
  };

  /** Frames for the current match and (Find all) the matches around the viewport. */
  const draw = () => {
    frame = 0;
    if (!active) {
      undrawAll();
      return;
    }
    const keep = new Set<string>();
    const current = matches[index];
    if (current) for (const segment of current.segments) keep.add(frameSegment(segment, 'current'));
    if (all && matches.length) {
      const buffer = terminal.buffer.active;
      const from = buffer.viewportY - terminal.rows;
      const to = buffer.viewportY + terminal.rows * 2;
      // First match at or after `from` (matches are in buffer order).
      let lo = 0;
      let hi = matches.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (matches[mid].line < from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < matches.length && matches[i].line <= to; i++) {
        if (i === index) continue;
        for (const segment of matches[i].segments) keep.add(frameSegment(segment, 'other'));
      }
    }
    for (const key of [...drawn.keys()]) if (!keep.has(key)) undraw(key);
  };
  const scheduleDraw = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  /** Text of the logical line starting at `start` (it + its wrapped rows), with the cell of each char. */
  const logicalLine = (start: number) => {
    const buffer = terminal.buffer.active;
    let text = '';
    const rows: number[] = [];
    const columns: number[] = [];
    const widths: number[] = [];
    let row = start;
    do {
      const line = buffer.getLine(row);
      if (!line) break;
      let rowText = '';
      let lastContent = -1;
      const rowColumns: number[] = [];
      const rowWidths: number[] = [];
      for (let x = 0; x < line.length; x++) {
        cell = line.getCell(x, cell);
        if (!cell) break;
        const width = cell.getWidth();
        if (width === 0) continue;
        const chars = cell.getChars() || ' ';
        for (let unit = 0; unit < chars.length; unit++) {
          rowColumns.push(x);
          rowWidths.push(width);
        }
        rowText += chars;
        if (cell.getChars()) lastContent = rowText.length;
      }
      // Trailing blanks of the last row are not text (a wrapped row keeps them: they are content).
      const keep = buffer.getLine(row + 1)?.isWrapped ? rowText.length : Math.max(0, lastContent);
      text += rowText.slice(0, keep);
      for (let i = 0; i < keep; i++) {
        rows.push(row);
        columns.push(rowColumns[i]);
        widths.push(rowWidths[i]);
      }
      row++;
    } while (row < buffer.length && buffer.getLine(row)?.isWrapped);
    return { text, rows, columns, widths, end: row };
  };

  /** All matches of `query` in the active buffer. */
  const scan = (): Match[] => {
    const found: Match[] = [];
    capped = false;
    if (!query) return found;
    const needle = query.toLowerCase();
    const buffer = terminal.buffer.active;
    let y = 0;
    let logical = 0;
    while (y < buffer.length) {
      const { text, rows, columns, widths, end } = logicalLine(y);
      logical++;
      const haystack = text.toLowerCase();
      const same = haystack.length === text.length; // lowercasing changed the length: compare as typed
      const search = same ? haystack : text;
      const target = same ? needle : query;
      for (let at = search.indexOf(target); at !== -1; at = search.indexOf(target, at + Math.max(1, target.length))) {
        const segments: Segment[] = [];
        for (let i = at; i < at + target.length; i++) {
          const last = segments[segments.length - 1];
          if (last && last.line === rows[i]) last.width = columns[i] + widths[i] - last.x;
          else segments.push({ line: rows[i], x: columns[i], width: widths[i] });
        }
        found.push({ line: rows[at], x: columns[at], segments, start: y, logical, offset: at });
        if (found.length >= MAX_MATCHES) {
          capped = true;
          return found;
        }
      }
      y = Math.max(end, y + 1);
    }
    return found;
  };

  /** Scroll the current match into view (centred when it was off screen) and report its line. */
  const reveal = () => {
    const current = matches[index];
    if (!current) return;
    const buffer = terminal.buffer.active;
    const last = current.segments[current.segments.length - 1].line;
    if (current.line < buffer.viewportY || last >= buffer.viewportY + terminal.rows) {
      terminal.scrollToLine(Math.max(0, current.line - Math.floor(terminal.rows / 2)));
    }
    options.onFocusLine?.(current.line);
  };

  /** Initial match: the first one at or below the top of the view, else the last one above it. */
  const nearestIndex = () => {
    if (!matches.length) return -1;
    const top = anchor;
    const below = matches.findIndex(match => match.line >= top);
    return below === -1 ? matches.length - 1 : below;
  };

  const research = (keepPosition: boolean) => {
    const previous = matches[index];
    matches = scan();
    version++;
    if (keepPosition && previous) {
      const same = matches.findIndex(match => match.line === previous.line && match.x === previous.x);
      index = same !== -1 ? same : Math.min(index, matches.length - 1);
    } else {
      index = nearestIndex();
    }
    undrawAll();
    scheduleDraw();
    emit();
  };

  const subscriptions = [
    terminal.onScroll(() => {
      if (active && all) scheduleDraw();
    }),
    onViewportScroll(terminal, () => {
      if (active && all) draw();
    }),
    terminal.onRender(() => {
      if (active && all) scheduleDraw();
    }),
    terminal.onWriteParsed(() => {
      if (!active || !query) return;
      window.clearTimeout(researchTimer);
      researchTimer = window.setTimeout(() => research(true), RESEARCH_DELAY);
    }),
    terminal.buffer.onBufferChange(() => {
      if (active) research(false);
    }),
  ];

  return {
    /** Find bar opened / closed. Closing removes every frame. */
    setActive(value: boolean) {
      active = value;
      if (!value) {
        window.clearTimeout(researchTimer);
        undrawAll();
        return;
      }
      anchor = terminal.buffer.active.viewportY;
      if (query) research(false);
    },
    /** New search text: jumps to the match nearest to the view. */
    search(text: string) {
      query = text;
      research(false);
      reveal();
    },
    next() {
      if (!matches.length) return;
      index = (index + 1) % matches.length;
      scheduleDraw();
      reveal();
      emit();
    },
    previous() {
      if (!matches.length) return;
      index = (index - 1 + matches.length) % matches.length;
      scheduleDraw();
      reveal();
      emit();
    },
    /** "Find all": frame every match (around the viewport) as well as the current one. */
    setAll(value: boolean) {
      all = value;
      undrawAll();
      scheduleDraw();
      emit();
    },
    setColors(next: FindColors) {
      colors = next;
      undrawAll();
      scheduleDraw();
    },
    dispose() {
      window.clearTimeout(researchTimer);
      if (frame) cancelAnimationFrame(frame);
      subscriptions.forEach(item => item.dispose());
      undrawAll();
    },
  };
}
