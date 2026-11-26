import { useState } from 'react';
import { DialogFrame, DialogActions } from '../common/DialogFrame';
import { errorText } from '../../lib/platform/log';
import { backend } from '../../lib/platform/backend';
import {
  describeProxy,
  proxyActive,
  sanitizeProxy,
  sanitizeSessionDefaults,
  type ProxyPrefs,
  type SessionDefaults,
} from '../../lib/settings/preferences';
import { defaultPort, isNetwork, sanitizeSerial, TRANSPORTS } from '../../lib/sessions/transports';
import { jumpHostsOf, type SerialSettings, type SessionProxy, type Transport } from '../../types';
import { makeSessionId, type SessionFolder } from '../../lib/sessions/tree';
import { ComboBox } from '../common/ComboBox';
import { FolderTreeSelect } from './FolderTreeSelect';
import { Icon } from '../common/Icon';
import { PasswordInput } from '../common/PasswordInput';
import { Select } from '../common/Select';
import type { TreeSession } from './SessionTree';
import { t } from '../../i18n';
import { parsePort } from '../../lib/format';

import {
  type ShellInfo,
  shellOptions,
  shellPlaceholder,
  AUTH_OPTIONS,
  DATA_BITS,
  PARITY_OPTIONS,
  STOP_BITS,
  FLOW_OPTIONS,
  BAUD_OPTIONS,
  type ProxyMode,
  proxyModeOf,
  OWN_PROXY_PORT,
  DEFAULT_NAMES,
  isDefaultName,
  useSerialPorts,
} from './sessionFields';

/**
 * Session config dialog. Without `initial` it creates a new session; with `initial` it is the
 * "Properties" dialog of an existing one (same fields, pre-filled; id, favorite and status are kept).
 * With `initial` and `copy` it is "Save Session As…": pre-filled, saved under a new id.
 * Types: SSH, Telnet, raw TCP, serial port and local shell.
 */
export function NewConnectionDialog({
  onClose,
  onSave,
  folders,
  folderId: initialFolder,
  shells,
  initial,
  copy = false,
  openTerminals = 0,
  defaults = sanitizeSessionDefaults(undefined),
  folderCounts = {},
  proxy = sanitizeProxy(undefined),
  sessions = [],
}: {
  folderCounts?: Record<string, number>;
  onClose: () => void;
  onSave: (connection: TreeSession) => void;
  folders: SessionFolder[];
  folderId: string | null;
  shells: ShellInfo[];
  initial?: TreeSession;
  copy?: boolean;
  openTerminals?: number;
  defaults?: SessionDefaults;
  /** Session → Proxy… (the PROXY field's default of SSH / Telnet / TCP sessions). */
  proxy?: ProxyPrefs;
  /** Saved sessions: the SSH ones can be a jump host. */
  sessions?: TreeSession[];
}) {
  // `copy`: "Save Session As…" — pre-filled from `initial`, but saved as a new session.
  const editing = !!initial && !copy;
  const startType: Transport = initial ? initial.transport : defaults.transport;
  const [transport, setTransport] = useState<Transport>(startType);
  const [name, setName] = useState(initial ? (copy ? t('{{name}} copy', { name: initial.name }) : initial.name) : DEFAULT_NAMES[startType]);
  const remote = initial && isNetwork(initial.transport);
  const [host, setHost] = useState(remote ? initial.host : '');
  const [username, setUsername] = useState(initial?.transport === 'ssh' ? initial.username : defaults.username);
  const [port, setPort] = useState(remote && initial.port ? initial.port : startType === 'ssh' ? defaults.port : defaultPort(startType));
  const [auth, setAuth] = useState<NonNullable<TreeSession['auth']>>(initial ? (initial.auth ?? 'auto') : defaults.auth);
  const [identityFile, setIdentityFile] = useState(initial ? (initial.identityFile ?? '') : defaults.identityFile);
  const [shell, setShell] = useState(initial ? (initial.shell ?? '') : defaults.shell);
  const [serial, setSerial] = useState<SerialSettings>(() => sanitizeSerial(initial?.serial));
  const [proxyMode, setProxyMode] = useState<ProxyMode>(() => proxyModeOf(initial));
  const ownBefore = initial?.proxy && initial.proxy.type !== 'jump' ? initial.proxy : undefined;
  const [proxyHost, setProxyHost] = useState(ownBefore?.host ?? '');
  const [proxyPort, setProxyPort] = useState(ownBefore?.port ?? 1080);
  const [proxyUser, setProxyUser] = useState(ownBefore?.username ?? '');
  const [proxyPassword, setProxyPassword] = useState('');
  /** Jump hosts in connection order. */
  const [jumpIds, setJumpIds] = useState<string[]>(() => jumpHostsOf(initial?.proxy));
  const [localEcho, setLocalEcho] = useState(Boolean(initial?.localEcho));
  const [folderId, setFolderId] = useState<string>((initial ? initial.folderId : initialFolder) ?? '');
  // Remember password (password login only): typed here, stored encrypted as `savedPassword`.
  const savedBefore = initial?.transport === 'ssh' ? initial.savedPassword : undefined;
  const [remember, setRemember] = useState(Boolean(savedBefore));
  const [password, setPassword] = useState('');
  const [saveError, setSaveError] = useState('');
  const ssh = transport === 'ssh';
  const network = isNetwork(transport);
  const { ports, refresh } = useSerialPorts(transport === 'serial');
  /** Only the Password method shows PASSWORD / Remember (Auto still asks for a password when it falls back to one). */
  const usesPassword = auth === 'password';
  const keep =
    editing && initial
      ? { id: initial.id, status: initial.status, favorite: initial.favorite }
      : { id: makeSessionId(), status: 'offline' as const, favorite: false };
  const switchTo = (next: Transport) => {
    if (next === transport) return;
    if (isDefaultName(name)) setName(DEFAULT_NAMES[next]);
    // A port still at the old type's default follows the new type.
    const oldDefault = transport === 'ssh' ? defaults.port : defaultPort(transport);
    if (!port || port === oldDefault || port === defaultPort(transport)) setPort(next === 'ssh' ? defaults.port : defaultPort(next));
    setSaveError('');
    setTransport(next);
  };
  const title = t(TRANSPORTS.find(item => item.value === transport)?.title ?? '');
  /** SSH sessions that can be a jump host: not this one, and none whose own route goes through this one. */
  const jumpsThrough = (session: TreeSession, seen: string[] = []): boolean =>
    (session.noProxy ? [] : jumpHostsOf(session.proxy)).some(next => {
      if (next === keep.id) return true;
      if (seen.includes(next)) return false;
      const hop = sessions.find(item => item.id === next);
      return hop ? jumpsThrough(hop, [...seen, next]) : false;
    });
  const jumpOptions = sessions
    .filter(item => item.transport === 'ssh' && item.id !== keep.id && !jumpsThrough(item))
    .map(item => ({
      value: item.id,
      label: item.name,
      hint: `${item.username ? `${item.username}@` : ''}${item.host}${item.port && item.port !== 22 ? `:${item.port}` : ''}`,
    }));
  const jumpNames = jumpIds.map(id => sessions.find(item => item.id === id)?.name ?? t('(missing session)'));
  /** Sessions not in the chain yet (a session is used once). */
  const jumpAddable = jumpOptions.filter(item => !jumpIds.includes(item.value));
  const moveJump = (index: number, by: -1 | 1) =>
    setJumpIds(current => {
      const next = [...current];
      [next[index], next[index + by]] = [next[index + by], next[index]];
      return next;
    });
  const proxyOptions = [
    {
      value: 'global',
      label: t('Session → Proxy…'),
      hint: proxyActive(proxy) ? describeProxy(proxy) : t('none set — direct'),
    },
    { value: 'none', label: t('No proxy'), hint: t('direct') },
    { value: 'socks5', label: 'SOCKS5' },
    { value: 'http', label: 'HTTP CONNECT' },
    // Upper case like the other proxy kinds (SOCKS5, HTTP CONNECT).
    { value: 'jump', label: t('JUMP HOST'), hint: t('through an SSH session') },
  ];
  const note = (() => {
    const proxyNote = !network
      ? ''
      : proxyMode === 'global' && proxyActive(proxy)
        ? t(' Connects through {{v}}.', { v: describeProxy(proxy) })
        : (proxyMode === 'socks5' || proxyMode === 'http') && proxyHost.trim()
          ? t(' Connects through {{v}}.', { v: `${proxyMode === 'socks5' ? 'SOCKS5' : 'HTTP'} ${proxyHost.trim()}:${proxyPort}` })
          : proxyMode === 'jump' && jumpIds.length === 1
            ? t(' Connects through the jump host {{v}} (its SSH server opens the connection).', { v: jumpNames[0] })
            : proxyMode === 'jump' && jumpIds.length > 1
              ? t(' Connects through the jump hosts {{v}}, one after the other (the last one opens the connection).', {
                  v: jumpNames.join(' → '),
                })
              : '';
    switch (transport) {
      case 'ssh':
        return `${usesPassword && remember ? 'The password is stored encrypted for this computer and user in sessions.json and tried first when connecting.' : 'Passwords and key passphrases are asked when connecting.'} New host keys must be confirmed (stored in ~/.metroterm/known_hosts).${proxyNote}`;
      case 'telnet':
        return `Telnet sends everything, passwords included, unencrypted — use it only on trusted networks.${proxyNote}`;
      case 'tcp':
        return `Raw TCP: bytes go to the port unchanged (no protocol, no encryption).${proxyNote}`;
      case 'serial':
        return ports.length || !backend.live
          ? t('Opens the serial port with these line settings. On Linux the user needs access to the device (dialout / uucp group).')
          : t('No serial port found — connect the device and press ↻, or type the device path (/dev/ttyUSB0, COM3 …).');
      default:
        return t('Opens a shell on this machine in a native pseudo terminal.');
    }
  })();
  /** A serial line setting: the select shows it as text, numbers are stored as numbers. */
  const serialSelect = (
    key: 'dataBits' | 'parity' | 'stopBits' | 'flowControl',
    label: string,
    ariaLabel: string,
    options: { value: string; label: string }[],
  ) => (
    <label>
      {label}
      <Select
        ariaLabel={ariaLabel}
        value={String(serial[key])}
        onChange={value =>
          setSerial(current => ({ ...current, [key]: typeof current[key] === 'number' ? Number(value) : value }) as SerialSettings)
        }
        options={options}
      />
    </label>
  );
  return (
    <DialogFrame
      kicker={editing ? t('PROPERTIES') : copy ? t('SAVE AS') : t('NEW')}
      title={title}
      focusForm={false}
      onClose={onClose}
      onSubmit={() => {
        void (async () => {
          if (transport === 'tcp' && !port) {
            setSaveError('A TCP session needs a port.');
            return;
          }
          if (transport === 'serial' && !serial.device.trim()) {
            setSaveError('Choose or type the serial port.');
            return;
          }
          let savedPassword: string | undefined;
          if (ssh && usesPassword && remember) {
            if (password) {
              try {
                savedPassword = await backend.call<string>('secret.seal', { text: password });
              } catch (error) {
                setSaveError(`Cannot save the password here (${errorText(error)}) — it needs the desktop app or "metroterm web".`);
                return;
              }
            } else savedPassword = savedBefore;
          } else if (ssh && auth === 'auto') savedPassword = savedBefore; // remembered at the AUTH prompt: keep it
          const base = { ...keep, folderId: folderId || null };
          let proxyFlag: { noProxy?: true; proxy?: SessionProxy } = {};
          if (network && proxyMode === 'none') proxyFlag = { noProxy: true };
          else if (network && proxyMode === 'jump') {
            if (!jumpIds.length) {
              setSaveError(t('Choose the jump host (an SSH session).'));
              return;
            }
            if (jumpIds.some(id => !jumpOptions.some(item => item.value === id))) {
              setSaveError(t('Remove the jump hosts that no longer exist or would go through this session.'));
              return;
            }
            proxyFlag = { proxy: { type: 'jump', host: '', port: 0, username: '', jumps: jumpIds } };
          } else if (network && (proxyMode === 'socks5' || proxyMode === 'http')) {
            if (!proxyHost.trim()) {
              setSaveError(t('Enter the proxy host.'));
              return;
            }
            let sealed = ownBefore?.type === proxyMode ? ownBefore.savedPassword : undefined;
            if (proxyPassword) {
              try {
                sealed = await backend.call<string>('secret.seal', { text: proxyPassword });
              } catch (error) {
                setSaveError(`Cannot save the password here (${errorText(error)}) — it needs the desktop app or "metroterm web".`);
                return;
              }
            } else if (!proxyUser.trim()) sealed = undefined;
            proxyFlag = {
              proxy: {
                type: proxyMode,
                host: proxyHost.trim(),
                port: proxyPort || OWN_PROXY_PORT[proxyMode],
                username: proxyUser.trim(),
                ...(sealed ? { savedPassword: sealed } : {}),
              },
            };
          }
          const echoFlag = !ssh && transport !== 'local' && localEcho ? { localEcho: true } : {};
          if (ssh)
            onSave({
              ...base,
              ...proxyFlag,
              name: name.trim() || host,
              host: host.trim(),
              username: username.trim(),
              port,
              transport: 'ssh',
              auth,
              identityFile: auth === 'key' || auth === 'auto' ? identityFile.trim() || undefined : undefined,
              savedPassword,
            });
          else if (transport === 'telnet' || transport === 'tcp')
            onSave({
              ...base,
              ...proxyFlag,
              ...echoFlag,
              name: name.trim() || host,
              host: host.trim(),
              username: '',
              port: port || defaultPort(transport),
              transport,
            });
          else if (transport === 'serial')
            onSave({
              ...base,
              ...echoFlag,
              name: name.trim() || serial.device.trim(),
              host: '',
              username: '',
              port: 0,
              transport: 'serial',
              serial: { ...serial, device: serial.device.trim() },
            });
          else
            onSave({
              ...base,
              name: name.trim() || t('local shell'),
              host: 'localhost',
              username: '',
              port: 0,
              transport: 'local',
              shell: shell.trim() || undefined,
            });
        })();
      }}
    >
      <div className="segmented session-types" role="radiogroup" aria-label={t('Session type')}>
        {TRANSPORTS.map(item => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={transport === item.value}
            className={transport === item.value ? 'is-active' : ''}
            onClick={() => switchTo(item.value)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <label>
        {t('LABEL')}
        <input value={name} onChange={event => setName(event.target.value)} autoFocus />
      </label>
      {network && (
        <>
          <label>
            {t('HOST')}
            <input
              value={host}
              onChange={event => setHost(event.target.value)}
              placeholder="server.example.com"
              required
              spellCheck={false}
            />
          </label>
          {ssh ? (
            <div className="form-grid">
              <label>
                {t('USER')}
                <input value={username} onChange={event => setUsername(event.target.value)} />
              </label>
              <label>
                {t('PORT')}
                <input type="text" inputMode="numeric" value={port} onChange={event => setPort(parsePort(event.target.value))} />
              </label>
            </div>
          ) : (
            <label>
              {t('PORT')}
              <input
                type="text"
                inputMode="numeric"
                value={port || ''}
                placeholder={transport === 'telnet' ? '23' : 'required'}
                onChange={event => {
                  setPort(parsePort(event.target.value));
                  setSaveError('');
                }}
              />
            </label>
          )}
        </>
      )}
      {ssh && (
        <>
          <label>
            {t('AUTHENTICATION')}
            <Select ariaLabel="Authentication" value={auth} onChange={value => setAuth(value as typeof auth)} options={AUTH_OPTIONS} />
          </label>
          {usesPassword && (
            <>
              <label>
                {t('PASSWORD')}
                <PasswordInput
                  value={password}
                  disabled={!remember}
                  onChange={event => {
                    setPassword(event.target.value);
                    setSaveError('');
                  }}
                  placeholder={
                    !remember
                      ? t('Asked when connecting')
                      : savedBefore
                        ? t('Saved — type a new one to replace it')
                        : t('Password to remember')
                  }
                />
              </label>
              <label className="dialog-check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={event => {
                    setRemember(event.target.checked);
                    setSaveError('');
                  }}
                />
                <span>{t('Remember password')}</span>
              </label>
            </>
          )}
          {(auth === 'key' || auth === 'auto') && (
            <label>
              {t('PRIVATE KEY')}
              <input
                value={identityFile}
                onChange={event => setIdentityFile(event.target.value)}
                placeholder={auth === 'auto' ? t('~/.ssh/id_ed25519 (optional)') : '~/.ssh/id_ed25519'}
                spellCheck={false}
              />
            </label>
          )}
        </>
      )}
      {transport === 'serial' && (
        <>
          <div className="form-grid">
            <label>
              {t('PORT')}
              <div className="serial-port-row">
                <ComboBox
                  ariaLabel="Serial port"
                  value={serial.device}
                  options={ports.map(item => ({ value: item.path, label: item.path, hint: item.description || undefined }))}
                  onChange={device => {
                    setSerial(current => ({ ...current, device }));
                    setSaveError('');
                    if (isDefaultName(name) || name === serial.device) setName(device.split(/[\\/]/).pop() || DEFAULT_NAMES.serial);
                  }}
                  placeholder={ports.length ? ports.map(item => item.path).join(' · ') : t('/dev/ttyUSB0 · COM3')}
                />
                <button
                  type="button"
                  className="icon-button"
                  title={t('Look for serial ports again')}
                  onClick={refresh}
                  disabled={!backend.live}
                >
                  <Icon name="refresh" />
                </button>
              </div>
            </label>
            <label>
              {t('BAUD RATE')}
              <ComboBox
                ariaLabel="Baud rate"
                value={String(serial.baudRate || '')}
                options={BAUD_OPTIONS}
                onChange={text => {
                  const rate = Number(text.replace(/\D/g, '').slice(0, 8)) || 0;
                  setSerial(current => ({ ...current, baudRate: rate }));
                }}
                placeholder="115200"
              />
            </label>
          </div>
          <div className="form-grid even">
            {serialSelect('dataBits', t('DATA BITS'), 'Data bits', DATA_BITS)}
            {serialSelect('parity', t('PARITY'), 'Parity', PARITY_OPTIONS)}
          </div>
          <div className="form-grid even">
            {serialSelect('stopBits', t('STOP BITS'), 'Stop bits', STOP_BITS)}
            {serialSelect('flowControl', t('FLOW CONTROL'), 'Flow control', FLOW_OPTIONS)}
          </div>
        </>
      )}
      {transport === 'local' && (
        <label>
          {t('SHELL')}
          <ComboBox
            ariaLabel="Shell"
            value={shell}
            options={shellOptions(shells)}
            onChange={value => {
              setShell(value);
              if (!name.trim() || name === 'local shell' || shells.some(item => item.name === name)) {
                const picked = shells.find(item => item.name === value || item.path === value);
                if (picked) setName(picked.name);
                else if (!value) setName('local shell');
              }
            }}
            placeholder={shellPlaceholder(shells)}
          />
        </label>
      )}
      {(transport === 'telnet' || transport === 'tcp' || transport === 'serial') && (
        <label className="dialog-check">
          <input type="checkbox" checked={localEcho} onChange={event => setLocalEcho(event.target.checked)} />
          <span>{transport === 'telnet' ? t('Local echo while the server does not echo') : t('Local echo (show what is typed)')}</span>
        </label>
      )}
      {network && (
        <>
          <label>
            {t('PROXY')}
            <Select
              ariaLabel="Proxy"
              value={proxyMode}
              onChange={value => {
                const next = value as ProxyMode;
                // The port still at the other type's default follows the new type.
                if ((next === 'socks5' || next === 'http') && (proxyPort === 1080 || proxyPort === 8080))
                  setProxyPort(OWN_PROXY_PORT[next]);
                setSaveError('');
                setProxyMode(next);
              }}
              options={proxyOptions}
            />
          </label>
          {(proxyMode === 'socks5' || proxyMode === 'http') && (
            <>
              <div className="form-grid">
                <label>
                  {t('PROXY HOST')}
                  <input
                    value={proxyHost}
                    onChange={event => {
                      setProxyHost(event.target.value);
                      setSaveError('');
                    }}
                    placeholder="127.0.0.1"
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t('PROXY PORT')}
                  <input
                    type="text"
                    inputMode="numeric"
                    value={proxyPort || ''}
                    onChange={event => setProxyPort(parsePort(event.target.value))}
                  />
                </label>
              </div>
              <div className="form-grid">
                <label>
                  {t('PROXY USER')}
                  <input
                    value={proxyUser}
                    onChange={event => setProxyUser(event.target.value)}
                    placeholder={t('optional')}
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t('PROXY PASSWORD')}
                  <PasswordInput
                    value={proxyPassword}
                    onChange={event => setProxyPassword(event.target.value)}
                    placeholder={ownBefore?.type === proxyMode && ownBefore.savedPassword ? t('saved — type to replace') : t('optional')}
                    autoComplete="off"
                  />
                </label>
              </div>
            </>
          )}
          {proxyMode === 'jump' && (
            <>
              <div className="field-label">{t('JUMP HOSTS (IN ORDER)')}</div>
              {jumpIds.length > 0 && (
                <ol className="jump-list" aria-label={t('Jump hosts')}>
                  {jumpIds.map((id, index) => {
                    const option = jumpOptions.find(item => item.value === id);
                    return (
                      <li key={id} className={option ? '' : 'is-missing'}>
                        <span className="jump-index">{index + 1}</span>
                        <span className="jump-name">{jumpNames[index]}</span>
                        <small>{option?.hint ?? ''}</small>
                        <button
                          type="button"
                          className="icon-button"
                          title={t('Move up')}
                          aria-label={t('Move up')}
                          disabled={index === 0}
                          onClick={() => moveJump(index, -1)}
                        >
                          <Icon name="arrowUp" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title={t('Move down')}
                          aria-label={t('Move down')}
                          disabled={index === jumpIds.length - 1}
                          onClick={() => moveJump(index, 1)}
                        >
                          <Icon name="arrowDown" />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title={t('Remove')}
                          aria-label={t('Remove')}
                          onClick={() => {
                            setJumpIds(current => current.filter(item => item !== id));
                            setSaveError('');
                          }}
                        >
                          <Icon name="close" />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
              <label className="jump-add">
                {jumpAddable.length ? (
                  <Select
                    ariaLabel="Add jump host"
                    value=""
                    onChange={value => {
                      if (value) setJumpIds(current => (current.includes(value) ? current : [...current, value]));
                      setSaveError('');
                    }}
                    options={[
                      { value: '', label: jumpIds.length ? t('Add another jump host…') : t('Choose an SSH session…'), disabled: true },
                      ...jumpAddable,
                    ]}
                  />
                ) : (
                  !jumpIds.length && <input value={t('No other SSH session saved yet')} disabled />
                )}
              </label>
            </>
          )}
        </>
      )}
      <label>
        {t('FOLDER')}
        <FolderTreeSelect ariaLabel="Folder" value={folderId} onChange={setFolderId} folders={folders} counts={folderCounts} />
      </label>
      <p className={`dialog-note${saveError ? ' is-error' : ''}`}>
        {saveError || note}
        {!saveError && editing && openTerminals > 0
          ? t(' Changes apply to new terminals; {{openTerminals}} open terminal(s) keep their current connection until Reconnect.', {
              openTerminals,
            })
          : ''}
      </p>
      <DialogActions
        onCancel={onClose}
        label={editing ? t('SAVE') : copy ? t('SAVE AS NEW SESSION') : transport === 'local' ? t('CREATE SESSION') : t('CREATE CONNECTION')}
      />
    </DialogFrame>
  );
}
