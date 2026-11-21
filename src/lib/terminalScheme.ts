import { invalidateRows } from './domRendererSpeed';
import { decorationService } from './xtermInternals';
import type { IBufferCell, ITheme, Terminal } from '@xterm/xterm';
import type { ThemeMode } from '../types';

/**
 * Built-in terminal configurations, one per app theme (black / white / gold):
 * - `theme`: the xterm palette (16 ANSI colors, cursor, selection);
 * - `highlight`: colors for output highlighting (see attachHighlighter).
 * Only `#RRGGBB` values: xterm decorations accept nothing else.
 */
type HighlightKind =
  'error' | 'warning' | 'success' | 'info' | 'debug' | 'url' | 'path' | 'address' | 'time' | 'uuid' | 'string' | 'number' | 'permission';
type TerminalScheme = { theme: ITheme; highlight: Record<HighlightKind, string> };

export const TERMINAL_SCHEMES: Record<ThemeMode, TerminalScheme> = {
  dark: {
    theme: {
      // Background = the gutter (time / line number) colour, var(--terminal) in the dark theme.
      // ANSI palette: Monokai / Molokai as in VS Code's terminal (blue #819aff directories, cyan #66d9ef links).
      background: '#171717',
      foreground: '#f8f8f2',
      cursor: '#ffaa5c',
      cursorAccent: '#171717', // orange block cursor
      selectionBackground: '#f8f8f255',
      selectionInactiveBackground: '#f8f8f22a',
      black: '#333333',
      red: '#c4265e',
      green: '#86b42b',
      yellow: '#b3b42b',
      blue: '#6a7ec8',
      magenta: '#8c6bc8',
      cyan: '#56adbc',
      white: '#e3e3dd',
      brightBlack: '#666666',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#e2e22e',
      brightBlue: '#819aff',
      brightMagenta: '#ae81ff',
      brightCyan: '#66d9ef',
      brightWhite: '#f8f8f2',
    },
    highlight: {
      error: '#f92672',
      warning: '#e6db74',
      success: '#a6e22e',
      info: '#819aff',
      debug: '#75715e',
      url: '#66d9ef',
      path: '#66d9ef',
      address: '#ae81ff',
      time: '#8e9db0',
      uuid: '#fd971f',
      string: '#e6db74',
      number: '#ae81ff',
      permission: '#8a8a8a',
    },
  },
  light: {
    // Full palette darkened for contrast on white (xterm's defaults are made for dark backgrounds).
    theme: {
      // Background = the gutter (time / line number) colour, var(--panel) in the light theme.
      background: '#fafafa',
      foreground: '#1e1e1e',
      cursor: '#ff8a2e',
      cursorAccent: '#fafafa', // orange block cursor
      // Selection a little deeper than the (lighter) selection-match grey #e2e2e2, so the two stay apart.
      selectionBackground: '#1e1e1e30',
      selectionInactiveBackground: '#1e1e1e1a',
      // The same Monokai hues, darkened so they stay readable on #fafafa.
      black: '#1e1e1e',
      red: '#c4265e',
      green: '#5c8a00',
      yellow: '#8a7f00',
      blue: '#3d55c4',
      magenta: '#7a4fc4',
      cyan: '#1a8296',
      white: '#6e6e6e',
      brightBlack: '#5c5c5c',
      brightRed: '#d81b60',
      brightGreen: '#669900',
      brightYellow: '#968a00',
      brightBlue: '#4762d6',
      brightMagenta: '#8a5cd6',
      brightCyan: '#1690a8',
      brightWhite: '#3a3a3a',
    },
    highlight: {
      error: '#c4265e',
      warning: '#8a6d00',
      success: '#5c8a00',
      info: '#3d55c4',
      debug: '#8a8a8a',
      url: '#1a7f93',
      path: '#1a7f93',
      address: '#7a4fc4',
      time: '#5b6b80',
      uuid: '#b35c00',
      string: '#8a6d00',
      number: '#7a4fc4',
      permission: '#7a7a7a',
    },
  },
  gold: {
    // The black theme's Monokai palette on a warm black, with a gold selection and the yellows moved
    // to gold; the cursor is the dark theme's orange; the other hues stay as they are, so `ls` / git colours still read the same.
    theme: {
      background: '#141310',
      foreground: '#f3ecdc',
      cursor: '#ffaa5c',
      cursorAccent: '#141310', // orange block cursor, as in the dark theme
      selectionBackground: '#e8bf5a4d',
      selectionInactiveBackground: '#e8bf5a26',
      black: '#35312a',
      red: '#c4265e',
      green: '#86b42b',
      yellow: '#c9a33a',
      blue: '#6a7ec8',
      magenta: '#8c6bc8',
      cyan: '#56adbc',
      white: '#e6dfcf',
      brightBlack: '#6b6458',
      brightRed: '#f92672',
      brightGreen: '#a6e22e',
      brightYellow: '#f0cf6a',
      brightBlue: '#819aff',
      brightMagenta: '#ae81ff',
      brightCyan: '#66d9ef',
      brightWhite: '#fbf6ea',
    },
    highlight: {
      error: '#f92672',
      warning: '#f0cf6a',
      success: '#a6e22e',
      info: '#819aff',
      debug: '#7d7461',
      url: '#66d9ef',
      path: '#66d9ef',
      address: '#ae81ff',
      time: '#a8997a',
      uuid: '#e8a33d',
      string: '#e6c86e',
      number: '#ae81ff',
      permission: '#8c8473',
    },
  },
};

/**
 * Highlight rules, highest priority first. Where matches overlap, the earlier rule wins.
 * Keywords are whole words and ignore case.
 *
 * No lookbehind (`(?<!…)`) in the patterns: WebKit only knows it since Safari 16.4 (macOS 13.3),
 * and the macOS app runs on the system's WebKit — on an older Mac one such pattern stopped the
 * whole interface from starting (a `SyntaxError` while the module loaded: an empty window).
 * `notAfter` does the lookbehind's job instead: a match right after such a character is skipped,
 * and the search goes on one character later (as the regex engine itself would). `when` limits
 * that to the matches of the alternatives that had the lookbehind (they start differently).
 */
type Rule = { kind: HighlightKind; pattern: RegExp; notAfter?: RegExp; when?: RegExp };
const RULES: Rule[] = [
  { kind: 'url', pattern: /\b(?:https?|ftp|sftp|ssh|wss?|file):\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g },
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
  {
    kind: 'success',
    pattern:
      /\b(?:ok|okay|success(?:ful|fully)?|succeeded|passed|done|completed?|active|running|enabled|online|listening|established|accepted|ready|healthy)\b/gi,
  },
  { kind: 'info', pattern: /\b(?:info|notice)\b/gi },
  { kind: 'debug', pattern: /\b(?:debug|trace|verbose)\b/gi },
  { kind: 'permission', pattern: /[-dlcbps][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT][.+@]?(?!\S)/g, notAfter: /\S/ },
  {
    kind: 'path',
    pattern: /(?:~|\.{1,2})?\/[\p{L}\p{N}_.@%+=,~-]+(?:\/[\p{L}\p{N}_.@%+=,~-]*)*/gu,
    notAfter: /[\p{L}\p{N}_.~/-]/u,
  },
  { kind: 'string', pattern: /"[^"\n]{0,240}"|'[^'\s][^'\n]{0,240}'(?!\w)/g, notAfter: /\w/, when: /^'/ },
  {
    kind: 'number',
    pattern: /\b0x[0-9a-f]+\b|\d+(?:\.\d+)?(?:[KMGTP]i?B?|[kKMGTP]|ms|us|µs|ns|s|%|B)?\b/gi,
    notAfter: /[\w.]/,
    when: /^(?!0x)/i,
  },
];

/** The character before `index` (a whole surrogate pair, for the `u` patterns). */
function charBefore(text: string, index: number) {
  const low = text.charCodeAt(index - 1);
  return low >= 0xdc00 && low <= 0xdfff && index > 1 ? text.slice(index - 2, index) : text.charAt(index - 1);
}

type Match = { start: number; end: number; kind: HighlightKind };
/** Non-overlapping matches over the cells whose color the program did not set (`plain`). */
function findMatches(text: string, plain: boolean[]): Match[] {
  const taken = new Uint8Array(text.length);
  const result: Match[] = [];
  for (const { kind, pattern, notAfter, when } of RULES) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (end === start) {
        pattern.lastIndex++;
        continue;
      }
      if (notAfter && start > 0 && (!when || when.test(match[0])) && notAfter.test(charBefore(text, start))) {
        pattern.lastIndex = start + 1;
        continue;
      }
      let free = true;
      for (let index = start; index < end && free; index++) free = !taken[index] && plain[index];
      if (!free) continue;
      taken.fill(1, start, end);
      result.push({ start, end, kind });
    }
  }
  return result;
}

/**
 * Keyword colours (errors, paths, IPs, times, numbers …) for the normal screen; full-screen programs
 * (alternate screen: vim, htop, less) are left alone, and so is text the program coloured itself.
 *
 * The colours are part of the rows themselves: xterm's DOM row builder asks the decoration service
 * which decorations cover each cell (`forEachDecorationAtCell`); this adds the keyword matches of
 * that line to the answer, as decorations that exist only there (no markers, no DOM elements). So a
 * row is built once, already coloured — before, real decorations were registered after the row
 * had been drawn (one more render per row, a flash of uncoloured text while scrolling), and every
 * match had an element in xterm's decoration layer (hundreds per screen, moved on every render).
 * Rows built this way can be kept and shown again by the row pool (domRendererSpeed) unchanged:
 * the colours follow from the line's cells, which the pool compares anyway.
 */
type VirtualDecoration = {
  options: { x: number; width: number; layer: 'bottom' };
  foregroundColorRGB: { css: string; rgba: number };
  backgroundColorRGB?: undefined;
};

function toColor(css: string) {
  const hex = css.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16),
    g = parseInt(hex.slice(2, 4), 16),
    b = parseInt(hex.slice(4, 6), 16);
  return { css: `#${hex.slice(0, 6)}`, rgba: ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0 };
}

export function attachHighlighter(terminal: Terminal, initial: TerminalScheme['highlight']) {
  let colors = initial;
  let palette = Object.fromEntries(Object.entries(colors).map(([kind, css]) => [kind, toColor(css)])) as Record<
    HighlightKind,
    { css: string; rgba: number }
  >;
  let enabled = true;
  let cell: IBufferCell | undefined;
  /** Matches by line text (+ which cells are plain): the same text gives the same colours. */
  const cache = new Map<string, Match[]>();
  /** Decorations of the row being built (the row builder asks cell by cell, left to right). */
  let currentRow = -1;
  let lastX = -1;
  let current: VirtualDecoration[] = [];

  const lineDecorations = (row: number): VirtualDecoration[] => {
    const buffer = terminal.buffer.active;
    if (!enabled || buffer.type !== 'normal') return [];
    const line = buffer.getLine(row);
    if (!line) return [];
    let text = '';
    const columns: number[] = [];
    const widths: number[] = [];
    const plain: boolean[] = [];
    let mask = '';
    for (let x = 0; x < line.length; x++) {
      cell = line.getCell(x, cell);
      if (!cell) break;
      const width = cell.getWidth();
      if (width === 0) continue; // trailing half of a wide (CJK) character
      const chars = cell.getChars() || ' ';
      const isPlain = cell.isFgDefault() && !cell.isInverse() && !cell.isInvisible();
      for (let unit = 0; unit < chars.length; unit++) {
        columns.push(x);
        widths.push(width);
        plain.push(isPlain);
      }
      text += chars;
      mask += isPlain ? '1' : '0';
    }
    if (!text.trim()) return [];
    const key = `${text}\u0000${mask}`;
    let matches = cache.get(key);
    if (!matches) {
      matches = findMatches(text, plain);
      if (cache.size > 4000) cache.clear();
      cache.set(key, matches);
    }
    return matches.map(match => {
      const x = columns[match.start];
      return {
        options: { x, width: columns[match.end - 1] + widths[match.end - 1] - x, layer: 'bottom' as const },
        foregroundColorRGB: palette[match.kind],
      };
    });
  };

  type Service = {
    forEachDecorationAtCell: (
      x: number,
      line: number,
      layer: 'bottom' | 'top' | undefined,
      callback: (decoration: unknown) => void,
    ) => void;
  };
  const service = decorationService<Service>(terminal);
  const original = service?.forEachDecorationAtCell;
  if (service && original) {
    service.forEachDecorationAtCell = function (x, line, layer, callback) {
      if (layer !== 'top') {
        // A new row, or the same row built again (x back at the start; each cell is asked twice).
        if (line !== currentRow || x < lastX) {
          currentRow = line;
          current = lineDecorations(line);
        }
        lastX = x;
        // Keyword colours first: real decorations (same-text marks, selection …) are drawn over them.
        for (const decoration of current)
          if (x >= decoration.options.x && x < decoration.options.x + decoration.options.width) callback(decoration);
      }
      original.call(this, x, line, layer, callback);
    };
  }

  const redraw = () => {
    currentRow = -1;
    invalidateRows(terminal);
    terminal.refresh(0, terminal.rows - 1);
  };

  return {
    /** Switch colors (app theme changed). */
    setColors(next: TerminalScheme['highlight']) {
      colors = next;
      palette = Object.fromEntries(Object.entries(colors).map(([kind, css]) => [kind, toColor(css)])) as Record<
        HighlightKind,
        { css: string; rgba: number }
      >;
      redraw();
    },
    setEnabled(value: boolean) {
      enabled = value;
      redraw();
    },
    dispose() {
      if (service && original) service.forEachDecorationAtCell = original;
      cache.clear();
    },
  };
}
