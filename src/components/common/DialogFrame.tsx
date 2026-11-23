import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { escapeCloses, backdropMouseDown } from './dialog';
import { t } from '../../i18n';

/** Frame of the app dialogs (Proxy, Log, About, Tunnels …) — same look as Settings…. */
export function DialogFrame({
  kicker,
  title,
  className = '',
  onClose,
  onSubmit,
  children,
}: {
  kicker: string;
  title: string;
  className?: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={backdropMouseDown}>
      <form
        className={`connection-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={formRef}
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
          <button type="button" className="icon-button" title={t('Close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {children}
      </form>
    </div>
  );
}
