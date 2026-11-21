import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { pressTarget } from '../lib/customScrollbars';

type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean };

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
};

/**
 * Custom dropdown (native <option> lists cannot be styled consistently).
 * Square Metro look, low-contrast gray, keyboard support (↑ ↓ Home End Enter Esc).
 * The menu is position: fixed so it is not clipped by panel overflow, and it
 * opens upward automatically when there is not enough room below.
 */
export function Select({ value, options, onChange, className = '', ariaLabel }: SelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [placement, setPlacement] = useState<{ left: number; top?: number; bottom?: number; width: number }>({ left: 0, width: 0 });
  const selected = options.find(option => option.value === value) ?? options[0];

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = Math.min(options.length * 30 + 8, 260);
    const below = window.innerHeight - rect.bottom;
    setPlacement(
      below < menuHeight + 8 && rect.top > below
        ? { left: rect.left, bottom: window.innerHeight - rect.top + 2, width: rect.width }
        : { left: rect.left, top: rect.bottom + 2, width: rect.width },
    );
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!rootRef.current?.contains(pressTarget(event))) setOpen(false);
    };
    const reflow = () => place();
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [open]);

  const openMenu = () => {
    setHighlight(
      Math.max(
        0,
        options.findIndex(option => option.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const move = (step: number) =>
    setHighlight(current => {
      let next = current;
      for (let i = 0; i < options.length; i++) {
        next = (next + step + options.length) % options.length;
        if (!options[next].disabled) break;
      }
      return next;
    });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openMenu();
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
      setHighlight(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlight(options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(options[highlight]);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`ui-select ${open ? 'is-open' : ''} ${className}`} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span>{selected && t(selected.label)}</span>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" />
        </svg>
      </button>
      {open && (
        // preventDefault on click: when the Select sits inside a <label>, the browser would otherwise
        // forward a click in the list to the trigger button and reopen the menu after a choice.
        <ul
          className={`ui-select-menu ${placement.bottom !== undefined ? 'opens-up' : ''}`}
          role="listbox"
          style={{ left: placement.left, top: placement.top, bottom: placement.bottom, minWidth: placement.width }}
          onClick={event => event.preventDefault()}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled}
              className={`${index === highlight ? 'is-active' : ''} ${option.value === value ? 'is-selected' : ''} ${option.disabled ? 'is-disabled' : ''}`}
              onPointerEnter={() => !option.disabled && setHighlight(index)}
              onPointerDown={event => event.preventDefault()}
              onClick={() => choose(option)}
            >
              <span>{t(option.label)}</span>
              {option.hint && <small>{t(option.hint)}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
