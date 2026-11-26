import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalTab } from '../../types';
import type { LayoutNode } from '../../lib/workspace/layout';
import { tmuxIds, tmuxLeaf, tmuxView } from '../../lib/workspace/tmux';
import { restoreWindows, type WorkWindow } from '../../lib/workspace/windows';
import { useAgentFocus, useAgentStatuses } from '../../lib/terminal/agentStatus';
import { FALLBACK_SESSION, type ManagedConnection } from '../sessionsDoc';
import { tabNumber } from '../tmuxGeometry';

/**
 * The windows and their terminal tabs (Window menu: workspaces switched like tabs, each with its own layout,
 * tmux panes and tabs), the shown window's tmux view and the connection the panels show.
 * `setLayout` / `setActiveTabId` / `updateWindow` / `setTerminalTabs` change the shown window.
 */
export function useWorkspace(connections: ManagedConnection[]) {
  // activeId = connection (config) selected in Explorer; terminal tabs are separate session instances.
  // Window menu: windows (workspaces switched like tabs), each with its own layout and terminal tabs,
  // as they were when the app was last closed (sessions.json → windows: order, custom names, active tab).
  // Nothing saved yet / no valid tab left → one window with one local shell.
  const [start] = useState(() => restoreWindows(connections));
  const [windows, setWindows] = useState<WorkWindow[]>(start.windows);
  const [windowId, setWindowIdState] = useState(start.activeWindowId);
  /** The shown window, for updaters that run later (setLayout / setTerminalTabs from callbacks). */
  const windowIdRef = useRef(windowId);
  const windowSeq = useRef(start.windows.length);
  /** Terminal tabs of every window (each tab knows its window); all of them stay mounted. */
  const [allTabs, setAllTabs] = useState<TerminalTab[]>(start.tabs);
  const currentWindow = windows.find(item => item.id === windowId) ?? windows[0];
  const layout = currentWindow.layout;
  const activeTabId = currentWindow.activeTabId;
  const activeTabIdRef = useRef(activeTabId);
  // Agent CLI status of the terminals (detected by the backend), shown in the Session panel.
  const agentStatuses = useAgentStatuses();
  useAgentFocus(activeTabId);
  activeTabIdRef.current = activeTabId;
  /** The shown window's terminal tabs (in their order). */
  const terminalTabs = useMemo(() => allTabs.filter(tab => tab.windowId === currentWindow.id), [allTabs, currentWindow.id]);
  const startActive = start.windows.find(item => item.id === start.activeWindowId)?.activeTabId;
  const [activeId, setActiveId] = useState(
    () =>
      start.tabs.find(tab => tab.id === startActive)?.connectionId ??
      (connections.find(item => item.transport === 'local') ?? connections[0])?.id ??
      '',
  );
  const tabSeq = useRef(start.tabs.length);
  /** Change the shown window's layout. */
  const setLayout = useCallback((next: LayoutNode | ((current: LayoutNode) => LayoutNode)) => {
    setWindows(list =>
      list.map(item =>
        item.id === windowIdRef.current ? { ...item, layout: typeof next === 'function' ? next(item.layout) : next } : item,
      ),
    );
  }, []);
  const allTabsRef = useRef(allTabs);
  allTabsRef.current = allTabs;
  /** Select a terminal tab of the shown window; the tmux pane that loses the focus keeps showing its tab. */
  const setActiveTabId = useCallback((id: string | null) => {
    setWindows(list =>
      list.map(item => {
        if (item.id !== windowIdRef.current || item.activeTabId === id) return item;
        const old = allTabsRef.current.find(tab => tab.id === item.activeTabId);
        const pane = old?.tmuxPane;
        return { ...item, activeTabId: id, tmuxActive: pane ? { ...item.tmuxActive, [pane]: old.id } : item.tmuxActive };
      }),
    );
  }, []);
  /** Change the shown window (its tmux panes …). */
  const updateWindow = useCallback((change: (item: WorkWindow) => Partial<WorkWindow>) => {
    setWindows(list => list.map(item => (item.id === windowIdRef.current ? { ...item, ...change(item) } : item)));
  }, []);
  /** Change the shown window's terminal tabs (the other windows' tabs are kept). */
  const setTerminalTabs = useCallback((next: TerminalTab[] | ((current: TerminalTab[]) => TerminalTab[])) => {
    setAllTabs(all => {
      const id = windowIdRef.current;
      const mine = all.filter(tab => tab.windowId === id);
      const result = typeof next === 'function' ? next(mine) : next;
      return [...all.filter(tab => tab.windowId !== id), ...result.map(tab => (tab.windowId === id ? tab : { ...tab, windowId: id }))];
    });
  }, []);
  /** The selected terminal tab: the shown tab of the focused tmux pane; the terminal actions act on it. */
  const activeTab = terminalTabs.find(tab => tab.id === activeTabId);
  /** tmux panes of the shown window (tab groups, each with its own tab bar). */
  const tmux = useMemo(
    () => tmuxView(currentWindow.tmux, terminalTabs, activeTabId, currentWindow.tmuxActive),
    [currentWindow.tmux, currentWindow.tmuxActive, terminalTabs, activeTabId],
  );
  const tmuxTree = tmux.tree;
  /** The focused pane's tabs (tmux n / p / 0–9, Close other tabs …). */
  const tmuxPaneTabs = (paneId: string) => tmux.panes.find(pane => pane.id === paneId)?.tabs ?? [];
  const tmuxPaneOfTab = (tabId: string) => tmux.paneOf.get(tabId) ?? tmux.focus;
  const tmuxFocusRef = useRef(tmux.focus);
  tmuxFocusRef.current = tmux.focus;
  // Keep the bookkeeping explicit: every tab names its pane, and panes left without tabs leave the tree.
  useEffect(() => {
    setWindows(list => {
      let changed = false;
      const next = list.map(item => {
        if (!item.tmux) return item;
        const own = allTabs.filter(tab => tab.windowId === item.id);
        const view = tmuxView(item.tmux, own, item.activeTabId, item.tmuxActive);
        if (view.tree === item.tmux && (view.tree.kind === 'split' || !item.tmuxZoomed)) return item;
        changed = true;
        return { ...item, tmux: view.tree, tmuxZoomed: view.tree.kind === 'split' ? item.tmuxZoomed : undefined };
      });
      return changed ? next : list;
    });
    setAllTabs(all => {
      let changed = false;
      const next = all.map(tab => {
        const item = windows.find(entry => entry.id === tab.windowId);
        if (!item) return tab;
        const ids = tmuxIds(item.tmux ?? tmuxLeaf());
        const pane = tab.tmuxPane && ids.includes(tab.tmuxPane) ? tab.tmuxPane : ids[0];
        if (pane === tab.tmuxPane) return tab;
        changed = true;
        return { ...tab, tmuxPane: pane };
      });
      return changed ? next : all;
    });
  }, [allTabs, windows]);
  // The connection shown by the terminal area / Filer / Sender: the active terminal's, else the Explorer selection.
  const active = useMemo(
    () => connections.find(connection => connection.id === (activeTab?.connectionId ?? activeId)) ?? connections[0] ?? FALLBACK_SESSION,
    [activeTab, activeId, connections],
  );
  const terminalTabOpen = Boolean(activeTab);
  /** Every window's terminals in a fixed order (by creation), so switching windows never moves their DOM. */
  const terminalStack = useMemo(() => [...allTabs].sort((a, b) => tabNumber(a.id) - tabNumber(b.id)), [allTabs]);
  const shownTabs = terminalTabs;
  const shownTabId = activeTab?.id ?? null;
  const shownTab = activeTab;
  const shownActive = active;
  /** Zoomed (tmux z): only the focused pane is on screen; needs more than one pane. */
  const tmuxZoomed = Boolean(currentWindow.tmuxZoomed) && tmux.panes.length > 1;
  /** Sessions by id, for lookups inside loops (js-index-maps). */
  const connectionById = useMemo(() => new Map(connections.map(connection => [connection.id, connection])), [connections]);
  return {
    setAllTabs,
    windowIdRef,
    allTabs,
    windows,
    windowId,
    tabSeq,
    activeTabIdRef,
    allTabsRef,
    setTerminalTabs,
    tmuxFocusRef,
    setActiveTabId,
    setActiveId,
    tmux,
    currentWindow,
    updateWindow,
    setWindows,
    terminalTabOpen,
    terminalTabs,
    tmuxPaneOfTab,
    tmuxPaneTabs,
    activeTabId,
    tmuxTree,
    setWindowIdState,
    windowSeq,
    layout,
    active,
    activeTab,
    connectionById,
    setLayout,
    shownTabs,
    shownTabId,
    shownTab,
    shownActive,
    agentStatuses,
    terminalStack,
    tmuxZoomed,
  };
}
