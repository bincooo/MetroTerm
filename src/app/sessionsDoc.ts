/**
 * The saved session tree (~/.metroterm/sessions.json): built-in local shells, default folders and
 * the migrations of older files (v1 → v4).
 */
import type { TreeSession } from '../components/sessions/SessionTree';
import { foldersFromGroups, ROOT_FOLDER_ID, type SessionFolder } from '../lib/sessions/tree';
import { readConfig } from '../lib/platform/config';
import { isWindowsHost } from '../lib/platform/hostOs';
import { t } from '../i18n';

/** A saved session config (Explorer item) inside a folder of the session tree. */
export type ManagedConnection = TreeSession;
/** A built-in local shell session. `shell` is a bare name, looked up on PATH by the backend. */
export const localShell = (id: string, shell: string): ManagedConnection => ({
  id,
  name: shell,
  host: 'localhost',
  port: 0,
  username: '',
  transport: 'local',
  shell,
  status: 'offline',
  folderId: 'folder-local',
  favorite: false,
});
/**
 * First start (no ~/.metroterm/sessions.json): only the local shells of the computer the backend
 * runs on (lib/platform/hostOs) — cmd and PowerShell on Windows (Windows PowerShell is part of every
 * Windows; pwsh can be added by the user), bash and zsh elsewhere. Shells missing on this computer
 * are greyed out in Explorer.
 */
export const builtinShells = (): ManagedConnection[] =>
  isWindowsHost()
    ? [localShell('local', 'cmd'), localShell('local-powershell', 'powershell')]
    : [localShell('local', 'bash'), localShell('local-zsh', 'zsh')];
/** The Linux / macOS built-ins, which earlier versions also gave Windows (see the v3 → v4 repair). */
export const UNIX_BUILTINS: Record<string, string> = { local: 'bash', 'local-zsh': 'zsh' };
export const defaultFolders: SessionFolder[] = [
  { id: ROOT_FOLDER_ID, name: 'Shell sessions', parentId: null },
  { id: 'folder-local', name: 'Local', parentId: ROOT_FOLDER_ID },
];
/** Terminal / Filer / Sender target when no session config exists at all (every folder deleted). */
export const FALLBACK_SESSION: ManagedConnection = {
  id: '__fallback__',
  name: 'local shell',
  host: 'localhost',
  port: 0,
  username: '',
  transport: 'local',
  status: 'offline',
  folderId: null,
  favorite: false,
};

/** v1 / v2: flat `group` names. v3: nested folders (`folders` + `folderId`). */
export type SavedSession = Omit<ManagedConnection, 'status' | 'folderId'> & { folderId?: string | null; group?: string };
export type SessionsDoc = { version: 1 | 2 | 3 | 4; folders?: SessionFolder[]; sessions: SavedSession[] };
/** sessions.json → explorer: open / closed folders of each Explorer panel. */
export type ExplorerDoc = { panels: Record<string, Record<string, boolean>> };

/** Saved session tree (Explorer). Runtime status is not persisted. */
export function initialSessions(): { folders: SessionFolder[]; sessions: ManagedConnection[] } {
  const doc = readConfig<SessionsDoc>('sessions');
  const saved = doc?.sessions;
  if (!doc || !Array.isArray(saved)) return { folders: defaultFolders, sessions: builtinShells() };
  let items: SavedSession[] = saved.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string');
  const version = doc.version ?? 1;
  // v1 → v2: the built-in "local shell" ($SHELL) became separate local shell sessions (builtinShells).
  if (version < 2) {
    const first = builtinShells()[0];
    items = items.map(item =>
      item.id === 'local' && item.transport === 'local' && !item.shell && item.name === 'local shell'
        ? { ...item, name: first.name, shell: first.shell }
        : item,
    );
    for (const builtin of builtinShells()) {
      if (items.some(item => item.id === builtin.id || (item.transport === 'local' && item.shell === builtin.shell))) continue;
      const after = items.reduce((last, item, index) => (item.transport === 'local' ? index : last), -1);
      const { status: _status, folderId: _folder, ...config } = builtin;
      items.splice(after + 1, 0, { ...config, group: t('Local') });
    }
  }
  // v3 → v4 (Windows): earlier versions created bash and zsh there too. Built-ins still as created
  // (same id, name and shell) become cmd and PowerShell, keeping their place, folder and favourite;
  // anything the user changed or added stays.
  if (version < 4 && isWindowsHost()) {
    const replacements = builtinShells();
    items = items.map((item, index) => {
      const shell = UNIX_BUILTINS[item.id];
      if (!shell || item.transport !== 'local' || item.shell !== shell || item.name !== shell) return item;
      const builtin = replacements[item.id === 'local' ? 0 : 1];
      if (items.some((other, at) => at !== index && other.transport === 'local' && other.shell === builtin.shell)) return item;
      // Same id: open tabs (sessions.json), Open Recent and tunnels keep pointing at it.
      return { ...item, name: builtin.name, shell: builtin.shell };
    });
  }
  // v2 → v3: groups became folders under "Shell sessions".
  if (version < 3 || !Array.isArray(doc.folders)) {
    const { folders, folderOf } = foldersFromGroups(items);
    return {
      folders,
      sessions: items.map(item => {
        const { group: _group, ...rest } = item;
        return { ...rest, folderId: folderOf(item), status: 'offline' as const };
      }),
    };
  }
  const folders = doc.folders
    .filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string')
    .map(folder => ({ ...folder, parentId: folder.parentId ?? null }));
  const known = new Set(folders.map(folder => folder.id));
  // Repair: a parent that no longer exists → top level.
  const repaired = folders.map(folder => (folder.parentId && !known.has(folder.parentId) ? { ...folder, parentId: null } : folder));
  return {
    folders: repaired,
    sessions: items.map(({ group: _group, ...item }) => ({
      ...item,
      folderId: item.folderId && known.has(item.folderId) ? item.folderId : null,
      status: 'offline' as const,
    })),
  };
}
