import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';
import { escapeCloses, backdropMouseDown } from './dialog';
import { t } from '../../i18n';

/**
 * Frame of the app dialogs: backdrop, form and title bar. Esc closes (unless it only closes an open
 * dropdown). `focusForm` focuses the form itself on open (for dialogs without an autofocused field).
 */
export function DialogFrame({
  kicker,
  title,
  className = '',
  backdrop = '',
  label,
  closeTitle = t('Close'),
  focusForm = true,
  formRef,
  onClose,
  onSubmit,
  children,
}: {
  kicker: ReactNode;
  title: ReactNode;
  className?: string;
  backdrop?: string;
  label?: string;
  closeTitle?: string;
  focusForm?: boolean;
  formRef?: RefObject<HTMLFormElement>;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const own = useRef<HTMLFormElement>(null);
  const ref = formRef ?? own;
  useEffect(() => {
    if (focusForm) ref.current?.focus({ preventScroll: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={backdrop ? `modal-backdrop ${backdrop}` : 'modal-backdrop'} role="presentation" onMouseDown={backdropMouseDown}>
      <form
        className={`connection-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={focusForm ? -1 : undefined}
        ref={ref}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={escapeCloses(onClose)}
        onSubmit={event => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-title">
          <span>{kicker}</span>
          <b>{title}</b>
          <button type="button" className="icon-button" title={closeTitle} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </form>
    </div>
  );
}

/** Footer of a form dialog: `extra` buttons, CANCEL and the submit button (default SAVE →). */
export function DialogActions({
  onCancel,
  label = t('SAVE'),
  children,
}: {
  onCancel: () => void;
  label?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="dialog-actions">
      {children}
      <button type="button" onClick={onCancel}>
        {t('CANCEL')}
      </button>
      <button className="primary-button" type="submit">
        {label} <Icon name="arrowRight" />
      </button>
    </div>
  );
}
