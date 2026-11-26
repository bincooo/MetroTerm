import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Icon, type IconName } from './Icon';
import { t } from '../../i18n';
import { pressTarget } from '../../lib/ui/customScrollbars';

export type MenuItem =
  | { type: 'item'; id: string; label: string; icon?: IconName; hint?: string; checked?: boolean; disabled?: boolean; onSelect: () => void }
  | { type: 'separator'; id: string };

/** A `position: fixed` dropdown beside its anchor: `top` below it, or `bottom` above when there is less room below. */
export type Placement = { left: number; right: number; width: number; top?: number; bottom?: number; room: number };

/**
 * Placement of an open dropdown under `anchor` (it opens upward without `height` px of room below).
 * It follows resize and scroll (except scrolling inside `list`); a press outside `inside` closes it.
 */
export function useDropdown(
  open: boolean,
  close: () => void,
  anchor: RefObject<HTMLElement | null>,
  inside: RefObject<HTMLElement | null>[],
  height: number,
  list?: RefObject<HTMLElement | null>,
): Placement {
  const [placement, setPlacement] = useState<Placement>({ left: 0, right: 0, width: 0, room: 0 });
  const latest = useRef({ close, height });
  latest.current = { close, height };
  const place = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const base = { left: rect.left, right: Math.max(4, window.innerWidth - rect.right), width: rect.width };
    setPlacement(
      below < latest.current.height && above > below
        ? { ...base, bottom: window.innerHeight - rect.top + 2, room: above }
        : { ...base, top: rect.bottom + 2, room: below },
    );
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open, height]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const press = (event: Event) => {
      const target = pressTarget(event);
      if (!inside.some(ref => ref.current?.contains(target))) latest.current.close();
    };
    const reflow = (event: Event) => {
      if (!(event.target instanceof Node && list?.current?.contains(event.target))) place();
    };
    document.addEventListener('pointerdown', press);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', press);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return placement;
}

/** ↑ ↓ Home End Enter / Space Esc / Tab in an open list. */
export function listKeys(
  event: React.KeyboardEvent,
  keys: { move: (step: number) => void; edge?: (last: boolean) => void; pick: () => void; close: () => void },
) {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (step) keys.move(step);
  else if ((event.key === 'Home' || event.key === 'End') && keys.edge) keys.edge(event.key === 'End');
  else if (event.key === 'Enter' || event.key === ' ') keys.pick();
  else {
    if (event.key === 'Escape' || event.key === 'Tab') keys.close();
    return;
  }
  event.preventDefault();
}

/** Next enabled index from `current` (−1 = none yet) in direction `step`, wrapping around. */
export const stepIndex = (enabled: number[], current: number, step: number) => {
  if (!enabled.length) return -1;
  const at = enabled.indexOf(current);
  return enabled[at < 0 ? (step > 0 ? 0 : enabled.length - 1) : (at + step + enabled.length) % enabled.length];
};

/** Option rows of a listbox (Select, ComboBox). */
export function OptionRows<T extends { value: string; label: string; hint?: string; disabled?: boolean }>({
  options,
  highlight,
  setHighlight,
  isSelected,
  choose,
}: {
  options: T[];
  highlight: number;
  setHighlight: (index: number) => void;
  isSelected: (option: T) => boolean;
  choose: (option: T) => void;
}) {
  return options.map((option, index) => (
    <li
      key={`${option.value}-${index}`}
      role="option"
      aria-selected={isSelected(option)}
      aria-disabled={option.disabled}
      className={`${index === highlight ? 'is-active' : ''} ${isSelected(option) ? 'is-selected' : ''} ${option.disabled ? 'is-disabled' : ''}`}
      onPointerEnter={() => !option.disabled && setHighlight(index)}
      onPointerDown={event => event.preventDefault()}
      onClick={() => choose(option)}
    >
      <span>{t(option.label)}</span>
      {option.hint && <small>{t(option.hint)}</small>}
    </li>
  ));
}

/** Rows of a menu (MenuButton, ContextMenu). */
export function MenuRows({
  items,
  role,
  highlight,
  setHighlight,
  choose,
}: {
  items: MenuItem[];
  role: 'menuitem' | 'menuitemradio';
  highlight: number;
  setHighlight: (index: number) => void;
  choose: (item: MenuItem) => void;
}) {
  return items.map((item, index) =>
    item.type === 'separator' ? (
      <li key={item.id} role="separator" className="ui-menu-separator" />
    ) : (
      <li
        key={item.id}
        role={role}
        aria-checked={role === 'menuitemradio' ? (item.checked ?? false) : undefined}
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
  );
}
