import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { cellLine, cellSegments, lineStart } from './buffer';
import { tokenHex } from '../ui/cssToken';

/**
 * Same-text marks: while text is selected in the terminal, every other occurrence of it gets a
 * background (`--terminal-same-text`, an opaque #rrggbb), like VS Code's selection highlight.
 *
 * The marks are xterm decorations with `backgroundColor` (public API, `allowProposedApi`): the
 * renderer itself paints those cells' background, under the text, on exactly the same cell grid as
 * the selection — no overlay of our own that could land a pixel off at fractional positions or
 * display scales.
 *
 * - Which selections: one line of text (no line break), not only whitespace, at most 256 characters.
 *   Exact (case-sensitive), non-overlapping; the selected occurrence itself keeps xterm's selection.
 * - Rows around the viewport only (one screen above and below), on logical lines: soft-wrapped rows
 *   are joined, so a match can run over a wrap (one decoration per row). Recomputed after renders,
 *   scrolls and resizes; decorations are kept by position and only added / removed when the set of
 *   matches changes, so a render caused by our own decorations changes nothing and stops there.
 * - Cells, not characters: wide characters (CJK) take two cells (lib/terminal/buffer `cellLine`).
 * - Paused while the find bar is open (`setPaused`): find selects each match itself.
 */

const MAX_TERM = 256;
const MAX_MARKS = 600;
const FALLBACK = '#3a3a3a';

/** The `--terminal-same-text` token of the current theme (colors.css). */
const tokenColor = () => tokenHex('--terminal-same-text', FALLBACK);

export function attachSelectionMarks(terminal: Terminal) {
  /** Decorations drawn now, by `${row}:${col}:${width}`. */
  const drawn = new Map<string, { marker: IMarker; decoration: IDecoration }>();
  let term = '';
  /** The selected occurrence (0-based column, absolute buffer row, as xterm reports it). */
  let own: { row: number; col: number } | null = null;
  let color = tokenColor();
  let frame = 0;
  let disposed = false;
  let paused = false;

  const undraw = (key: string) => {
    const item = drawn.get(key);
    if (!item) return;
    item.decoration.dispose();
    item.marker.dispose();
    drawn.delete(key);
  };
  const clear = () => {
    for (const key of [...drawn.keys()]) undraw(key);
  };

  const draw = (row: number, col: number, width: number, keep: Set<string>) => {
    const key = `${row}:${col}:${width}`;
    keep.add(key);
    const existing = drawn.get(key);
    if (existing && !existing.marker.isDisposed && existing.marker.line === row) return;
    if (existing) undraw(key);
    const buffer = terminal.buffer.active;
    const marker = terminal.registerMarker(row - (buffer.baseY + buffer.cursorY));
    if (!marker) return;
    const decoration = terminal.registerDecoration({ marker, x: col, width, backgroundColor: color, layer: 'bottom' });
    if (!decoration) {
      marker.dispose();
      return;
    }
    drawn.set(key, { marker, decoration });
  };

  const flush = () => {
    frame = 0;
    if (disposed) return;
    if (!term) {
      clear();
      return;
    }
    const keep = new Set<string>();
    const buffer = terminal.buffer.active;
    const from = Math.max(0, buffer.viewportY - terminal.rows);
    const to = Math.min(buffer.length, buffer.viewportY + terminal.rows * 2); // exclusive
    let row = lineStart(buffer, from);
    let count = 0;
    while (row < to && count < MAX_MARKS) {
      const line = cellLine(buffer, row);
      const { text } = line;
      for (let at = text.indexOf(term); at !== -1 && count < MAX_MARKS; at = text.indexOf(term, at + term.length)) {
        if (own && line.rows[at] === own.row && line.cols[at] === own.col) continue;
        count++;
        for (const segment of cellSegments(line, at, term.length))
          if (segment.row >= from && segment.row < to) draw(segment.row, segment.x, segment.width, keep);
      }
      row = Math.max(line.end, row + 1);
    }
    for (const key of [...drawn.keys()]) if (!keep.has(key)) undraw(key);
  };

  const schedule = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(flush);
  };

  const onSelection = () => {
    // Paused (the find bar is open: the search addon selects each match, and its own colours show
    // the other matches — marks would duplicate them).
    const text = !paused && terminal.hasSelection() ? terminal.getSelection() : '';
    const next = text.length <= MAX_TERM && !/[\r\n]/.test(text) && text.trim() ? text : '';
    const range = next ? terminal.getSelectionPosition() : undefined;
    const nextOwn = range ? { row: range.start.y, col: range.start.x } : null;
    if (next === term && nextOwn?.row === own?.row && nextOwn?.col === own?.col) return;
    term = next;
    own = nextOwn;
    if (!term) {
      cancelAnimationFrame(frame);
      frame = 0;
      clear();
      return;
    }
    schedule();
  };

  const listeners: IDisposable[] = [
    terminal.onSelectionChange(onSelection),
    terminal.onRender(() => term && schedule()),
    // Scrolling: decorate the rows coming into view right away (from onRender they would get their
    // background one frame late).
    terminal.onScroll(() => {
      if (!term) return;
      cancelAnimationFrame(frame);
      flush();
    }),
    terminal.onResize(() => term && schedule()),
    terminal.buffer.onBufferChange(() => {
      clear();
      if (term) schedule();
    }),
  ];

  return {
    /** Pause while the find bar is open; resuming marks the selection of that moment again. */
    setPaused(value: boolean) {
      if (paused === value) return;
      paused = value;
      onSelection();
    },
    /** Theme changed: re-read `--terminal-same-text` and repaint. */
    refresh() {
      // Next frame: the app switches the theme class on <html> in an effect of its own.
      requestAnimationFrame(() => {
        const next = tokenColor();
        if (disposed || next === color) return;
        color = next;
        clear();
        if (term) schedule();
      });
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      listeners.forEach(listener => listener.dispose());
      clear();
    },
  };
}
