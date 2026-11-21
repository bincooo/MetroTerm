import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { pressTarget } from '../lib/customScrollbars';

export type ComboOption = { value: string; label: string; hint?: string };

type ComboBoxProps = {
  value: string;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
};

/**
 * Text input with a suggestion list in the app's dropdown style — replaces <datalist>, whose
 * popup is drawn by the browser / WebKitGTK and cannot be styled.
 * Free text is allowed; the list filters as you type (name or hint), ▾ shows every option.
 * Keys: ↓ / ↑ open and move, Enter picks, Esc closes (without closing the dialog).
 */
export function ComboBox({ value, options, onChange, placeholder, ariaLabel, className = '' }: ComboBoxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  /** false: list shows everything (opened with ▾ / arrow keys); true: filtered by the typed text. */
  const [filtering, setFiltering] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [placement, setPlacement] = useState<{ left: number; top?: number; bottom?: number; width: number }>({ left: 0, width: 0 });

  const query = value.trim().toLowerCase();
  const shown =
    filtering && query
      ? options.filter(
          option =>
            option.label.toLowerCase().includes(query) ||
            (option.hint ?? '').toLowerCase().includes(query) ||
            option.value.toLowerCase().includes(query),
        )
      : options;
  const visible = open && shown.length > 0;

  const place = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuHeight = Math.min(shown.length * 30 + 8, 260);
    const below = window.innerHeight - rect.bottom;
    setPlacement(
      below < menuHeight + 8 && rect.top > below
        ? { left: rect.left, bottom: window.innerHeight - rect.top + 2, width: rect.width }
        : { left: rect.left, top: rect.bottom + 2, width: rect.width },
    );
  };
  useLayoutEffect(() => {
    if (visible) place();
  }, [visible, shown.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCurrent = (option: ComboOption) => option.value === value || (!!value && option.hint === value);
  const showAll = () => {
    setFiltering(false);
    setHighlight(Math.max(0, options.findIndex(isCurrent)));
    setOpen(true);
  };
  const choose = (option: ComboOption) => {
    onChange(option.value);
    setOpen(false);
    inputRef.current?.focus();
  };
  const move = (step: number) => setHighlight(current => (shown.length ? (current + step + shown.length) % shown.length : -1));

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!visible) showAll();
      else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && visible && highlight >= 0 && shown[highlight]) {
      event.preventDefault(); // pick, don't submit the dialog
      choose(shown[highlight]);
    } else if (event.key === 'Escape' && visible) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={rootRef} className={`ui-select ui-combobox ${visible ? 'is-open' : ''} ${className}`}>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        role="combobox"
        aria-expanded={visible}
        aria-autocomplete="list"
        onChange={event => {
          onChange(event.target.value);
          setFiltering(true);
          setHighlight(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="ui-combobox-toggle"
        tabIndex={-1}
        aria-label={t('Show options')}
        onPointerDown={event => event.preventDefault()}
        onClick={event => {
          event.preventDefault();
          if (visible) setOpen(false);
          else {
            showAll();
            inputRef.current?.focus();
          }
        }}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" />
        </svg>
      </button>
      {visible && (
        <ul
          className={`ui-select-menu ui-combobox-menu ${placement.bottom !== undefined ? 'opens-up' : ''}`}
          role="listbox"
          style={{ left: placement.left, top: placement.top, bottom: placement.bottom, minWidth: placement.width }}
          onClick={event => event.preventDefault()}
        >
          {shown.map((option, index) => (
            <li
              key={`${option.value}-${index}`}
              role="option"
              aria-selected={isCurrent(option)}
              className={`${index === highlight ? 'is-active' : ''} ${isCurrent(option) ? 'is-selected' : ''}`}
              onPointerEnter={() => setHighlight(index)}
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
