import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pressTarget } from '../../lib/ui/customScrollbars';
import { listKeys, MenuRows, stepIndex, useDropdown, type MenuItem } from './dropdown';

export type { MenuItem };

/**
 * Where menus are rendered: the app root, above every panel. A menu drawn inside its panel was only on top
 * within that panel's stacking context — the terminal's context menu went under the tmux splitters (z-index 7
 * in the stage, above the terminals at 1). Under `.metroterm-shell` the theme / font rules still apply.
 */
export const overlayHost = () => document.querySelector<HTMLElement>('.metroterm-shell') ?? document.body;

type MenuButtonProps = {
  items: MenuItem[];
  title: string;
  children: ReactNode;
  className?: string;
  /** Extra class on the dropdown (e.g. a narrower menu). */
  menuClassName?: string;
};

/**
 * Icon button that opens a dropdown menu (same Metro look as <Select>).
 * The menu is position: fixed, right-aligned to the button, flips upward when
 * there is no room below, and supports ↑ ↓ Home End Enter Esc.
 */
export function MenuButton({ items, title, children, className = '', menuClassName = '' }: MenuButtonProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const selectable = items.flatMap((item, index) => (item.type === 'item' && !item.disabled ? [index] : []));
  const placement = useDropdown(
    open,
    () => setOpen(false),
    buttonRef,
    [rootRef, menuRef],
    items.reduce((height, item) => height + (item.type === 'item' ? 30 : 9), 8),
  );

  const choose = (item: MenuItem) => {
    if (item.type !== 'item' || item.disabled) return;
    setOpen(false);
    item.onSelect();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (open)
      listKeys(event, {
        move: step => setHighlight(current => stepIndex(selectable, current, step)),
        edge: last => setHighlight(selectable[last ? selectable.length - 1 : 0]),
        pick: () => highlight >= 0 && choose(items[highlight]),
        close: () => {
          setOpen(false);
          buttonRef.current?.focus();
        },
      });
    else if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setHighlight(selectable[0] ?? -1);
      setOpen(true);
    }
  };

  return (
    <div ref={rootRef} className={`menu-button ${open ? 'is-open' : ''} ${className}`} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setHighlight(-1);
          setOpen(value => !value);
        }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <ul
            ref={menuRef}
            className={`ui-select-menu ui-menu ${menuClassName} ${placement.bottom !== undefined ? 'opens-up' : ''}`}
            role="menu"
            style={{ right: placement.right, top: placement.top, bottom: placement.bottom }}
          >
            <MenuRows items={items} role="menuitemradio" highlight={highlight} setHighlight={setHighlight} choose={choose} />
          </ul>,
          overlayHost(),
        )}
    </div>
  );
}

/**
 * Right-click menu at a pointer position: same items and look as <MenuButton>, kept inside the
 * window. Closes on outside click, Esc, scroll, resize or after a choice.
 */
export function ContextMenu({ items, x, y, onClose }: { items: MenuItem[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLUListElement>(null);
  const [highlight, setHighlight] = useState(-1);
  const [position, setPosition] = useState({ left: x, top: y });
  const selectable = items.flatMap((item, index) => (item.type === 'item' && !item.disabled ? [index] : []));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const left = Math.max(4, Math.min(x, window.innerWidth - node.offsetWidth - 4));
    const top = y + node.offsetHeight + 4 > window.innerHeight ? Math.max(4, y - node.offsetHeight) : y;
    setPosition({ left, top });
    node.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const close = (event: Event) => {
      if (!ref.current?.contains(pressTarget(event))) closeRef.current();
    };
    const closeNow = () => closeRef.current();
    const closeOnScroll = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener('pointerdown', close, true);
    window.addEventListener('resize', closeNow);
    window.addEventListener('blur', closeNow);
    document.addEventListener('scroll', closeOnScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', close, true);
      window.removeEventListener('resize', closeNow);
      window.removeEventListener('blur', closeNow);
      document.removeEventListener('scroll', closeOnScroll, true);
    };
  }, []);

  const choose = (item: MenuItem) => {
    if (item.type !== 'item' || item.disabled) return;
    onClose();
    item.onSelect();
  };
  return createPortal(
    <ul
      ref={ref}
      tabIndex={-1}
      className="ui-select-menu ui-menu ui-context-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event =>
        listKeys(event, {
          move: step => setHighlight(current => stepIndex(selectable, current, step)),
          pick: () => highlight >= 0 && choose(items[highlight]),
          close: () => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          },
        })
      }
    >
      <MenuRows items={items} role="menuitem" highlight={highlight} setHighlight={setHighlight} choose={choose} />
    </ul>,
    overlayHost(),
  );
}
