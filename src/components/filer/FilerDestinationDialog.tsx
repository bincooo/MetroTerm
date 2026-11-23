import { useCallback, useEffect, useRef, useState } from 'react';
import { backdropMouseDown } from '../common/dialog';
import { errorText } from '../../lib/platform/log';
import type { Connection, RemoteFile } from '../../types';
import { backend, type WireSpec } from '../../lib/platform/backend';
import { joinPath, normalizePath, parentPath } from '../../lib/files/path';
import { Icon } from '../common/Icon';
import { t } from '../../i18n';

export type DestinationMode = 'move' | 'copy';

/** Is `path` the folder `folder` itself or somewhere inside it? */
const isInside = (path: string, folder: string) => {
  const base = folder.replace(/\/+$/, '');
  return path === base || path.startsWith(`${base}/`);
};

/**
 * Filer → Move to… / Copy to…: pick the destination folder on the same connection. The path box
 * can be typed into (Enter opens it); clicking a folder opens it, ↑ goes to the parent. The folder
 * that is open is the destination. Same look as the other Filer dialogs.
 */
export function FilerDestinationDialog({
  mode,
  files,
  connection,
  spec,
  startPath,
  home,
  showHidden,
  onCancel,
  onSubmit,
}: {
  mode: DestinationMode;
  /** The items to move / copy (one or more, all from the same folder). */
  files: RemoteFile[];
  connection: Connection;
  spec: WireSpec;
  startPath: string;
  /** Expands a typed `~`. */
  home: string;
  showHidden: boolean;
  onCancel: () => void;
  onSubmit: (folder: string) => void;
}) {
  const [folder, setFolder] = useState(startPath);
  const [draft, setDraft] = useState(startPath);
  const [folders, setFolders] = useState<RemoteFile[]>([]);
  /** Every name in the open folder (files too): the item must not land on an existing one. */
  const [names, setNames] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const norm = (value: string) => normalizePath(value, home || '/', false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const open = useCallback(
    async (target: string) => {
      const id = ++seq.current;
      setLoading(true);
      try {
        const result = await backend.call<{ path: string; entries: RemoteFile[] }>('fs.list', { connection: spec, path: target });
        if (id !== seq.current) return;
        setFolder(result.path);
        setDraft(result.path);
        setFolders(result.entries.filter(entry => entry.isDir));
        setNames(new Set(result.entries.map(entry => entry.name)));
        setError(null);
        listRef.current?.scrollTo({ top: 0 });
        // Keep the keyboard (Esc / Enter) in the dialog once the old rows are gone.
        requestAnimationFrame(() => {
          if (!formRef.current?.contains(document.activeElement)) inputRef.current?.focus();
        });
      } catch (reason) {
        if (id !== seq.current) return;
        setError(errorText(reason));
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [spec],
  );
  useEffect(() => {
    void open(startPath);
  }, [open, startPath]);

  const title = mode === 'move' ? t('MOVE TO') : t('COPY TO');
  const verb = mode === 'move' ? t('MOVE') : t('COPY');
  const file = files[0];
  const many = files.length > 1;
  const target = many ? `${folder.replace(/\/+$/, '')}/` : joinPath(folder, file.name);
  const sameFolder = norm(folder) === norm(parentPath(file.path));
  const intoItself = files.some(item => item.isDir && isInside(norm(folder), norm(item.path)));
  const existing = files.find(item => names.has(item.name));
  const problem = error
    ? null
    : intoItself
      ? t('A folder cannot go inside itself')
      : sameFolder && mode === 'move'
        ? many
          ? t('The items are already in this folder')
          : t('{{name}} is already in this folder', { name: file.name })
        : sameFolder || existing
          ? t('{{name}} already exists in this folder', { name: (existing ?? file).name })
          : null;
  const canSubmit = !loading && !error && !problem;
  const shown = folders.filter(entry => showHidden || !entry.name.startsWith('.'));
  const where =
    connection.transport === 'local' ? t('this computer') : `${connection.username ? `${connection.username}@` : ''}${connection.host}`;
  const draftChanged = !!draft.trim() && norm(draft) !== norm(folder);

  return (
    <div className="modal-backdrop file-op-backdrop" role="presentation" onMouseDown={backdropMouseDown}>
      <form
        ref={formRef}
        className="connection-dialog auth-dialog file-op-dialog file-dest-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
          // Enter in an edited path box opens that folder first; Enter again moves / copies.
          if (draftChanged) void open(norm(draft));
          else if (canSubmit) onSubmit(folder);
        }}
      >
        <div className="dialog-title">
          <span>{t('FILER')}</span>
          <b>{title}</b>
          <button type="button" className="icon-button" title={t('Cancel (Esc)')} onClick={onCancel}>
            <Icon name="close" />
          </button>
        </div>
        <div className="auth-target" title={`${connection.name} · ${where}`}>
          <Icon name={many ? 'copy' : file.isDir ? 'folder' : 'file'} />
          <span>{many ? t('{{count}} items', { count: files.length }) : file.name}</span>
          <small>{many ? files.map(item => item.name).join(', ') : file.path}</small>
        </div>
        <label>
          {t('DESTINATION FOLDER')}
          <span className="file-dest-path">
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              spellCheck={false}
              autoComplete="off"
              aria-label={t('Destination folder')}
              onChange={event => setDraft(event.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              title={t('Parent folder')}
              aria-label={t('Parent folder')}
              disabled={loading || parentPath(folder) === folder}
              onClick={() => void open(parentPath(folder))}
            >
              <Icon name="arrowUp" />
            </button>
          </span>
        </label>
        <div className="file-dest-list" ref={listRef} role="listbox" aria-label={t('Folders')} aria-busy={loading}>
          {error ? (
            <p className="file-dest-empty is-error">{error}</p>
          ) : shown.length ? (
            shown.map(entry => {
              const blocked = files.some(item => item.isDir && isInside(norm(entry.path), norm(item.path)));
              return (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={blocked}
                  title={
                    blocked
                      ? mode === 'move'
                        ? t('{{name}} is the item being moved', { name: entry.name })
                        : t('{{name}} is the item being copied', { name: entry.name })
                      : entry.path
                  }
                  onClick={() => {
                    inputRef.current?.focus(); // this row is replaced by the next folder's rows
                    void open(entry.path);
                  }}
                >
                  <Icon name="folder" />
                  <span>{entry.name}</span>
                </button>
              );
            })
          ) : (
            <p className="file-dest-empty">{loading ? t('Loading…') : t('No subfolders')}</p>
          )}
        </div>
        <p className={`file-dest-result${problem ? ' is-problem' : ''}`} title={problem ?? target}>
          {problem ?? (
            <>
              → <code>{target}</code>
            </>
          )}
        </p>
        <div className="auth-actions dialog-actions">
          <button type="button" onClick={onCancel}>
            {t('CANCEL')}
          </button>
          <button type="submit" className="primary-button" disabled={!canSubmit && !draftChanged}>
            {draftChanged ? t('OPEN') : verb} <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    </div>
  );
}
