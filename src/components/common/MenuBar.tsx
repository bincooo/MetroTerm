import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import type { MenuItem } from './MenuButton';
import { t } from '../../i18n';
import { pressTarget } from '../../lib/ui/customScrollbars';

/** A menu-bar entry: the normal menu items plus cascading submenus (Open Recent ▸, Log ▸ …). */
export type BarMenuItem =
  MenuItem | { type: 'submenu'; id: string; label: string; icon?: IconName; disabled?: boolean; items: BarMenuItem[] };
export type BarMenu = { id: string; label: string; items?: BarMenuItem[] };

type Anchor = { left: number; right: number; top: number; bottom: number };
const EDGE = 4;
/** Delay before hovering opens / switches a submenu, so a diagonal move into it doesn't close it. */
const HOVER_DELAY = 160;

const enabled = (item: BarMenuItem) => item.type !== 'separator' && !item.disabled;

/**
 * Window menu bar (Session, Edit …). A menu opens on click; while one is open, hovering another
 * title switches to it. Submenus cascade to the right (left when there is no room). Keyboard:
 * ↑ ↓ Home End move, → opens a submenu / goes to the next menu, ← closes it / previous menu,
 * Enter chooses, Esc closes one level. Menus without items are plain (inactive) titles.
 */
export function MenuBar({ menus }: { menus: BarMenu[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState<{ id: string; anchor: Anchor; keyboard: boolean } | null>(null);
  /** Focus before the menu opened (usually the terminal): given back when the menu closes. */
  const returnFocus = useRef<HTMLElement | null>(null);
  const withItems = menus.filter(menu => menu.items?.length);

  const anchorOf = (id: string): Anchor | null => {
    const rect = buttons.current.get(id)?.getBoundingClientRect();
    return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null;
  };
  const show = (id: string, keyboard = false) => {
    const anchor = anchorOf(id);
    if (!anchor) return;
    if (!open) {
      const focused = document.activeElement;
      returnFocus.current = focused instanceof HTMLElement && !rootRef.current?.contains(focused) ? focused : null;
    }
    setOpen({ id, anchor, keyboard });
  };
  const close = (restore = true) => {
    setOpen(null);
    if (restore) returnFocus.current?.focus({ preventScroll: true });
    returnFocus.current = null;
  };
  const step = (delta: number) => {
    if (!open) return;
    const index = withItems.findIndex(menu => menu.id === open.id);
    const next = withItems[(index + delta + withItems.length) % withItems.length];
    if (next) show(next.id, true);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!rootRef.current?.contains(pressTarget(event))) close(false);
    };
    const closeNow = () => close(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', closeNow);
    window.addEventListener('blur', closeNow);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', closeNow);
      window.removeEventListener('blur', closeNow);
    };
  }, [open]);

  const current = open ? menus.find(menu => menu.id === open.id) : undefined;
  return (
    <div ref={rootRef} className="menu-items" role="menubar">
      {menus.map(menu => {
        const active = open?.id === menu.id;
        return (
          <button
            key={menu.id}
            ref={node => {
              if (node) buttons.current.set(menu.id, node);
              else buttons.current.delete(menu.id);
            }}
            type="button"
            role="menuitem"
            aria-haspopup={menu.items?.length ? 'menu' : undefined}
            aria-expanded={menu.items?.length ? active : undefined}
            className={active ? 'is-open' : ''}
            // pointerdown (not click) so the terminal keeps focus until a command is chosen.
            onPointerDown={event => {
              if (!menu.items?.length || event.button !== 0) return;
              event.preventDefault();
              if (active) close();
              else show(menu.id);
            }}
            onPointerEnter={() => {
              if (open && !active && menu.items?.length) show(menu.id);
            }}
            onKeyDown={event => {
              if (!menu.items?.length) return;
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
                event.preventDefault();
                show(menu.id, true);
              }
            }}
          >
            {t(menu.label)}
          </button>
        );
      })}
      {open && current?.items && (
        <MenuPanel
          key={open.id}
          items={current.items}
          anchor={open.anchor}
          placement="below"
          autoFocus
          keyboard={open.keyboard}
          onChoose={item => {
            close();
            item.onSelect();
          }}
          onDismiss={() => close()}
          onStep={step}
        />
      )}
    </div>
  );
}

type PanelProps = {
  items: BarMenuItem[];
  anchor: Anchor;
  placement: 'below' | 'side';
  autoFocus: boolean;
  /** Opened from the keyboard: the first item starts highlighted. */
  keyboard: boolean;
  onChoose: (item: Extract<MenuItem, { type: 'item' }>) => void;
  /** Esc (or ← in a submenu): close this level. */
  onDismiss: () => void;
  /** ← / → on the top level: previous / next menu-bar menu. */
  onStep?: (delta: number) => void;
  /** Pointer entered this panel: the parent cancels a pending submenu switch. */
  onPointerInside?: () => void;
};

function MenuPanel({ items, anchor, placement, autoFocus, keyboard, onChoose, onDismiss, onStep, onPointerInside }: PanelProps) {
  const ref = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const selectable = items.map((item, index) => (enabled(item) ? index : -1)).filter(index => index >= 0);
  const [highlight, setHighlight] = useState(keyboard ? (selectable[0] ?? -1) : -1);
  const [sub, setSub] = useState<{ index: number; anchor: Anchor; keyboard: boolean } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const hoverTimer = useRef(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let left: number;
    let top: number;
    if (placement === 'below') {
      left = Math.min(anchor.left, window.innerWidth - width - EDGE);
      top = anchor.bottom;
    } else {
      // Beside the parent item, the first item level with it (menu padding + border = 5px).
      left = anchor.right + width + EDGE <= window.innerWidth ? anchor.right - 1 : anchor.left - width + 1;
      top = anchor.top - 5;
    }
    if (top + height > window.innerHeight - EDGE) top = window.innerHeight - EDGE - height;
    setPosition({ left: Math.max(EDGE, left), top: Math.max(EDGE, top) });
    if (autoFocus) node.focus({ preventScroll: true });
  }, []);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const openSub = (index: number, viaKeyboard: boolean) => {
    window.clearTimeout(hoverTimer.current);
    const item = items[index];
    const rect = itemRefs.current[index]?.getBoundingClientRect();
    if (!item || item.type !== 'submenu' || item.disabled || !rect) {
      setSub(null);
      return;
    }
    if (sub?.index === index && !viaKeyboard) return;
    setSub({ index, anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, keyboard: viaKeyboard });
  };
  const activate = (index: number, viaKeyboard: boolean) => {
    const item = items[index];
    if (!item || !enabled(item)) return;
    if (item.type === 'submenu') openSub(index, viaKeyboard);
    else if (item.type === 'item') onChoose(item);
  };
  const move = (delta: number) => {
    // Keyboard takes over from the mouse: drop a hover-opened submenu / pending hover switch.
    window.clearTimeout(hoverTimer.current);
    setSub(null);
    if (!selectable.length) return;
    const at = selectable.indexOf(highlight);
    setHighlight(selectable[at < 0 ? (delta > 0 ? 0 : selectable.length - 1) : (at + delta + selectable.length) % selectable.length]);
  };

  const subItem = sub ? items[sub.index] : undefined;
  return (
    <>
      <ul
        ref={ref}
        tabIndex={-1}
        role="menu"
        className="ui-select-menu ui-menu menu-bar-menu"
        style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
        onContextMenu={event => event.preventDefault()}
        onPointerEnter={() => onPointerInside?.()}
        onKeyDown={event => {
          // Keys from an open submenu bubble up through React's tree: leave them to it.
          if (event.target !== ref.current) return;
          const key = event.key;
          // A submenu opened by hover (focus stayed here): Esc / ← close just that submenu.
          if (sub && (key === 'Escape' || key === 'ArrowLeft')) {
            setSub(null);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (key === 'ArrowDown') move(1);
          else if (key === 'ArrowUp') move(-1);
          else if (key === 'Home') {
            setSub(null);
            setHighlight(selectable[0] ?? -1);
          } else if (key === 'End') {
            setSub(null);
            setHighlight(selectable[selectable.length - 1] ?? -1);
          } else if (key === 'Enter' || key === ' ') {
            if (highlight >= 0) activate(highlight, true);
          } else if (key === 'ArrowRight') {
            if (items[highlight]?.type === 'submenu') activate(highlight, true);
            else onStep?.(1);
          } else if (key === 'ArrowLeft') {
            if (onStep) onStep(-1);
            else onDismiss();
          } else if (key === 'Escape') onDismiss();
          else if (key === 'Tab') onDismiss();
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {items.map((item, index) => {
          if (item.type === 'separator') return <li key={item.id} role="separator" className="ui-menu-separator" />;
          const isSub = item.type === 'submenu';
          const checked = item.type === 'item' && item.checked;
          const expanded = isSub && sub?.index === index;
          return (
            <li
              key={item.id}
              ref={node => {
                itemRefs.current[index] = node;
              }}
              role={item.type === 'item' && item.checked !== undefined ? 'menuitemradio' : 'menuitem'}
              aria-checked={item.type === 'item' && item.checked !== undefined ? item.checked : undefined}
              aria-haspopup={isSub ? 'menu' : undefined}
              aria-expanded={isSub ? expanded : undefined}
              aria-disabled={item.disabled}
              className={[
                index === highlight || expanded ? 'is-active' : '',
                checked ? 'is-selected' : '',
                item.disabled ? 'is-disabled' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerEnter={() => {
                window.clearTimeout(hoverTimer.current);
                if (item.disabled) {
                  setHighlight(-1);
                  hoverTimer.current = window.setTimeout(() => setSub(null), HOVER_DELAY);
                  return;
                }
                setHighlight(index);
                hoverTimer.current = window.setTimeout(() => (isSub ? openSub(index, false) : setSub(null)), HOVER_DELAY);
              }}
              onPointerLeave={() => {
                if (!sub) setHighlight(-1);
              }}
              onPointerDown={event => event.preventDefault()}
              onClick={() => activate(index, false)}
            >
              <i aria-hidden="true">{item.icon ? <Icon name={item.icon} /> : checked ? <span className="ui-menu-check" /> : null}</i>
              <span>{t(item.label)}</span>
              {isSub ? (
                <b className="menu-bar-chevron" aria-hidden="true">
                  <Icon name="chevronRight" size={12} />
                </b>
              ) : item.hint ? (
                <small>{t(item.hint)}</small>
              ) : (
                <small />
              )}
            </li>
          );
        })}
      </ul>
      {sub && subItem?.type === 'submenu' && (
        <MenuPanel
          key={subItem.id}
          items={subItem.items}
          anchor={sub.anchor}
          placement="side"
          autoFocus={sub.keyboard}
          keyboard={sub.keyboard}
          onChoose={onChoose}
          onDismiss={() => {
            setSub(null);
            ref.current?.focus({ preventScroll: true });
          }}
          onPointerInside={() => {
            window.clearTimeout(hoverTimer.current);
            setHighlight(sub.index);
          }}
        />
      )}
    </>
  );
}
