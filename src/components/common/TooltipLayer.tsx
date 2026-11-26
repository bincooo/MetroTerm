import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Replaces the browser's native `title` tooltips everywhere with one styled tooltip.
 *
 * Components keep using plain `title="…"`. Every `title` attribute that appears in the document
 * (now or later) is moved to `data-tip`, so the native tooltip never shows. Icon-only controls
 * keep an accessible name through `aria-label`. A trailing shortcut such as "Rename (F2)" is
 * shown as a key cap.
 *
 * Shows after the pointer rests on a control for about 1.5 s, below and to the right of the
 * pointer. Near the window edges it flips to the left of / above the pointer so it never leaves
 * the window. Keyboard focus (:focus-visible) shows it under the control. Clicking, typing,
 * scrolling or leaving hides it.
 */
const SHOW_DELAY = 1500;
/** Offset from the pointer tip: clears the arrow cursor (about 16 × 20 px). */
const POINTER_DX = 12;
const POINTER_DY = 20;
const GAP = 6;
const EDGE = 6;
const KEY =
  /^(?:(?:Ctrl|Shift|Alt|Cmd|Meta|⌘|⌥|⇧)\s*[+-]\s*)*(?:F\d{1,2}|Esc|Del|Delete|Enter|Tab|Space|Home|End|Backspace|[A-Z0-9]|[←→↑↓])$/i;

type Tip = { text: string; shortcut?: string; rows?: [string, string][]; anchor: DOMRect; pointer: { x: number; y: number } | null };

function adopt(element: Element) {
  const title = element.getAttribute('title');
  if (title === null) return;
  element.removeAttribute('title');
  if (!title.trim()) {
    element.removeAttribute('data-tip');
    return;
  }
  element.setAttribute('data-tip', title);
  if (!element.hasAttribute('aria-label') && !element.textContent?.trim()) element.setAttribute('aria-label', title);
}
const adoptTree = (node: Node) => {
  if (!(node instanceof Element)) return;
  adopt(node);
  node.querySelectorAll('[title]').forEach(adopt);
};

/**
 * A tip whose lines are all "Label<TAB>Value" renders as a property table (Filer rows):
 * labels on the left, right-aligned; values on the right.
 */
function parse(raw: string): Pick<Tip, 'text' | 'shortcut' | 'rows'> {
  const lines = raw.split('\n');
  if (lines.length > 1 && lines.every(line => line.includes('\t'))) {
    const rows = lines.map(line => {
      const tab = line.indexOf('\t');
      return [line.slice(0, tab), line.slice(tab + 1)] as [string, string];
    });
    return { text: rows.map(([label, value]) => `${label}: ${value}`).join('\n'), rows };
  }
  const match = /^(.*\S)\s+\(([^()]{1,24})\)$/s.exec(raw.trim());
  if (match && KEY.test(match[2].trim())) return { text: match[1], shortcut: match[2].trim() };
  return { text: raw.trim() };
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    adoptTree(document.body);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') adopt(record.target as Element);
        // Terminal rows / gutter / scrollbars are re-rendered every frame while scrolling and carry no titles.
        else if (!(record.target as Element).closest?.('.xterm-screen, .terminal-gutter, .sb-layer')) record.addedNodes.forEach(adoptTree);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

    let current: Element | null = null; // element the tooltip belongs to (shown or pending)
    let suppressed: Element | null = null; // clicked element: no tooltip until the pointer leaves it
    let timer = 0;
    let visible = false;
    let pointer: { x: number; y: number } | null = null;
    let fromKeyboard = false;

    const hide = () => {
      window.clearTimeout(timer);
      visible = false;
      current = null;
      setTip(null);
    };
    const show = (element: Element, delay: number) => {
      window.clearTimeout(timer);
      current = element;
      timer = window.setTimeout(() => {
        if (current !== element || !element.isConnected) return;
        const raw = element.getAttribute('data-tip');
        if (!raw) return;
        visible = true;
        setTip({ ...parse(raw), anchor: element.getBoundingClientRect(), pointer: fromKeyboard ? null : pointer });
      }, delay);
    };

    const onOver = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      fromKeyboard = false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.hasAttribute('title')) adopt(target);
      const element = target?.closest('[data-tip]') ?? null;
      if (element === current) return;
      if (suppressed && element !== suppressed) suppressed = null;
      if (!element || element === suppressed || document.body.classList.contains('is-resizing')) {
        hide();
        return;
      }
      if (visible) {
        visible = false;
        setTip(null);
      }
      show(element, SHOW_DELAY);
    };
    // The tooltip appears where the pointer is when the delay ends (it rests on the control).
    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
    };
    const onDown = (event: Event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
      suppressed = target;
      hide();
    };
    const onFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !target.matches(':focus-visible')) return;
      const element = target.closest('[data-tip]');
      if (element) {
        fromKeyboard = true;
        show(element, SHOW_DELAY);
      }
    };
    const onBlur = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-tip]') === current) hide();
    };
    const onLeave = (event: PointerEvent) => {
      if (!event.relatedTarget) hide();
    };

    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointermove', onMove, { capture: true, passive: true });
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onDown, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    document.addEventListener('scroll', hide, { capture: true, passive: true });
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', hide);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', onOver, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onDown, true);
      document.removeEventListener('wheel', hide, true);
      document.removeEventListener('scroll', hide, true);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Pointer: below-right of the pointer; flipped to the left / above when it would leave the window.
  // Keyboard focus: under the control's left edge (above it when there is no room below).
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!tip || !node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const maxLeft = window.innerWidth - width - EDGE;
    const maxTop = window.innerHeight - height - EDGE;
    let left: number;
    let top: number;
    if (tip.pointer) {
      const { x, y } = tip.pointer;
      left = x + POINTER_DX <= maxLeft ? x + POINTER_DX : x - width - 4;
      top = y + POINTER_DY <= maxTop ? y + POINTER_DY : y - height - GAP;
    } else {
      const { anchor } = tip;
      left = anchor.left;
      top = anchor.bottom + GAP <= maxTop ? anchor.bottom + GAP : anchor.top - height - GAP;
    }
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, maxLeft));
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, maxTop));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
    node.dataset.placement = tip.pointer && top < tip.pointer.y ? 'above' : 'below';
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={tipRef} className={`ui-tip${tip.rows ? ' is-table' : ''}`} role="tooltip" style={{ left: -9999, top: -9999 }}>
      {tip.rows ? (
        <dl className="ui-tip-table">
          {tip.rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <span className="ui-tip-text">{tip.text}</span>
      )}
      {tip.shortcut && <kbd>{tip.shortcut}</kbd>}
    </div>
  );
}
