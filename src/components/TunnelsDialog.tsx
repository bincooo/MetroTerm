import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { log } from '../lib/log';
import { backend } from '../lib/backend';
import { configLocation } from '../lib/config';
import { tunnelRuntime } from '../lib/tunnelRuntime';
import { useStableCallback } from '../lib/useStableCallback';
import {
  TUNNEL_KINDS,
  defaultBindHost,
  describeTunnel,
  newTunnelId,
  readTunnels,
  saveTunnels,
  sshFlag,
  validateTunnel,
  type TunnelConfig,
  type TunnelKind,
  type TunnelView,
} from '../lib/tunnels';
import type { Connection } from '../types';
import { DialogFrame } from './DialogFrame';
import { Icon } from './Icon';
import { formatBytes } from './MonitorPanel';
import { Select } from './Select';
import { t, tc } from '../i18n';
import { useTranslation } from 'react-i18next';

type TunnelsDialogProps = {
  /** Explorer sessions; only SSH sessions can carry tunnels. */
  sessions: readonly Connection[];
  onClose: () => void;
};

const parsePort = (text: string) => Math.min(65535, Number(text.replace(/\D/g, '').slice(0, 5)) || 0);
const STOPPED: TunnelView = { state: 'stopped', message: null };
const EMPTY_SESSION = { value: '', label: 'No SSH sessions in Explorer', disabled: true };

const blankTunnel = (sessionId: string): TunnelConfig => ({
  id: newTunnelId(),
  name: '',
  sessionId,
  kind: 'local',
  bindHost: '',
  bindPort: 0,
  destHost: '',
  destPort: 0,
  autoStart: false,
});

/**
 * Menu bar → Tunnels: SSH port forwarding. The list shows every saved tunnel with its state and
 * traffic (Start / Stop / Edit / Delete); NEW TUNNEL and Edit switch the dialog to the form.
 */
export function TunnelsDialog({ sessions, onClose }: TunnelsDialogProps) {
  const [tunnels, setTunnels] = useState(readTunnels);
  /** Form being edited (new or existing), or null for the list. */
  const [editing, setEditing] = useState<TunnelConfig | null>(null);
  const views = useSyncExternalStore(tunnelRuntime.subscribe, tunnelRuntime.getViews);
  useEffect(() => tunnelRuntime.watch(), []);

  const sshSessions = useMemo(() => sessions.filter(session => session.transport === 'ssh'), [sessions]);
  const sessionById = useMemo(() => new Map(sshSessions.map(session => [session.id, session])), [sshSessions]);

  const persist = (next: TunnelConfig[]) => {
    setTunnels(next);
    saveTunnels(next);
  };

  const start = useStableCallback(async (tunnel: TunnelConfig) => {
    const session = sessionById.get(tunnel.sessionId);
    if (!session) return;
    const label = tunnel.name || describeTunnel(tunnel);
    const error = await tunnelRuntime.start(tunnel, session);
    if (error) log.error(t('Tunnel {{label}}', { label }), error);
    else log.info(t('Tunnel {{label}} started ({{name}})', { label, name: session.name }));
  });
  const stop = useStableCallback(async (tunnel: TunnelConfig) => {
    await tunnelRuntime.stop(tunnel.id);
    log.info(t('Tunnel {{v}} stopped', { v: tunnel.name || describeTunnel(tunnel) }));
  });
  const remove = useStableCallback((tunnel: TunnelConfig) => {
    void tunnelRuntime.remove(tunnel.id);
    persist(tunnels.filter(item => item.id !== tunnel.id));
  });
  const save = (tunnel: TunnelConfig) => {
    const exists = tunnels.some(item => item.id === tunnel.id);
    persist(exists ? tunnels.map(item => (item.id === tunnel.id ? tunnel : item)) : [...tunnels, tunnel]);
    setEditing(null);
    // A running tunnel picks up the new settings at once.
    const view = views.get(tunnel.id);
    if (view && (view.state === 'running' || view.state === 'error')) void start(tunnel);
  };

  if (editing) {
    return (
      <TunnelForm
        initial={editing}
        isNew={!tunnels.some(item => item.id === editing.id)}
        sessions={sshSessions}
        onCancel={() => setEditing(null)}
        onSave={save}
        onClose={onClose}
      />
    );
  }

  return (
    <DialogFrame kicker={t('TUNNELS')} title={t('PORT FORWARDING')} className="tunnels-dialog" onClose={onClose} onSubmit={onClose}>
      <div className="tunnels-list" data-scrollbar role="list" aria-label={t('Tunnels')}>
        {tunnels.length ? (
          tunnels.map(tunnel => (
            <TunnelRow
              key={tunnel.id}
              tunnel={tunnel}
              view={views.get(tunnel.id) ?? STOPPED}
              session={sessionById.get(tunnel.sessionId)}
              onStart={start}
              onStop={stop}
              onEdit={setEditing}
              onRemove={remove}
            />
          ))
        ) : (
          <div className="tunnels-empty">
            {t('No tunnels yet. NEW TUNNEL forwards a port through an SSH session: local (-L), remote (-R) or dynamic SOCKS (-D).')}
          </div>
        )}
      </div>
      <p className="dialog-note">
        {backend.live
          ? t("Tunnels use the session's SSH connection (connecting it if needed) and stop when it closes. Saved in {{v}}/sessions.json.", {
              v: configLocation(),
            })
          : t('The static preview has no backend: tunnels can be configured here but only run in the MetroTerm app or server.')}
      </p>
      <div className="dialog-actions tunnels-actions">
        <button type="button" className="tunnels-new" onClick={() => setEditing(blankTunnel(sshSessions[0]?.id ?? ''))}>
          <Icon name="plus" /> {t('NEW TUNNEL')}
        </button>
        <button className="primary-button" type="submit">
          {t('CLOSE')}
        </button>
      </div>
    </DialogFrame>
  );
}

type TunnelRowProps = {
  tunnel: TunnelConfig;
  view: TunnelView;
  session: Connection | undefined;
  onStart: (tunnel: TunnelConfig) => void;
  onStop: (tunnel: TunnelConfig) => void;
  onEdit: (tunnel: TunnelConfig) => void;
  onRemove: (tunnel: TunnelConfig) => void;
};

/** One tunnel of the list; memoized so the 1 s polling only re-renders rows whose state changed. */
const TunnelRow = memo(function TunnelRow({ tunnel, view, session, onStart, onStop, onEdit, onRemove }: TunnelRowProps) {
  useTranslation(); // memoized: re-render on a language change
  const live = view.state === 'running' || view.state === 'error';
  const flag = TUNNEL_KINDS.find(item => item.value === tunnel.kind)!.flag;
  const rule = describeTunnel(tunnel, live ? view.boundPort : undefined);
  const stateLabel =
    view.state === 'running' ? t('Running') : view.state === 'starting' ? t('Starting…') : view.state === 'error' ? t('Stopped') : t('Off');
  return (
    <div className={`tunnel-row is-${view.state}`} role="listitem">
      <i className="tunnel-dot" title={stateLabel} />
      <div className="tunnel-main">
        <div className="tunnel-title">
          <em>{flag}</em>
          <b>{tunnel.name || rule}</b>
        </div>
        <div className="tunnel-rule">
          {session ? session.name : <span className="tunnel-missing">{t('Session missing')}</span>}
          {tunnel.name ? ` · ${rule}` : ''}
        </div>
        {view.message ? (
          <div className={`tunnel-message${view.state === 'running' ? '' : ' is-error'}`} title={view.message}>
            {view.message}
          </div>
        ) : null}
      </div>
      <div
        className="tunnel-traffic"
        title={
          live ? t('Connections now\t{{active}}\nConnections in total\t{{total}}', { active: view.active, total: view.total }) : undefined
        }
      >
        {live ? (
          <>
            <span>
              {view.active} / {view.total} conn
            </span>
            <span>
              ↓ {formatBytes(view.rx)} ↑ {formatBytes(view.tx)}
            </span>
          </>
        ) : (
          <span>{stateLabel}</span>
        )}
      </div>
      <div className="tunnel-buttons">
        {live || view.state === 'starting' ? (
          <button
            type="button"
            title={t('Stop')}
            aria-label={t('Stop tunnel')}
            disabled={view.state === 'starting'}
            onClick={() => onStop(tunnel)}
          >
            <Icon name="stop" />
          </button>
        ) : (
          <button
            type="button"
            title={session ? t('Start') : t('The session of this tunnel no longer exists')}
            aria-label={t('Start tunnel')}
            disabled={!session}
            onClick={() => onStart(tunnel)}
          >
            <Icon name="play" />
          </button>
        )}
        <button type="button" title={t('Edit')} aria-label={t('Edit tunnel')} onClick={() => onEdit(tunnel)}>
          <Icon name="rename" />
        </button>
        <button type="button" title="Delete" aria-label="Delete tunnel" onClick={() => onRemove(tunnel)}>
          <Icon name="trash" />
        </button>
      </div>
    </div>
  );
});

type TunnelFormProps = {
  initial: TunnelConfig;
  isNew: boolean;
  sessions: readonly Connection[];
  onCancel: () => void;
  onSave: (tunnel: TunnelConfig) => void;
  onClose: () => void;
};

const LISTEN_LABEL: Record<TunnelKind, string> = {
  local: 'LISTEN ON THIS COMPUTER',
  remote: 'LISTEN ON THE SSH SERVER',
  dynamic: 'SOCKS PROXY ON THIS COMPUTER',
};
const DEST_LABEL: Record<TunnelKind, string> = {
  local: 'DESTINATION (AS SEEN FROM THE SERVER)',
  remote: 'DESTINATION (AS SEEN FROM THIS COMPUTER)',
  dynamic: '',
};

function TunnelForm({ initial, isNew, sessions, onCancel, onSave, onClose }: TunnelFormProps) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const kind = TUNNEL_KINDS.find(item => item.value === draft.kind)!;
  const sessionOptions = sessions.length
    ? sessions.map(session => ({
        value: session.id,
        label: session.name,
        hint: `${session.username ? `${session.username}@` : ''}${session.host}`,
      }))
    : [EMPTY_SESSION];
  const update = (patch: Partial<TunnelConfig>) => {
    setDraft(current => ({ ...current, ...patch }));
    setError(null);
  };

  return (
    <DialogFrame
      kicker={t('TUNNELS')}
      title={isNew ? t('NEW TUNNEL') : t('EDIT TUNNEL')}
      className="tunnels-dialog tunnel-form"
      onClose={onClose}
      onSubmit={() => {
        const problem = validateTunnel(
          draft,
          sessions.some(session => session.id === draft.sessionId),
        );
        if (problem) setError(problem);
        else onSave({ ...draft, name: draft.name.trim(), bindHost: draft.bindHost.trim(), destHost: draft.destHost.trim() });
      }}
    >
      <div className="segmented" role="radiogroup" aria-label={t('Tunnel type')}>
        {TUNNEL_KINDS.map(item => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={draft.kind === item.value}
            className={draft.kind === item.value ? 'is-active' : ''}
            title={t(item.hint)}
            onClick={() => update({ kind: item.value })}
          >
            {t(item.label)} <small>{item.flag}</small>
          </button>
        ))}
      </div>
      <div className="form-grid even">
        <label>
          {t('NAME (OPTIONAL)')}
          <input
            value={draft.name}
            onChange={event => update({ name: event.target.value })}
            placeholder={describeTunnel(draft)}
            spellCheck={false}
          />
        </label>
        <label>
          {t('SSH SESSION')}
          <Select
            ariaLabel="SSH session"
            value={draft.sessionId}
            onChange={value => update({ sessionId: value })}
            options={sessionOptions}
          />
        </label>
      </div>
      <div className="form-grid">
        <label>
          {t(LISTEN_LABEL[draft.kind])}
          <input
            value={draft.bindHost}
            onChange={event => update({ bindHost: event.target.value })}
            placeholder={defaultBindHost(draft.kind)}
            spellCheck={false}
          />
        </label>
        <label>
          {t('PORT')}
          <input
            type="text"
            inputMode="numeric"
            value={draft.bindPort || ''}
            placeholder={draft.kind === 'remote' ? '' : 'auto'}
            onChange={event => update({ bindPort: parsePort(event.target.value) })}
          />
        </label>
      </div>
      {draft.kind !== 'dynamic' ? (
        <div className="form-grid">
          <label>
            {t(DEST_LABEL[draft.kind])}
            <input
              value={draft.destHost}
              onChange={event => update({ destHost: event.target.value })}
              placeholder="localhost"
              spellCheck={false}
            />
          </label>
          <label>
            {t('PORT')}
            <input
              type="text"
              inputMode="numeric"
              value={draft.destPort || ''}
              onChange={event => update({ destPort: parsePort(event.target.value) })}
            />
          </label>
        </div>
      ) : null}
      <label className="dialog-check">
        <input type="checkbox" checked={draft.autoStart} onChange={event => update({ autoStart: event.target.checked })} />
        <span>{t('Start when MetroTerm starts')}</span>
      </label>
      <p className={`dialog-note${error ? ' is-error' : ''}`}>
        {error ?? (
          <>
            {t(kind.hint)} {tc('Like <c>{{flag}}</c>.', { flag: sshFlag(draft) })}
            {draft.kind !== 'remote' && !draft.bindHost.trim()
              ? t(' Only this computer can connect; listen on 0.0.0.0 to allow others.')
              : ''}
          </>
        )}
      </p>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {t('CANCEL')}
        </button>
        <button className="primary-button" type="submit">
          {t('SAVE')} <Icon name="arrowRight" />
        </button>
      </div>
    </DialogFrame>
  );
}
