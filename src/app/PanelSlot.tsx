import { useLayoutEffect, useRef } from 'react';

/**
 * Placeholder in the layout tree. The real panel content is rendered (via portal) into a
 * persistent host element that is moved into this slot, so panels keep their React state
 * and DOM (Sender text, xterm buffer) when the tree is restructured by split / close.
 */
export function PanelSlot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(host);
    return () => {
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [host]);
  return <div className="panel-slot" ref={ref} />;
}
