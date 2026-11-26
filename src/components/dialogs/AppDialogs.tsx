import { useEffect, useState } from 'react';
import { errorText } from '../../lib/platform/log';
import { backend } from '../../lib/platform/backend';
import { configLocation } from '../../lib/platform/config';
import {
  LOG_KEEP_RANGE,
  LOG_LEVELS,
  LOG_SIZE_RANGE,
  sanitizeLog,
  sanitizeProxy,
  type LogLevel,
  type LogPrefs,
  type ProxyPrefs,
} from '../../lib/settings/preferences';
import { DialogFrame, DialogActions } from '../common/DialogFrame';
import { Icon } from '../common/Icon';
import { PasswordInput } from '../common/PasswordInput';
import { NumberInput } from '../common/NumberInput';
import { Select } from '../common/Select';
import { t } from '../../i18n';
import { parsePort } from '../../lib/format';

const message = errorText;
/** Session → Proxy… → TEST TARGET default: Google's connectivity check, answers HTTP 204 over plain HTTP. */
const PROXY_TEST_TARGET = 'www.gstatic.com/generate_204';

type ProbeTarget = { host: string; port: number; path?: string; tls?: boolean };

/**
 * TEST TARGET → what to probe:
 * - `www.gstatic.com/generate_204`, `http://host[:port]/path`, `host` → HTTP GET through the proxy (port 80);
 * - `host:port` → open a tunnel only (any TCP service, e.g. an SSH server);
 * - `https://host[:port]/…` → tunnel to 443 (no TLS client: the HTTPS answer itself is not checked).
 */
function parseProbeTarget(text: string): ProbeTarget | null {
  const match = /^(?:(https?):\/\/)?(\[[^\]]+\]|[^\s/:[\]]+)(?::(\d{1,5}))?(\/\S*)?$/i.exec(text.trim());
  if (!match) return null;
  const [, scheme, rawHost, rawPort, path] = match;
  const host = rawHost.replace(/^\[|\]$/g, '');
  const port = rawPort ? Number(rawPort) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  if (scheme?.toLowerCase() === 'https') return { host, port: port ?? 443, tls: true };
  if (!scheme && port !== undefined && !path) return { host, port };
  return { host, port: port ?? 80, path: path || '/' };
}

const PROXY_TYPES: { value: ProxyPrefs['type']; label: string }[] = [
  { value: 'none', label: 'NO PROXY' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'http', label: 'HTTP CONNECT' },
];

/**
 * Session → Proxy…: one proxy for SSH, Telnet and TCP sessions (a session can opt out in its
 * settings). Saved in settings.json; the password only in encrypted form.
 */
export function ProxyDialog({ value, onClose, onSave }: { value: ProxyPrefs; onClose: () => void; onSave: (value: ProxyPrefs) => void }) {
  const [type, setType] = useState(value.type);
  const [host, setHost] = useState(value.host);
  const [port, setPort] = useState(value.port);
  const [username, setUsername] = useState(value.username);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(Boolean(value.savedPassword));
  const [target, setTarget] = useState(PROXY_TEST_TARGET);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [testing, setTesting] = useState(false);
  const off = type === 'none';

  /** Password for the saved config / the test: a new one is sealed by the backend, else the saved one. */
  const sealedPassword = async () => {
    if (!username.trim() || !remember) return undefined;
    if (password) return backend.call<string>('secret.seal', { text: password });
    return value.savedPassword;
  };
  const draft = async (): Promise<ProxyPrefs> =>
    sanitizeProxy({ type, host: host.trim(), port, username: username.trim(), savedPassword: await sealedPassword() });

  const test = async () => {
    const probe = parseProbeTarget(target);
    if (!probe) {
      setStatus({ text: t('Test target must be a URL or host:port, e.g. {{PROXY_TEST_TARGET}}', { PROXY_TEST_TARGET }), error: true });
      return;
    }
    const shown = target.trim();
    setTesting(true);
    setStatus({ text: t('Connecting to {{shown}} through {{host}}:{{port}} …', { shown, host, port }) });
    try {
      const proxy = await draft();
      // A typed password is used for the test even when it is not remembered.
      if (password && !remember) proxy.savedPassword = await backend.call<string>('secret.seal', { text: password });
      const result = await backend.call<{ ms: number; status: number | null }>('proxy.test', {
        proxy,
        host: probe.host,
        port: probe.port,
        path: probe.path,
      });
      if (result.status === null)
        setStatus({
          text: probe.tls
            ? t('OK — tunnel to {{host}}:{{port}} opened in {{ms}} ms (HTTPS itself is not checked).', {
                host: probe.host,
                port: probe.port,
                ms: result.ms,
              })
            : t('OK — tunnel to {{shown}} opened in {{ms}} ms.', { shown, ms: result.ms }),
        });
      else if (result.status < 400)
        setStatus({ text: t('OK — HTTP {{status}} from {{shown}} in {{ms}} ms.', { status: result.status, shown, ms: result.ms }) });
      else
        setStatus({
          text: t('The proxy works, but {{shown}} answered HTTP {{status}} ({{ms}} ms).', { shown, status: result.status, ms: result.ms }),
          error: true,
        });
    } catch (error) {
      setStatus({ text: message(error), error: true });
    } finally {
      setTesting(false);
    }
  };

  return (
    <DialogFrame
      kicker={t('SESSION')}
      title={t('PROXY')}
      className="proxy-dialog"
      onClose={onClose}
      onSubmit={() => {
        if (!off && !host.trim()) {
          setStatus({ text: t('Enter the proxy host.'), error: true });
          return;
        }
        void draft().then(onSave, error => setStatus({ text: t('Cannot save the password: {{v}}', { v: message(error) }), error: true }));
      }}
    >
      <div className="segmented" role="radiogroup" aria-label={t('Proxy type')}>
        {PROXY_TYPES.map(item => (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={type === item.value}
            className={type === item.value ? 'is-active' : ''}
            onClick={() => {
              setType(item.value);
              setStatus(null);
              if (item.value === 'http' && port === 1080) setPort(8080);
              if (item.value === 'socks5' && port === 8080) setPort(1080);
            }}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label>
          {t('PROXY HOST')}
          <input value={host} disabled={off} onChange={event => setHost(event.target.value)} placeholder="127.0.0.1" spellCheck={false} />
        </label>
        <label>
          {t('PORT')}
          <input
            type="text"
            inputMode="numeric"
            disabled={off}
            value={port || ''}
            onChange={event => setPort(parsePort(event.target.value))}
          />
        </label>
      </div>
      <div className="form-grid even">
        <label>
          {t('USER (OPTIONAL)')}
          <input value={username} disabled={off} onChange={event => setUsername(event.target.value)} spellCheck={false} />
        </label>
        <label>
          {t('PASSWORD')}
          <PasswordInput
            value={password}
            disabled={off || !username.trim()}
            onChange={event => setPassword(event.target.value)}
            placeholder={value.savedPassword && remember ? t('Saved — type to replace') : ''}
          />
        </label>
      </div>
      <label className={`dialog-check${off || !username.trim() ? ' is-disabled' : ''}`}>
        <input
          type="checkbox"
          checked={remember}
          disabled={off || !username.trim()}
          onChange={event => setRemember(event.target.checked)}
        />
        <span>{t('Remember password (stored encrypted)')}</span>
      </label>
      <div className="form-grid proxy-test">
        <label>
          {t('TEST TARGET')}
          <input
            value={target}
            disabled={off}
            onChange={event => setTarget(event.target.value)}
            placeholder={PROXY_TEST_TARGET}
            spellCheck={false}
          />
        </label>
        <label>
          &nbsp;
          <button
            type="button"
            className="secondary-button"
            disabled={off || testing || !host.trim() || !backend.live}
            onClick={() => void test()}
          >
            {testing ? t('TESTING…') : t('TEST')}
          </button>
        </label>
      </div>
      <p className={`dialog-note${status?.error ? ' is-error' : ''}`}>
        {status?.text ??
          (off
            ? t('SSH, Telnet and TCP sessions connect directly.')
            : t(
                'SSH, Telnet and TCP sessions connect through this proxy (the proxy resolves host names). A session can opt out in its Session Settings. Saved in {{v}}/settings.json.',
                { v: configLocation() },
              ))}
      </p>
      <DialogActions onCancel={onClose} />
    </DialogFrame>
  );
}

const LEVEL_OPTIONS: { value: LogLevel; label: string; hint: string }[] = LOG_LEVELS.map(level => ({
  value: level,
  label: level === 'off' ? t('Off') : level[0].toUpperCase() + level.slice(1),
  hint:
    level === 'off'
      ? t('nothing is written')
      : level === 'error'
        ? t('failures only')
        : level === 'warn'
          ? t('failures and warnings')
          : level === 'info'
            ? t('connections, sessions, settings')
            : level === 'debug'
              ? t('+ details and libraries')
              : t('everything (large)'),
}));

/**
 * Session → Log…: the application log (what MetroTerm itself does — connections, errors …; not the
 * terminal output, which is saved with Save Output As…). Level, file, line format and size limit.
 */
export function LogSettingsDialog({ value, onClose, onSave }: { value: LogPrefs; onClose: () => void; onSave: (value: LogPrefs) => void }) {
  const [level, setLevel] = useState(value.level);
  const [path, setPath] = useState(value.path);
  const [format, setFormat] = useState(value.format);
  const [maxSizeMb, setMaxSizeMb] = useState(value.maxSizeMb);
  const [keep, setKeep] = useState(value.keep);
  const [defaultPath, setDefaultPath] = useState('~/.metroterm/logs/metroterm.log');
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (backend.live) void backend.call<string>('log.defaultPath').then(setDefaultPath, () => undefined);
  }, []);
  const draft = () => sanitizeLog({ level, path, format, maxSizeMb, keep });
  const now = new Date();
  const time = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().slice(0, 8)}.000`;
  const sample =
    format === 'json'
      ? `{"level":"INFO","message":"SSH connect root@server:22","target":"metroterm_lib::ssh","time":"${time.replace(' ', 'T')}"}`
      : `${time} INFO  [metroterm_lib::ssh] SSH connect root@server:22`;
  return (
    <DialogFrame
      kicker={t('SESSION')}
      title={t('LOG SETTINGS')}
      className="log-dialog"
      onClose={onClose}
      onSubmit={() => {
        const next = draft();
        if (!backend.live) {
          onSave(next);
          return;
        }
        void backend.call<string>('log.configure', next).then(
          () => onSave(next),
          error => setStatus({ text: message(error), error: true }),
        );
      }}
    >
      <label>
        {t('LOG LEVEL')}
        <Select ariaLabel="Log level" value={level} onChange={next => setLevel(next as LogLevel)} options={LEVEL_OPTIONS} />
      </label>
      <label>
        {t('LOG FILE')}
        <div className="log-path-row">
          <input
            value={path}
            onChange={event => {
              setPath(event.target.value);
              setStatus(null);
            }}
            placeholder={defaultPath}
            spellCheck={false}
          />
          <button
            type="button"
            className="icon-button"
            title={t('Show the log folder')}
            disabled={!backend.live}
            onClick={() =>
              void backend.call<string>('log.open', draft()).then(
                dir => setStatus({ text: t('Opened {{dir}}', { dir }) }),
                error => setStatus({ text: message(error), error: true }),
              )
            }
          >
            <Icon name="folder" />
          </button>
        </div>
      </label>
      <div className="field-label">{t('FORMAT')}</div>
      <div className="segmented" role="radiogroup" aria-label={t('Log format')}>
        <button
          type="button"
          role="radio"
          aria-checked={format === 'text'}
          className={format === 'text' ? 'is-active' : ''}
          onClick={() => setFormat('text')}
        >
          {t('TEXT')}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={format === 'json'}
          className={format === 'json' ? 'is-active' : ''}
          onClick={() => setFormat('json')}
        >
          {t('JSON LINES')}
        </button>
      </div>
      <pre className="log-sample" aria-label={t('Sample line')}>
        {sample}
      </pre>
      <div className="form-grid even">
        <label>
          {t('NEW FILE AFTER')}
          <NumberInput
            ariaLabel="Start a new log file after (MB, 0 = never)"
            value={maxSizeMb}
            onChange={setMaxSizeMb}
            min={LOG_SIZE_RANGE.min}
            max={LOG_SIZE_RANGE.max}
            step={1}
            suffix="MB"
          />
        </label>
        <label>
          {t('KEEP OLD FILES')}
          <NumberInput
            ariaLabel="Old log files kept"
            value={keep}
            onChange={setKeep}
            min={LOG_KEEP_RANGE.min}
            max={LOG_KEEP_RANGE.max}
            step={1}
          />
        </label>
      </div>
      <p className={`dialog-note${status?.error ? ' is-error' : ''}`}>
        {status?.text ??
          t(
            'Application log: connections, disconnects and errors of MetroTerm (terminal output is not logged). Empty file = {{defaultPath}}. Size 0 = one growing file; old files are kept as .1 … .{{v}}.',
            { defaultPath, v: keep || 'N' },
          )}
      </p>
      <DialogActions onCancel={onClose} />
    </DialogFrame>
  );
}

/** Help → About MetroTerm. */
export function AboutDialog({ version, backendVersion, onClose }: { version: string; backendVersion: string | null; onClose: () => void }) {
  const rows: [string, string][] = [
    ['Version', version],
    ['Backend', backendVersion ? t('metroterm {{backendVersion}}', { backendVersion }) : backend.live ? '—' : t('not connected (preview)')],
    ['Runtime', isDesktopRuntime() ? t('Desktop app (Tauri 2)') : t('Browser')],
    ['Terminal', 'xterm.js 5.5'],
    ['Sessions', 'SSH · SFTP · Telnet · TCP · Serial · Local shell'],
    ['Settings', configLocation()],
  ];
  return (
    <DialogFrame kicker={t('HELP')} title={t('ABOUT')} className="about-dialog" onClose={onClose} onSubmit={onClose}>
      <div className="about-head">
        <b>{t('MetroTerm')}</b>
        <span>{version}</span>
      </div>
      <dl className="about-rows">
        {rows.map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="dialog-note">{t('A terminal for SSH, SFTP, Telnet, TCP and serial sessions — TypeScript, React and Rust.')}</p>
      <div className="dialog-actions">
        <button className="primary-button" type="submit" autoFocus>
          {t('OK')}
        </button>
      </div>
    </DialogFrame>
  );
}

const isDesktopRuntime = () => Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
