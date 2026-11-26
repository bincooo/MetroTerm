import type { Connection, RemoteFile } from '../../types';
import { DialogFrame } from '../common/DialogFrame';
import { Icon } from '../common/Icon';
import { t, tc } from '../../i18n';

/** `files`: Delete with several items picked (`file` is the first of them). */
export type Dialog = { kind: 'mkdir' | 'rename' | 'delete'; file?: RemoteFile; files?: RemoteFile[]; value: string };

/**
 * New folder / rename / delete: a window-level dialog with the same look as the other dialogs
 * (auth prompt, new session). Esc or a click on the backdrop cancels.
 */
export function FileOpDialog({
  dialog,
  connection,
  folder,
  onChange,
  onCancel,
  onSubmit,
}: {
  dialog: Dialog;
  connection: Connection;
  folder: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const remove = dialog.kind === 'delete';
  const title = dialog.kind === 'mkdir' ? t('NEW FOLDER') : dialog.kind === 'rename' ? t('RENAME') : t('DELETE');
  const where =
    connection.transport === 'local' ? t('this computer') : `${connection.username ? `${connection.username}@` : ''}${connection.host}`;
  return (
    <DialogFrame
      kicker={t('FILER')}
      title={title}
      className="auth-dialog file-op-dialog"
      backdrop="file-op-backdrop"
      label={title}
      closeTitle={t('Cancel (Esc)')}
      focusForm={false}
      onClose={onCancel}
      onSubmit={() => onSubmit()}
    >
      <div className="auth-target" title={`${connection.name} · ${where}`}>
        <Icon name={connection.transport === 'local' ? 'terminal' : 'server'} />
        <span>{connection.name}</span>
        <small>
          {(dialog.files?.length ?? 0) > 1 ? dialog.files!.map(item => item.name).join(', ') : dialog.file ? dialog.file.path : folder}
        </small>
      </div>
      {remove ? (
        <p className="auth-message">
          {(dialog.files?.length ?? 0) > 1
            ? tc('Delete <c>{{count}} items</c> (folders with everything inside them)? This cannot be undone.', {
                count: dialog.files!.length,
              })
            : dialog.file?.kind === 'dir'
              ? tc('Delete <c>{{name}}</c> and everything inside it? This cannot be undone.', { name: dialog.file?.name })
              : tc('Delete <c>{{name}}</c>? This cannot be undone.', { name: dialog.file?.name })}
        </p>
      ) : (
        <label>
          {dialog.kind === 'mkdir' ? t('FOLDER NAME') : t('NEW NAME')}
          <input
            autoFocus
            value={dialog.value}
            spellCheck={false}
            autoComplete="off"
            onChange={event => onChange(event.target.value)}
            onFocus={event => {
              const input = event.currentTarget;
              const dot = dialog.kind === 'rename' && !dialog.file?.isDir ? input.value.lastIndexOf('.') : -1;
              requestAnimationFrame(() => input.setSelectionRange(0, dot > 0 ? dot : input.value.length));
            }}
          />
        </label>
      )}
      <div className="auth-actions dialog-actions">
        <button type="button" onClick={onCancel}>
          {t('CANCEL')}
        </button>
        <button type="submit" className={`primary-button${remove ? ' is-danger' : ''}`} autoFocus={remove}>
          {remove ? t('DELETE') : dialog.kind === 'mkdir' ? t('CREATE') : t('RENAME')} <Icon name="arrowRight" />
        </button>
      </div>
    </DialogFrame>
  );
}
