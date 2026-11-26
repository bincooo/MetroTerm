import type { Dispatch, SetStateAction } from 'react';
import { useRef } from 'react';
import type { TerminalTab } from '../../types';
import { log } from '../../lib/platform/log';
import type { LayoutNode } from '../../lib/workspace/layout';
import type { WorkWindow } from '../../lib/workspace/windows';
import {
  folderAndDescendants,
  folderChain,
  makeFolderId,
  makeSessionId,
  moveFolder,
  moveSession,
  type DropTarget,
  type SessionFolder,
  type TreeRef,
} from '../../lib/sessions/tree';
import { t } from '../../i18n';
import { collectLeaves } from '../helpers';
import type { ManagedConnection } from '../sessionsDoc';

type ExplorerTreeDeps = {
  layout: LayoutNode;
  folders: SessionFolder[];
  setFolders: Dispatch<SetStateAction<SessionFolder[]>>;
  connections: ManagedConnection[];
  setConnections: Dispatch<SetStateAction<ManagedConnection[]>>;
  /** Per Explorer panel (layout leaf id): folder id → collapsed. */
  explorerFolds: Record<string, Record<string, boolean>>;
  setExplorerFolds: Dispatch<SetStateAction<Record<string, Record<string, boolean>>>>;
  allTabs: TerminalTab[];
  setAllTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setWindows: Dispatch<SetStateAction<WorkWindow[]>>;
  activeTabId: string | null;
  windowId: string;
  setActiveId: Dispatch<SetStateAction<string>>;
};

/**
 * Explorer session tree: open / closed folders of each Explorer panel, and the tree edits (move,
 * new folder, rename, delete, duplicate). The tree itself (folders, sessions) is App state, saved to
 * sessions.json.
 */
export function useExplorerTree(deps: ExplorerTreeDeps) {
  const {
    layout,
    folders,
    setFolders,
    connections,
    setConnections,
    explorerFolds,
    setExplorerFolds,
    allTabs,
    setAllTabs,
    setWindows,
    activeTabId,
    windowId,
    setActiveId,
  } = deps;
  /** Explorer panel the user worked in last (clicks, right-clicks, drags): where "reveal" / Expand all apply. */
  const lastExplorer = useRef<string | null>(null);
  /** Collapsed state of a folder in one Explorer panel (its own; falls back to the saved folder default). */
  const isCollapsedIn = (panel: string, folder: SessionFolder) => explorerFolds[panel]?.[folder.id] ?? Boolean(folder.collapsed);
  /** Explorer panels in the layout (each keeps its own open / closed folders). */
  const explorerPanels = () =>
    collectLeaves(layout)
      .filter(leaf => (leaf.tabs ?? []).includes('explorer'))
      .map(leaf => leaf.id);
  const setFolds = (panels: string[], change: (panel: string) => Record<string, boolean>) =>
    setExplorerFolds(current => {
      const next = { ...current };
      for (const panel of panels) next[panel] = { ...current[panel], ...change(panel) };
      return next;
    });
  /** Open a folder and those above it (nothing else) so what is in it shows — in the Explorer panel being used, else in all of them. */
  const revealFolder = (id: string | null | undefined) => {
    const open = Object.fromEntries(folderChain(folders, id).map(folder => [folder.id, false]));
    const panels = explorerPanels();
    setFolds(lastExplorer.current && panels.includes(lastExplorer.current) ? [lastExplorer.current] : panels, () => open);
  };
  const toggleFolder = (panel: string, id: string) => {
    const folder = folders.find(item => item.id === id);
    if (folder) setFolds([panel], () => ({ [id]: !isCollapsedIn(panel, folder) }));
  };
  const setAllFolders = (collapsed: boolean) => {
    const panels = explorerPanels();
    const all = Object.fromEntries(folders.map(folder => [folder.id, collapsed]));
    setFolds(lastExplorer.current && panels.includes(lastExplorer.current) ? [lastExplorer.current] : panels, () => all);
  };
  const moveTreeItem = (dragged: TreeRef, target: DropTarget) => {
    if (dragged.kind === 'session') setConnections(current => moveSession(current, folders, dragged.id, target));
    else setFolders(current => moveFolder(current, connections, dragged.id, target));
    // Dropped into a folder → open it so the item stays visible.
    if (target.kind === 'folder' && target.mode === 'into') revealFolder(target.id);
    const name =
      dragged.kind === 'session'
        ? connections.find(item => item.id === dragged.id)?.name
        : folders.find(folder => folder.id === dragged.id)?.name;
    const where =
      target.kind === 'root'
        ? t('top level')
        : target.kind === 'folder' && target.mode === 'into'
          ? folders.find(folder => folder.id === target.id)?.name
          : null;
    log(where ? t('{{name}} moved to {{where}}', { name: name ?? t('Item'), where }) : t('{{name}} moved', { name: name ?? t('Item') }));
  };
  const createFolder = (parentId: string | null, name: string) => {
    setFolders(current => [...current, { id: makeFolderId(), name, parentId }]);
    revealFolder(parentId);
    log(t('Folder {{name}} created', { name }));
  };
  const renameItem = (target: TreeRef, name: string) => {
    if (target.kind === 'folder') setFolders(current => current.map(folder => (folder.id === target.id ? { ...folder, name } : folder)));
    else setConnections(current => current.map(item => (item.id === target.id ? { ...item, name } : item)));
    log(t('Renamed to {{name}}', { name }));
  };
  /** Delete a session config, or a folder with everything inside it. Their open terminals are closed. */
  const deleteItem = (target: TreeRef) => {
    const folderIds = target.kind === 'folder' ? folderAndDescendants(folders, target.id) : new Set<string>();
    const removed = new Set(
      connections
        .filter(item => (target.kind === 'session' ? item.id === target.id : item.folderId !== null && folderIds.has(item.folderId)))
        .map(item => item.id),
    );
    if (target.kind === 'folder') setFolders(current => current.filter(folder => !folderIds.has(folder.id)));
    setConnections(current => current.filter(item => !removed.has(item.id)));
    // Their terminals are closed in every window; a window whose selected tab went selects its last one.
    const remaining = allTabs.filter(tab => !removed.has(tab.connectionId));
    if (remaining.length !== allTabs.length) {
      setAllTabs(remaining);
      setWindows(list =>
        list.map(item => {
          if (remaining.some(tab => tab.id === item.activeTabId)) return item;
          const own = remaining.filter(tab => tab.windowId === item.id);
          return { ...item, activeTabId: own[own.length - 1]?.id ?? null };
        }),
      );
      if (!remaining.some(tab => tab.id === activeTabId)) {
        const next = remaining.filter(tab => tab.windowId === windowId).pop();
        if (next) setActiveId(next.connectionId);
      }
    }
    const name =
      target.kind === 'folder'
        ? folders.find(folder => folder.id === target.id)?.name
        : connections.find(item => item.id === target.id)?.name;
    log(
      removed.size && target.kind === 'folder'
        ? t('{{name}} deleted · {{count}} session(s)', { name: name ?? t('Item'), count: removed.size })
        : t('{{name}} deleted', { name: name ?? t('Item') }),
    );
  };
  /** Explorer → Duplicate: a copy of a session config, or of a folder with all sub-folders and sessions, placed right after the original. */
  const duplicateItem = (target: TreeRef) => {
    let seq = 0;
    const newId = () => `${makeSessionId()}-${++seq}`;
    if (target.kind === 'session') {
      const source = connections.find(item => item.id === target.id);
      if (!source) return;
      const copy: ManagedConnection = {
        ...source,
        id: newId(),
        name: t('{{name}} copy', { name: source.name }),
        status: 'offline',
        favorite: false,
      };
      setConnections(current => {
        const index = current.findIndex(item => item.id === source.id);
        const next = [...current];
        next.splice(index + 1, 0, copy);
        return next;
      });
      log(t('{{name}} duplicated as {{name2}}', { name: source.name, name2: copy.name }));
      return;
    }
    const source = folders.find(folder => folder.id === target.id);
    if (!source) return;
    const ids = folderAndDescendants(folders, source.id);
    const mapped = new Map([...ids].map(id => [id, makeFolderId() + ++seq]));
    const copies = folders
      .filter(folder => ids.has(folder.id))
      .map(folder => ({
        ...folder,
        id: mapped.get(folder.id)!,
        parentId: folder.id === source.id ? folder.parentId : (mapped.get(folder.parentId!) ?? folder.parentId),
        name: folder.id === source.id ? t('{{name}} copy', { name: folder.name }) : folder.name,
      }));
    const sessions = connections
      .filter(item => item.folderId !== null && ids.has(item.folderId))
      .map(item => ({ ...item, id: newId(), folderId: mapped.get(item.folderId!)!, status: 'offline' as const, favorite: false }));
    setFolders(current => {
      const index = current.findIndex(folder => folder.id === source.id);
      const rootCopy = copies.find(folder => folder.parentId === source.parentId && mapped.get(source.id) === folder.id)!;
      const next = [...current];
      next.splice(index + 1, 0, rootCopy);
      return [...next, ...copies.filter(folder => folder !== rootCopy)];
    });
    setConnections(current => [...current, ...sessions]);
    log(
      sessions.length
        ? t('{{name}} duplicated as {{copy}} · {{count}} session(s)', {
            name: source.name,
            copy: t('{{name}} copy', { name: source.name }),
            count: sessions.length,
          })
        : t('{{name}} duplicated as {{copy}}', { name: source.name, copy: t('{{name}} copy', { name: source.name }) }),
    );
  };
  return {
    lastExplorer,
    isCollapsedIn,
    revealFolder,
    toggleFolder,
    setAllFolders,
    moveTreeItem,
    createFolder,
    renameItem,
    deleteItem,
    duplicateItem,
  };
}
