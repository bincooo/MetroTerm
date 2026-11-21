import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText, log } from '../lib/log';
import { flushSync } from 'react-dom';
import { Terminal, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Connection, ThemeMode } from '../types';
import { backend, terminalRegistry, toSpec, type BackendEvent } from '../lib/backend';
import { isWindowsHost } from '../lib/hostOs';
import { attachHighlighter, TERMINAL_SCHEMES } from '../lib/terminalScheme';
import { ContextMenu, type MenuItem } from './MenuButton';
import { attachImeInput, isImeKey } from '../lib/imeInput';
import { attachBoxGlyphs } from '../lib/boxGlyphs';
import { attachExactCharWidths } from '../lib/exactCharWidths';
import { attachDomRendererSpeedups, screenRows } from '../lib/domRendererSpeed';
import { attachTextCentering, centringOffset } from '../lib/textCentering';
import { DEFAULT_TERMINAL_PREFS, TERMINAL_FONT_STACK, withFallback, type CursorShape, type TerminalPrefs } from '../lib/preferences';
import { describeConnection, transportName } from '../lib/transports';
import { densityLineHeight } from '../lib/rowDensity';
import { parseOsc7, parseOsc9, registerTerminal } from '../lib/terminalCwd';
import { attachSelectionMatches, type MatchColors } from '../lib/selectionMatches';
import { onViewportScroll } from '../lib/viewportScroll';
import { attachFind, type FindColors, type FindState } from '../lib/terminalFind';
import { Icon } from './Icon';
import { renderDimensions, xtermViewport } from '../lib/xtermInternals';
import { t } from '../i18n';
import { FILE_DROP_EVENT, shellQuote, type FileDrop } from '../lib/fileDrop';

/** Unfocused cursor: the block becomes a hollow box (`outline`); a bar / underline keeps its shape (steady). */
const inactiveCursor = (shape: CursorShape) => (shape === 'block' ? 'outline' : shape);
/** Put the Preferences cursor (shape + blinking) on a terminal; unchanged options are not touched. */
const applyCursor = (terminal: Terminal, prefs: Pick<TerminalPrefs, 'cursorBlink' | 'cursorStyle'>) => {
  const inactive = inactiveCursor(prefs.cursorStyle);
  if (terminal.options.cursorBlink !== prefs.cursorBlink) terminal.options.cursorBlink = prefs.cursorBlink;
  if (terminal.options.cursorStyle !== prefs.cursorStyle) terminal.options.cursorStyle = prefs.cursorStyle;
  if (terminal.options.cursorInactiveStyle !== inactive) terminal.options.cursorInactiveStyle = inactive;
};

/** Find frames: the current match in the theme foreground, the others ("Find all") in a mid grey. */
const FIND_COLORS: Record<ThemeMode, FindColors> = {
  // Soft 1px frames: the current match a step brighter (dark) / darker (light) than the others.
  dark: { current: '#9a9a9a', other: '#5e5e5e' },
  light: { current: '#707070', other: '#a8a8a8' },
  gold: { current: '#c9a54e', other: '#6b5a33' },
};

/** Other occurrences of the selected text: neutral grey, no outline, subtler than the selection in
 * both themes (dark: darker than the light-grey selection; light: a pale grey, lighter than it). */
const MATCH_COLORS: Record<ThemeMode, MatchColors> = {
  dark: { background: '#3a3a3a' },
  light: { background: '#e2e2e2' },
  gold: { background: '#3a3324' },
};

/** Settings → FONTS → terminal font, the built-in stack behind it. */
const terminalFont = (family: string) => withFallback(family, TERMINAL_FONT_STACK);

/** Clipboard write with a fallback for non-secure pages (plain http preview). */
const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall back below */
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const done = document.execCommand('copy');
  field.remove();
  return done;
};

type Props = {
  /** Terminal tab id (stable for the lifetime of the tab). */
  tabId: string;
  connection: Connection;
  theme: ThemeMode;
  /** Incremented by the app to force a reconnect (Explorer "Reconnect"). */
  reconnectToken?: number;
  /** The visible tab: gets keyboard focus when it is opened or activated. */
  active?: boolean;
  /** Session items appended to the terminal's right-click menu (provided by the app). */
  /** Extra context-menu entries (session / pane commands), built when the menu opens. */
  menuItems?: (tabId: string) => MenuItem[];
  /** The visible tab reports its size and cursor position (status bar). */
  onCursor?: (tabId: string, info: CursorInfo) => void;
  /** Font size, scrollback and cursor blink (Preferences → Settings…); applied in place. */
  prefs?: TerminalPrefs;
};

export type CursorInfo = { cols: number; rows: number; line: number; column: number };

type SessionState = 'connecting' | 'online' | 'closed' | 'error' | 'preview';

const prompt = '\u001b[38;5;244m>\u001b[0m ';
/** Light theme: map the 256-color codes used by the demo shell to ANSI codes, so the light palette applies. */
const LIGHT_CODES: Record<string, string> = { '38;5;244': '90', '38;5;76': '32', '38;5;75': '34', '38;5;204': '31' };
const forTheme = (text: string, theme: ThemeMode) =>
  theme === 'light'
    ? text.replace(/\u001b\[(38;5;\d+)m/g, (match, code: string) => (LIGHT_CODES[code] ? `\u001b[${LIGHT_CODES[code]}m` : match))
    : text;
const shellBanner = (connection: Connection) =>
  [
    '\u001b[38;5;244mStatic preview — no backend is running, this terminal is simulated.\u001b[0m',
    '\u001b[38;5;244mDesktop: npm run tauri dev · Browser: npm run server + npm run dev\u001b[0m',
    '',
    `\u001b[38;5;76m${connection.username}@${connection.host}\u001b[0m \u001b[38;5;244m~\u001b[0m`,
    prompt,
  ].join('\r\n');

const DIM = '\u001b[90m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

const themes = { dark: TERMINAL_SCHEMES.dark.theme, light: TERMINAL_SCHEMES.light.theme, gold: TERMINAL_SCHEMES.gold.theme };

const stateLabel = (state: SessionState, connection: Connection) => {
  const transport = connection.transport === 'local' ? t('PTY') : transportName(connection.transport).toUpperCase();
  switch (state) {
    case 'connecting':
      return t('CONNECTING');
    case 'online':
      return `${transport} / LIVE`;
    case 'closed':
      return `${transport} / CLOSED`;
    case 'error':
      return `${transport} / ERROR`;
    default:
      return t('PREVIEW / SIMULATED');
  }
};

/**
 * Memoized (rerender-memo): App re-renders on every cursor move (status bar Ln / Ch) and each keystroke in
 * its dialogs; a terminal only re-renders when its own props change. Props must stay referentially stable —
 * App passes `menuItems` as a stable callback and zoomed prefs from a memoized map.
 */
export default memo(function TerminalView({
  tabId,
  connection,
  theme,
  reconnectToken = 0,
  active = true,
  menuItems,
  onCursor,
  prefs = DEFAULT_TERMINAL_PREFS,
}: Props) {
  // Re-render on a language change (memo would otherwise keep the old labels).
  useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number; line: string; hasLine: boolean } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [state, setState] = useState<SessionState>(backend.live ? 'connecting' : 'preview');
  const [size, setSize] = useState({ cols: 0, rows: 0 });
  const [gutter, setGutter] = useState<{
    rowHeight: number;
    rows: { time: string; line: string; current?: boolean; picked?: boolean }[];
    digits: number;
  }>({ rowHeight: 17, rows: [], digits: 3 });
  // Latest props for the long-lived terminal effect (no re-creation on rename / theme / callback change).
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const refitRef = useRef<() => void>(() => undefined);
  const highlighterRef = useRef<ReturnType<typeof attachHighlighter> | null>(null);
  const selectionMatchesRef = useRef<ReturnType<typeof attachSelectionMatches> | null>(null);
  // ---------- find (Ctrl+F / header Find button) ----------
  const findRef = useRef<ReturnType<typeof attachFind> | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findState, setFindState] = useState<FindState>({ query: '', count: 0, index: -1, capped: false, all: false, version: 0 });
  const pickLineRef = useRef<(line: number) => void>(() => undefined);
  const openFind = () => {
    // Selected text (one line) becomes the search text.
    const selection = terminalRef.current?.hasSelection() ? terminalRef.current.getSelection() : '';
    const useSelection = Boolean(selection) && !/[\r\n]/.test(selection) && selection.length <= 200;
    // Rendered and focused right now: keys typed straight after Ctrl+F must reach the find box,
    // not the shell.
    flushSync(() => {
      setFindOpen(true);
      if (useSelection) setFindText(selection);
    });
    findRef.current?.setActive(true);
    if (useSelection) findRef.current?.search(selection);
    findInputRef.current?.focus();
    findInputRef.current?.select();
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;
  const closeFind = () => {
    setFindOpen(false);
    findRef.current?.setActive(false);
    terminalRef.current?.focus();
  };
  const restartRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const reportCursorRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    const live = backend.live;
    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: prefsRef.current.cursorBlink,
      cursorStyle: prefsRef.current.cursorStyle,
      cursorInactiveStyle: inactiveCursor(prefsRef.current.cursorStyle),
      fontFamily: terminalFont(prefsRef.current.fontFamily),
      fontSize: prefsRef.current.fontSize,
      lineHeight: densityLineHeight(terminalFont(prefsRef.current.fontFamily), prefsRef.current.fontSize),
      letterSpacing: 0.15,
      // No bold glyphs: bold (SGR 1) text keeps the regular weight (it still gets the bright colour).
      fontWeight: 'normal',
      fontWeightBold: 'normal',
      scrollback: prefsRef.current.scrollback,
      // A real PTY already sends CR LF; only the simulated preview needs LF → CR LF.
      convertEol: !live,
      allowProposedApi: true,
      theme: themes[themeRef.current],
    });
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    // The native scrollbar is hidden and replaced by the app's own bar (lib/customScrollbars).
    // xterm would otherwise subtract a guessed native width (0–15px depending on the browser)
    // from the columns; the bar's space is reserved by `.xterm { padding-right }` instead.
    const viewport = xtermViewport(terminal);
    if (viewport && typeof viewport.scrollBarWidth === 'number') viewport.scrollBarWidth = 0;
    terminalRef.current = terminal;
    const highlighter = attachHighlighter(terminal, TERMINAL_SCHEMES[themeRef.current].highlight);
    highlighterRef.current = highlighter;
    const selectionMatches = attachSelectionMatches(terminal, MATCH_COLORS[themeRef.current]);
    selectionMatchesRef.current = selectionMatches;
    const find = attachFind(terminal, {
      colors: FIND_COLORS[themeRef.current],
      onFocusLine: line => pickLineRef.current(line),
      onChange: setFindState,
    });
    findRef.current = find;
    // Chinese / Japanese / Korean input methods: committed text is sent exactly once (lib/imeInput).
    const ime = attachImeInput(terminal);
    // Table borders and block characters connect across rows despite the line height (lib/boxGlyphs).
    const boxGlyphs = attachBoxGlyphs(terminal);
    // Text stays on the cell grid along the whole line, Chinese included (lib/exactCharWidths).
    const exactWidths = attachExactCharWidths(terminal);
    // Smooth scrolling: rows rendered once per step, with far fewer spans (lib/domRendererSpeed).
    attachDomRendererSpeedups(terminal);
    // Letters centred in the row like the cursor and table borders (lib/textCentering).
    const textCentering = attachTextCentering(terminal);

    // ---------- session ----------
    let generation = 0;
    let sessionId = '';
    let sessionState: SessionState = live ? 'connecting' : 'preview';
    // Current directory for the Filer ("Terminal folder" / "Follow terminal", lib/terminalCwd):
    // OSC 7 reports from the shell, plus a backend lookup after each command line.
    const cwdWatch = registerTerminal(tabId, () => (sessionState === 'online' ? sessionId : ''));
    const osc7 = terminal.parser.registerOscHandler(7, data => {
      const path = parseOsc7(data);
      if (path) cwdWatch.osc(path);
      return true;
    });
    const osc9 = terminal.parser.registerOscHandler(9, data => {
      const path = parseOsc9(data);
      if (path) cwdWatch.osc(path);
      return Boolean(path);
    });
    // The cursor follows Preferences only. xterm 5.5 lets programs rewrite the options themselves:
    // DECSET / DECRST 12 (`ESC[?12h` / `ESC[?12l`, sent by `tput cvvis` / `tput cnorm`, vim, less …)
    // set `cursorBlink`, DECSCUSR (`ESC[n q`) sets `cursorStyle` + `cursorBlink`. The handlers let
    // xterm run its own code (return false) and put the preferences back before the next render.
    let pinQueued = false;
    const pinCursor = () => {
      if (pinQueued) return;
      pinQueued = true;
      queueMicrotask(() => {
        pinQueued = false;
        if (disposed) return;
        applyCursor(terminal, prefsRef.current);
      });
    };
    const blinkMode = (params: (number | number[])[]) => {
      if (params.some(param => param === 12)) pinCursor();
      return false;
    };
    const cursorModes = [
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, blinkMode),
      terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, blinkMode),
      terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, () => {
        pinCursor();
        return false;
      }),
    ];
    const setSession = (next: SessionState) => {
      sessionState = next;
      if (next !== 'connecting' && next !== 'online') releaseSize();
      if (!disposed) setState(next);
    };
    let lastSize = '';

    // Startup hold: from terminal.start until the shell's first output has gone quiet, xterm keeps
    // the size the PTY was created with. A resize in between would reach the shell only after it
    // has already drawn its first prompt for the old width; zsh's PROMPT_SP marker (an inverse
    // "%" padded to the line width) then wraps and stays on the first line. Afterwards xterm
    // fits, the PTY is resized and the shell simply redraws its prompt.
    const STARTUP_QUIET = 120;
    const STARTUP_MAX = 2000;
    let holdSize = false;
    let quietTimer = 0;
    let maxTimer = 0;
    const releaseSize = () => {
      window.clearTimeout(quietTimer);
      window.clearTimeout(maxTimer);
      if (!holdSize) return;
      holdSize = false;
      fit();
    };
    const holdOutput = () => {
      if (!holdSize) return;
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(releaseSize, STARTUP_QUIET);
    };

    // Typed text is debounced into one write per short window: fast typing, key repeat and an
    // input method committing several characters reach the backend as one message instead of one
    // per key (fewer WebSocket frames, PTY writes and echo bursts). The window is bounded from the
    // first key (INPUT_WINDOW ms, below one frame), so typing feels no slower. Enter, Tab, Ctrl
    // keys, Esc / arrow sequences, pastes and input-method commits are sent at once, together with anything still waiting,
    // so commands, completion and Ctrl+C never wait. Writes go out without waiting for the previous
    // reply: the WebSocket keeps them in order and the backend handles terminal.write / resize
    // strictly in arrival order.
    const INPUT_WINDOW = 8;
    const INPUT_MAX = 4096;
    const IMMEDIATE = /[\x00-\x1f]/; // control characters (CR, Tab, Ctrl+…, ESC sequences); DEL / Backspace is batched like text
    let queue = '';
    let inputTimer = 0;
    const flush = () => {
      window.clearTimeout(inputTimer);
      inputTimer = 0;
      if (!queue || sessionState !== 'online') {
        queue = '';
        return;
      }
      const data = queue;
      queue = '';
      void backend.call('terminal.write', { sessionId, data }).catch(() => undefined); // session ended; exit event follows
    };
    const send = (data: string, immediate = false) => {
      if (sessionState !== 'online') return;
      cwdWatch.input(data);
      queue += data;
      // Several characters at once (a paste, an input-method commit) are already one write.
      if (immediate || data.length > 1 || IMMEDIATE.test(data) || queue.length >= INPUT_MAX) flush();
      else if (!inputTimer) inputTimer = window.setTimeout(flush, INPUT_WINDOW);
    };

    // Redraw hold: one resize at a time. After a resize reaches the PTY the shell redraws its
    // prompt / input line for the new width (bash / zsh on SIGWINCH). Until that redraw has
    // arrived, xterm keeps its size: a further resize (dragging a handle) would reflow the screen
    // under the shell's redraw, which was computed for the previous width, and every step would
    // leave a copy of the wrapped input line behind. Further resizes are coalesced into one fit
    // after the shell's output has gone quiet.
    const REDRAW_FIRST = 300; // no output at all (program that ignores SIGWINCH)
    const REDRAW_QUIET = 40;
    const REDRAW_MAX = 600; // continuous output (top, a build log …)
    // Debounce: while a handle is dragged (or the window resized) xterm keeps its size; it fits
    // once the size has stopped changing for RESIZE_DEBOUNCE ms. The shell gets a single resize
    // per drag and redraws its input line once.
    const RESIZE_DEBOUNCE = 150;
    let debounceTimer = 0;
    let redrawHold = false;
    let fitPending = false;
    let redrawTimer = 0;
    let redrawMaxTimer = 0;
    const endRedrawHold = () => {
      window.clearTimeout(redrawTimer);
      window.clearTimeout(redrawMaxTimer);
      if (!redrawHold) return;
      redrawHold = false;
      if (fitPending) {
        fitPending = false;
        fit();
      }
    };
    const startRedrawHold = () => {
      redrawHold = true;
      window.clearTimeout(redrawTimer);
      window.clearTimeout(redrawMaxTimer);
      redrawTimer = window.setTimeout(endRedrawHold, REDRAW_FIRST);
      redrawMaxTimer = window.setTimeout(endRedrawHold, REDRAW_MAX);
    };
    const redrawOutput = () => {
      if (!redrawHold) return;
      window.clearTimeout(redrawTimer);
      redrawTimer = window.setTimeout(endRedrawHold, REDRAW_QUIET);
    };

    const syncSize = (force = false) => {
      const key = `${terminal.cols}x${terminal.rows}`;
      if (!disposed) setSize({ cols: terminal.cols, rows: terminal.rows });
      if (sessionState !== 'online' || (!force && key === lastSize)) return;
      lastSize = key;
      startRedrawHold();
      void backend.call('terminal.resize', { sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    };

    const start = async () => {
      const current = connectionRef.current;
      const id = `${tabId}#${++generation}`;
      sessionId = id;
      queue = '';
      setSession('connecting');
      holdSize = true;
      lastSize = `${terminal.cols}x${terminal.rows}`; // the size the PTY is created with
      if (current.transport === 'ssh')
        terminal.write(
          `${DIM}Connecting to ${current.username ? `${current.username}@` : ''}${current.host}:${current.port || 22} …${RESET}\r\n`,
        );
      else if (current.transport !== 'local')
        terminal.write(
          `${DIM}${current.transport === 'serial' ? 'Opening' : 'Connecting to'} ${describeConnection(current)} …${RESET}\r\n`,
        );
      log.info(t('{{name}} · connecting…', { name: current.name }));
      try {
        await backend.call('terminal.start', { sessionId: id, connection: toSpec(current), cols: terminal.cols, rows: terminal.rows });
        if (disposed || sessionId !== id) {
          void backend.call('terminal.close', { sessionId: id }).catch(() => undefined);
          return;
        }
        setSession('online');
        cwdWatch.started();
        syncSize();
        // Release at the latest after STARTUP_MAX (a shell that prints nothing at all).
        window.clearTimeout(maxTimer);
        maxTimer = window.setTimeout(releaseSize, STARTUP_MAX);
        log.info(
          current.transport === 'local'
            ? t('{{name}} · local shell connected', { name: current.name })
            : t('{{name}} · {{type}} session connected', { name: current.name, type: transportName(current.transport) }),
        );
      } catch (error) {
        if (disposed || sessionId !== id) return;
        setSession('error');
        const message = errorText(error);
        terminal.write(`\r\n${RED}✗ ${message}${RESET}\r\n${DIM}Press Enter to retry.${RESET}\r\n`);
        log.error(`${current.name} · ${message}`);
      }
    };
    const stop = () => {
      if (!sessionId) return;
      const id = sessionId;
      sessionId = '';
      if (sessionState === 'online' || sessionState === 'connecting')
        void backend.call('terminal.close', { sessionId: id }).catch(() => undefined);
    };
    restartRef.current = () => {
      if (!live || disposed) return;
      stop();
      terminal.write(`\r\n${DIM}── reconnecting ──${RESET}\r\n`);
      void start();
    };

    const offEvents = live
      ? backend.on((event: BackendEvent) => {
          if (event.type === 'terminal.data' && event.sessionId === sessionId) {
            terminal.write(event.data, redrawOutput);
            holdOutput();
            cwdWatch.output();
          } // redraw hold: count from when xterm has parsed it
          else if (event.type === 'terminal.exit' && event.sessionId === sessionId) {
            setSession('closed');
            const detail = event.reason ?? (event.code !== null ? t('exit code {{code}}', { code: event.code }) : 'closed');
            terminal.write(`\r\n${DIM}[Session ended · ${detail}] Press Enter to reconnect.${RESET}\r\n`);
            log.info(t('{{name}} · session ended ({{detail}})', { name: connectionRef.current.name, detail }));
          } else if (event.type === 'backend.closed' && (sessionState === 'online' || sessionState === 'connecting')) {
            setSession('error');
            terminal.write(`\r\n${RED}✗ ${event.message}${RESET}\r\n`);
          }
        })
      : () => undefined;

    refitRef.current = () => {
      fit();
      updateGutter();
    };
    const requestFit = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = 0;
        fit();
      }, RESIZE_DEBOUNCE);
    };
    const fit = () => {
      try {
        if (!hostRef.current?.clientHeight) return; // hidden tab
        if (live && holdSize) return; // startup hold, see releaseSize
        if (live && redrawHold) {
          fitPending = true;
          return;
        } // see startRedrawHold
        fitAddon.fit();
        syncSize();
      } catch {
        /* Panel may be temporarily hidden during rearrange. */
      }
    };
    // Start the PTY only once the terminal has its real, settled size: fonts loaded, the panel
    // visible (a hidden tab waits until it is shown) and the same cols × rows for two frames.
    const waitForStableSize = async () => {
      try {
        await document.fonts?.ready;
      } catch {
        /* no font loading API */
      }
      let last = '';
      let stable = 0;
      while (!disposed) {
        const host = hostRef.current;
        const dims = host?.clientWidth && host.clientHeight ? fitAddon.proposeDimensions() : undefined;
        if (!dims || !dims.cols || !dims.rows || Number.isNaN(dims.cols)) {
          last = '';
          stable = 0;
          await new Promise(resolve => window.setTimeout(resolve, 100));
          continue;
        }
        const key = `${dims.cols}x${dims.rows}`;
        if (key === last) {
          if (++stable >= 2) return;
        } else {
          last = key;
          stable = 0;
        }
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    };
    void (async () => {
      if (live) await waitForStableSize();
      if (disposed) return;
      try {
        if (hostRef.current?.clientHeight) fitAddon.fit();
      } catch {
        /* hidden */
      }
      syncSize();
      if (live) void start();
    })();

    // Line-number gutter: one label per visible row, synced with the xterm viewport.
    // Soft-wrapped continuation rows get an empty label, like a code editor.
    // Each logical line is stamped with the time it started. xterm markers follow the
    // line when the buffer scrolls and are disposed automatically when scrollback trims it.
    const lineTimes: { marker: IMarker; time: string }[] = [];
    const now = () => new Date().toTimeString().slice(0, 8);
    /** Stamp a normal-buffer row (`offset` rows from the cursor row) with the current time. */
    const stampLine = (offset = 0) => {
      if (terminal.buffer.active.type !== 'normal') return;
      const marker = terminal.registerMarker(offset);
      if (!marker) return;
      const entry = { marker, time: now() };
      // A line written again (a program redrawing in place, e.g. a spinner) keeps only its newest
      // stamp, so redraws don't pile up markers. Recent entries are enough to find it.
      for (let index = lineTimes.length - 1; index >= Math.max(0, lineTimes.length - 256); index--) {
        if (lineTimes[index].marker.line === marker.line) lineTimes[index].marker.dispose();
      }
      lineTimes.push(entry);
      marker.onDispose(() => {
        const index = lineTimes.indexOf(entry);
        if (index >= 0) lineTimes.splice(index, 1);
      });
    };
    // Full-screen programs (vim, less, htop, Claude Code …) draw on the alternate screen by moving
    // the cursor, with few or no line feeds, and that screen has no scrollback: each row there shows
    // the time its content last changed (the time the screen was entered at first).
    let altRows: { text: string; time: string }[] = [];
    const bufferChange = terminal.buffer.onBufferChange(() => {
      altRows = [];
      updateGutter();
    });
    const lineFeed = terminal.onLineFeed(() => stampLine());
    // Click a line → it is highlighted: a band across the whole terminal width (under the text) and
    // its gutter row. An xterm marker keeps it on that line while output scrolls; a soft-wrapped line
    // is highlighted as a whole. Clicking below the last line clears it. Normal screen only (not vim/less).
    let picked: IMarker | null = null;
    const band = document.createElement('div');
    band.className = 'terminal-line-highlight';
    band.hidden = true;
    const screenElement = terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
    if (terminal.element && screenElement) terminal.element.insertBefore(band, screenElement);
    const lastContentLine = () => {
      const buffer = terminal.buffer.active;
      const cursorLine = buffer.baseY + buffer.cursorY;
      let last = buffer.length - 1;
      while (last > cursorLine && !buffer.getLine(last)?.translateToString(true)) last--;
      return last;
    };
    const pickedRange = (): [number, number] | null => {
      const buffer = terminal.buffer.active;
      if (!picked || picked.isDisposed || picked.line < 0 || buffer.type !== 'normal') return null;
      let start = picked.line;
      while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
      let end = picked.line;
      while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;
      return [start, end];
    };
    const placeBand = (range: [number, number] | null, rowHeight: number) => {
      const buffer = terminal.buffer.active;
      const first = range ? Math.max(range[0], buffer.viewportY) : 0;
      const last = range ? Math.min(range[1], buffer.viewportY + terminal.rows - 1) : -1;
      band.hidden = !screenElement || first > last;
      if (band.hidden || !screenElement) {
        hideGutterBand();
        return;
      }
      // Placed on the rendered rows themselves: offsetTop and a computed row height are rounded
      // (to whole pixels / the layout grid) and put the band up to a pixel off the text and the
      // gutter at display scaling.
      const parent = band.offsetParent as HTMLElement | null;
      const parentTop = parent ? parent.getBoundingClientRect().top + parent.clientTop : 0;
      const rowElements = screenRows(terminal); // screen order (the row pool keeps DOM order otherwise)
      const firstRow = rowElements?.[first - buffer.viewportY];
      const lastRow = rowElements?.[last - buffer.viewportY];
      let top: number;
      let height: number;
      if (parent && firstRow && lastRow) {
        top = firstRow.getBoundingClientRect().top;
        height = lastRow.getBoundingClientRect().bottom - top;
      } else {
        top = screenElement.getBoundingClientRect().top + (first - buffer.viewportY) * rowHeight;
        height = (last - first + 1) * rowHeight;
      }
      band.style.top = `${top - parentTop}px`;
      band.style.height = `${height}px`;
      // The gutter's part of the highlight is the same strip, from the very same numbers: it used to be
      // the gutter rows' own background, laid out by a separate calculation (row height × index +
      // shift), which could end up a few pixels off the band after scrolling.
      const gutterElement = gutterRef.current;
      const strip = gutterBandRef.current;
      if (gutterElement && strip) {
        const gutterTop = gutterElement.getBoundingClientRect().top + gutterElement.clientTop - gutterElement.scrollTop;
        strip.style.top = `${top - gutterTop}px`;
        strip.style.height = `${height}px`;
        strip.style.display = 'block';
      }
    };
    const hideGutterBand = () => {
      if (gutterBandRef.current) gutterBandRef.current.style.display = 'none';
    };
    let pointerDown: { x: number; y: number } | null = null;
    const onPointerDown = (event: MouseEvent) => {
      pointerDown = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const onPointerUp = (event: MouseEvent) => {
      const start = pointerDown;
      pointerDown = null;
      // A drag selects text: only a click (no movement) picks a line.
      if (!start || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) return;
      const buffer = terminal.buffer.active;
      if (buffer.type !== 'normal' || !screenElement?.clientHeight || !terminal.rows) return;
      const rect = screenElement.getBoundingClientRect();
      const row = Math.max(0, Math.min(terminal.rows - 1, Math.floor((event.clientY - rect.top) / (rect.height / terminal.rows))));
      const line = buffer.viewportY + row;
      picked?.dispose();
      picked = line <= lastContentLine() ? (terminal.registerMarker(line - (buffer.baseY + buffer.cursorY)) ?? null) : null;
      updateGutter();
    };
    terminal.element?.addEventListener('mousedown', onPointerDown);
    terminal.element?.addEventListener('mouseup', onPointerUp);
    // Find: the current match's line is highlighted like a clicked line.
    pickLineRef.current = (line: number) => {
      const buffer = terminal.buffer.active;
      if (buffer.type !== 'normal') return;
      picked?.dispose();
      picked = terminal.registerMarker(line - (buffer.baseY + buffer.cursorY)) ?? null;
      updateGutter();
    };

    let cursorInfo: CursorInfo | null = null;
    let reported = '';
    const reportCursor = () => {
      if (!activeRef.current || !cursorInfo) return;
      const key = `${tabId}|${cursorInfo.cols}|${cursorInfo.rows}|${cursorInfo.line}|${cursorInfo.column}`;
      if (key === reported) return;
      reported = key;
      cursorRef.current?.(tabId, cursorInfo);
    };
    reportCursorRef.current = () => {
      reported = '';
      reportCursor();
    };
    const cursorMove = terminal.onCursorMove(() => updateGutter());
    let gutterFrame = 0;
    const updateGutter = () => {
      if (gutterFrame) return;
      gutterFrame = requestAnimationFrame(() => {
        gutterFrame = 0;
        if (disposed) return;
        const buffer = terminal.buffer.active;
        const screen = hostRef.current?.querySelector<HTMLElement>('.xterm-screen');
        // Hidden terminal (inactive tab): keep the last gutter, refresh when shown again.
        if (!screen?.clientHeight) return;
        // Row height exactly as xterm lays the rows out (fractional at display scaling or with some
        // fonts). clientHeight / rows was rounded: the gutter rows were then slightly taller than the
        // terminal rows and drifted down, line by line, from the text and the highlight band.
        const cellHeight = renderDimensions(terminal)?.css?.cell?.height;
        const rowHeight = cellHeight && cellHeight > 0 ? cellHeight : terminal.rows ? screen.clientHeight / terminal.rows : 17;
        // The gutter's first row starts exactly where the terminal's first row does (CSS padding alone
        // can differ by a fraction of a pixel once the browser snaps the boxes to device pixels).
        const gutterElement = gutterRef.current;
        if (gutterElement) {
          const style = getComputedStyle(gutterElement);
          const shift =
            screen.getBoundingClientRect().top -
            (gutterElement.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0));
          gutterElement.style.setProperty('--gutter-shift', `${Math.abs(shift) < 0.01 ? 0 : Math.round(shift * 1000) / 1000}px`);
        }
        const cursorLine = buffer.baseY + buffer.cursorY;
        // The cursor's logical line starts at the first non-wrapped row above it.
        let cursorStart = cursorLine;
        while (cursorStart > 0 && buffer.getLine(cursorStart)?.isWrapped) cursorStart--;
        const lastLine = lastContentLine();
        const range = pickedRange();
        placeBand(range, rowHeight);
        // Logical line number = count of non-wrapped rows up to each row.
        const timeByLine = new Map<number, string>();
        const end = Math.min(buffer.viewportY + terminal.rows, lastLine + 1);
        if (buffer.type === 'alternate') {
          const stamp = now();
          for (let row = 0; row < terminal.rows; row++) {
            const text = buffer.getLine(row)?.translateToString(true) ?? '';
            if (!altRows[row]) altRows[row] = { text, time: stamp };
            else if (altRows[row].text !== text) altRows[row] = { text, time: stamp };
            timeByLine.set(row, altRows[row].time);
          }
        } else {
          lineTimes.forEach(({ marker, time }) => timeByLine.set(marker.line, time)); // newest stamp wins
          // Rows a program reached by moving the cursor (no line feed) get stamped when first shown,
          // so every line has its time. Only while following the output, not while scrolled back.
          if (buffer.viewportY === buffer.baseY) {
            for (let row = buffer.viewportY; row < end; row++) {
              if (timeByLine.has(row) || buffer.getLine(row)?.isWrapped) continue;
              stampLine(row - cursorLine);
              timeByLine.set(row, now());
            }
          }
        }
        let logical = 0;
        let cursorLogical = 0;
        const rows: { time: string; line: string; current?: boolean; picked?: boolean }[] = [];
        for (let row = 0; row < end; row++) {
          const wrapped = buffer.getLine(row)?.isWrapped ?? false;
          if (!wrapped) logical++;
          if (row === cursorStart) cursorLogical = logical;
          const isPicked = !!range && row >= range[0] && row <= range[1];
          if (row >= buffer.viewportY)
            rows.push(
              wrapped
                ? { time: '', line: '', picked: isPicked }
                : { time: timeByLine.get(row) ?? '', line: String(logical), current: row === cursorStart, picked: isPicked },
            );
        }
        // Committed now, in this frame: a plain setState from rAF is rendered by React after the
        // browser has painted, so while scrolling the numbers trailed the rows by a frame.
        // Width from the whole buffer, not from the lines in view: a width that changed while scrolling
        // (e.g. 999 → 1000) resized the terminal, which re-rendered and re-wrapped every row.
        flushSync(() => setGutter({ rowHeight, rows, digits: Math.max(3, String(buffer.length).length) }));
        // Status bar: the cursor's line (same number as the gutter) and column within that logical line.
        if (!cursorLogical) {
          cursorLogical = logical;
          for (let row = end; row <= cursorStart; row++) if (!buffer.getLine(row)?.isWrapped) cursorLogical++;
        }
        cursorInfo = {
          cols: terminal.cols,
          rows: terminal.rows,
          line: cursorLogical,
          column: (cursorLine - cursorStart) * terminal.cols + buffer.cursorX + 1,
        };
        reportCursor();
      });
    };
    const gutterEvents = [
      terminal.onRender(updateGutter),
      terminal.onScroll(updateGutter),
      onViewportScroll(terminal, updateGutter),
      terminal.onResize(updateGutter),
    ];
    updateGutter();
    resizeObserver = new ResizeObserver(() => {
      requestFit();
      updateGutter();
    });
    resizeObserver.observe(hostRef.current);
    // Anything inside the terminal body that scrolls (the viewport, or a box the browser scrolls to
    // reveal the focused input) moves rows under the highlight: place it again in that frame.
    const body = hostRef.current.parentElement;
    const onBodyScroll = () => updateGutter();
    body?.addEventListener('scroll', onBodyScroll, { capture: true, passive: true });

    // Clipboard: Ctrl+Shift+C copies the selection, Ctrl+Shift+V pastes. Local Mode adds the
    // editor keys: Ctrl+C copies when there is a selection (otherwise it stays SIGINT), Ctrl+V pastes.
    // Remote Mode: no key is taken here, everything goes to the remote side.
    const pasteClipboard = () => {
      // Chrome and WebKitGTK paste on these keys by themselves (a native paste event, which xterm
      // handles). Reading the clipboard as well pasted the text twice; it's only the fallback for a
      // webview that doesn't paste on the key.
      const seen = nativePastes;
      window.setTimeout(() => {
        if (disposed || nativePastes !== seen) return;
        void navigator.clipboard
          ?.readText()
          .then(text => {
            if (text) terminal.paste(text);
          })
          .catch(() => undefined);
      }, 150);
    };
    terminal.attachCustomKeyEventHandler(event => {
      // Input-method keys are handled by lib/imeInput, not by xterm's composition helper.
      if (isImeKey(event)) return false;
      if (prefsRef.current.keyMode === 'remote') return true;
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (!event.shiftKey) {
        // Ctrl+F: find in the terminal (instead of readline's forward-char).
        if (key === 'f') {
          event.preventDefault();
          openFindRef.current();
          return false;
        }
        if (key === 'c' && terminal.hasSelection()) {
          void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined);
          terminal.clearSelection();
          return false;
        }
        if (key === 'v') {
          pasteClipboard();
          return false;
        }
        return true;
      }
      if (key === 'c' && terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined);
        return false;
      }
      if (key === 'v') {
        pasteClipboard();
        return false;
      }
      return true;
    });
    let nativePastes = 0;
    const countPaste = () => {
      nativePastes++;
    };
    terminal.textarea?.addEventListener('paste', countPaste, true);

    const input = terminal.onData(data => {
      if (live) {
        if (sessionState === 'online') send(data);
        else if ((sessionState === 'closed' || sessionState === 'error') && data.includes('\r')) void start();
        return;
      }
      if (data === '\r') {
        terminal.write(
          forTheme('\r\n\u001b[38;5;244mPreview only — start the backend for a real shell or SSH session.\u001b[0m\r\n', themeRef.current),
        );
        terminal.write(forTheme(prompt, themeRef.current));
      } else if (data === '\u007f') {
        terminal.write('\b \b');
      } else if (data >= ' ') {
        terminal.write(data);
      }
    });
    if (!live) {
      terminal.write(forTheme(shellBanner(connectionRef.current), themeRef.current));
      log.info(t('Static preview · terminal simulation active'));
    }
    // Files dropped from the file manager (lib/fileDrop): their paths are typed at the prompt, quoted,
    // separated by spaces, without Enter. The browser gives no paths, only the file names.
    const host = hostRef.current;
    const onFileDrop = (event: Event) => {
      const drop = (event as CustomEvent<FileDrop>).detail;
      const windowsShell = connectionRef.current.transport === 'local' && isWindowsHost();
      const words = (drop.paths.length ? drop.paths : drop.files.map(file => file.name)).map(item => shellQuote(item, windowsShell));
      if (!words.length) return;
      terminal.paste(`${words.join(' ')} `);
      terminal.focus();
    };
    host?.addEventListener(FILE_DROP_EVENT, onFileDrop);
    const unregister = terminalRegistry.register(tabId, {
      write: data => {
        if (live) send(data, true);
        else terminal.write(data.replace(/\r/g, '\r\n'));
      },
      paste: text => terminal.paste(text),
      disconnect: () => {
        if (live && sessionState !== 'online' && sessionState !== 'connecting') return false;
        stop();
        if (live) setSession('closed');
        terminal.write(`\r\n${DIM}[Disconnected] Press Enter to reconnect.${RESET}\r\n`);
        log.info(t('{{name}} · disconnected', { name: connectionRef.current.name }));
        return true;
      },
      selection: () => terminal.getSelection(),
      output: () => {
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (let row = 0; row < buffer.length; row++) {
          const line = buffer.getLine(row);
          if (!line) continue;
          const text = line.translateToString(true);
          if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
          else lines.push(text);
        }
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        return lines.join('\n');
      },
      clear: () => terminal.clear(),
      focus: () => terminal.focus(),
      find: () => openFindRef.current(),
    });

    return () => {
      disposed = true;
      cwdWatch.dispose();
      osc7.dispose();
      osc9.dispose();
      cursorModes.forEach(handler => handler.dispose());
      window.clearTimeout(quietTimer);
      window.clearTimeout(maxTimer);
      window.clearTimeout(redrawTimer);
      window.clearTimeout(redrawMaxTimer);
      window.clearTimeout(debounceTimer);
      unregister();
      host?.removeEventListener(FILE_DROP_EVENT, onFileDrop);
      offEvents();
      stop();
      input.dispose();
      window.clearTimeout(inputTimer);
      gutterEvents.forEach(event => event.dispose());
      lineFeed.dispose();
      bufferChange.dispose();
      cursorMove.dispose();
      terminal.element?.removeEventListener('mousedown', onPointerDown);
      terminal.element?.removeEventListener('mouseup', onPointerUp);
      picked?.dispose();
      band.remove();
      body?.removeEventListener('scroll', onBodyScroll, { capture: true });
      cancelAnimationFrame(gutterFrame);
      resizeObserver?.disconnect();
      ime.dispose();
      boxGlyphs.dispose();
      terminal.textarea?.removeEventListener('paste', countPaste, true);
      exactWidths.dispose();
      textCentering.dispose();
      highlighter.dispose();
      highlighterRef.current = null;
      selectionMatches.dispose();
      selectionMatchesRef.current = null;
      find.dispose();
      findRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [tabId]);

  // A tab that is opened or switched to gets the keyboard, so typing goes straight into it.
  useEffect(() => {
    if (!active) return;
    reportCursorRef.current();
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      // Don't steal focus from a dialog the user is typing in (auth prompt, new session …).
      if (focused?.closest('.modal-backdrop, .file-dialog')) return;
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // …and a tab that stops being the selected one (another pane got the focus, the pane was hidden)
  // drops its focus state. Normally its textarea's blur does that, but WebKit fires no blur when the
  // focused element is hidden (pane fullscreen hides the other panes), so xterm kept its `focus`
  // class — a solid cursor in a pane that no longer has the keyboard, next to the newly focused one.
  useEffect(() => {
    if (active) return;
    const terminal = terminalRef.current;
    const textarea = terminal?.textarea;
    if (!terminal || !textarea) return;
    if (document.activeElement === textarea) terminal.blur();
    else if (terminal.element?.classList.contains('focus')) textarea.dispatchEvent(new FocusEvent('blur'));
  }, [active]);

  // Gutter labels centred in their row like the terminal text (lib/textCentering): a taller or
  // shorter line box moves the digits without changing the row height.
  const gutterRef = useRef<HTMLDivElement>(null);
  const gutterBandRef = useRef<HTMLDivElement>(null);
  const [gutterLine, setGutterLine] = useState<number | null>(null);
  useEffect(() => {
    const element = gutterRef.current;
    if (!element || !gutter.rowHeight) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setGutterLine(gutter.rowHeight + 2 * centringOffset(style.fontFamily, parseFloat(style.fontSize) || 12, gutter.rowHeight));
    };
    measure();
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
    };
  }, [gutter.rowHeight]);

  // Theme switch: recolor in place (the session keeps running).
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = themes[theme];
    highlighterRef.current?.setColors(TERMINAL_SCHEMES[theme].highlight);
    selectionMatchesRef.current?.setColors(MATCH_COLORS[theme]);
    findRef.current?.setColors(FIND_COLORS[theme]);
  }, [theme]);

  // Preferences: font size changes the cell size, so the terminal is refitted (new cols × rows).
  // A different font family changes the cell size as well.
  const { fontSize, scrollback, cursorBlink, cursorStyle, fontFamily } = prefs;
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const font = terminalFont(fontFamily);
    const sizeChanged = terminal.options.fontSize !== fontSize || terminal.options.fontFamily !== font;
    if (sizeChanged) {
      terminal.options.lineHeight = densityLineHeight(font, fontSize);
      terminal.options.fontFamily = font;
      terminal.options.fontSize = fontSize;
    }
    if (terminal.options.scrollback !== scrollback) terminal.options.scrollback = scrollback;
    applyCursor(terminal, { cursorBlink, cursorStyle });
    if (sizeChanged) refitRef.current();
  }, [fontSize, fontFamily, scrollback, cursorBlink, cursorStyle]);

  // Explorer "Reconnect".
  const firstToken = useRef(reconnectToken);
  useEffect(() => {
    if (reconnectToken !== firstToken.current) restartRef.current();
  }, [reconnectToken]);

  // ---------- right-click menu ----------
  /** Text of the logical line (soft-wrapped rows joined) under a viewport row. */
  const lineAt = (clientY: number) => {
    const terminal = terminalRef.current;
    const screen = hostRef.current?.querySelector<HTMLElement>('.xterm-screen');
    if (!terminal || !screen?.clientHeight || !terminal.rows) return null;
    const rect = screen.getBoundingClientRect();
    const buffer = terminal.buffer.active;
    const row = Math.max(0, Math.min(terminal.rows - 1, Math.floor((clientY - rect.top) / (rect.height / terminal.rows))));
    let start = buffer.viewportY + row;
    if (start >= buffer.length) return null;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    let text = buffer.getLine(start)?.translateToString(true) ?? '';
    for (let y = start + 1; y < buffer.length && buffer.getLine(y)?.isWrapped; y++)
      text += buffer.getLine(y)?.translateToString(true) ?? '';
    return text.replace(/\s+$/, '');
  };
  const openMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const line = lineAt(event.clientY);
    setMenu({ x: event.clientX, y: event.clientY, line: line ?? '', hasLine: !!line });
  };
  // The menu took the keyboard: give it back to the terminal, unless something else got it
  // (a dialog opened from the menu, or the user clicked into another field to close it).
  const closeMenu = () => {
    setMenu(null);
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body) terminalRef.current?.focus();
    });
  };
  const terminalMenu = (): MenuItem[] => {
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection() ?? '';
    const refocus = () => requestAnimationFrame(() => terminalRef.current?.focus());
    const copy = (text: string, what: string) => {
      void copyText(text).then(ok => (ok ? log.info(t('{{what}} copied', { what })) : log.warn(t('Clipboard is not available'))));
      refocus();
    };
    const paste = () => {
      const read = navigator.clipboard?.readText?.();
      if (!read) {
        log.warn(t('Clipboard is not available — use Ctrl+Shift+V'));
        refocus();
        return;
      }
      void read
        .then(text => {
          if (text) terminalRef.current?.paste(text);
        })
        .catch(() => log.warn(t('Clipboard access was denied — use Ctrl+Shift+V')))
        .finally(refocus);
    };
    return [
      {
        type: 'item',
        id: 'copy',
        label: t('Copy'),
        icon: 'copy',
        hint: 'Ctrl+Shift+C',
        disabled: !selection,
        onSelect: () => copy(selection, 'Selection'),
      },
      { type: 'item', id: 'paste', label: t('Paste'), hint: 'Ctrl+Shift+V', onSelect: paste },
      {
        type: 'item',
        id: 'paste-selection',
        label: t('Paste Selection'),
        disabled: !selection,
        onSelect: () => {
          terminal?.paste(selection);
          refocus();
        },
      },
      { type: 'item', id: 'copy-line', label: t('Copy Line'), disabled: !menu?.hasLine, onSelect: () => copy(menu?.line ?? '', 'Line') },
      {
        type: 'item',
        id: 'select-all',
        label: t('Select All'),
        onSelect: () => {
          terminal?.selectAll();
          refocus();
        },
      },
      { type: 'separator', id: 'terminal-sep' },
      {
        type: 'item',
        id: 'clear',
        label: t('Clear Scrollback'),
        icon: 'trash',
        onSelect: () => {
          terminal?.clear();
          log.info(t('Scrollback cleared'));
          refocus();
        },
      },
      ...(menuItems ? [{ type: 'separator', id: 'session-sep' } as MenuItem, ...menuItems(tabId)] : []),
    ];
  };

  return (
    <div className="terminal-shell">
      <div className="terminal-meta">
        <span className={`status-dot ${state === 'online' ? 'online' : state === 'preview' ? 'idle' : state === 'error' ? 'error' : ''}`} />
        <span>{stateLabel(state, connection)}</span>
        <span className="terminal-dim">
          UTF-8 · {size.cols} × {size.rows}
        </span>
      </div>
      <div className="terminal-body">
        <div
          className={`terminal-gutter${prefs.gutterTime ? '' : ' no-time'}${prefs.gutterLine ? '' : ' no-line'}`}
          hidden={!prefs.gutterTime && !prefs.gutterLine}
          ref={gutterRef}
          aria-hidden="true"
          style={{ '--line-digits': gutter.digits } as React.CSSProperties}
        >
          {/* Invisible sizing row: the gutter has its final width before the first output, so the
              shell starts with the right number of columns (zsh would otherwise show a stray %). */}
          {/* The clicked line's highlight in the gutter, placed with the terminal's band (placeBand). */}
          <div className="terminal-gutter-band" ref={gutterBandRef} />
          <div className="terminal-gutter-sizer">
            <time>[00:00:00]</time>
            <span>{'0'.repeat(gutter.digits)}</span>
          </div>
          {gutter.rows.map((row, index) => (
            <div
              key={index}
              className={[row.current ? 'is-current' : '', row.picked ? 'is-picked' : ''].filter(Boolean).join(' ') || undefined}
              style={{ height: gutter.rowHeight, lineHeight: `${gutterLine ?? gutter.rowHeight}px` }}
            >
              <time>{row.time && `[${row.time}]`}</time>
              <span>{row.line}</span>
            </div>
          ))}
        </div>
        <div
          className="xterm-host"
          ref={hostRef}
          data-file-drop="terminal"
          data-file-drop-label={t('Drop to insert the path at the prompt')}
          onContextMenu={openMenu}
        />
        {findOpen && (
          <div className="terminal-find" role="search" onMouseDown={event => event.stopPropagation()}>
            <input
              ref={findInputRef}
              value={findText}
              spellCheck={false}
              placeholder={t('Find')}
              aria-label={t('Find in terminal')}
              onChange={event => {
                setFindText(event.target.value);
                findRef.current?.search(event.target.value);
              }}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (event.shiftKey) findRef.current?.previous();
                  else findRef.current?.next();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  closeFind();
                } else if (event.key === 'F3') {
                  event.preventDefault();
                  if (event.shiftKey) findRef.current?.previous();
                  else findRef.current?.next();
                }
              }}
            />
            <span className={`terminal-find-count${findText && !findState.count ? ' is-empty' : ''}`}>
              {!findText
                ? ''
                : findState.count
                  ? `${findState.index + 1}/${findState.count}${findState.capped ? '+' : ''}`
                  : t('No results')}
            </span>
            <button
              title={t('Previous (Shift+Enter)')}
              aria-label={t('Previous match')}
              disabled={!findState.count}
              onClick={() => findRef.current?.previous()}
            >
              <Icon name="arrowUp" />
            </button>
            <button
              title={t('Next (Enter)')}
              aria-label={t('Next match')}
              disabled={!findState.count}
              onClick={() => findRef.current?.next()}
            >
              <Icon name="arrowDown" />
            </button>
            <button
              className={findState.all ? 'is-on' : undefined}
              aria-pressed={findState.all}
              title={findState.all ? t('Find all: on — every match is framed') : t('Find all — frame every match')}
              onClick={() => findRef.current?.setAll(!findState.all)}
            >
              <Icon name="list" />
            </button>
            <button title={t('Close (Esc)')} aria-label={t('Close find')} onClick={closeFind}>
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={terminalMenu()} onClose={closeMenu} />}
    </div>
  );
});
