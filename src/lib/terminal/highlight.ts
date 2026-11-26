import type { IDisposable, Terminal } from '@xterm/xterm';
import type { HighlightColors, HighlightKind } from './scheme';

/**
 * Output highlighting (colours: lib/terminal/scheme.ts `highlight`).
 *
 * - Only cells the program left unstyled (default fg and bg, not inverse / invisible / dim), so
 *   anything coloured by SGR keeps its own colour. A match must lie entirely on such cells.
 * - Coloured in the buffer itself: the cell gets a true-colour fg plus a mark in bit 31 of its bg
 *   word, unused by xterm 6. A program writing over the cell writes a new bg word (no mark), so the
 *   colours follow the text without decorations or DOM elements.
 * - Viewport rows only, right after parse / scroll / resize, before the frame is drawn. Rows are
 *   hashed (with a generation bumped on theme change), so an unchanged row is skipped.
 * - Uses xterm internals (`_buffer.lines`, `BufferLine._data`): @xterm/xterm is pinned at 6.0.0.
 * - Rows, not logical lines: a word cut by a soft wrap is not matched.
 */

/**
 * Rules, highest priority first (overlaps: the earlier rule wins). Keywords are whole words, any case.
 * No lookbehind: WebKit before Safari 16.4 (older macOS) fails to load the module at all. `notAfter`
 * skips a match right after such a character; `when` limits that to the alternatives concerned.
 */
/** `group`: colour only the first capture group, which ends where the match ends. */
type Rule = { kind: HighlightKind | 'plain'; pattern: RegExp; notAfter?: RegExp; when?: RegExp; group?: true };
const RULES: Rule[] = [
  // Shell prompts: the symbol before the input, at the start of the line and followed by a space (or
  // the end of the line). On its own only $ ❯ ➜ λ (a bare "# " is a comment, "> " a quote); # % >
  // need a prompt in front: user@host:~/dir, [user@host dir], bash-5.1, PS C:\…, C:\… (with an
  // optional (venv) / (base) first). Only the symbol is coloured.
  { kind: 'prompt', pattern: /^([$❯➜λ])(?= |$)/g, group: true },
  {
    kind: 'prompt',
    pattern:
      /^(?:\([^)\n]{1,40}\) +)?(?:\[[^\]\n]{1,120}\]|PS [A-Za-z]:[^>\n]{0,200}|[A-Za-z]:\\[^>\n]{0,200}|[\w.-]+@[\w.-]+(?:[: ][^\s$#%>]*)?|[\w.]+-\d[\w.]*) ?([$#%>])(?= |$)/g,
    group: true,
  },
  // Web addresses keep the terminal's colour (@xterm/addon-web-links underlines and opens them, see
  // TerminalView); their numbers, paths and keywords are not coloured either.
  { kind: 'plain', pattern: /\b(?:https?|ftp|sftp|ssh|wss?|file):\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g },
  // Paths stay uncoloured, and so does everything inside them (numbers, keywords, brackets): a
  // `plain` match only takes its text away from the later rules.
  {
    kind: 'plain',
    pattern: /(?:~|\.{1,2})?\/[\p{L}\p{N}_.@%+=,~-]+(?:\/[\p{L}\p{N}_.@%+=,~-]*)*/gu,
    notAfter: /[\p{L}\p{N}_.~/-]/u,
  },
  // `ls -l` modes first: -rw-r--r-- is not an option.
  { kind: 'permission', pattern: /[-dlcbps][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT][.+@]?(?!\S)/g, notAfter: /\S/ },
  // Command-line options: -a, -la, --help, --dry-run (a word of its own; `-5` and "re-enter" are not).
  // Before the keywords, so --fail-fast or 'ls --help' is one option, not a keyword / a string.
  { kind: 'option', pattern: /--?[a-z][\w-]*/gi, notAfter: /[^\s'"=]/ },
  { kind: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  {
    kind: 'time',
    pattern:
      /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2}(?: +(?:\d{1,2}:\d{2}(?::\d{2})?|\d{4}))?\b/g,
  },
  { kind: 'address', pattern: /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi },
  { kind: 'address', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?(?::\d{1,5})?\b/g },
  {
    kind: 'address',
    pattern:
      /(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])|::1(?![\w:])/gi,
    notAfter: /[\w:]/,
  },
  {
    kind: 'error',
    pattern:
      /\b(?:errors?|err|fail(?:ed|ure|ures|s)?|fatal|panic(?:ked)?|critical|crit|emerg|alert|denied|refused|forbidden|unauthorized|exception|traceback|abort(?:ed)?|unreachable|invalid|cannot|can't|unable|not found|no such file(?: or directory)?|segmentation fault|core dumped|killed|timed out|timeout)\b/gi,
  },
  { kind: 'warning', pattern: /\b(?:warn(?:ing|ings)?|deprecated|caution|retry(?:ing)?|skipp(?:ed|ing)|degraded)\b/gi },
  // Outcomes only: states such as active / running stay uncoloured (they fill service and log output).
  { kind: 'success', pattern: /\b(?:ok|okay|success(?:ful|fully)?|succeeded|passed|done|completed?)\b/gi },
  // Something has ended ("closing …" is still under way: uncoloured).
  { kind: 'stopped', pattern: /\b(?:closed|stopped|terminated|exited|disconnected|shut ?down)\b/gi },
  { kind: 'info', pattern: /\b(?:info|notice)\b/gi },
  { kind: 'debug', pattern: /\b(?:debug|trace|verbose)\b/gi },
  { kind: 'string', pattern: /"[^"\n]{0,240}"|'[^'\s][^'\n]{0,240}'(?!\w)/g, notAfter: /\w/, when: /^'/ },
  {
    kind: 'number',
    // Versions as a whole (21.0.11, 11.0.27), not just their first two parts.
    pattern: /\b0x[0-9a-f]+\b|\d+(?:\.\d+)*(?:[KMGTP]i?B?|[kKMGTP]|ms|us|µs|ns|s|%|B)?\b/gi,
    notAfter: /[\w.]/,
    when: /^(?!0x)/i,
  },
  // Log structure: brackets and a free-standing " - " separator.
  { kind: 'bracket', pattern: /[[\]{}()]/g },
  { kind: 'bracket', pattern: /-(?= )/g, notAfter: /\S/ },
];

/** The character before `index` (a whole surrogate pair, for the `u` patterns). */
function charBefore(text: string, index: number) {
  const low = text.charCodeAt(index - 1);
  return low >= 0xdc00 && low <= 0xdfff && index > 1 ? text.slice(index - 2, index) : text.charAt(index - 1);
}

type Match = { start: number; end: number; kind: HighlightKind };
type RuleMatch = { start: number; end: number; kind: Rule['kind'] };
/** Non-overlapping rule matches in `text` (UTF-16 indices); `plain` matches only shield their text. */
function findMatches(text: string): Match[] {
  const taken = new Uint8Array(text.length);
  const result: RuleMatch[] = [];
  for (const { kind, pattern, notAfter, when, group } of RULES) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const end = match.index + match[0].length;
      const start = group && match[1] ? end - match[1].length : match.index;
      if (end === start) {
        pattern.lastIndex++;
        continue;
      }
      if (notAfter && start > 0 && (!when || when.test(match[0])) && notAfter.test(charBefore(text, start))) {
        pattern.lastIndex = start + 1;
        continue;
      }
      let free = true;
      for (let index = start; index < end && free; index++) free = !taken[index];
      if (!free) continue;
      taken.fill(1, start, end);
      result.push({ start, end, kind });
    }
  }
  return result.filter((match): match is Match => match.kind !== 'plain');
}

/** The internal buffer and line of @xterm/xterm 6 (not in its typings). */
type Line = {
  length: number;
  _data: Uint32Array;
  translateToString(trimRight?: boolean, start?: number, end?: number, columns?: number[]): string;
};
type Buffer = { lines: { length: number; get(index: number): Line | undefined }; ydisp: number };
/** The internal buffer, or undefined when xterm's internals are not the expected ones (no highlighting then). */
const internal = (terminal: Terminal, which: 'active' | 'normal' | 'alternate') => {
  const buffer = (terminal.buffer[which] as unknown as { _buffer?: Buffer })._buffer;
  const line = buffer?.lines?.get?.(0);
  return line && line._data instanceof Uint32Array && typeof line.translateToString === 'function' ? buffer : undefined;
};

/** A match in cells: columns `x` … `x + width − 1` of its row. */
type CellMatch = { x: number; width: number; kind: HighlightKind };

/** Cell words: `_data[3 * column + 1]` = foreground, `+ 2` = background (xterm common/buffer/Constants). */
const FG = 1;
const BG = 2;
/** Background bit 31: "this cell's foreground colour is ours". */
const MARK = 0x80000000;
/** Colour mode + RGB bits of a foreground / background word. */
const COLOR = 0x3ffffff;
const CM_MASK = 0x3000000;
const CM_RGB = 0x3000000;
/** Foreground flags inverse / invisible, background flag dim: such cells are not coloured. */
const FG_SKIP = 0x4000000 | 0x40000000;
const BG_SKIP = 0x8000000;

const CACHE_LIMIT = 4000;

/** `#rrggbb` → a true-colour foreground word. */
const fgWord = (hex: string) => CM_RGB | (parseInt(hex.slice(1, 7), 16) & 0xffffff);

/** Takes our colours out of a row: marked cells go back to the default foreground. */
const strip = (line: Line) => {
  const data = line._data;
  let changed = false;
  for (let index = 0, end = line.length * 3; index < end; index += 3) {
    if (data[index + BG] & MARK) {
      data[index + FG] &= ~COLOR;
      data[index + BG] &= ~MARK;
      changed = true;
    }
  }
  return changed;
};

/** FNV-1a over a row's cell words, seeded with the colouring generation. */
const hashOf = (line: Line, seed: number) => {
  const data = line._data;
  let hash = 0x811c9dc5 ^ seed;
  for (let index = 0, end = line.length * 3; index < end; index++) hash = Math.imul(hash ^ data[index], 0x01000193);
  return hash | 0;
};

export function attachHighlighter(terminal: Terminal, initial: HighlightColors, enabledInitially = true) {
  let words = wordsOf(initial);
  let enabled = enabledInitially;
  let generation = 1;
  let disposed = false;
  let queued = false;
  let lastViewport = -1;
  /** A row's hash after its last colouring (by line object: xterm reuses them, the hash tells). */
  const done = new WeakMap<Line, number>();
  /** Matches by row text (the same text always gives the same matches; colours are checked per pass). */
  const cache = new Map<string, CellMatch[]>();
  const columns: number[] = [];

  function wordsOf(colors: HighlightColors) {
    return Object.fromEntries(Object.entries(colors).map(([kind, hex]) => [kind, fgWord(hex)])) as Record<HighlightKind, number>;
  }

  /** Rule matches of a row's text, in cells (cached by text). */
  const textMatches = (line: Line): CellMatch[] => {
    const text = line.translateToString(true, 0, line.length, columns);
    let found = cache.get(text);
    if (found) return found;
    found = text.trim()
      ? findMatches(text).map(match => ({ x: columns[match.start], width: columns[match.end] - columns[match.start], kind: match.kind }))
      : [];
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(text, found);
    return found;
  };

  /** Colours one row (after taking the old colours out); true when a cell changed. */
  const paint = (line: Line) => {
    const data = line._data;
    let changed = strip(line);
    for (const match of textMatches(line)) {
      const end = Math.min(match.x + match.width, line.length);
      let plain = true;
      for (let x = match.x; x < end && plain; x++) {
        const fg = data[x * 3 + FG];
        const bg = data[x * 3 + BG];
        plain = !(fg & CM_MASK) && !(bg & CM_MASK) && !(fg & FG_SKIP) && !(bg & BG_SKIP);
      }
      if (!plain) continue;
      const word = words[match.kind];
      for (let x = match.x; x < end; x++) {
        data[x * 3 + FG] = (data[x * 3 + FG] & ~COLOR) | word;
        data[x * 3 + BG] |= MARK;
      }
      changed = true;
    }
    return changed;
  };

  /** Takes every colour out of a buffer (turned off, or full-screen programs no longer coloured). */
  const stripAll = (buffer: Buffer | undefined) => {
    if (!buffer) return false;
    let changed = false;
    for (let row = 0; row < buffer.lines.length; row++) {
      const line = buffer.lines.get(row);
      if (line && strip(line)) changed = true;
    }
    return changed;
  };

  const flush = () => {
    queued = false;
    if (disposed) return;
    const api = terminal.buffer.active;
    lastViewport = api.viewportY;
    if (!enabled) return;
    const buffer = internal(terminal, 'active');
    if (!buffer) return;
    let first = -1;
    let last = -1;
    for (let row = 0; row < terminal.rows; row++) {
      const line = buffer.lines.get(buffer.ydisp + row);
      if (!line || done.get(line) === hashOf(line, generation)) continue;
      if (paint(line)) {
        if (first < 0) first = row;
        last = row;
      }
      done.set(line, hashOf(line, generation));
    }
    // The rows output just changed are drawn in the coming frame anyway; this covers rows that were
    // drawn before (a scroll into rows not coloured yet, a theme change).
    if (first >= 0) terminal.refresh(first, last);
  };

  // A microtask: everything parsed / scrolled in this task is handled once, before the frame is drawn
  // (xterm renders in an animation frame).
  const queue = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(flush);
  };
  const redrawAll = () => terminal.refresh(0, terminal.rows - 1);

  const listeners: IDisposable[] = [
    terminal.onWriteParsed(queue),
    // Output, wheel, scrollbar and keyboard scrolling (xterm 6 fires onScroll for all of them).
    terminal.onScroll(queue),
    // A resize reflows the buffer (cells move with their colours and marks; the row hashes change).
    terminal.onResize(queue),
    // Any other way the viewport moved (selection drag scrolls without the event): catch up.
    terminal.onRender(() => {
      if (terminal.buffer.active.viewportY !== lastViewport) queue();
    }),
    terminal.buffer.onBufferChange(queue),
  ];
  queue();

  return {
    /** Theme changed: rows are coloured again in the new colours (as they come into view). */
    setColors(next: HighlightColors) {
      words = wordsOf(next);
      generation++;
      queue();
    },
    /** View → Highlight Keywords. */
    setEnabled(value: boolean) {
      if (value === enabled) return;
      enabled = value;
      generation++;
      if (!value) {
        const normal = stripAll(internal(terminal, 'normal'));
        if (stripAll(internal(terminal, 'alternate')) || normal) redrawAll();
      }
      queue();
    },
    /** `read` sees the normal buffer as the programs wrote it (Save Output As ANSI…); the viewport is
     *  coloured again before the next frame, other rows as they come into view. */
    unstyled<T>(read: () => T): T {
      stripAll(internal(terminal, 'normal'));
      try {
        return read();
      } finally {
        generation++;
        queue();
      }
    },
    dispose() {
      disposed = true;
      listeners.forEach(listener => listener.dispose());
      cache.clear();
    },
  };
}
