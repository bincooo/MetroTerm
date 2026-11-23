import { useEffect, useRef, useState } from 'react';
import { backdropMouseDown } from '../common/dialog';
import { errorText } from '../../lib/platform/log';
import { Icon } from '../common/Icon';
import { PasswordInput } from '../common/PasswordInput';
import { hasLockPassword, verifyLockPassword, type LockSettings } from '../../lib/settings/lockScreen';
import { t } from '../../i18n';
import { pad2 } from '../../lib/format';

/**
 * Full-window lock screen. Covers (and hides) everything; while it is shown no key, click, wheel or
 * paste reaches the app underneath (capture-phase filter) and focus can't leave it. With a lock
 * password it asks for it; without one it is a privacy cover that any click / Enter unlocks.
 */
export function LockOverlay({ settings, onUnlock }: { settings: LockSettings; onUnlock: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const protectedLock = hasLockPassword(settings);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Nothing underneath gets input; focus stays on the lock screen.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const focusOwn = () =>
      (inputRef.current ?? root.querySelector<HTMLElement>('button.primary-button') ?? root).focus({ preventScroll: true });
    const block = (event: Event) => {
      if (root.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'mousedown' || event.type === 'keydown') focusOwn();
    };
    const types = [
      'keydown',
      'keypress',
      'keyup',
      'beforeinput',
      'input',
      'paste',
      'cut',
      'copy',
      'compositionstart',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'contextmenu',
      'wheel',
      'pointerdown',
      'dragstart',
      'drop',
    ];
    types.forEach(type => window.addEventListener(type, block, { capture: true, passive: false }));
    const onFocus = (event: FocusEvent) => {
      if (!root.contains(event.target as Node)) focusOwn();
    };
    window.addEventListener('focusin', onFocus, true);
    (document.activeElement as HTMLElement | null)?.blur?.();
    focusOwn();
    return () => {
      types.forEach(type => window.removeEventListener(type, block, { capture: true }));
      window.removeEventListener('focusin', onFocus, true);
    };
  }, []);

  const unlock = async () => {
    if (checking) return;
    if (!protectedLock) {
      onUnlock();
      return;
    }
    setChecking(true);
    try {
      if (await verifyLockPassword(settings, password)) {
        onUnlock();
        return;
      }
      setError(t('Wrong password'));
      setPassword('');
      inputRef.current?.focus();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="lock-screen"
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t('Locked')}
      onMouseDown={event => {
        if (!protectedLock && event.button === 0 && !(event.target as HTMLElement).closest('button')) void unlock();
      }}
    >
      <form
        className="lock-card"
        onSubmit={event => {
          event.preventDefault();
          void unlock();
        }}
      >
        <div className="lock-icon">
          <Icon name="lock" size={28} />
        </div>
        <div className="lock-time">
          {pad2(now.getHours())}:{pad2(now.getMinutes())}
        </div>
        <div className="lock-date">
          {now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
        <div className="lock-title">{t('MetroTerm is locked')}</div>
        {protectedLock ? (
          <>
            <label className="lock-field">
              <PasswordInput
                ref={inputRef}
                value={password}
                placeholder={t('Lock password')}
                aria-label={t('Lock password')}
                autoComplete="off"
                spellCheck={false}
                onChange={event => {
                  setPassword(event.target.value);
                  setError('');
                }}
              />
              <button type="submit" className="primary-button" disabled={checking} title={t('Unlock (Enter)')}>
                <Icon name="arrowRight" />
              </button>
            </label>
            <div className={`lock-error${error ? ' is-shown' : ''}`} role="alert">
              {error || ' '}
            </div>
          </>
        ) : (
          <>
            <button type="submit" className="primary-button lock-unlock">
              {t('UNLOCK')} <Icon name="arrowRight" />
            </button>
            <div className="lock-hint">{t('No lock password — click anywhere or press Enter. Set one in Preferences → Settings.')}</div>
          </>
        )}
      </form>
    </div>
  );
}

/** Two password fields that must match; used by the prompts below. */
function NewPasswordFields({
  value,
  confirm,
  onValue,
  onConfirm,
  autoFocus,
}: {
  value: string;
  confirm: string;
  onValue: (value: string) => void;
  onConfirm: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <>
      <label>
        {t('NEW PASSWORD')}
        <PasswordInput
          autoFocus={autoFocus}
          autoComplete="new-password"
          spellCheck={false}
          value={value}
          onChange={event => onValue(event.target.value)}
        />
      </label>
      <label>
        {t('CONFIRM PASSWORD')}
        <PasswordInput autoComplete="new-password" spellCheck={false} value={confirm} onChange={event => onConfirm(event.target.value)} />
      </label>
    </>
  );
}

/**
 * Lock Screen without a lock password: offer to set one now, or skip (lock without a password).
 * "Don't ask again" skips this prompt next time (Preferences can turn it back on).
 */
export function LockSetupDialog({
  onSetAndLock,
  onSkip,
  onCancel,
}: {
  onSetAndLock: (password: string, dontAsk: boolean) => Promise<void> | void;
  onSkip: (dontAsk: boolean) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [dontAsk, setDontAsk] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!value) {
      setError(t('Enter a password, or Skip to lock without one.'));
      return;
    }
    if (value !== confirm) {
      setError(t('The passwords do not match.'));
      return;
    }
    try {
      await onSetAndLock(value, dontAsk);
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={backdropMouseDown}>
      <form
        className="connection-dialog auth-dialog lock-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('Lock password')}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-title">
          <span>{t('LOCK SCREEN')}</span>
          <b>{t('SET A LOCK PASSWORD')}</b>
          <button type="button" className="icon-button" title={t('Cancel (Esc)')} onClick={onCancel}>
            <Icon name="close" />
          </button>
        </div>
        <p className="auth-message">
          {t(
            'No lock password is set. With a password, the lock screen can only be unlocked with it; without one, anyone can unlock it with a click.',
          )}
        </p>
        <NewPasswordFields
          value={value}
          confirm={confirm}
          onValue={next => {
            setValue(next);
            setError('');
          }}
          onConfirm={next => {
            setConfirm(next);
            setError('');
          }}
          autoFocus
        />
        <label className="dialog-check">
          <input type="checkbox" checked={dontAsk} onChange={event => setDontAsk(event.target.checked)} />
          <span>{t("Don't ask again")}</span>
        </label>
        <div className={`dialog-error${error ? ' is-shown' : ''}`} role="alert">
          {error}
        </div>
        <div className="auth-actions dialog-actions">
          <button type="button" onClick={onCancel}>
            {t('CANCEL')}
          </button>
          <button type="button" onClick={() => onSkip(dontAsk)}>
            {t('SKIP')}
          </button>
          <button type="submit" className="primary-button">
            {t('SET & LOCK')} <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    </div>
  );
}

/** Preferences → Lock password: set, change or remove it (changing / removing needs the current one). */
export function LockPasswordDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: LockSettings;
  onSave: (password: string | null) => Promise<void> | void;
  onClose: () => void;
}) {
  const has = hasLockPassword(settings);
  const [current, setCurrent] = useState('');
  const [value, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (remove: boolean) => {
    if (busy) return;
    if (!remove && !value) {
      setError(t('Enter the new password.'));
      return;
    }
    if (!remove && value !== confirm) {
      setError(t('The passwords do not match.'));
      return;
    }
    setBusy(true);
    try {
      if (has && !(await verifyLockPassword(settings, current))) {
        setError(t('The current password is wrong.'));
        return;
      }
      await onSave(remove ? null : value);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop file-op-backdrop" role="presentation" onMouseDown={backdropMouseDown}>
      <form
        className="connection-dialog auth-dialog lock-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('Lock password')}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onSubmit={event => {
          event.preventDefault();
          void run(false);
        }}
      >
        <div className="dialog-title">
          <span>{t('LOCK SCREEN')}</span>
          <b>{has ? t('CHANGE LOCK PASSWORD') : t('SET LOCK PASSWORD')}</b>
          <button type="button" className="icon-button" title={t('Cancel (Esc)')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {has && (
          <label>
            {t('CURRENT PASSWORD')}
            <PasswordInput
              autoFocus
              autoComplete="current-password"
              spellCheck={false}
              value={current}
              onChange={event => {
                setCurrent(event.target.value);
                setError('');
              }}
            />
          </label>
        )}
        <NewPasswordFields
          value={value}
          confirm={confirm}
          onValue={next => {
            setValue(next);
            setError('');
          }}
          onConfirm={next => {
            setConfirm(next);
            setError('');
          }}
          autoFocus={!has}
        />
        <div className={`dialog-error${error ? ' is-shown' : ''}`} role="alert">
          {error}
        </div>
        <div className="auth-actions dialog-actions">
          {has && (
            <button type="button" className="is-danger-text" disabled={busy} onClick={() => void run(true)}>
              {t('REMOVE PASSWORD')}
            </button>
          )}
          <button type="button" onClick={onClose}>
            {t('CANCEL')}
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {t('SAVE')} <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    </div>
  );
}
