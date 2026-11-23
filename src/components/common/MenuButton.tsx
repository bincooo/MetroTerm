import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { t } from '../../i18n';
import { pressTarget } from '../../lib/ui/customScrollbars';

export type MenuItem =
  | { type: 'item'; id: string; label: string; icon?: IconName; hint?: string; checked?: boolean; disabled?: boolean; onSelect: () => void }
  | { type: 'separator'; id: string };

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
  const [placement, setPlacement] = useState<{ right: number; top?: number; bottom?: number }>({ right: 0 });
  const selectable = items.map((item, index) => (item.type === 'item' && !item.disabled ? index : -1)).filter(index => index >= 0);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = items.reduce((height, item) => height + (item.type === 'item' ? 30 : 9), 8);
    const below = window.innerHeight - rect.bottom;
    const right = Math.max(4, window.innerWidth - rect.right);
    setPlacement(
      below < menuHeight + 8 && rect.top > below ? { right, bottom: window.innerHeight - rect.top + 2 } : { right, top: rect.bottom + 2 },
    );
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const target = pressTarget(event);
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const reflow = () => place();
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', reflow);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', reflow);
    };
  }, [open]);

  const choose = (item: MenuItem) => {
    if (item.type !== 'item' || item.disabled) return;
    setOpen(false);
    item.onSelect();
  };
  const move = (step: number) => {
    if (!selectable.length) return;
    const position = selectable.indexOf(highlight);
    setHighlight(selectable[(position + step + selectable.length) % selectable.length] ?? selectable[0]);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setHighlight(selectable[0] ?? -1);
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlight(selectable[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlight(selectable[selectable.length - 1]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (highlight >= 0) choose(items[highlight]);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      buttonRef.current?.focus();
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
            {items.map((item, index) =>
              item.type === 'separator' ? (
                <li key={item.id} role="separator" className="ui-menu-separator" />
              ) : (
                <li
                  key={item.id}
                  role="menuitemradio"
                  aria-checked={item.checked ?? false}
                  aria-disabled={item.disabled}
                  className={`${index === highlight ? 'is-active' : ''} ${item.checked ? 'is-selected' : ''} ${item.disabled ? 'is-disabled' : ''}`}
                  onPointerEnter={() => !item.disabled && setHighlight(index)}
                  onPointerLeave={() => setHighlight(-1)}
                  onPointerDown={event => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  <i aria-hidden="true">
                    {item.icon ? <Icon name={item.icon} /> : item.checked ? <span className="ui-menu-check" /> : null}
                  </i>
                  <span>{t(item.label)}</span>
                  {item.hint && <small>{t(item.hint)}</small>}
                </li>
              ),
            )}
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
  const selectable = items.map((item, index) => (item.type === 'item' && !item.disabled ? index : -1)).filter(index => index >= 0);
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
  const move = (step: number) => {
    if (!selectable.length) return;
    const index = selectable.indexOf(highlight);
    setHighlight(selectable[index < 0 ? (step > 0 ? 0 : selectable.length - 1) : (index + step + selectable.length) % selectable.length]);
  };
  return createPortal(
    <ul
      ref={ref}
      tabIndex={-1}
      className="ui-select-menu ui-menu ui-context-menu"
      role="menu"
      style={{ left: position.left, top: position.top }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (highlight >= 0) choose(items[highlight]);
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {items.map((item, index) =>
        item.type === 'separator' ? (
          <li key={item.id} role="separator" className="ui-menu-separator" />
        ) : (
          <li
            key={item.id}
            role="menuitem"
            aria-disabled={item.disabled}
            className={`${index === highlight ? 'is-active' : ''} ${item.checked ? 'is-selected' : ''} ${item.disabled ? 'is-disabled' : ''}`}
            onPointerEnter={() => !item.disabled && setHighlight(index)}
            onPointerLeave={() => setHighlight(-1)}
            onPointerDown={event => event.preventDefault()}
            onClick={() => choose(item)}
          >
            <i aria-hidden="true">{item.icon ? <Icon name={item.icon} /> : item.checked ? <span className="ui-menu-check" /> : null}</i>
            <span>{t(item.label)}</span>
            {item.hint && <small>{t(item.hint)}</small>}
          </li>
        ),
      )}
    </ul>,
    overlayHost(),
  );
}
