import { useEffect, useRef, useState } from 'react';
import { errorText } from '../lib/log';
import { backend } from '../lib/backend';
import {
  describeProxy,
  proxyActive,
  sanitizeProxy,
  sanitizeSessionDefaults,
  type ProxyPrefs,
  type SessionDefaults,
} from '../lib/preferences';
import { BAUD_RATES, defaultPort, isNetwork, sanitizeSerial, TRANSPORTS } from '../lib/transports';
import type { SerialSettings, Transport } from '../types';
import { makeSessionId, type SessionFolder } from '../lib/sessionTree';
import { ComboBox, type ComboOption } from './ComboBox';
import { escapeCloses } from './dialog';
import { FolderTreeSelect } from './FolderTreeSelect';
import { Icon } from './Icon';
import { Select } from './Select';
import type { TreeSession } from './SessionTree';
import { t } from '../i18n';

type ShellInfo = { name: string; path: string };

/** SHELL field suggestions: the default shell, then every shell found on this computer (name · path). */
const shellOptions = (shells: ShellInfo[]): ComboOption[] => [
  { value: '', label: t('Default shell'), hint: '$SHELL' },
  ...shells.map(item => ({ value: item.name, label: item.name, hint: item.path })),
];

/** SHELL field placeholder: the shells found on this computer, or a generic hint. */
const shellPlaceholder = (shells: ShellInfo[]) =>
  shells.length
    ? t('{{v}} · empty = $SHELL', { v: shells.map(item => item.name).join(' · ') })
    : t('bash, zsh … · empty = $SHELL / PowerShell');

/** PORT field: digits only, at most 65535 (a text input — number inputs expose no caret position). */
const parsePort = (text: string) => Math.min(65535, Number(text.replace(/\D/g, '').slice(0, 5)) || 0);

const AUTH_OPTIONS = [
  { value: 'auto', label: 'Auto', hint: 'agent → key → password' },
  { value: 'password', label: 'Password', hint: 'asked on connect' },
  { value: 'key', label: 'Public key', hint: 'key file' },
  { value: 'agent', label: 'SSH agent', hint: 'ssh-agent / Pageant' },
];

const DATA_BITS = [5, 6, 7, 8].map(value => ({ value: String(value), label: String(value) }));
const PARITY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'odd', label: 'Odd' },
  { value: 'even', label: 'Even' },
];
const STOP_BITS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
];
const FLOW_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'hardware', label: 'Hardware', hint: 'RTS/CTS' },
  { value: 'software', label: 'Software', hint: 'XON/XOFF' },
];
const BAUD_OPTIONS: ComboOption[] = BAUD_RATES.map(rate => ({ value: String(rate), label: String(rate) }));

/** Name a new session gets for each type (replaced when the type changes and the name was not edited). */
const DEFAULT_NAMES: Record<Transport, string> = { ssh: 'server', telnet: 'telnet', tcp: 'tcp', serial: 'serial', local: 'local shell' };
const isDefaultName = (name: string) => !name.trim() || Object.values(DEFAULT_NAMES).includes(name);

type SerialPortInfo = { path: string; description: string };

/** Serial ports present on this computer (backend `system.serialPorts`); [] in the browser preview. */
function useSerialPorts(enabled: boolean) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!enabled || !backend.live) return;
    let cancelled = false;
    void backend.call<SerialPortInfo[]>('system.serialPorts').then(
      list => !cancelled && setPorts(list),
      () => !cancelled && setPorts([]),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, token]);
  return { ports, refresh: () => setToken(value => value + 1) };
}

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
  /** Session → Proxy… (shown by the "Use proxy" option of SSH / Telnet / TCP sessions). */
  proxy?: ProxyPrefs;
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
  const [useProxy, setUseProxy] = useState(!initial?.noProxy);
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
  const note = (() => {
    const proxyNote = network && useProxy && proxyActive(proxy) ? t(' Connects through {{v}}.', { v: describeProxy(proxy) }) : '';
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
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="connection-dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={escapeCloses(onClose)}
        onSubmit={event => {
          event.preventDefault();
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
                  setSaveError(`Cannot save the password here (${errorText(error)}) — it needs the desktop app or metroterm-server.`);
                  return;
                }
              } else savedPassword = savedBefore;
            } else if (ssh && auth === 'auto') savedPassword = savedBefore; // remembered at the AUTH prompt: keep it
            const base = { ...keep, folderId: folderId || null };
            const proxyFlag = network && !useProxy ? { noProxy: true } : {};
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
        <div className="dialog-title">
          <span>{editing ? t('PROPERTIES') : copy ? t('SAVE AS') : t('NEW')}</span>
          <b>{title}</b>
          <button type="button" className="icon-button" title={t('Close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
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
                  <input
                    type="password"
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
              <label>
                {t('DATA BITS')}
                <Select
                  ariaLabel="Data bits"
                  value={String(serial.dataBits)}
                  onChange={value => setSerial(current => ({ ...current, dataBits: Number(value) as SerialSettings['dataBits'] }))}
                  options={DATA_BITS}
                />
              </label>
              <label>
                {t('PARITY')}
                <Select
                  ariaLabel="Parity"
                  value={serial.parity}
                  onChange={value => setSerial(current => ({ ...current, parity: value as SerialSettings['parity'] }))}
                  options={PARITY_OPTIONS}
                />
              </label>
            </div>
            <div className="form-grid even">
              <label>
                {t('STOP BITS')}
                <Select
                  ariaLabel="Stop bits"
                  value={String(serial.stopBits)}
                  onChange={value => setSerial(current => ({ ...current, stopBits: value === '2' ? 2 : 1 }))}
                  options={STOP_BITS}
                />
              </label>
              <label>
                {t('FLOW CONTROL')}
                <Select
                  ariaLabel="Flow control"
                  value={serial.flowControl}
                  onChange={value => setSerial(current => ({ ...current, flowControl: value as SerialSettings['flowControl'] }))}
                  options={FLOW_OPTIONS}
                />
              </label>
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
          <label className={`dialog-check${proxyActive(proxy) ? '' : ' is-disabled'}`}>
            <input
              type="checkbox"
              checked={useProxy && proxyActive(proxy)}
              disabled={!proxyActive(proxy)}
              onChange={event => setUseProxy(event.target.checked)}
            />
            <span>
              {proxyActive(proxy) ? t('Use proxy ({{v}})', { v: describeProxy(proxy) }) : t('Use proxy — none set (Session → Proxy…)')}
            </span>
          </label>
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
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('CANCEL')}
          </button>
          <button className="primary-button" type="submit">
            {editing ? t('SAVE') : copy ? t('SAVE AS NEW SESSION') : transport === 'local' ? t('CREATE SESSION') : t('CREATE CONNECTION')}{' '}
            <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    </div>
  );
}

/** Session → Preferences → Default Session Settings…: what the New Session dialog starts with. */
export function SessionDefaultsDialog({
  value,
  shells,
  onClose,
  onSave,
}: {
  value: SessionDefaults;
  shells: ShellInfo[];
  onClose: () => void;
  onSave: (value: SessionDefaults) => void;
}) {
  const [transport, setTransport] = useState(value.transport);
  const [username, setUsername] = useState(value.username);
  const [port, setPort] = useState(value.port);
  const [auth, setAuth] = useState(value.auth);
  const [identityFile, setIdentityFile] = useState(value.identityFile);
  const [shell, setShell] = useState(value.shell);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="connection-dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={formRef}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={escapeCloses(onClose)}
        onSubmit={event => {
          event.preventDefault();
          onSave(
            sanitizeSessionDefaults({
              transport,
              username: username.trim(),
              port,
              auth,
              identityFile: identityFile.trim(),
              shell: shell.trim(),
            }),
          );
        }}
      >
        <div className="dialog-title">
          <span>{t('DEFAULTS')}</span>
          <b>{t('DEFAULT SESSION SETTINGS')}</b>
          <button type="button" className="icon-button" title={t('Close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="field-label">{t('NEW SESSIONS START AS')}</div>
        <div className="segmented session-types" role="radiogroup" aria-label={t('Default session type')}>
          {TRANSPORTS.map(item => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={transport === item.value}
              className={transport === item.value ? 'is-active' : ''}
              onClick={() => setTransport(item.value)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <label>
            {t('SSH USER')}
            <input value={username} onChange={event => setUsername(event.target.value)} spellCheck={false} />
          </label>
          <label>
            {t('SSH PORT')}
            <input type="text" inputMode="numeric" value={port} onChange={event => setPort(parsePort(event.target.value))} />
          </label>
        </div>
        <label>
          {t('SSH AUTHENTICATION')}
          <Select
            ariaLabel="Default authentication"
            value={auth}
            onChange={next => setAuth(next as SessionDefaults['auth'])}
            options={AUTH_OPTIONS}
          />
        </label>
        <label>
          {t('SSH PRIVATE KEY')}
          <input
            value={identityFile}
            onChange={event => setIdentityFile(event.target.value)}
            placeholder={t('~/.ssh/id_ed25519 (optional)')}
            spellCheck={false}
          />
        </label>
        <label>
          {t('LOCAL SHELL')}
          <ComboBox
            ariaLabel="Local shell"
            value={shell}
            options={shellOptions(shells)}
            onChange={setShell}
            placeholder={shellPlaceholder(shells)}
          />
        </label>
        <p className="dialog-note">
          {t('Used to fill in the New Session dialog. Existing sessions are not changed — use Session Settings… for those.')}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('CANCEL')}
          </button>
          <button className="primary-button" type="submit">
            {t('SAVE DEFAULTS')} <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    </div>
  );
}
