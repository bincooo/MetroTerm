import type { Terminal } from '@xterm/xterm';

/**
 * Text typed with an input method reaches the terminal once. Two WebKitGTK cases break xterm's
 * CompositionHelper:
 *
 * 1. Commit-only input (fcitx5; IBus with its own preedit window): no `compositionstart`, only 229
 *    keydowns, then `input` and a lone `compositionend`. Every 229 keydown makes xterm diff its textarea
 *    and resend the word. So 229 keydowns outside a composition are kept from xterm (`keydown()` → false)
 *    and the committed text is sent once from here, then the textarea is emptied.
 * 2. An extra `insertText` after a normal composition (IBus inline preedit): stopped.
 *
 * Normal compositions are left to xterm. The same text from two commit paths within a moment is sent once.
 */
const SAME_COMMIT_MS = 100;

type ImeGuard = {
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
