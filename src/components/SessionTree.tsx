import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ContextMenu, type MenuItem } from './MenuButton';
import { Icon } from './Icon';
import { transportIcon } from '../lib/transports';
import type { Connection } from '../types';
import { canDrop, childFolders, type DropTarget, type SessionFolder, type TreeRef } from '../lib/sessionTree';
import { t } from '../i18n';

export type TreeSession = Connection & { folderId: string | null; favorite: boolean };

type Props = {
  folders: SessionFolder[];
  sessions: TreeSession[];
  filter: string;
  isMissing: (session: TreeSession) => boolean;
  onOpen: (id: string) => void;
  onToggleFolder: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onMove: (dragged: TreeRef, target: DropTarget) => void;
  /** Context menu for a folder, a session or (null) the empty area. */
  menuFor: (target: TreeRef | null) => MenuItem[];
};

type Drag = { ref: TreeRef; label: string; x: number; y: number; target: DropTarget | null };
const DRAG_THRESHOLD = 4;

/**
 * Explorer tree: folders nested to any depth (top level: "Shell sessions" and any other folder),
 * session configs inside them. Click a folder to expand / collapse it, double-click a session to
 * open a new terminal. Folders and sessions can be dragged onto other folders (into), between
 * siblings (before / after) or onto the empty area (top level). Right-click for the menu.
 */
export function SessionTree({ folders, sessions, filter, isMissing, onOpen, onToggleFolder, onToggleFavorite, onMove, menuFor }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: TreeRef | null } | null>(null);
  const [favoritesCollapsed, setFavoritesCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const dragRef = useRef<Drag | null>(null);

  // ---------- filtering ----------
  const query = filter.trim().toLowerCase();
  const { visibleFolders, visibleSessions } = useMemo(() => {
    if (!query) return { visibleFolders: null, visibleSessions: null };
    // A session is shown when it matches, or when it sits (at any depth) in a folder whose name matches.
    // A folder is shown when it or an ancestor matches, or when anything inside it is shown.
    const parentOf = new Map(folders.map(folder => [folder.id, folder.parentId]));
    const named = new Set(folders.filter(folder => folder.name.toLowerCase().includes(query)).map(folder => folder.id));
    const inNamed = (id: string | null) => {
      const seen = new Set<string>();
      for (let at = id; at && !seen.has(at); at = parentOf.get(at) ?? null) {
        if (named.has(at)) return true;
        seen.add(at);
      }
      return false;
    };
    const sessionIds = new Set(
      sessions
        .filter(
          session =>
            inNamed(session.folderId) || [session.name, session.host, session.username].some(text => text?.toLowerCase().includes(query)),
        )
        .map(session => session.id),
    );
    const folderIds = new Set(folders.filter(folder => inNamed(folder.id)).map(folder => folder.id));
    for (const session of sessions) {
      if (!sessionIds.has(session.id)) continue;
      const seen = new Set<string>();
      for (let at = session.folderId; at && !seen.has(at); at = parentOf.get(at) ?? null) {
        folderIds.add(at);
        seen.add(at);
      }
    }
    return { visibleFolders: folderIds, visibleSessions: sessionIds };
  }, [query, folders, sessions]);
  const folderShown = (folder: SessionFolder) => !visibleFolders || visibleFolders.has(folder.id);
  const sessionShown = (session: TreeSession) => !visibleSessions || visibleSessions.has(session.id);
  const countIn = (folderId: string): number =>
    sessions.filter(session => session.folderId === folderId && sessionShown(session)).length +
    childFolders(folders, folderId)
      .filter(folderShown)
      .reduce((sum, child) => sum + countIn(child.id), 0);

  // ---------- drag & drop (pointer based: works the same in browsers and the desktop webview) ----------
  const targetAt = (x: number, y: number, ref: TreeRef): DropTarget | null => {
    const element = document.elementFromPoint(x, y);
    if (!element || !rootRef.current?.contains(element)) return null;
    const row = element.closest<HTMLElement>('[data-folder], [data-session]');
    let target: DropTarget;
    if (!row) target = { kind: 'root' };
    else {
      const rect = row.getBoundingClientRect();
      const offset = (y - rect.top) / rect.height;
      if (row.dataset.folder) {
        // Folders dragged onto a folder: top quarter = before, bottom quarter = after (when collapsed), middle = into.
        const id = row.dataset.folder;
        const collapsed = row.dataset.collapsed === 'true';
        const mode =
          ref.kind === 'folder' && offset < 0.25 ? 'before' : ref.kind === 'folder' && offset > 0.75 && collapsed ? 'after' : 'into';
        target = { kind: 'folder', id, mode };
      } else {
        if (row.dataset.virtual) return null; // Favorites list: not a place
        target = { kind: 'session', id: row.dataset.session!, mode: offset < 0.5 ? 'before' : 'after' };
      }
    }
    return canDrop(folders, ref, target) ? target : null;
  };
  const startPointer = (event: React.PointerEvent, ref: TreeRef, label: string) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    const move = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return;
        started = true;
        document.body.classList.add('is-tree-dragging');
      }
      const next: Drag = {
        ref,
        label,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        target: targetAt(moveEvent.clientX, moveEvent.clientY, ref),
      };
      dragRef.current = next;
      setDrag(next);
    };
    const finish = (cancelled: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      document.body.classList.remove('is-tree-dragging');
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!started) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (!cancelled && current?.target) onMove(ref, current.target);
    };
    const up = () => finish(false);
    const key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(true);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
  };
  useEffect(() => () => document.body.classList.remove('is-tree-dragging'), []);

  const dropClass = (kind: 'folder' | 'session', id: string) => {
    const target = drag?.target;
    if (!target || target.kind !== kind || target.id !== id) return '';
    return ` drop-${target.mode}`;
  };
  const isDragged = (kind: 'folder' | 'session', id: string) => (drag?.ref.kind === kind && drag.ref.id === id ? ' is-dragged' : '');
  const openMenu = (event: React.MouseEvent, target: TreeRef | null) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target });
  };

  // ---------- rows ----------
  const sessionRow = (session: TreeSession, depth: number, virtual = false): ReactNode => {
    const missing = isMissing(session);
    return (
      <div
        key={`${virtual ? 'fav-' : ''}${session.id}`}
        data-session={session.id}
        data-virtual={virtual || undefined}
        className={`tree-row${missing ? ' is-missing' : ''}${dropClass('session', session.id)}${virtual ? '' : isDragged('session', session.id)}`}
        style={{ '--depth': depth } as React.CSSProperties}
        title={
          missing ? t('{{shell}} is not installed on this computer', { shell: session.shell }) : t('Double-click to open a new terminal')
        }
        onPointerDown={virtual ? undefined : event => startPointer(event, { kind: 'session', id: session.id }, session.name)}
        onDoubleClick={() => onOpen(session.id)}
        onContextMenu={event => openMenu(event, { kind: 'session', id: session.id })}
      >
        <i className={session.status === 'online' ? 'session-online' : session.status === 'connecting' ? 'session-connecting' : ''}>
          <Icon name={transportIcon(session.transport)} />
        </i>
        <span>{session.name}</span>
        <div className="tree-row-actions" onDoubleClick={event => event.stopPropagation()}>
          <button
            title={t('Favorite')}
            onClick={event => {
              event.stopPropagation();
              onToggleFavorite(session.id);
            }}
          >
            <Icon name={session.favorite ? 'starFilled' : 'star'} />
          </button>
        </div>
      </div>
    );
  };
  const folderNode = (folder: SessionFolder, depth: number): ReactNode => {
    if (!folderShown(folder)) return null;
    const open = query ? true : !folder.collapsed;
    return (
      <div className="tree-folder" key={folder.id}>
        <div
          role="button"
          tabIndex={-1}
          data-folder={folder.id}
          data-collapsed={String(!open)}
          className={`group-row${dropClass('folder', folder.id)}${isDragged('folder', folder.id)}`}
          style={{ '--depth': depth } as React.CSSProperties}
          onPointerDown={event => startPointer(event, { kind: 'folder', id: folder.id }, folder.name)}
          onClick={() => {
            if (!suppressClick.current) onToggleFolder(folder.id);
          }}
          onContextMenu={event => openMenu(event, { kind: 'folder', id: folder.id })}
        >
          <i>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} />
          </i>
          <span>{folder.name}</span>
          <small>{countIn(folder.id)}</small>
        </div>
        {open && (
          <>
            {childFolders(folders, folder.id).map(child => folderNode(child, depth + 1))}
            {sessions
              .filter(session => session.folderId === folder.id && sessionShown(session))
              .map(session => sessionRow(session, depth + 1))}
          </>
        )}
      </div>
    );
  };

  const favorites = sessions.filter(session => session.favorite && sessionShown(session));
  const folderIds = new Set(folders.map(folder => folder.id));
  const rootSessions = sessions.filter(session => (!session.folderId || !folderIds.has(session.folderId)) && sessionShown(session));
  const empty = !folders.length && !sessions.length;

  return (
    <div
      ref={rootRef}
      className={`tree-list session-tree${drag?.target?.kind === 'root' ? ' drop-root' : ''}`}
      onContextMenu={event => openMenu(event, null)}
    >
      {favorites.length > 0 && (
        <div className="tree-folder is-virtual">
          <div
            role="button"
            tabIndex={-1}
            className="group-row"
            style={{ '--depth': 0 } as React.CSSProperties}
            onClick={() => setFavoritesCollapsed(value => !value)}
            onContextMenu={event => openMenu(event, null)}
          >
            <i>
              <Icon name={favoritesCollapsed ? 'chevronRight' : 'chevronDown'} />
            </i>
            <span>{t('Favorites')}</span>
            <small>{favorites.length}</small>
          </div>
          {!favoritesCollapsed && favorites.map(session => sessionRow(session, 1, true))}
        </div>
      )}
      {childFolders(folders, null).map(folder => folderNode(folder, 0))}
      {rootSessions.map(session => sessionRow(session, 0))}
      {empty && <div className="tree-empty">{t('No sessions. Right-click to add a folder or a session.')}</div>}
      {query && !empty && !rootSessions.length && !favorites.length && !childFolders(folders, null).some(folderShown) && (
        <div className="tree-empty">{t('No matches')}</div>
      )}
      {menu && <ContextMenu items={menuFor(menu.target)} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {drag &&
        createPortal(
          <div className={`tree-drag-ghost${drag.target ? '' : ' is-blocked'}`} style={{ left: drag.x + 12, top: drag.y + 10 }}>
            <Icon name={drag.ref.kind === 'folder' ? 'folderFilled' : 'terminal'} size={12} />
            <span>{drag.label}</span>
          </div>,
          document.querySelector('.metroterm-shell') ?? document.body,
        )}
    </div>
  );
}

/** Small window-level dialog (same look as the auth / Filer dialogs): a name prompt or a confirmation. */
export function TreeDialog({
  title,
  section,
  label,
  initial,
  message,
  confirm,
  danger,
  onSubmit,
  onCancel,
}: {
  title: string;
  section: string;
  label?: string;
  initial?: string;
  message?: ReactNode;
  confirm: string;
  danger?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  const prompt = label !== undefined;
  return createPortal(
    <div className="modal-backdrop file-op-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="connection-dialog auth-dialog file-op-dialog tree-dialog"
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
          if (!prompt || value.trim()) onSubmit(value.trim());
        }}
      >
        <div className="dialog-title">
          <span>{section}</span>
          <b>{title}</b>
          <button type="button" className="icon-button" title={t('Cancel (Esc)')} onClick={onCancel}>
            <Icon name="close" />
          </button>
        </div>
        {message && <p className="auth-message">{message}</p>}
        {prompt && (
          <label>
            {label}
            <input
              autoFocus
              value={value}
              spellCheck={false}
              autoComplete="off"
              onChange={event => setValue(event.target.value)}
              onFocus={event => {
                const input = event.currentTarget;
                requestAnimationFrame(() => input.select());
              }}
            />
          </label>
        )}
        <div className="auth-actions dialog-actions">
          <button type="button" onClick={onCancel}>
            {t('CANCEL')}
          </button>
          <button
            type="submit"
            className={`primary-button${danger ? ' is-danger' : ''}`}
            autoFocus={!prompt}
            disabled={prompt && !value.trim()}
          >
            {confirm} <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    </div>,
    document.querySelector('.metroterm-shell') ?? document.body,
  );
}
