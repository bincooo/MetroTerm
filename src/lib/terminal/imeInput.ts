import type { Terminal } from '@xterm/xterm';

/**
 * Text typed with an input method (Chinese pinyin, Japanese, Korean …) reaches the terminal once.
 *
 * xterm's own IME handling (CompositionHelper) expects `compositionstart` → updates → `compositionend` and
 * sends the composed text when the composition ends. Two webview / IME combinations break it in the Linux
 * desktop app (WebKitGTK):
 *
 * 1. **Commit-only input** (fcitx5, and IBus set to show the preedit in its own window): the page gets no
 *    `compositionstart` at all — only `keydown` with keyCode 229 for every key, then
 *    `input(insertFromComposition | insertText)` and a lone `compositionend` when a word is chosen. xterm
 *    then sends it over and over: every 229 keydown schedules a diff of its hidden textarea
 *    (`_handleAnyTextareaChanges`), and each of them finds the committed word (typing `nihao` + space gave
 *    "你好" five times, plus stray letters); the lone `compositionend` sends a stale slice of the textarea —
 *    which is only emptied on Enter / Ctrl+C — once more.
 *    Here xterm is kept out: 229 keydowns outside a composition are not passed to it (`keydown()` returns
 *    false, used by TerminalView's custom key handler), and the committed text is sent once, by this guard
 *    (`terminal.input(text, true)`, like typed text) from the lone `compositionend` or a commit-only
 *    `insertText`; the event is then stopped before xterm's listener on the textarea. The textarea is
 *    emptied afterwards so nothing from earlier commits is left in it.
 * 2. **An extra `insertText`** at the end of a normal composition (IBus with the preedit in the page):
 *    xterm sends the composition, and its `_inputEvent` sends the `insertText` again. That event is stopped.
 *
 * Normal compositions (Chromium, Firefox, macOS, IBus inline preedit) are left to xterm, and so are ordinary
 * keys. The same text arriving twice within a moment from two commit paths is sent once.
 */
const SAME_COMMIT_MS = 100;

export type ImeGuard = {
  /** For the terminal's custom key handler: false = xterm must not handle this keydown. */
  keydown(event: KeyboardEvent): boolean;
  dispose(): void;
};

export function guardImeInput(terminal: Terminal): ImeGuard {
  const element = terminal.element;
  const textarea = terminal.textarea;
  if (!element || !textarea) return { keydown: () => true, dispose: () => undefined };

  /** Between `compositionstart` and `compositionend`: xterm composes. */
  let composing = false;
  /** A 229 keydown outside a composition was held back from xterm: an IME commit may follow. */
  let commitPending = false;
  /** Text of the last `insertFromComposition` (a lone `compositionend` can come without data). */
  let fromComposition = '';
  /** Textarea length when the held-back keys began: the last resort for a commit's text. */
  let commitStart = 0;
  /** The last text sent or let through, so a second path with the same commit is dropped. */
  let last: { data: string; at: number } | null = null;
  let clearTimer = 0;

  const isRepeat = (data: string) => last !== null && last.data === data && performance.now() - last.at < SAME_COMMIT_MS;
  const remember = (data: string) => {
    last = { data, at: performance.now() };
  };
  const stop = (event: Event) => {
    event.stopImmediatePropagation();
    event.stopPropagation();
  };
  const send = (data: string) => {
    remember(data);
    commitPending = false;
    terminal.input(data, true);
    // Start the next commit from an empty textarea (after the event, and only outside a composition).
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      if (!composing) textarea.value = '';
    }, 0);
  };

  const keydown = (event: KeyboardEvent) => {
    if (event.type !== 'keydown' || composing) return true;
    if (event.keyCode === 229 || event.key === 'Process') {
      if (!commitPending) commitStart = textarea.value.length;
      commitPending = true;
      return false;
    }
    commitPending = false;
    return true;
  };
  const onStart = () => {
    composing = true;
    commitPending = false;
    fromComposition = '';
  };
  const onEnd = (event: CompositionEvent) => {
    if (composing) {
      // xterm finishes its own composition; remember the text against an extra insertText.
      composing = false;
      if (event.data) remember(event.data);
      return;
    }
    // A lone compositionend: a commit-only IME. Send it here, once; xterm's would send a stale slice.
    const data = event.data || fromComposition || textarea.value.slice(commitStart);
    fromComposition = '';
    stop(event);
    if (!data || isRepeat(data)) return;
    send(data);
  };
  const onInput = (event: Event) => {
    const input = event as InputEvent;
    if (input.target !== textarea || !input.data) return;
    if (input.inputType === 'insertFromComposition' || input.inputType === 'insertCompositionText') {
      if (!composing) fromComposition = input.data;
      return; // xterm ignores these
    }
    if (input.inputType !== 'insertText') return;
    if (composing || isRepeat(input.data)) {
      stop(event); // the composition sends it
      return;
    }
    if (commitPending) {
      // Text committed right after a held-back 229 keydown (punctuation, a commit-only word).
      stop(event);
      send(input.data);
    }
  };

  element.addEventListener('compositionstart', onStart, true);
  element.addEventListener('compositionend', onEnd, true);
  element.addEventListener('input', onInput, true);
  return {
    keydown,
    dispose: () => {
      window.clearTimeout(clearTimer);
      element.removeEventListener('compositionstart', onStart, true);
      element.removeEventListener('compositionend', onEnd, true);
      element.removeEventListener('input', onInput, true);
    },
  };
}
