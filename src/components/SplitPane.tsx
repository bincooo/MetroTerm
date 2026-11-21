import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Default minimum size of a panel on either side of a splitter: smaller → the panel is hidden. */
export const MIN_PANEL_SIZE = 180;
/** The frame's Sender panel (layout `SENDER_SLOT`) has its own, halved minimum. */
export const SENDER_MIN_PANEL_SIZE = MIN_PANEL_SIZE / 2;
export const SPLITTER_SIZE = 4;

export type SplitDirection = 'horizontal' | 'vertical';
export type SplitCollapse = 'none' | 'first' | 'second';
/** `ratio` = share of the available space taken by the first panel (0..1). */
export type SplitState = { ratio: number; collapsed: SplitCollapse };

type SplitPaneProps = {
  direction: SplitDirection;
  state: SplitState;
  onChange: (next: SplitState) => void;
  /** Called when a side gets hidden automatically because it no longer fits (container shrank). */
  onAutoCollapse?: (side: 'first' | 'second') => void;
  /**
   * Keep the splitter at the container edge while a side is hidden (drag back to restore).
   * false → no edge handle: the hidden side reappears automatically once it fits again.
   */
  edgeHandle?: boolean;
  /** Minimum size of each side (px along the split direction). Default: MIN_PANEL_SIZE. */
  minFirst?: number;
  minSecond?: number;
  /** Side to hide first when neither side fits (e.g. the empty one). Default: 'first'. */
  preferCollapse?: 'first' | 'second';
  first: ReactNode;
  second: ReactNode;
  className?: string;
  title?: string;
};

/**
 * Generic two-panel split. `horizontal` = left | right, `vertical` = top / bottom.
 * Panels can be nested: put another <SplitPane> into `first` or `second`.
 *
 * Rule (same for every splitter): while dragging, whichever side becomes
 * smaller than its minimum (MIN_PANEL_SIZE unless set per side) is hidden and the other side takes all the space.
 * The splitter stays at the container edge, so the hidden panel can be dragged back.
 * Hidden panels stay mounted (display: none) so terminals keep their state.
 */
export function SplitPane({
  direction,
  state,
  onChange,
  onAutoCollapse,
  edgeHandle = true,
  minFirst = MIN_PANEL_SIZE,
  minSecond = MIN_PANEL_SIZE,
  preferCollapse = 'first',
  first,
  second,
  className = '',
  title,
}: SplitPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [autoCollapsed, setAutoCollapsed] = useState<SplitCollapse>('none');
  const horizontal = direction === 'horizontal';

  // If the container itself shrinks (window resize / parent drag), apply the same rule.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || state.collapsed !== 'none') {
      setAutoCollapsed('none');
      return;
    }
    const evaluate = () => {
      const total = (horizontal ? node.clientWidth : node.clientHeight) - SPLITTER_SIZE;
      const firstSize = total * state.ratio;
      const firstSmall = firstSize < minFirst;
      const secondSmall = total - firstSize < minSecond;
      setAutoCollapsed(firstSmall && secondSmall ? preferCollapse : firstSmall ? 'first' : secondSmall ? 'second' : 'none');
    };
    evaluate();
    const observer = new ResizeObserver(evaluate);
    observer.observe(node);
    return () => observer.disconnect();
  }, [horizontal, state.collapsed, state.ratio, preferCollapse, minFirst, minSecond]);

  const collapsed = state.collapsed !== 'none' ? state.collapsed : autoCollapsed;
  useEffect(() => {
    if (autoCollapsed !== 'none') onAutoCollapse?.(autoCollapsed);
  }, [autoCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const node = rootRef.current;
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = node.getBoundingClientRect();
    const total = Math.max(1, (horizontal ? bounds.width : bounds.height) - SPLITTER_SIZE);
    const onMove = (moveEvent: PointerEvent) => {
      const raw = horizontal ? moveEvent.clientX - bounds.left : moveEvent.clientY - bounds.top;
      const firstSize = Math.max(0, Math.min(total, raw - SPLITTER_SIZE / 2));
      if (firstSize < minFirst) onChange({ ratio: state.ratio, collapsed: 'first' });
      else if (total - firstSize < minSecond) onChange({ ratio: state.ratio, collapsed: 'second' });
      else onChange({ ratio: firstSize / total, collapsed: 'none' });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('is-resizing', 'is-resizing-x', 'is-resizing-y');
    };
    document.body.classList.add('is-resizing', horizontal ? 'is-resizing-x' : 'is-resizing-y');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleHidden = collapsed !== 'none' && !edgeHandle;
  const handleSize = handleHidden ? 0 : SPLITTER_SIZE;
  const track =
    collapsed === 'first'
      ? `0 ${handleSize}px minmax(0, 1fr)`
      : collapsed === 'second'
        ? `minmax(0, 1fr) ${handleSize}px 0`
        : `minmax(0, ${state.ratio}fr) ${SPLITTER_SIZE}px minmax(0, ${1 - state.ratio}fr)`;

  return (
    <div
      ref={rootRef}
      className={`split split-${direction} ${className}`}
      data-collapsed={collapsed}
      style={horizontal ? { gridTemplateColumns: track } : { gridTemplateRows: track }}
    >
      <div className={`split-cell split-first ${collapsed === 'first' ? 'is-hidden' : ''}`}>{first}</div>
      <div
        className={handleHidden ? 'split-handle is-hidden' : 'split-handle'}
        onPointerDown={beginDrag}
        title={title}
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      />
      <div className={`split-cell split-second ${collapsed === 'second' ? 'is-hidden' : ''}`}>{second}</div>
    </div>
  );
}
