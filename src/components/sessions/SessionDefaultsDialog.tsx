import { useState } from 'react';
import { DialogFrame, DialogActions } from '../common/DialogFrame';
import { sanitizeSessionDefaults, type SessionDefaults } from '../../lib/settings/preferences';
import { TRANSPORTS } from '../../lib/sessions/transports';
import { ComboBox } from '../common/ComboBox';
import { Select } from '../common/Select';
import { t } from '../../i18n';
import { parsePort } from '../../lib/format';

import { type ShellInfo, shellOptions, shellPlaceholder, AUTH_OPTIONS } from './sessionFields';

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
  return (
    <DialogFrame
      kicker={t('DEFAULTS')}
      title={t('DEFAULT SESSION SETTINGS')}
      onClose={onClose}
      onSubmit={() => {
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
      <DialogActions onCancel={onClose} label={t('SAVE DEFAULTS')} />
    </DialogFrame>
  );
}
