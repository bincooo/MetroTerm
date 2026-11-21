import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * Input-method (IME) handling for an xterm terminal, replacing xterm's own CompositionHelper.
 *
 * xterm 5.5 works out the committed text from the hidden textarea: it remembers where a composition
 * started in `textarea.value`, reads the text after it once the composition ends, and on every
 * keydown 229 sends whatever the textarea grew by. The textarea is never emptied, so it collects
 * everything typed since the page opened, and any event order other than Chrome's sends text twice:
 * - Linux input methods in WebKitGTK (the desktop app) and fcitx5 send preedit updates without a
 *   `compositionstart`, so the start position is stale and the next end re-sends old text;
 * - some send the committed text again as an `insertText` input right after `compositionend`;
 * - a commit followed by a keydown 229 in a later task is sent both by the end and by the diff.
 * The result was "你好今天今天": the first word fine, later ones repeated.
 *
 * Here the committed text comes from the events themselves, never from the textarea:
 * - `compositionend.data` is the commit (an empty end, as WebKitGTK sends before re-inserting the
 *   text, commits nothing);
 * - an `insertText` input after a keydown 229 outside a composition (an input method committing
 *   without composition events, or a full-width punctuation mark) is a commit too;
 * - the same text arriving through both paths with no key in between is sent once.
 * xterm never sees the composition events, IME keydowns (229) or IME input events, so its helper
 * stays idle; its composition view is reused to show the text being composed at the cursor.
 * Ordinary keys (letters, Enter, arrows …) still go through xterm's keydown handling.
 */
export const attachImeInput = (terminal: Terminal): IDisposable => {
  const root = terminal.element;
  const textarea = terminal.textarea;
  if (!root || !textarea) return { dispose: () => undefined };
  const view = root.querySelector<HTMLElement>('.composition-view');

  let composing = false;
  /** Text an input event inserted during the current composition (fallback for an end without data). */
  let pendingText = '';
  /** Last keydown came from the input method (keyCode 229 / isComposing). */
  let imeKey = false;
  /** Last commit, so the same text arriving through the other path right after it (no key in between) is dropped. */
  let lastCommit: { text: string; at: number } | null = null;
  let resetTimer = 0;

  const showView = (text: string) => {
    if (!view) return;
    view.textContent = text;
    view.classList.toggle('active', !!text);
    if (!text) return;
    const screen = root.querySelector<HTMLElement>('.xterm-screen');
    if (!screen?.clientHeight || !terminal.rows || !terminal.cols) return;
    const cellWidth = screen.clientWidth / terminal.cols;
    const cellHeight = screen.clientHeight / terminal.rows;
    const buffer = terminal.buffer.active;
    const x = Math.min(buffer.cursorX, terminal.cols - 1);
    // The view is positioned in xterm's helper container; the screen may be inset from it (padding).
    const origin = view.offsetParent?.getBoundingClientRect();
    const screenBox = screen.getBoundingClientRect();
    const dx = origin ? screenBox.left - origin.left : 0;
    const dy = origin ? screenBox.top - origin.top : 0;
    view.style.left = `${dx + x * cellWidth}px`;
    view.style.top = `${dy + buffer.cursorY * cellHeight}px`;
    view.style.height = `${cellHeight}px`;
    view.style.lineHeight = `${cellHeight}px`;
    view.style.fontFamily = String(terminal.options.fontFamily ?? '');
    view.style.fontSize = `${terminal.options.fontSize ?? 13}px`;
  };

  // The textarea's content is not used; empty it between compositions so it doesn't grow forever.
  const scheduleReset = () => {
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      if (!composing) textarea.value = '';
    }, 0);
  };

  const commit = (text: string) => {
    pendingText = '';
    scheduleReset();
    if (!text) return;
    if (lastCommit && lastCommit.text === text && performance.now() - lastCommit.at < 300) {
      lastCommit = null;
      return;
    }
    lastCommit = { text, at: performance.now() };
    terminal.input(text, true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    imeKey = event.keyCode === 229 || event.isComposing;
    // A key between two commits: the next identical text is a new word, not a duplicate.
    lastCommit = null;
  };
  const onCompositionStart = (event: CompositionEvent) => {
    event.stopPropagation();
    composing = true;
    pendingText = '';
    lastCommit = null;
    window.clearTimeout(resetTimer);
    showView('');
  };
  const onCompositionUpdate = (event: CompositionEvent) => {
    event.stopPropagation();
    if (!composing) {
      composing = true;
      pendingText = '';
      lastCommit = null;
      window.clearTimeout(resetTimer);
    }
    showView(event.data ?? '');
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    event.stopPropagation();
    const text = event.data || pendingText;
    composing = false;
    showView('');
    commit(text);
  };
  const onInput = (event: Event) => {
    const { inputType, data } = event as InputEvent;
    if (
      composing ||
      inputType === 'insertCompositionText' ||
      inputType === 'deleteCompositionText' ||
      inputType === 'insertFromComposition'
    ) {
      // Part of a composition: the text is committed by compositionend.
      event.stopPropagation();
      if (data && (inputType === 'insertText' || inputType === 'insertFromComposition')) pendingText = data;
      return;
    }
    if (inputType === 'insertText' && data && (imeKey || lastCommit)) {
      // An input method committing without composition events, or repeating the last commit.
      event.stopPropagation();
      commit(data);
    }
    // Anything else (an emoji picker, a dead key …) is left to xterm.
  };

  // Capture listeners on an ancestor run before xterm's own listeners on the textarea.
  const listeners: [string, (event: never) => void][] = [
    ['keydown', onKeyDown],
    ['compositionstart', onCompositionStart],
    ['compositionupdate', onCompositionUpdate],
    ['compositionend', onCompositionEnd],
    ['input', onInput],
  ];
  const fromTextarea = (handler: (event: never) => void) => (event: Event) => {
    if (event.target === textarea) handler(event as never);
  };
  const bound = listeners.map(([type, handler]) => [type, fromTextarea(handler)] as const);
  bound.forEach(([type, handler]) => root.addEventListener(type, handler, true));

  return {
    dispose: () => {
      bound.forEach(([type, handler]) => root.removeEventListener(type, handler, true));
      window.clearTimeout(resetTimer);
      showView('');
    },
  };
};

/** For xterm's custom key handler: IME keydowns must not reach xterm (its textarea diff re-sends text). */
export const isImeKey = (event: KeyboardEvent) => event.keyCode === 229 || event.isComposing;
