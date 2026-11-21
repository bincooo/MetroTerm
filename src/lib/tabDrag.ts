/**
 * Drag tabs with the mouse to change their order (and, for panel tabs, their panel).
 *
 * Markup:
 * - a tab strip: `data-tab-strip="<id>" data-tab-group="<group>"` (+ `data-tab-axis="y"` for a vertical list);
 * - each tab in it: `data-tab-key="<key>"`.
 *
 * `startTabDrag` is called from the tab's `onPointerDown`. Nothing happens until the pointer moves
 * DRAG_THRESHOLD px (so clicks, double-clicks and right-clicks are unchanged). While dragging, a
 * ghost with the tab name follows the pointer and a marker shows where the tab will go; both are
 * plain DOM nodes updated in place, so dragging does not re-render React on every pointer move.
 * The drop is reported once, as "put `key` before `before` in strip `strip`" (`before: null` = at the end).
 * Esc cancels. Dropping where nothing changes is ignored.
 */

export type TabDropTarget = { strip: string; before: string | null };

type TabDragOptions = {
  /** Strips of the same group accept each other's tabs. */
  group: string;
  key: string;
  /** Strip the tab is dragged from. */
  strip: string;
  /** Text of the ghost. */
  label: string;
  /** Whether the tab may go to another strip (same strip: always). */
  canDrop?: (target: TabDropTarget) => boolean;
  onDrop: (target: TabDropTarget) => void;
};

const DRAG_THRESHOLD = 5;
/** Distance from a scrollable strip's edge where dragging scrolls it. */
const EDGE_SCROLL = 28;

const isVertical = (strip: HTMLElement) => strip.dataset.tabAxis === 'y';

/** The tabs directly in this strip (not those of a nested strip). */
const tabsIn = (strip: HTMLElement) =>
  [...strip.querySelectorAll<HTMLElement>('[data-tab-key]')].filter(tab => tab.closest('[data-tab-strip]') === strip);

function stripAt(x: number, y: number, group: string) {
  const strip = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-tab-strip]');
  return strip && strip.dataset.tabGroup === group ? strip : null;
}

/** Where in `strip` a tab dropped at (x, y) goes: before the first tab whose middle is past the pointer. */
function slotAt(strip: HTMLElement, x: number, y: number) {
  const vertical = isVertical(strip);
  const tabs = tabsIn(strip);
  const index = tabs.findIndex(tab => {
    const box = tab.getBoundingClientRect();
    return vertical ? y < box.top + box.height / 2 : x < box.left + box.width / 2;
  });
  return { tabs, index: index < 0 ? tabs.length : index };
}

function edgeScroll(strip: HTMLElement, x: number, y: number) {
  const box = strip.getBoundingClientRect();
  if (isVertical(strip)) {
    if (strip.scrollHeight <= strip.clientHeight) return;
    if (y < box.top + EDGE_SCROLL) strip.scrollTop -= 8;
    else if (y > box.bottom - EDGE_SCROLL) strip.scrollTop += 8;
  } else {
    if (strip.scrollWidth <= strip.clientWidth) return;
    if (x < box.left + EDGE_SCROLL) strip.scrollLeft -= 8;
    else if (x > box.right - EDGE_SCROLL) strip.scrollLeft += 8;
  }
}

/** The click that ends a drag (pointerup on the same tab) must not activate or close anything. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener('click', swallow, true);
  window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}

export function startTabDrag(event: React.PointerEvent<HTMLElement>, options: TabDragOptions) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  // The close button and the rename field keep their own pointer behaviour.
  if ((event.target as Element).closest('input, textarea, [data-tab-close]')) return;
  const source = event.currentTarget;
  const host = source.closest<HTMLElement>('.metroterm-shell') ?? document.body;
  const startX = event.clientX;
  const startY = event.clientY;
  let started = false;
  let target: TabDropTarget | null = null;
  let ghost: HTMLDivElement | null = null;
  let marker: HTMLDivElement | null = null;

  const begin = () => {
    started = true;
    ghost = document.createElement('div');
    ghost.className = 'tab-drag-ghost';
    ghost.textContent = options.label;
    marker = document.createElement('div');
    marker.className = 'tab-drop-marker';
    marker.hidden = true;
    host.append(ghost, marker);
    source.classList.add('is-tab-dragged');
    document.body.classList.add('is-tab-dragging');
  };

  const update = (x: number, y: number) => {
    ghost!.style.transform = `translate(${x + 12}px, ${y + 14}px)`;
    const strip = stripAt(x, y, options.group);
    target = null;
    if (strip) {
      edgeScroll(strip, x, y);
      const { tabs, index } = slotAt(strip, x, y);
      const id = strip.dataset.tabStrip!;
      const before = tabs[index]?.dataset.tabKey ?? null;
      const from = id === options.strip ? tabs.findIndex(tab => tab.dataset.tabKey === options.key) : -1;
      // Same strip, right before or after itself: nothing would change.
      const noChange = from >= 0 && (index === from || index === from + 1);
      const next = { strip: id, before };
      if (!noChange && (id === options.strip || (options.canDrop?.(next) ?? true))) {
        target = next;
        const vertical = isVertical(strip);
        const stripBox = strip.getBoundingClientRect();
        const edge = tabs[index]?.getBoundingClientRect();
        const last = tabs[tabs.length - 1]?.getBoundingClientRect();
        const style = marker!.style;
        if (vertical) {
          const top = edge ? edge.top : last ? last.bottom : stripBox.top;
          const clamped = Math.max(stripBox.top, Math.min(top - 1, stripBox.bottom - 2));
          Object.assign(style, { left: `${stripBox.left}px`, top: `${clamped}px`, width: `${stripBox.width}px`, height: '2px' });
        } else {
          const left = edge ? edge.left : last ? last.right : stripBox.left;
          const clamped = Math.max(stripBox.left, Math.min(left - 1, stripBox.right - 2));
          Object.assign(style, { left: `${clamped}px`, top: `${stripBox.top}px`, width: '2px', height: `${stripBox.height}px` });
        }
      }
      document.body.classList.toggle('is-tab-drop-blocked', !target && !noChange);
    } else document.body.classList.add('is-tab-drop-blocked');
    marker!.hidden = !target;
  };

  const move = (moveEvent: PointerEvent) => {
    if (!started) {
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
      begin();
    }
    update(moveEvent.clientX, moveEvent.clientY);
  };
  const finish = (drop: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    if (!started) return;
    ghost?.remove();
    marker?.remove();
    source.classList.remove('is-tab-dragged');
    document.body.classList.remove('is-tab-dragging', 'is-tab-drop-blocked');
    swallowNextClick();
    if (drop && target) options.onDrop(target);
  };
  const up = () => finish(true);
  const cancel = () => finish(false);
  const key = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== 'Escape' || !started) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    finish(false);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}

/** `list` with `key` moved before `before` (`null` = to the end). */
export function moveBefore<T>(list: readonly T[], keyOf: (item: T) => string, key: string, before: string | null): T[] {
  const item = list.find(entry => keyOf(entry) === key);
  if (!item) return [...list];
  const rest = list.filter(entry => keyOf(entry) !== key);
  const index = before === null ? -1 : rest.findIndex(entry => keyOf(entry) === before);
  if (index < 0) rest.push(item);
  else rest.splice(index, 0, item);
  return rest;
}
