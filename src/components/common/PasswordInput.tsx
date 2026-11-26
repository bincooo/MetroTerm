import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { t } from '../../i18n';
import { Icon } from './Icon';

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Password field with an eye button on its right: shows the text in clear, a second click hides it
 * again. The button keeps the focus in the field (and its caret), is skipped by Tab, and is disabled
 * with the field. Used for every password / passphrase input (session, proxy, SSH prompt, lock).
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput({ className, ...rest }, ref) {
  const [shown, setShown] = useState(false);
  const label = shown ? t('Hide password') : t('Show password');
  return (
    <span className={`password-field${className ? ` ${className}` : ''}`}>
      <input ref={ref} {...rest} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="password-eye"
        tabIndex={-1}
        title={label}
        aria-label={label}
        aria-pressed={shown}
        disabled={rest.disabled}
        onMouseDown={event => event.preventDefault()}
        onClick={() => setShown(value => !value)}
      >
        <Icon name={shown ? 'eyeOff' : 'eye'} />
      </button>
    </span>
  );
});
