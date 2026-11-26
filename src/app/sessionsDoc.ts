/**
 * The saved session tree (~/.metroterm/sessions.json): built-in local shells and default folders.
 */
import type { TreeSession } from '../components/sessions/SessionTree';
import { ROOT_FOLDER_ID, type SessionFolder } from '../lib/sessions/tree';
import { readConfig } from '../lib/platform/config';
import { isWindowsHost } from '../lib/platform/hostOs';

/** A saved session config (Explorer item) inside a folder of the session tree. */
export type ManagedConnection = TreeSession;
/** A built-in local shell session. `shell` is a bare name, looked up on PATH by the backend. */
const localShell = (id: string, shell: string): ManagedConnection => ({
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
const builtinShells = (): ManagedConnection[] =>
  isWindowsHost()
    ? [localShell('local', 'cmd'), localShell('local-powershell', 'powershell')]
    : [localShell('local', 'bash'), localShell('local-zsh', 'zsh')];
const defaultFolders: SessionFolder[] = [
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

export type SavedSession = Omit<ManagedConnection, 'status' | 'folderId'> & { folderId?: string | null };
export type SessionsDoc = { version: 4; folders?: SessionFolder[]; sessions: SavedSession[] };
/** sessions.json → explorer: open / closed folders of each Explorer panel. */
export type ExplorerDoc = { panels: Record<string, Record<string, boolean>> };

/** Saved session tree (Explorer). Runtime status is not persisted. */
export function initialSessions(): { folders: SessionFolder[]; sessions: ManagedConnection[] } {
  const doc = readConfig<SessionsDoc>('sessions');
  if (!doc || !Array.isArray(doc.sessions)) return { folders: defaultFolders, sessions: builtinShells() };
  const folders = (Array.isArray(doc.folders) ? doc.folders : [])
    .filter(folder => folder && typeof folder.id === 'string' && typeof folder.name === 'string')
    .map(folder => ({ ...folder, parentId: folder.parentId ?? null }));
  const known = new Set(folders.map(folder => folder.id));
  return {
    // A parent that no longer exists → top level.
    folders: folders.map(folder => (folder.parentId && !known.has(folder.parentId) ? { ...folder, parentId: null } : folder)),
    sessions: doc.sessions
      .filter(item => item && typeof item.id === 'string' && typeof item.name === 'string')
      .map(item => ({ ...item, folderId: item.folderId && known.has(item.folderId) ? item.folderId : null, status: 'offline' as const })),
  };
}
