import { onViewportScroll } from './viewportScroll';
import type { IBufferCell, IDecoration, IMarker, Terminal } from '@xterm/xterm';

/**
 * Selection matches: while text is selected in the terminal, every other occurrence of the same
 * text is highlighted too (like VS Code's "selection highlight"): a neutral grey fill, no outline,
 * in a different grey level from the selection itself so the two stay apart.
 *
 * - Needle: the selection when it is one line, 2–200 characters, not only spaces. Exact,
 *   case-sensitive match. The selected occurrence itself is not decorated.
 * - Like the output highlighter (terminalScheme.ts), only rows around the viewport are decorated;
 *   rows scrolled into view are scanned on render. Background-colour decorations (under the text,
 *   so the text colour — ANSI / output highlighting — stays).
 * - Wide (CJK) characters: string offsets are mapped back to cell columns.
 */
export type MatchColors = { background: string };

const MIN = 2;
const MAX = 200;
const DEBOUNCE = 60;

export function attachSelectionMatches(terminal: Terminal, initial: MatchColors) {
  type Entry = { signature: string; marker?: IMarker; decorations: IDecoration[] };
  const entries = new Map<number, Entry>();
  let colors = initial;
  let needle = '';
  /** The selected occurrence (buffer line + start column), not decorated. */
  let own: { line: number; x: number } | null = null;
  let frame = 0;
  let timer = 0;
  let cell: IBufferCell | undefined;

  const drop = (line: number) => {
    const entry = entries.get(line);
    if (!entry) return;
    entry.decorations.forEach(decoration => decoration.dispose());
    entry.marker?.dispose();
    entries.delete(line);
  };
  const clear = () => {
    for (const line of [...entries.keys()]) drop(line);
  };

  const scanLine = (y: number) => {
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(y);
    if (!line) {
      drop(y);
      return;
    }
    let text = '';
    const columns: number[] = [];
    const widths: number[] = [];
    for (let x = 0; x < line.length; x++) {
      cell = line.getCell(x, cell);
      if (!cell) break;
      const width = cell.getWidth();
      if (width === 0) continue; // trailing half of a wide character
      const chars = cell.getChars() || ' ';
      for (let unit = 0; unit < chars.length; unit++) {
        columns.push(x);
        widths.push(width);
      }
      text += chars;
    }
    const ownX = own && own.line === y ? own.x : -1;
    const signature = `${needle}\u0000${ownX}\u0000${text}`;
    const existing = entries.get(y);
    if (existing && existing.signature === signature && (!existing.marker || (!existing.marker.isDisposed && existing.marker.line === y)))
      return;
    drop(y);
    const found: { x: number; width: number }[] = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const x = columns[at];
      const last = at + needle.length - 1;
      if (x === undefined || columns[last] === undefined) break;
      if (x === ownX) continue;
      found.push({ x, width: columns[last] + widths[last] - x });
    }
    if (!found.length) {
      entries.set(y, { signature, decorations: [] });
      return;
    }
    const marker = terminal.registerMarker(y - (buffer.baseY + buffer.cursorY));
    if (!marker) return;
    const decorations: IDecoration[] = [];
    for (const match of found) {
      const decoration = terminal.registerDecoration({
        marker,
        x: match.x,
        width: match.width,
        backgroundColor: colors.background,
        layer: 'bottom',
      });
      if (decoration) decorations.push(decoration);
    }
    entries.set(y, { signature, marker, decorations });
  };

  const flush = () => {
    frame = 0;
    const buffer = terminal.buffer.active;
    if (!needle) {
      clear();
      return;
    }
    const top = buffer.viewportY;
    for (let row = 0; row < terminal.rows; row++) scanLine(top + row);
    const keepFrom = top - terminal.rows;
    const keepTo = top + terminal.rows * 2;
    for (const line of [...entries.keys()]) if (line < keepFrom || line > keepTo) drop(line);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const readSelection = () => {
    timer = 0;
    const text = terminal.hasSelection() ? terminal.getSelection() : '';
    const range = terminal.getSelectionPosition();
    const next = text.length >= MIN && text.length <= MAX && !/[\r\n]/.test(text) && text.trim() ? text : '';
    // xterm reports the selection's columns / rows 0-based.
    const nextOwn = next && range && range.start.y === range.end.y ? { line: range.start.y, x: range.start.x } : null;
    if (next === needle && nextOwn?.line === own?.line && nextOwn?.x === own?.x) return;
    needle = next;
    own = nextOwn;
    clear();
    schedule();
  };

  const subscriptions = [
    terminal.onSelectionChange(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(readSelection, DEBOUNCE);
    }),
    terminal.onRender(() => {
      if (needle) schedule();
    }),
    // Scrolling: mark the rows coming into view before xterm renders them (from onRender they got
    // their background one frame late — grey blocks popping in while dragging the scrollbar).
    onViewportScroll(terminal, () => {
      if (!needle) return;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      flush();
    }),
    terminal.buffer.onBufferChange(() => {
      clear();
      schedule();
    }),
  ];

  return {
    setColors(next: MatchColors) {
      colors = next;
      clear();
      schedule();
    },
    dispose() {
      window.clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      subscriptions.forEach(item => item.dispose());
      clear();
    },
  };
}
