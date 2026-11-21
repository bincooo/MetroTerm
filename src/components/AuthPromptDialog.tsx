import { useEffect, useRef, useState } from 'react';
import { backend, type BackendEvent } from '../lib/backend';
import type { Connection } from '../types';
import { Icon } from './Icon';
import { t } from '../i18n';

type Prompt = Extract<BackendEvent, { type: 'auth.prompt' }>;

/**
 * Answers interactive questions from the backend: SSH password, key passphrase,
 * keyboard-interactive (OTP…) and unknown host key confirmation. Questions are queued
 * and shown one at a time; answers go back with `auth.respond`. Password prompts offer
 * "Remember password" (`onRemember`; the app keeps it, encrypted, once the login succeeds).
 */
export function AuthPromptDialog({
  connections,
  onRemember,
}: {
  connections: Connection[];
  onRemember?: (connectionId: string, password: string, remember: boolean) => void;
}) {
  const [queue, setQueue] = useState<Prompt[]>([]);
  const [values, setValues] = useState<string[]>([]);
  const [remember, setRemember] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);
  /** What had focus before the dialog opened, restored once the queue is empty. */
  const returnFocus = useRef<Element | null>(null);
  const current = queue[0];
  const open = queue.length > 0;

  useEffect(
    () =>
      backend.on(event => {
        if (event.type === 'auth.prompt') setQueue(items => [...items, event]);
        else if (event.type === 'auth.done') setQueue(items => items.filter(item => item.requestId !== event.requestId));
        else if (event.type === 'backend.closed') setQueue([]);
      }),
    [],
  );

  useEffect(() => {
    setValues(current ? current.fields.map(() => '') : []);
    // Already remembered (and rejected now): keep the box ticked so the new password replaces it.
    setRemember(Boolean(current && connections.find(item => item.id === current.connectionId)?.savedPassword));
    if (current) requestAnimationFrame(() => firstInput.current?.focus());
  }, [current?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) {
      if (!returnFocus.current) returnFocus.current = document.activeElement;
      return;
    }
    const previous = returnFocus.current as HTMLElement | null;
    returnFocus.current = null;
    // Typing fields (SFTP path, Sender…) get focus back; otherwise (a toolbar button, Explorer row)
    // the visible terminal does, so the user can type straight into the session that just logged in.
    const typing =
      previous?.isConnected && previous.matches('input, textarea, [contenteditable="true"]') && !previous.closest('.auth-dialog');
    const target = typing ? previous : document.querySelector<HTMLElement>('.terminal-instance:not([hidden]) .xterm-helper-textarea');
    requestAnimationFrame(() => target?.focus());
  }, [open]);

  if (!current) return null;
  const connection = connections.find(item => item.id === current.connectionId);
  const respond = (answers: string[] | null) => {
    void backend.call('auth.respond', { requestId: current.requestId, answers }).catch(() => undefined);
    setQueue(items => items.slice(1));
  };
  const hostKey = current.kind === 'hostkey';
  const passwordPrompt = current.kind === 'password' && current.fields.length === 1 && Boolean(onRemember);
  const [intro, ...details] = current.message.split('\n');

  return (
    <div className="modal-backdrop auth-backdrop" role="presentation">
      <form
        className="connection-dialog auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            respond(null);
          }
        }}
        onSubmit={event => {
          event.preventDefault();
          if (passwordPrompt && (remember || connection?.savedPassword)) onRemember?.(current.connectionId, values[0] ?? '', remember);
          respond(hostKey ? ['save'] : values);
        }}
      >
        <div className="dialog-title">
          <span>{hostKey ? t('SECURITY') : t('AUTH')}</span>
          <b>{current.title.toUpperCase()}</b>
          <button type="button" className="icon-button" title={t('Cancel (Esc)')} onClick={() => respond(null)}>
            <Icon name="close" />
          </button>
        </div>
        <div className="auth-target">
          <Icon name={hostKey ? 'lock' : 'server'} />
          <span>{connection?.name ?? 'session'}</span>
          <small>
            {connection
              ? `${connection.username ? `${connection.username}@` : ''}${connection.host}${connection.port ? `:${connection.port}` : ''}`
              : ''}
          </small>
        </div>
        <p className="auth-message">
          {intro}
          {details.map((line, index) => (
            <span key={index}>
              <br />
              {line.includes('SHA256:') ? (
                <>
                  {line.split('SHA256:')[0]}
                  <code>SHA256:{line.split('SHA256:')[1]}</code>
                </>
              ) : (
                line
              )}
            </span>
          ))}
        </p>
        {current.fields.map((field, index) => (
          <label key={index}>
            {field.label.replace(/:\s*$/, '').toUpperCase() || t('RESPONSE')}
            <input
              ref={index === 0 ? firstInput : undefined}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={values[index] ?? ''}
              onChange={event => setValues(items => items.map((item, position) => (position === index ? event.target.value : item)))}
            />
          </label>
        ))}
        {passwordPrompt && (
          <label className="dialog-check">
            <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
            <span>{t('Remember password')}</span>
          </label>
        )}
        {hostKey ? (
          <div className="auth-actions dialog-actions">
            <button type="button" onClick={() => respond(null)}>
              {t('CANCEL')}
            </button>
            <button type="button" onClick={() => respond(['once'])}>
              {t('ACCEPT ONCE')}
            </button>
            <button type="submit" className="primary-button" autoFocus>
              {t('ACCEPT & SAVE')} <Icon name="arrowRight" />
            </button>
          </div>
        ) : (
          <div className="auth-actions dialog-actions">
            <button type="button" onClick={() => respond(null)}>
              {t('CANCEL')}
            </button>
            <button type="submit" className="primary-button">
              {t('CONTINUE')} <Icon name="arrowRight" />
            </button>
          </div>
        )}
        {queue.length > 1 && <small className="auth-queue">{t('{{count}} more request(s) waiting', { count: queue.length - 1 })}</small>}
      </form>
    </div>
  );
}
