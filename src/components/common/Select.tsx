import { useRef, useState } from 'react';
import { t } from '../../i18n';
import { listKeys, OptionRows, stepIndex, useDropdown } from './dropdown';

type SelectOption = { value: string; label: string; hint?: string; disabled?: boolean };

type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
};

/** Custom dropdown (native <option> lists cannot be styled consistently). */
export function Select({ value, options, onChange, className = '', ariaLabel }: SelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const placement = useDropdown(open, () => setOpen(false), triggerRef, [rootRef], Math.min(options.length * 30 + 8, 260));
  const selected = options.find(option => option.value === value) ?? options[0];
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));

  const openMenu = () => {
    setHighlight(
      Math.max(
        0,
        options.findIndex(option => option.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (option: SelectOption | undefined) => {
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (open)
      listKeys(event, {
        move: step => setHighlight(current => stepIndex(enabled, current, step)),
        edge: last => setHighlight(last ? options.length - 1 : 0),
        pick: () => choose(options[highlight]),
        close: () => setOpen(false),
      });
    else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openMenu();
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
        // preventDefault on click: inside a <label>, the browser would forward a click in the list to
        // the trigger button and reopen the menu after a choice.
        <ul
          className={`ui-select-menu ${placement.bottom !== undefined ? 'opens-up' : ''}`}
          role="listbox"
          style={{ left: placement.left, top: placement.top, bottom: placement.bottom, minWidth: placement.width }}
          onClick={event => event.preventDefault()}
        >
          <OptionRows
            options={options}
            highlight={highlight}
            setHighlight={setHighlight}
            isSelected={option => option.value === value}
            choose={choose}
          />
        </ul>
      )}
    </div>
  );
}
