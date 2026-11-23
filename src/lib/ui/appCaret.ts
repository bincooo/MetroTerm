/**
 * Taller, 2px text caret in every input / textarea except the terminal.
 *
 * Browsers draw the native caret 1px wide and as tall as the font (≈ 1.15 × font size) — CSS can
 * only change its colour. So the native caret is made transparent (`html.app-caret-on`, see
 * styles/controls.css) and one fixed-position bar is drawn at the caret position of the focused field:
 * 2px wide, ≈ 1.25 × font size tall (12px UI text → 15px; native ≈ 14px), centred on
 * the text line, in the theme's foreground colour, blinking like the native one (and solid while
 * typing / moving).
 *
 * The position comes from a hidden mirror element with the field's text metrics (the classic
 * textarea-caret technique): text before the caret + a marker span. Checked once per frame while a
 * field has focus, so typing, clicking, selecting, scrolling inside the field, IME composition
 * and layout changes are all followed; the mirror is only rebuilt when something changed.
 * Hidden while text is selected or the window is in the background (as the native caret), and
 * while the caret's spot is not visible: the bar is a fixed element above everything, so when a
 * dialog scrolls the field under its sticky title / button row or out of the dialog, the bar would
 * otherwise stay drawn there — over the title, outside the dialog (`visibleBox`).
 * The terminal (xterm's helper textarea) keeps its own block cursor.
 */

/** Input types whose caret position is readable (selectionStart); number / email are not. Keep in sync with styles/controls.css. */
const TEXT_TYPES = new Set(['text', 'search', 'password', 'url', 'tel']);
const WIDTH = 2;
const HEIGHT_RATIO = 1.25;
const BLINK = 'app-caret-blink';

type Field = HTMLInputElement | HTMLTextAreaElement;

const isField = (el: Element | null): el is Field => {
  if (!el || el.closest('.xterm')) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_TYPES.has(el.type);
};

/** Mirror copies these so text before the caret wraps / measures exactly like in the field. */
const COPIED = [
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'fontFeatureSettings',
  'fontKerning',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'direction',
] as const;

type Box = { top: number; bottom: number; left: number; right: number };

/**
 * Where `element` can be seen: inside the window and every clipping (scrolling) ancestor, minus the
 * sticky bars of those scroll boxes that cover what scrolls under them (a dialog's title and buttons).
 */
const visibleBox = (element: HTMLElement): Box => {
  const box: Box = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) continue;
    const rect = parent.getBoundingClientRect();
    box.top = Math.max(box.top, rect.top);
    box.bottom = Math.min(box.bottom, rect.bottom);
    box.left = Math.max(box.left, rect.left);
    box.right = Math.min(box.right, rect.right);
    for (const child of parent.children) {
      if (child.contains(element) || getComputedStyle(child).position !== 'sticky') continue;
      const bar = child.getBoundingClientRect();
      if (!bar.height) continue;
      if (bar.top <= rect.top + 1) box.top = Math.max(box.top, bar.bottom);
      else if (bar.bottom >= rect.bottom - 1) box.bottom = Math.min(box.bottom, bar.top);
    }
  }
  return box;
};

export function attachAppCaret() {
  if (typeof document === 'undefined' || document.documentElement.classList.contains('app-caret-on')) return () => undefined;
  document.documentElement.classList.add('app-caret-on');

  const caret = document.createElement('div');
  caret.className = 'app-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.hidden = true;
  document.body.appendChild(caret);

  const mirror = document.createElement('div');
  mirror.setAttribute('aria-hidden', 'true');
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    top: '0',
    left: '-9999px',
    overflow: 'hidden',
    pointerEvents: 'none',
  });
  const before = document.createTextNode('');
  const marker = document.createElement('span');
  mirror.append(before, marker);
  document.body.appendChild(mirror);

  let field: Field | null = null;
  let frame = 0;
  let lastKey = '';
  let lastPos = '';

  const hide = () => {
    caret.hidden = true;
    lastPos = '';
  };

  /** Restart the blink: solid right after a change, like the native caret. */
  const restartBlink = () => {
    caret.classList.remove(BLINK);
    void caret.offsetWidth;
    caret.classList.add(BLINK);
  };

  const colour = () => {
    const shell = document.querySelector('.metroterm-shell');
    if (!shell) return '';
    if (shell.classList.contains('light')) return '#333';
    return getComputedStyle(shell).getPropertyValue('--ink').trim() || '#dedede';
  };

  const update = () => {
    const el = field;
    if (!el || !el.isConnected || document.activeElement !== el) {
      stop();
      return;
    }
    frame = requestAnimationFrame(update);
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === null || end === null || start !== end || el.readOnly || el.disabled || !document.hasFocus()) {
      hide();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      hide();
      return;
    }
    const key = `${el.value.length}|${end}|${el.value.slice(Math.max(0, end - 2), end + 1)}|${rect.left},${rect.top},${rect.width},${rect.height}|${el.scrollLeft},${el.scrollTop}`;
    if (key === lastKey && !caret.hidden) return;
    lastKey = key;

    const style = getComputedStyle(el);
    for (const name of COPIED) mirror.style[name] = style[name];
    const textarea = el instanceof HTMLTextAreaElement;
    const wraps = textarea && el.getAttribute('wrap') !== 'off' && style.whiteSpace !== 'pre' && style.whiteSpace !== 'nowrap';
    mirror.style.whiteSpace = textarea ? (wraps ? 'pre-wrap' : 'pre') : 'pre';
    if (!textarea) {
      mirror.style.overflowX = 'hidden';
      mirror.style.overflowY = 'hidden';
    } // no scrollbar gutter in a one-line mirror
    mirror.style.overflowWrap = wraps ? 'break-word' : 'normal';
    let text = el.value.slice(0, end);
    if (el instanceof HTMLInputElement && el.type === 'password') text = '•'.repeat(text.length);
    before.nodeValue = text;
    // The next character (so wrapping matches), or a zero-width space at the end (keeps right /
    // centre aligned text where it is).
    marker.textContent = el.value.slice(end, end + 1) || '\u200b';

    const fontSize = parseFloat(style.fontSize) || 12;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderRight = parseFloat(style.borderRightWidth) || 0;
    const borderBottom = parseFloat(style.borderBottomWidth) || 0;
    // offsetLeft / offsetTop count from inside the mirror's border.
    let x = rect.left + borderLeft + marker.offsetLeft - el.scrollLeft;
    // Vertical centre of the caret's text line. Textarea: the marker's own box (its offsetTop is the
    // top of the text inside the line box, below the half-leading — not the line's top).
    // Single-line input: the text is centred in the field.
    let centre: number;
    if (textarea) centre = rect.top + borderTop + marker.offsetTop + marker.offsetHeight / 2 - el.scrollTop;
    else centre = rect.top + borderTop + (rect.height - borderTop - borderBottom) / 2;
    const inner = textarea
      ? {
          left: rect.left + borderLeft,
          right: rect.left + borderLeft + el.clientWidth,
          top: rect.top + borderTop,
          bottom: rect.top + borderTop + el.clientHeight,
        }
      : { left: rect.left + borderLeft, right: rect.right - borderRight, top: rect.top + borderTop, bottom: rect.bottom - borderBottom };
    const height = Math.min(Math.round(fontSize * HEIGHT_RATIO), Math.floor(inner.bottom - inner.top) - 2);
    const top = Math.round(centre - height / 2);
    x = Math.round(x); // starts at the character boundary: the bar never covers the previous glyph
    // Outside the visible text area (scrolled away in a textarea): no caret, like the native one.
    if (x < inner.left - 1 || x + WIDTH > inner.right + 1 || top + height <= inner.top || top >= inner.bottom) {
      hide();
      return;
    }
    // Scrolled under a sticky title / button row, or out of its dialog / panel: no caret either.
    const shown = visibleBox(el);
    if (top < shown.top || top + height > shown.bottom || x < shown.left || x + WIDTH > shown.right) {
      hide();
      return;
    }
    const pos = `${x},${top},${height}`;
    caret.style.transform = `translate(${x}px, ${top}px)`;
    caret.style.height = `${height}px`;
    caret.style.background = colour();
    const wasHidden = caret.hidden;
    caret.hidden = false;
    if (pos !== lastPos || wasHidden) restartBlink();
    lastPos = pos;
  };

  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    field = null;
    lastKey = '';
    hide();
  };

  const onFocus = (event: FocusEvent) => {
    const target = event.target as Element | null;
    if (!isField(target)) {
      if (field && document.activeElement !== field) stop();
      return;
    }
    stop();
    field = target;
    frame = requestAnimationFrame(update);
  };
  const onBlur = () => {
    requestAnimationFrame(() => {
      if (field && document.activeElement !== field) stop();
    });
  };
  // Typing keeps the caret solid even when its position did not change (e.g. typing over a selection).
  const onInput = (event: Event) => {
    if (event.target === field) {
      lastKey = '';
      lastPos = '';
    }
  };

  document.addEventListener('focusin', onFocus, true);
  document.addEventListener('focusout', onBlur, true);
  document.addEventListener('input', onInput, true);
  if (isField(document.activeElement)) {
    field = document.activeElement;
    frame = requestAnimationFrame(update);
  }

  return () => {
    stop();
    document.removeEventListener('focusin', onFocus, true);
    document.removeEventListener('focusout', onBlur, true);
    document.removeEventListener('input', onInput, true);
    caret.remove();
    mirror.remove();
    document.documentElement.classList.remove('app-caret-on');
  };
}
