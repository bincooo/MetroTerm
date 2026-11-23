import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { TerminalTab, TmuxNode } from '../../types';
import { log } from '../../lib/platform/log';
import { tmuxNewId, tmuxSplit, type TmuxDirection } from '../../lib/workspace/tmux';
import { backend, terminalRegistry } from '../../lib/platform/backend';
import { moveBefore } from '../../lib/ui/tabDrag';
import { useStableCallback } from '../../lib/ui/useStableCallback';
import { t } from '../../i18n';
import { RECENT_MAX } from '../settingsDoc';
import { tabNumber } from '../tmuxGeometry';
import type { useWorkspace } from './useWorkspace';
import type { ManagedConnection } from '../sessionsDoc';

/**
 * Terminal tab actions of the shown window: open (also in the background for MCP), select, rename (tab bar and
 * Session panel), reconnect / clone / close (with the close confirmation), fullscreen terminal, and the tmux pane
 * actions (split, close pane, break a tab out, move a tab to another pane).
 */
type TabActionDeps = {
  ws: ReturnType<typeof useWorkspace>;
  setRecent: Dispatch<SetStateAction<string[]>>;
  setConnections: Dispatch<SetStateAction<ManagedConnection[]>>;
  connections: ManagedConnection[];
  setTabEpochs: Dispatch<SetStateAction<Record<string, number>>>;
};

export function useTabActions(deps: TabActionDeps) {
  const { tabSeq, activeTabIdRef, allTabsRef, setTerminalTabs, tmuxFocusRef, setActiveTabId, setActiveId, tmux, allTabs } = deps.ws;
  const { windowIdRef, currentWindow, updateWindow, setWindows, terminalTabOpen, terminalTabs, activeTabId, tmuxPaneTabs } = deps.ws;
  const { tmuxPaneOfTab, tmuxTree } = deps.ws;
  const { setRecent, setConnections, connections, setTabEpochs } = deps;
  /** Tabs opened in the background by an MCP client: they start their session without being shown. */
  const [backgroundStarts, setBackgroundStarts] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Always opens a NEW terminal for a saved connection (Explorer double-click, Clone Session …).
   * `activate: false` (MCP open_terminal in the background): the shown tab stays; the new one
   * starts its session while hidden (`backgroundStarts`). Returns the tab id.
   */
  const openTerminal = useCallback((connectionId: string, pane?: string, activate = true) => {
    const id = `tab-${++tabSeq.current}`;
    const shownTab = activeTabIdRef.current;
    const background = !activate && Boolean(shownTab && allTabsRef.current.some(tab => tab.id === shownTab));
    // In the given tmux pane, else the focused one.
    setTerminalTabs(current => [...current, { id, connectionId, tmuxPane: pane ?? tmuxFocusRef.current }]);
    setRecent(current => [connectionId, ...current.filter(item => item !== connectionId)].slice(0, RECENT_MAX));
    // Preview only: no backend reports real states.
    if (!backend.live)
      setConnections(current =>
        current.map(item => (item.id === connectionId && item.status === 'offline' ? { ...item, status: 'online' } : item)),
      );
    if (background) {
      setBackgroundStarts(current => new Set(current).add(id));
      return id;
    }
    setActiveTabId(id);
    setActiveId(connectionId);
    return id;
  }, []);
  /** Show a terminal: its tab is selected and its tmux pane gets the focus. */
  const activateTerminal = (tab: TerminalTab) => {
    setActiveTabId(tab.id);
    setActiveId(tab.connectionId);
  };
  /** Focus a tmux pane (tmux select-pane): its shown tab becomes the selected one. */
  const focusTmuxPane = (paneId: string) => {
    const tab = tmux.panes.find(pane => pane.id === paneId)?.active;
    if (tab) activateTerminal(tab);
  };
  /** Tab label: connection name, numbered when the same connection is open more than once. */
  const defaultTitle = (tab: TerminalTab) => {
    const connection = connections.find(item => item.id === tab.connectionId);
    // Numbered by opening order, so moving a tab (to another place or pane) keeps its name.
    const siblings = allTabs
      .filter(item => item.windowId === tab.windowId && item.connectionId === tab.connectionId)
      .sort((a, b) => tabNumber(a.id) - tabNumber(b.id));
    const index = siblings.findIndex(item => item.id === tab.id);
    return `${connection?.name ?? 'session'}${index > 0 ? ` (${index + 1})` : ''}`;
  };
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [barRename, setBarRename] = useState<{ id: string; value: string } | null>(null);
  /**
   * Pane toolbar → Fullscreen: only the terminal panel is shown (the others stay mounted, hidden), and
   * when the terminal is split only that pane (tmux zoom). Leaving restores the zoom state it had.
   */
  const [terminalFull, setTerminalFull] = useState(false);
  /** The (fullscreen) button took the keyboard: give it back to the focused pane's terminal once the
   *  layout has changed — else Ctrl+B and typing went nowhere until the user clicked a terminal. */
  const refocusTerminal = useStableCallback(() => {
    requestAnimationFrame(() => {
      const id = activeTabIdRef.current;
      if (id) terminalRegistry.get(id)?.focus();
    });
  });
  const fullRestore = useRef<{ windowId: string; zoomed: boolean } | null>(null);
  const enterTerminalFull = (paneId: string) => {
    fullRestore.current = { windowId: windowIdRef.current, zoomed: Boolean(currentWindow.tmuxZoomed) };
    if (tmux.panes.length > 1) {
      focusTmuxPane(paneId);
      updateWindow(() => ({ tmuxZoomed: true }));
    }
    setTerminalFull(true);
    refocusTerminal();
  };
  /** Every way out of fullscreen (button, window switch, last tab closed) goes through here. */
  const leaveTerminalFull = useStableCallback(() => {
    const saved = fullRestore.current;
    fullRestore.current = null;
    if (saved)
      setWindows(list => list.map(item => (item.id === saved.windowId ? { ...item, tmuxZoomed: saved.zoomed ? true : undefined } : item)));
    setTerminalFull(false);
    refocusTerminal();
  });
  useEffect(() => {
    if (!terminalTabOpen) leaveTerminalFull();
  }, [terminalTabOpen, leaveTerminalFull]);
  const commitBarRename = () => {
    if (!barRename) return;
    const tab = terminalTabs.find(item => item.id === barRename.id);
    const value = barRename.value.trim();
    setBarRename(null);
    if (!tab) return;
    if (!value || value === defaultTitle(tab)) {
      if (tab.title) renameTab(tab.id, null);
    } else if (value !== terminalTitle(tab)) renameTab(tab.id, value);
  };
  /** Tab label: the custom name when the tab was renamed, else the default one. */
  const terminalTitle = (tab: TerminalTab) => tab.title || defaultTitle(tab);
  const renameTab = (tabId: string, title: string | null) => {
    const tab = terminalTabs.find(item => item.id === tabId);
    if (!tab) return;
    const before = terminalTitle(tab);
    setTerminalTabs(current => current.map(item => (item.id === tabId ? { ...item, title: title ?? undefined } : item)));
    log(title ? t('Tab renamed: {{before}} → {{title}}', { before, title }) : t('Tab name restored: {{v}}', { v: defaultTitle(tab) }));
  };

  /**
   * Reconnect one terminal (pane toolbar ↻, terminal right-click menu, Session → Reconnect Session):
   * only this tab's shell / connection is started again — other tabs and split panes of the same
   * session keep running. An SSH session's shared connection is kept (a new channel on it; if it has
   * dropped, it is connected again).
   */
  const reconnectTab = (tab: { id: string; connectionId: string }) => {
    const connection = connections.find(item => item.id === tab.connectionId);
    if (!connection) return;
    log(t('Reconnecting {{name}}…', { name: connection.name }));
    setTabEpochs(current => ({ ...current, [tab.id]: (current[tab.id] ?? 0) + 1 }));
  };
  const cloneSession = (id: string) => {
    const source = connections.find(item => item.id === id);
    if (!source) return;
    // Clone = another terminal on the same saved connection; the Explorer config list is unchanged.
    openTerminal(source.id);
    log(t('{{name}} cloned · new terminal', { name: source.name }));
  };
  const closeSession = (tabId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    closeTabs([tabId]);
  };
  /** Shell tabs waiting for "Close?" to be confirmed. */
  const [closeConfirm, setCloseConfirm] = useState<{ ids: string[]; pane?: boolean } | null>(null);
  /** Close terminal tabs — after confirming (their shells / connections end). */
  const closeTabs = (tabIds: string[]) => {
    if (tabIds.length) setCloseConfirm({ ids: tabIds });
  };
  /**
   * Close terminal tabs. A closing selected tab hands over to its right neighbour in its tmux pane
   * (else the left one), else to the shown tab of another pane; panes left empty disappear.
   */
  const doCloseTabs = (tabIds: string[]) => {
    if (!tabIds.length) return;
    const closing = new Set(tabIds);
    setTerminalTabs(current => current.filter(tab => !closing.has(tab.id)));
    if (activeTabId && closing.has(activeTabId)) {
      const own = tmuxPaneTabs(tmuxPaneOfTab(activeTabId));
      const index = own.findIndex(tab => tab.id === activeTabId);
      const others = tmux.panes.flatMap(pane => [pane.active, ...pane.tabs]).filter((tab): tab is TerminalTab => Boolean(tab));
      const next =
        own.slice(index + 1).find(tab => !closing.has(tab.id)) ??
        [...own.slice(0, Math.max(index, 0))].reverse().find(tab => !closing.has(tab.id)) ??
        others.find(tab => !closing.has(tab.id));
      setActiveTabId(next?.id ?? null);
      if (next) setActiveId(next.connectionId);
    }
    log(tabIds.length === 1 ? t('Session tab closed') : t('{{length}} session tabs closed', { length: tabIds.length }));
  };

  // ---------- tmux panes: the terminal area split into tab groups ----------
  /** Split the pane of a tab (default: the selected one); the new pane gets a new terminal of that tab's session. */
  const splitTerminal = (dir: TmuxDirection, tabId = activeTabId) => {
    const source = terminalTabs.find(tab => tab.id === tabId);
    if (!source) return;
    const paneId = tmuxPaneOfTab(source.id);
    const added = tmuxNewId(currentWindow.tmux ?? tmuxTree);
    const id = `tab-${++tabSeq.current}`;
    setTerminalTabs(current => [...current, { id, connectionId: source.connectionId, tmuxPane: added }]);
    updateWindow(item => ({
      tmux: tmuxSplit(item.tmux ?? tmuxTree, paneId, added, dir),
      tmuxZoomed: undefined,
      // The split pane keeps showing the tab it was split from.
      tmuxActive: { ...item.tmuxActive, [paneId]: source.id },
      activeTabId: id,
    }));
    setActiveId(source.connectionId);
    log(
      dir === 'row'
        ? t('{{name}} · split left | right', { name: terminalTitle(source) })
        : t('{{name}} · split top / bottom', { name: terminalTitle(source) }),
    );
  };
  /** Change the tmux tree of the shown window. */
  const updateTmux = (change: (tree: TmuxNode) => TmuxNode) => updateWindow(item => ({ tmux: change(item.tmux ?? tmuxTree) }));
  /** tmux kill-pane: close every tab of a pane (after confirming). */
  const closeTmuxPane = (paneId: string) => {
    const ids = tmuxPaneTabs(paneId).map(tab => tab.id);
    if (ids.length) setCloseConfirm({ ids, pane: true });
  };
  /** tmux break-pane (`!`): the tab leaves its pane for a new pane on the right of it. */
  const breakTab = (tabId: string) => {
    const tab = terminalTabs.find(item => item.id === tabId);
    if (!tab) return;
    const paneId = tmuxPaneOfTab(tab.id);
    const own = tmuxPaneTabs(paneId);
    if (own.length < 2) return;
    const index = own.findIndex(item => item.id === tabId);
    const heir = own[index + 1] ?? own[index - 1];
    const added = tmuxNewId(currentWindow.tmux ?? tmuxTree);
    setTerminalTabs(current => current.map(item => (item.id === tabId ? { ...item, tmuxPane: added } : item)));
    updateWindow(item => ({
      tmux: tmuxSplit(item.tmux ?? tmuxTree, paneId, added, 'row'),
      tmuxZoomed: undefined,
      tmuxActive: { ...item.tmuxActive, [paneId]: heir.id },
      activeTabId: tab.id,
    }));
    setActiveId(tab.connectionId);
    log(t('Tab moved to a new pane'));
  };
  /** Drop a dragged tab on a pane's tab bar: it joins that pane (before `before`) and is selected. */
  const moveTabToPane = (tabId: string, paneId: string, before: string | null) => {
    const tab = terminalTabs.find(item => item.id === tabId);
    if (!tab) return;
    const fromPane = tmuxPaneOfTab(tabId);
    setTerminalTabs(current =>
      moveBefore(
        current.map(item => (item.id === tabId ? { ...item, tmuxPane: paneId } : item)),
        item => item.id,
        tabId,
        before,
      ),
    );
    if (fromPane === paneId) return;
    const own = tmuxPaneTabs(fromPane);
    const index = own.findIndex(item => item.id === tabId);
    const heir = own[index + 1] ?? own[index - 1];
    updateWindow(item => ({
      activeTabId: tabId,
      tmuxActive: heir ? { ...item.tmuxActive, [fromPane]: heir.id } : item.tmuxActive,
    }));
    setActiveId(tab.connectionId);
  };
  return {
    setTabMenu,
    setBarRename,
    leaveTerminalFull,
    setBackgroundStarts,
    terminalTitle,
    defaultTitle,
    reconnectTab,
    openTerminal,
    cloneSession,
    closeTabs,
    updateTmux,
    focusTmuxPane,
    splitTerminal,
    closeTmuxPane,
    breakTab,
    activateTerminal,
    moveTabToPane,
    barRename,
    commitBarRename,
    closeSession,
    terminalFull,
    enterTerminalFull,
    backgroundStarts,
    renameTab,
    tabMenu,
    closeConfirm,
    setCloseConfirm,
    doCloseTabs,
  };
}
