/**
 * Explorer session tree: folders (nested to any depth) holding saved session configs.
 * Pure helpers only — state lives in App and is saved to ~/.metroterm/sessions.json (v3).
 *
 * Order: siblings keep their array order; inside a folder, sub-folders are listed before sessions.
 */

export type SessionFolder = { id: string; name: string; parentId: string | null; collapsed?: boolean };
/** Anything with a folder; the App's saved session type extends this. */
type FolderItem = { id: string; folderId: string | null };

export const ROOT_FOLDER_ID = 'shell-sessions';

export type TreeRef = { kind: 'folder' | 'session'; id: string };
/** Where a dragged item lands. `into` a folder, `before` / `after` a sibling, or the top level. */
export type DropTarget =
  | { kind: 'folder'; id: string; mode: 'into' | 'before' | 'after' }
  | { kind: 'session'; id: string; mode: 'before' | 'after' }
  | { kind: 'root' };

export const childFolders = (folders: SessionFolder[], parentId: string | null) => folders.filter(folder => folder.parentId === parentId);

/** The folder itself and every folder below it. */
export function folderAndDescendants(folders: SessionFolder[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders)
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
  }
  return ids;
}

/** The folder and every folder above it, nearest first (a parent loop ends it). */
export function folderChain(folders: SessionFolder[], id: string | null | undefined): SessionFolder[] {
  const chain: SessionFolder[] = [];
  for (
    let at = folders.find(folder => folder.id === id);
    at && !chain.includes(at);
    at = folders.find(folder => folder.id === at!.parentId)
  )
    chain.push(at);
  return chain;
}

/** "Shell sessions / Local" */
export const folderPath = (folders: SessionFolder[], id: string | null) =>
  folderChain(folders, id)
    .map(folder => folder.name)
    .reverse()
    .join(' / ');

const moveInArray = <T extends { id: string }>(items: T[], id: string, update: (item: T) => T, anchorId?: string, after = false): T[] => {
  const item = items.find(entry => entry.id === id);
  if (!item) return items;
  const rest = items.filter(entry => entry.id !== id);
  const anchor = anchorId ? rest.findIndex(entry => entry.id === anchorId) : -1;
  const index = anchor < 0 ? rest.length : anchor + (after ? 1 : 0);
  return [...rest.slice(0, index), update(item), ...rest.slice(index)];
};

/** Can `dragged` be dropped on `target`? (a folder cannot go into itself or below itself) */
export function canDrop(folders: SessionFolder[], dragged: TreeRef, target: DropTarget): boolean {
  if (target.kind !== 'root' && target.kind === dragged.kind && target.id === dragged.id) return false;
  if (dragged.kind !== 'folder') return true;
  const blocked = folderAndDescendants(folders, dragged.id);
  if (target.kind === 'folder') {
    const parent = target.mode === 'into' ? target.id : (folders.find(folder => folder.id === target.id)?.parentId ?? null);
    return !(parent && blocked.has(parent)) && !(target.mode === 'into' && blocked.has(target.id));
  }
  return true;
}

export function moveSession<T extends FolderItem>(sessions: T[], folders: SessionFolder[], id: string, target: DropTarget): T[] {
  if (target.kind === 'root') return moveInArray(sessions, id, item => ({ ...item, folderId: null }));
  if (target.kind === 'folder') {
    // On a folder row a session always goes inside; the folder opens to show it.
    if (!folders.some(folder => folder.id === target.id)) return sessions;
    return moveInArray(sessions, id, item => ({ ...item, folderId: target.id }));
  }
  const anchor = sessions.find(item => item.id === target.id);
  if (!anchor) return sessions;
  return moveInArray(sessions, id, item => ({ ...item, folderId: anchor.folderId }), anchor.id, target.mode === 'after');
}

export function moveFolder(folders: SessionFolder[], sessions: FolderItem[], id: string, target: DropTarget): SessionFolder[] {
  if (!canDrop(folders, { kind: 'folder', id }, target)) return folders;
  if (target.kind === 'root') return moveInArray(folders, id, folder => ({ ...folder, parentId: null }));
  if (target.kind === 'session') {
    const parentId = sessions.find(item => item.id === target.id)?.folderId ?? null;
    return moveInArray(folders, id, folder => ({ ...folder, parentId }));
  }
  if (target.mode === 'into') return moveInArray(folders, id, folder => ({ ...folder, parentId: target.id }));
  const anchor = folders.find(folder => folder.id === target.id);
  if (!anchor) return folders;
  return moveInArray(folders, id, folder => ({ ...folder, parentId: anchor.parentId }), anchor.id, target.mode === 'after');
}

/** Id of a new saved session. */
export const makeSessionId = () => globalThis.crypto?.randomUUID?.() ?? `conn-${Date.now()}`;
export const makeFolderId = () => `folder-${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Date.now().toString(36)}`;
