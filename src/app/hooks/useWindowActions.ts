import { useState, type Dispatch, type SetStateAction } from 'react';
import type { TerminalTab } from '../../types';
import { log } from '../../lib/platform/log';
import { TMUX_FIRST_PANE, tmuxView } from '../../lib/workspace/tmux';
import { defaultWindowName, newWindowLayout, WINDOW_NAME_MAX } from '../../lib/workspace/windows';
import { t } from '../../i18n';
import type { useWorkspace } from './useWorkspace';
import type { ManagedConnection } from '../sessionsDoc';

/**
 * Window menu actions: windows are switched like tabs (Ctrl+Shift+1…9, previous / next), opened, renamed, closed
 * (with a confirmation when they have tabs), reordered, and terminal tabs move between them.
 */
type WindowActionDeps = {
  ws: ReturnType<typeof useWorkspace>;
  setTabMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  setBarRename: Dispatch<SetStateAction<{ id: string; value: string } | null>>;
  leaveTerminalFull: () => void;
  connections: ManagedConnection[];
  openTerminal: (connectionId: string, pane?: string, activate?: boolean) => string;
  terminalTitle: (tab: TerminalTab) => string;
};

export function useWindowActions(deps: WindowActionDeps) {
  const { windows, windowIdRef, setWindowIdState, allTabs, setActiveId, windowId, windowSeq, setWindows, setAllTabs } = deps.ws;
  const { currentWindow, tmux, tmuxPaneTabs, tmuxPaneOfTab } = deps.ws;
  const { setTabMenu, setBarRename, leaveTerminalFull, connections, openTerminal, terminalTitle } = deps;
  // ---------- Window menu: windows switched like tabs ----------
  /** Rename / close-confirm dialog of a window. */
  const [windowDialog, setWindowDialog] = useState<{ kind: 'rename' | 'close'; id: string } | null>(null);
  const switchWindow = (id: string) => {
    const target = windows.find(item => item.id === id);
    if (!target || id === windowIdRef.current) return;
    windowIdRef.current = id;
    setWindowIdState(id);
    setTabMenu(null);
    setBarRename(null);
    leaveTerminalFull();
    const tab = allTabs.find(item => item.id === target.activeTabId);
    if (tab) setActiveId(tab.connectionId);
    log(t('{{name}} · {{v}} tab(s)', { name: target.name, v: allTabs.filter(item => item.windowId === id).length }));
  };
  /** Previous / next window (wraps around). */
  const stepWindow = (delta: number) => {
    if (windows.length < 2) return;
    const index = windows.findIndex(item => item.id === windowId);
    switchWindow(windows[(index + delta + windows.length) % windows.length].id);
  };
  /** New Window: the fixed frame layout and one local shell; it becomes the shown window. */
  const newWindow = () => {
    const ids = new Set(windows.map(item => item.id));
    let id = `win-${++windowSeq.current}`;
    while (ids.has(id)) id = `win-${++windowSeq.current}`;
    const names = new Set(windows.map(item => item.name));
    let n = windows.length;
    while (names.has(defaultWindowName(n))) n++;
    const name = defaultWindowName(n);
    setWindows(list => [...list, { id, name, layout: newWindowLayout(id, list), activeTabId: null }]);
    windowIdRef.current = id;
    setWindowIdState(id);
    setTabMenu(null);
    setBarRename(null);
    leaveTerminalFull();
    const shell = connections.find(item => item.transport === 'local');
    if (shell) openTerminal(shell.id, TMUX_FIRST_PANE);
    log(t('{{name}} opened', { name }));
  };
  /** Close Window: its terminals end (asks first when it has any); the next window is shown. */
  const closeWindow = (id: string) => {
    if (windows.length < 2) return;
    if (allTabs.some(tab => tab.windowId === id)) setWindowDialog({ kind: 'close', id });
    else doCloseWindow(id);
  };
  const doCloseWindow = (id: string) => {
    const index = windows.findIndex(item => item.id === id);
    if (index < 0 || windows.length < 2) return;
    const name = windows[index].name;
    if (id === windowIdRef.current) switchWindow((windows[index + 1] ?? windows[index - 1]).id);
    setAllTabs(all => all.filter(tab => tab.windowId !== id));
    setWindows(list => list.filter(item => item.id !== id));
    log(t('{{name}} closed', { name }));
  };
  const renameWindow = (id: string, value: string) => {
    const index = windows.findIndex(item => item.id === id);
    if (index < 0) return;
    const name = value.trim().slice(0, WINDOW_NAME_MAX) || defaultWindowName(index);
    setWindows(list => list.map(item => (item.id === id ? { ...item, name } : item)));
    if (name !== windows[index].name) log(t('Window renamed: {{v}} → {{name}}', { v: windows[index].name, name }));
  };
  /** Move a terminal tab (its running session) to another window, into that window's focused pane; that window selects it. */
  const moveTabToWindow = (tabId: string, targetId: string) => {
    const tab = allTabs.find(item => item.id === tabId);
    const target = windows.find(item => item.id === targetId);
    if (!tab || !target || tab.windowId === targetId) return;
    const fromId = tab.windowId;
    const fromView = fromId === currentWindow.id ? tmux : null;
    const targetView = tmuxView(
      target.tmux,
      allTabs.filter(item => item.windowId === targetId),
      target.activeTabId,
      target.tmuxActive,
    );
    // The source window selects the tab's neighbour in its pane, else another pane's tab.
    const own = fromView ? tmuxPaneTabs(tmuxPaneOfTab(tabId)) : allTabs.filter(item => item.windowId === fromId);
    const index = own.findIndex(item => item.id === tabId);
    const heir = own[index + 1] ?? own[index - 1] ?? fromView?.panes.flatMap(pane => pane.tabs).find(item => item.id !== tabId);
    setAllTabs(all => [...all.filter(item => item.id !== tabId), { ...tab, windowId: targetId, tmuxPane: targetView.focus }]);
    setWindows(list =>
      list.map(item => {
        if (item.id === targetId) return { ...item, activeTabId: tabId };
        if (item.id === fromId && item.activeTabId === tabId) return { ...item, activeTabId: heir?.id ?? null };
        return item;
      }),
    );
    log(t('{{v}} moved to {{name}}', { v: terminalTitle(tab), name: target.name }));
  };
  /** Move a window one place left / right (Window menu list, status bar, Ctrl+Shift+1..9). */
  const moveWindow = (id: string, delta: number) => {
    setWindows(list => {
      const index = list.findIndex(item => item.id === id);
      const to = index + delta;
      if (index < 0 || to < 0 || to >= list.length) return list;
      const next = [...list];
      next.splice(index, 1);
      next.splice(to, 0, list[index]);
      return next;
    });
  };
  return {
    newWindow,
    setWindowDialog,
    closeWindow,
    stepWindow,
    switchWindow,
    moveTabToWindow,
    moveWindow,
    windowDialog,
    renameWindow,
    doCloseWindow,
  };
}
