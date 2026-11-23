import { memo, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { errorText, log } from '../../lib/platform/log';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { acquireWebgl, loseContexts, releaseWebgl, type WebglSlot } from '../../lib/terminal/webglBudget';
import '@xterm/xterm/css/xterm.css';
import type { Connection, ThemeMode } from '../../types';
import { backend, terminalRegistry, toSpec, type BackendEvent } from '../../lib/platform/backend';
import { isWindowsHost } from '../../lib/platform/hostOs';
import { openUrl } from '../../lib/platform/tauri';
import { TERMINAL_SCHEMES } from '../../lib/terminal/scheme';
import { terminalPalette, useTerminalPalette } from '../../lib/terminal/palettes';
import { ContextMenu, type MenuItem } from '../common/MenuButton';
import { DEFAULT_TERMINAL_PREFS, TERMINAL_FONT_STACK, withFallback, type TerminalPrefs } from '../../lib/settings/preferences';
import { describeConnection, transportName } from '../../lib/sessions/transports';
import { parseOsc7, parseOsc9, registerTerminal } from '../../lib/terminal/cwd';
import { attachGutter } from '../../lib/terminal/gutter';
import { guardImeInput } from '../../lib/terminal/imeInput';
import { attachSelectionMarks } from '../../lib/terminal/selectionMarks';
import { attachFind, type FindState } from '../../lib/terminal/find';
import { attachHighlighter } from '../../lib/terminal/highlight';
import { bindingOf, keyHint, matchesKey } from '../../lib/settings/keybindings';
import { lineStart, lineText } from '../../lib/terminal/buffer';
import { Icon } from '../common/Icon';
import { t } from '../../i18n';
import { FILE_DROP_EVENT, shellQuote, type FileDrop } from '../../lib/ui/fileDrop';
import { copyText } from '../../lib/platform/clipboard';

/** Settings → FONTS → terminal font, the built-in stack behind it. */
const terminalFont = (family: string) => withFallback(family, TERMINAL_FONT_STACK);

/** A hidden terminal (background tab / window, hidden pane) gives its WebGL context back after this long. */
const HIDDEN_RELEASE_MS = 5000;

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
  /**
   * Opened in the background by an MCP client: start the session while hidden (120×32 until it is
   * first shown and fitted). Other hidden tabs wait until they are shown.
   */
  startHidden?: boolean;
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
  startHidden = false,
}: Props) {
  // Re-render on a language change (memo would otherwise keep the old labels).
  useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number; line: string; hasLine: boolean } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const gutterApiRef = useRef<ReturnType<typeof attachGutter> | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [state, setState] = useState<SessionState>(backend.live ? 'connecting' : 'preview');
  const [size, setSize] = useState({ cols: 0, rows: 0 });
  // Latest props for the long-lived terminal effect (no re-creation on rename / theme / callback change).
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const refitRef = useRef<() => void>(() => undefined);
  const restartRef = useRef<() => void>(() => undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const startHiddenRef = useRef(startHidden);
  startHiddenRef.current = startHidden;
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const reportCursorRef = useRef<() => void>(() => undefined);
  const marksRef = useRef<ReturnType<typeof attachSelectionMarks> | null>(null);
  /** WebGL could not be started: the reason, shown in place of the terminal (no DOM-renderer fallback). */
  const [rendererError, setRendererError] = useState('');
  const restartRendererRef = useRef<() => void>(() => undefined);

  // ---------- find (Ctrl+F / right-click → Find…) ----------
  const findRef = useRef<ReturnType<typeof attachFind> | null>(null);
  const highlightRef = useRef<ReturnType<typeof attachHighlighter> | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findState, setFindState] = useState<FindState>({ count: 0, index: -1, capped: false, all: false });
  const openFind = () => {
    // Selected text (one line) becomes the search text.
    const selection = terminalRef.current?.hasSelection() ? terminalRef.current.getSelection() : '';
    const useSelection = Boolean(selection) && !/[\r\n]/.test(selection) && selection.length <= 200;
    // Rendered and focused right now: keys typed straight after Ctrl+F must reach the find box, not the shell.
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
  /** Clear Scrollback (context menu, Ctrl+Shift+L): the lines above the screen and their gutter marks. */
  const clearScrollbackRef = useRef(() => {
    terminalRef.current?.clear();
    gutterApiRef.current?.reset();
    log.info(t('Scrollback cleared'));
  });
  const closeFind = () => {
    setFindOpen(false);
    findRef.current?.setActive(false);
    terminalRef.current?.focus();
  };

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    const live = backend.live;
    const fitAddon = new FitAddon();
    // Plain xterm (its own cursor and input handling); the font, cursor, scrollback and colours come
    // from the preferences / app theme. Drawn by the WebGL renderer when available. The scrollbar of
    // `.xterm-viewport` is the app's own (lib/ui/customScrollbars.ts), like every other scrolling area.
    const terminal = new Terminal({
      cursorBlink: prefsRef.current.cursorBlink,
      cursorStyle: prefsRef.current.cursorStyle,
      // Bar cursor 2 CSS px wide (xterm's default is 1). The underline cursor is 3px: no xterm option,
      // see scripts/patch-xterm-webgl.mjs.
      cursorWidth: 2,
      // No cursor while the terminal is not focused (xterm's default draws an outline box).
      cursorInactiveStyle: 'none',
      fontFamily: terminalFont(prefsRef.current.fontFamily),
      fontSize: prefsRef.current.fontSize,
      // Decorations (same-text marks, find frames) are still a "proposed" API in xterm 5.5.
      allowProposedApi: true,
      // Bold text in the regular weight unless Settings → BOLD TEXT is on (the default is off).
      fontWeightBold: prefsRef.current.boldText ? 'bold' : 'normal',
      scrollback: prefsRef.current.scrollback,
      // A real PTY already sends CR LF; only the simulated preview needs LF → CR LF.
      convertEol: !live,
      theme: terminalPalette(themeRef.current),
      // CJK / ambiguous-width text: a one-cell glyph that would overlap the next cell (Ⅰ Ⅱ …, glyphs
      // missing from the monospace font) is squeezed into its cell. WebGL renderer only.
      rescaleOverlappingGlyphs: true,
      // Text colours are adjusted until they reach WCAG AA contrast (4.5:1) against their background.
      minimumContrastRatio: 4.5,
    });
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    // IME text was sent several times in the Linux desktop app (WebKitGTK + fcitx5 / IBus); see lib/terminal/imeInput.
    const ime = guardImeInput(terminal);
    // Time / line-number gutter and the clicked-line highlight (lib/terminal/gutter).
    const gutter = gutterRef.current
      ? attachGutter(terminal, {
          gutter: gutterRef.current,
          host: hostRef.current,
          columns: { time: prefsRef.current.gutterTime, line: prefsRef.current.gutterLine },
        })
      : null;
    gutterApiRef.current = gutter;
    // Other occurrences of the selected text are marked (lib/terminal/selectionMarks).
    const marks = attachSelectionMarks(terminal);
    marksRef.current = marks;
    // Find in the terminal (lib/terminal/find); the current match's line is highlighted like a clicked one.
    // While the find bar is open the same-text marks pause: find selects each match itself.
    const find = attachFind(terminal, {
      onFocusLine: line => gutter?.pickLine(line),
      onChange: setFindState,
      onActive: value => marks.setPaused(value),
    });
    findRef.current = find;
    // Web addresses (http / https, @xterm/addon-web-links): underlined under the pointer, opened in
    // the default browser by Ctrl+click (⌘+click on macOS) — a plain click still selects / picks the line.
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        openUrl(uri).catch(error => log.warn(t('Cannot open the link'), errorText(error)));
      }),
    );
    // Output highlighting: keywords, times, numbers … (lib/terminal/highlight).
    const highlighter = attachHighlighter(terminal, TERMINAL_SCHEMES[themeRef.current].highlight, prefsRef.current.highlight);
    highlightRef.current = highlighter;

    // Renderer: WebGL (rescaleOverlappingGlyphs, the 3px underline cursor); xterm's DOM renderer
    // stands in only while the terminal is hidden or waits for a WebGL context (lib/terminal/webglBudget: the
    // browser keeps ~16 contexts, the terminals share 12). A hidden terminal gives its context back
    // after HIDDEN_RELEASE_MS and gets one again when shown. When WebGL cannot be started the error is
    // reported (status bar + application log) and shown in place of the terminal. A lost context (GPU
    // reset) is restarted: right away when the terminal is on screen, otherwise when it is shown again;
    // lost more than 3 times in 30 s counts as unavailable.
    let webgl: WebglAddon | undefined;
    let rendererFailed = false;
    let rendererPending = false;
    let losses: number[] = [];
    let hiddenTimer = 0;
    const onScreen = () => Boolean(hostRef.current?.clientHeight);
    const canvasesOf = () => [...(terminal.element?.querySelectorAll('canvas') ?? [])];
    /** Dispose the WebGL renderer and free its context now (`lose`: false when it is lost already). */
    const dropRenderer = (lose: boolean) => {
      const addon = webgl;
      webgl = undefined;
      if (addon) {
        const canvases = lose ? canvasesOf() : [];
        addon.dispose();
        loseContexts(canvases);
      }
      releaseWebgl(slot);
    };
    const slot: WebglSlot = {
      visible: onScreen,
      lastShown: Date.now(),
      // Hidden a while, or a shown terminal needs the context: started again when shown.
      release: () => {
        dropRenderer(true);
        rendererPending = !rendererFailed && !disposed;
      },
      retry: () => {
        if (rendererPending && onScreen()) startRenderer();
      },
    };
    const failRenderer = (error: unknown) => {
      dropRenderer(true);
      rendererFailed = true;
      rendererPending = false;
      log.error(t('WebGL is not available, the terminal cannot be drawn'), error);
      if (!disposed) setRendererError(errorText(error));
    };
    const startRenderer = () => {
      rendererPending = false;
      if (disposed || rendererFailed || webgl) return;
      // Hidden (a background tab or window): no context until it is shown.
      if (!onScreen() || !acquireWebgl(slot)) {
        rendererPending = true;
        return;
      }
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          if (webgl !== addon) return;
          dropRenderer(false);
          const now = Date.now();
          losses = losses.filter(time => now - time < 30000);
          losses.push(now);
          if (losses.length > 3) {
            failRenderer(new Error(t('the WebGL context was lost repeatedly')));
            return;
          }
          log.warn(t('WebGL context lost, restarting the renderer'), undefined, { quiet: true });
          if (onScreen()) requestAnimationFrame(startRenderer);
          else rendererPending = true;
        });
        terminal.loadAddon(addon);
        webgl = addon;
      } catch (error) {
        failRenderer(error);
      }
    };
    startRenderer();
    // Shown / hidden / resized (ResizeObserver): a shown terminal gets its renderer back before the
    // frame is painted; a hidden one lets its context go after a while.
    restartRendererRef.current = () => {
      if (onScreen()) {
        slot.lastShown = Date.now();
        window.clearTimeout(hiddenTimer);
        hiddenTimer = 0;
        if (rendererPending) startRenderer();
        return;
      }
      if (webgl && !hiddenTimer)
        hiddenTimer = window.setTimeout(() => {
          hiddenTimer = 0;
          if (!onScreen() && webgl) slot.release();
        }, HIDDEN_RELEASE_MS);
    };

    // ---------- session ----------
    let generation = 0;
    let sessionId = '';
    let sessionState: SessionState = live ? 'connecting' : 'preview';
    // Current directory for the Filer ("Terminal folder" / "Follow terminal", lib/terminal/cwd):
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

    refitRef.current = () => fit();
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
          if (startHiddenRef.current) {
            // Not on screen and not waiting to be: the backend's default size.
            if (terminal.cols !== 120 || terminal.rows !== 32) terminal.resize(120, 32);
            return;
          }
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
    /** Fitted to its panel once (below); before that the terminal still has xterm's default 80 × 24. */
    let sized = false;
    void (async () => {
      if (live) await waitForStableSize();
      if (disposed) return;
      try {
        if (hostRef.current?.clientHeight) fitAddon.fit();
      } catch {
        /* hidden */
      }
      sized = true;
      syncSize();
      reportCursorRef.current();
      // No renderer: no session either (it could not be seen).
      if (live && !rendererFailed) void start();
    })();

    // Status bar: size and cursor position (Ln = logical line, as numbered in the gutter; Ch = column) of the visible tab.
    // While a splitter or the window is dragged the size shown is the one the terminal will get
    // (`size`, from the fit addon, every frame); the terminal itself is resized once the drag stops.
    let reported = '';
    /** The size the terminal will have in its panel (fit addon), if the panel can be measured. */
    const proposedSize = () => {
      if (!hostRef.current?.clientHeight) return undefined;
      try {
        const dims = fitAddon.proposeDimensions();
        return dims && dims.cols > 0 && dims.rows > 0 && !Number.isNaN(dims.cols) && !Number.isNaN(dims.rows) ? dims : undefined;
      } catch {
        return undefined; // not measurable yet
      }
    };
    const reportCursor = (size?: { cols: number; rows: number }) => {
      if (!activeRef.current || disposed) return;
      // Not fitted yet: the size it is about to get, or nothing (never xterm's default 80 × 24 for a moment).
      if (!size && !sized) size = proposedSize();
      if (!size && !sized) return;
      const buffer = terminal.buffer.active;
      const info: CursorInfo = {
        cols: size?.cols ?? terminal.cols,
        rows: size?.rows ?? terminal.rows,
        line:
          buffer.type === 'normal' && gutterApiRef.current
            ? gutterApiRef.current.lineNumber(buffer.baseY + buffer.cursorY)
            : buffer.baseY + buffer.cursorY + 1,
        column: buffer.cursorX + 1,
      };
      const key = `${tabId}|${info.cols}|${info.rows}|${info.line}|${info.column}`;
      if (key === reported) return;
      reported = key;
      cursorRef.current?.(tabId, info);
    };
    reportCursorRef.current = () => {
      reported = '';
      reportCursor();
    };
    const report = () => reportCursor();
    const cursorEvents = [terminal.onCursorMove(report), terminal.onResize(report), terminal.onLineFeed(report)];
    const reportProposedSize = () => {
      if (!activeRef.current || disposed) return;
      const dims = proposedSize();
      if (dims) reportCursor(dims);
    };
    resizeObserver = new ResizeObserver(() => {
      restartRendererRef.current();
      reportProposedSize();
      requestFit();
    });
    resizeObserver.observe(hostRef.current);

    // Terminal shortcuts (Preferences → Keyboard Shortcuts…; defaults Ctrl+F find, Ctrl+Shift+C copy,
    // Ctrl+Shift+V paste, Ctrl+Shift+L clear scrollback). Fixed editor keys: Ctrl+C copies when there
    // is a selection (otherwise it stays SIGINT), Ctrl+V pastes.
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
      // A 229 keydown of a commit-only IME: lib/terminal/imeInput sends the committed text, not xterm.
      if (!ime.keydown(event)) return false;
      if (prefsRef.current.keyMode === 'remote' || event.type !== 'keydown') return true;
      const binding = bindingOf(event);
      if (binding === null) return true;
      if (matchesKey('find', event, binding)) {
        event.preventDefault();
        openFindRef.current();
        return false;
      }
      if (matchesKey('clearScrollback', event, binding)) {
        event.preventDefault();
        clearScrollbackRef.current();
        return false;
      }
      // Copy only with a selection: without one the key goes on to the shell.
      if ((matchesKey('copy', event, binding) || binding === 'Ctrl+C') && terminal.hasSelection()) {
        void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined);
        if (binding === 'Ctrl+C') terminal.clearSelection();
        return false;
      }
      if (matchesKey('paste', event, binding) || binding === 'Ctrl+V') {
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
    // Files dropped from the file manager (lib/ui/fileDrop): their paths are typed at the prompt, quoted,
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
      clear: () => {
        terminal.clear();
        gutter?.reset();
      },
      focus: () => terminal.focus(),
      find: () => openFindRef.current(),
    });

    return () => {
      disposed = true;
      cwdWatch.dispose();
      osc7.dispose();
      osc9.dispose();
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
      cursorEvents.forEach(event => event.dispose());
      resizeObserver?.disconnect();
      terminal.textarea?.removeEventListener('paste', countPaste, true);
      ime.dispose();
      gutter?.dispose();
      gutterApiRef.current = null;
      marks.dispose();
      marksRef.current = null;
      find.dispose();
      findRef.current = null;
      highlighter.dispose();
      highlightRef.current = null;
      restartRendererRef.current = () => undefined;
      window.clearTimeout(hiddenTimer);
      dropRenderer(true);
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
      if (focused?.closest('.modal-backdrop')) return;
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

  // Theme switch / another colour scheme (Settings → TERMINAL COLORS): recolor in place (the session keeps running).
  const palette = useTerminalPalette(theme);
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = palette;
    marksRef.current?.refresh();
    findRef.current?.refresh();
    highlightRef.current?.setColors(TERMINAL_SCHEMES[theme].highlight);
  }, [theme, palette]);

  // Preferences: font size changes the cell size, so the terminal is refitted (new cols × rows).
  // A different font family changes the cell size as well.
  const { fontSize, scrollback, cursorBlink, cursorStyle, fontFamily, boldText, gutterTime, gutterLine, highlight } = prefs;
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const font = terminalFont(fontFamily);
    const sizeChanged = terminal.options.fontSize !== fontSize || terminal.options.fontFamily !== font;
    if (sizeChanged) {
      terminal.options.fontFamily = font;
      terminal.options.fontSize = fontSize;
    }
    if (terminal.options.scrollback !== scrollback) {
      terminal.options.scrollback = scrollback;
      gutterApiRef.current?.refresh();
    }
    if (terminal.options.cursorBlink !== cursorBlink) terminal.options.cursorBlink = cursorBlink;
    if (terminal.options.cursorStyle !== cursorStyle) terminal.options.cursorStyle = cursorStyle;
    const bold = boldText ? 'bold' : 'normal';
    if (terminal.options.fontWeightBold !== bold) terminal.options.fontWeightBold = bold;
    if (sizeChanged) refitRef.current();
  }, [fontSize, fontFamily, scrollback, cursorBlink, cursorStyle, boldText]);

  // View → Show Time / Show Line Number: the gutter's width changes, so the terminal is refitted.
  useEffect(() => {
    gutterApiRef.current?.setColumns({ time: gutterTime, line: gutterLine });
    refitRef.current();
  }, [gutterTime, gutterLine]);

  // View → Highlight Keywords.
  useEffect(() => {
    highlightRef.current?.setEnabled(highlight);
  }, [highlight]);

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
    if (buffer.viewportY + row >= buffer.length) return null;
    return lineText(buffer, lineStart(buffer, buffer.viewportY + row)).replace(/\s+$/, '');
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
        log.warn(t('Clipboard is not available — use {{keys}}', { keys: keyHint('paste') ?? 'Ctrl+V' }));
        refocus();
        return;
      }
      void read
        .then(text => {
          if (text) terminalRef.current?.paste(text);
        })
        .catch(() => log.warn(t('Clipboard access was denied — use {{keys}}', { keys: keyHint('paste') ?? 'Ctrl+V' })))
        .finally(refocus);
    };
    return [
      {
        type: 'item',
        id: 'copy',
        label: t('Copy'),
        icon: 'copy',
        hint: keyHint('copy'),
        disabled: !selection,
        onSelect: () => copy(selection, 'Selection'),
      },
      { type: 'item', id: 'paste', label: t('Paste'), hint: keyHint('paste'), onSelect: paste },
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
      {
        type: 'item',
        id: 'find',
        label: t('Find…'),
        icon: 'search',
        hint: keyHint('find'),
        onSelect: () => requestAnimationFrame(() => openFindRef.current()),
      },
      { type: 'separator', id: 'terminal-sep' },
      {
        type: 'item',
        id: 'clear',
        label: t('Clear Scrollback'),
        icon: 'trash',
        hint: keyHint('clearScrollback'),
        onSelect: () => {
          clearScrollbackRef.current();
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
      <div
        className={`terminal-body${rendererError ? ' has-renderer-error' : ''}`}
        // The scheme's background also behind the padding and the gutter.
        style={palette.background ? ({ '--xterm-bg': palette.background } as React.CSSProperties) : undefined}
      >
        {/* Time / line numbers one px smaller than the terminal's font size (Settings, View → Zoom); its width follows (ch), the terminal refits. */}
        <div className="terminal-gutter" ref={gutterRef} aria-hidden="true" style={{ fontSize: `${Math.max(6, fontSize - 1)}px` }} />
        <div
          className="xterm-host"
          ref={hostRef}
          data-file-drop="terminal"
          data-file-drop-label={t('Drop to insert the path at the prompt')}
          onContextMenu={openMenu}
        />
        {rendererError && (
          <div className="terminal-renderer-error" role="alert">
            <b>{t('WebGL is not available, the terminal cannot be drawn')}</b>
            <span>{t('MetroTerm draws terminals with WebGL only. Check that hardware acceleration is enabled.')}</span>
            <code>{rendererError}</code>
          </div>
        )}
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
                if (event.key === 'Enter' || event.key === 'F3') {
                  event.preventDefault();
                  if (event.shiftKey) findRef.current?.previous();
                  else findRef.current?.next();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  closeFind();
                }
              }}
            />
            <span className={`terminal-find-count${findText && !findState.count ? ' is-empty' : ''}`}>
              {!findText
                ? ''
                : findState.count
                  ? // index -1: the current match lies beyond the counted ones (more than 1000).
                    `${findState.index >= 0 ? findState.index + 1 : '?'}/${findState.count}${findState.capped ? '+' : ''}`
                  : t('No results')}
            </span>
            <button
              type="button"
              title={t('Previous (Shift+Enter)')}
              aria-label={t('Previous match')}
              disabled={!findState.count}
              onClick={() => findRef.current?.previous()}
            >
              <Icon name="arrowUp" />
            </button>
            <button
              type="button"
              title={t('Next (Enter)')}
              aria-label={t('Next match')}
              disabled={!findState.count}
              onClick={() => findRef.current?.next()}
            >
              <Icon name="arrowDown" />
            </button>
            <button
              type="button"
              className={findState.all ? 'is-on' : undefined}
              aria-pressed={findState.all}
              title={findState.all ? t('Find all: on — every match is framed') : t('Find all — frame every match')}
              onClick={() => findRef.current?.setAll(!findState.all)}
            >
              <Icon name="list" />
            </button>
            <button type="button" title={t('Close (Esc)')} aria-label={t('Close find')} onClick={closeFind}>
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={terminalMenu()} onClose={closeMenu} />}
    </div>
  );
});
