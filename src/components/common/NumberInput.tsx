import { useEffect, useState } from 'react';
import { t } from '../../i18n';

type NumberInputProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Digits after the decimal point (0 = integer). */
  precision?: number;
  /** Unit shown after the number, e.g. "s". */
  suffix?: string;
  className?: string;
  ariaLabel?: string;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Numeric input with Metro-style stepper buttons.
 * - Only digits (and one decimal point when precision > 0) can be typed.
 * - ↑ / ↓ step, Shift+↑ / Shift+↓ step ×10, mouse wheel steps while focused.
 * - Value is clamped to [min, max] and rounded to `precision` on blur / Enter.
 */
export function NumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision = 0,
  suffix,
  className = '',
  ariaLabel,
}: NumberInputProps) {
  const format = (next: number) => next.toFixed(precision);
  const [draft, setDraft] = useState(format(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(format(value));
  }, [value, precision, focused]);

  const commit = (next: number) => {
    const rounded = Number(clamp(Number.isFinite(next) ? next : value, min, max).toFixed(precision));
    onChange(rounded);
    setDraft(format(rounded));
  };
  const stepBy = (direction: 1 | -1, multiplier = 1) => {
    const base = Number.parseFloat(draft);
    commit((Number.isFinite(base) ? base : value) + direction * step * multiplier);
  };

  const pattern = precision > 0 ? /^\d*\.?\d*$/ : /^\d*$/;
  const allowNegative = min < 0;

  return (
    <div className={`ui-number ${focused ? 'is-focused' : ''} ${className}`}>
      <input
        type="text"
        inputMode={precision > 0 ? 'decimal' : 'numeric'}
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuemin={Number.isFinite(min) ? min : undefined}
        aria-valuemax={Number.isFinite(max) ? max : undefined}
        aria-valuenow={value}
        value={draft}
        onFocus={event => {
          setFocused(true);
          const input = event.currentTarget;
          requestAnimationFrame(() => input.select());
        }}
        onBlur={() => {
          setFocused(false);
          commit(Number.parseFloat(draft));
        }}
        onChange={event => {
          const text = event.target.value;
          const body = allowNegative && text.startsWith('-') ? text.slice(1) : text;
          if (pattern.test(body)) setDraft(text);
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            stepBy(1, event.shiftKey ? 10 : 1);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            stepBy(-1, event.shiftKey ? 10 : 1);
          } else if (event.key === 'Enter') {
            commit(Number.parseFloat(draft));
            event.currentTarget.select();
          } else if (event.key === 'Escape') {
            setDraft(format(value));
            event.currentTarget.blur();
          }
        }}
        onWheel={event => {
          if (focused) stepBy(event.deltaY < 0 ? 1 : -1);
        }}
      />
      {suffix && (
        <span className="ui-number-suffix" aria-hidden="true">
          {suffix}
        </span>
      )}
      <div className="ui-number-steppers">
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('Increase')}
          disabled={value >= max}
          onPointerDown={event => event.preventDefault()}
          onClick={() => stepBy(1)}
        >
          <svg viewBox="0 0 8 5" aria-hidden="true">
            <path d="M1 4 4 1 7 4" fill="none" />
          </svg>
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('Decrease')}
          disabled={value <= min}
          onPointerDown={event => event.preventDefault()}
          onClick={() => stepBy(-1)}
        >
          <svg viewBox="0 0 8 5" aria-hidden="true">
            <path d="M1 1 4 4 7 1" fill="none" />
          </svg>
        </button>
      </div>
    </div>
  );
}
