import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalTab } from '../types';
import { type CursorInfo } from '../components/terminal/TerminalView';
import { SplitPane } from '../components/common/SplitPane';
import { type MenuItem } from '../components/common/MenuButton';
import {
  applySplitChange,
  isUserSplit,
  removeEmptySide,
  openTab,
  panelOf,
  PANEL_VIEWS,
  type LayoutNode,
  type LeafNode,
  type PanelView,
} from '../lib/workspace/layout';
import { log } from '../lib/platform/log';
import { configLocation, flushConfig, readConfig } from '../lib/platform/config';
import { type WorkWindow } from '../lib/workspace/windows';
import { closeApp, isDesktop, windowFrame } from '../lib/platform/tauri';
import {
  FONT_SIZE_RANGE,
  UI_FONT_STACK,
  defaultUiFamily,
  withFallback,
  type KeyMode,
  type TerminalPrefs,
} from '../lib/settings/preferences';
import { backend, setSessionLookup, terminalRegistry, type BackendEvent } from '../lib/platform/backend';
import { saveTextAs } from '../lib/platform/saveText';
import { describeConnection } from '../lib/sessions/transports';
import { installCustomScrollbars } from '../lib/ui/customScrollbars';
import { moveBefore, startTabDrag } from '../lib/ui/tabDrag';
import { useStableCallback } from '../lib/ui/useStableCallback';
import { autoStartTunnels, tunnelRuntime } from '../lib/sessions/tunnelRuntime';
import { focusLayout, panesUnchanged } from '../lib/workspace/focusMode';
import { folderChain, ROOT_FOLDER_ID, type SessionFolder, type TreeRef } from '../lib/sessions/tree';
import { t } from '../i18n';
import { FALLBACK_SESSION, initialSessions, type ExplorerDoc, type ManagedConnection } from './sessionsDoc';
import { readSettings, RECENT_MAX } from './settingsDoc';
import { PanelSlot } from './PanelSlot';
import { collectLeaves, type ContentView, type TreeDialogState, type WindowCtx, fileSafe, hasTerminal, minSizeOf, stamp } from './helpers';
import { cursorStore } from './StatusCursor';
import { useWindowFrame } from './hooks/useWindowFrame';
import { useLockScreen } from './hooks/useLockScreen';
import { useFocusMode } from './hooks/useFocusMode';
import { useMcpUi } from './hooks/useMcpUi';
import { useExplorerTree } from './hooks/useExplorerTree';
import { usePersistence } from './hooks/usePersistence';
import { useWorkspace } from './hooks/useWorkspace';
import { usePreferences } from './hooks/usePreferences';
import { useShortcuts } from './hooks/useShortcuts';
import { useTabActions } from './hooks/useTabActions';
import { useWindowActions } from './hooks/useWindowActions';
import { buildMenuBar } from './menus/menuBar';
import { buildContextMenus } from './menus/contextMenus';
import { TmuxPanes } from './views/TmuxPanes';
import { ContentPanel } from './views/ContentPanel';
import { DialogHost } from './views/DialogHost';
import { AppHeader } from './views/AppHeader';
import { StatusBar } from './views/StatusBar';

export default function App() {
  // Preferences (settings.json): theme, language, terminal, session defaults, appearance, proxy, log, MCP, keys (hooks/usePreferences).
  const prefs = usePreferences();
  const { theme, language, swatches, terminalPrefs, setTerminalPrefs, sessionDefaults } = prefs;
  const { appearance, proxy, logPrefs, mcpPrefs, keyBindings } = prefs;
  const frame = useWindowFrame();
  const { titleBar, fullScreen, alwaysOnTop, syncWindowModes, toggleFullScreen, toggleAlwaysOnTop } = frame;
  const [initialTree] = useState(initialSessions);
  const [connections, setConnections] = useState<ManagedConnection[]>(initialTree.sessions);
  // Jump hosts: the backend gets the jump host session's config with the session (lib/platform/backend toSpec).
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  useState(() => setSessionLookup(id => connectionsRef.current.find(item => item.id === id)));
  const [folders, setFolders] = useState<SessionFolder[]>(initialTree.folders);
  /** Per Explorer panel (layout leaf id): folder id → collapsed. Panels opened several times don't share it. */
  const [explorerFolds, setExplorerFolds] = useState<Record<string, Record<string, boolean>>>(() => {
    const panels = readConfig<ExplorerDoc>('explorer')?.panels;
    if (!panels || typeof panels !== 'object') return {};
    return Object.fromEntries(
      Object.entries(panels)
        .filter(([, folds]) => folds && typeof folds === 'object')
        .map(([panel, folds]) => [panel, Object.fromEntries(Object.entries(folds).filter(([, value]) => typeof value === 'boolean'))]),
    );
  });
  // Sessions per Explorer folder, sub-folders included (same numbers as the Explorer tree); '' = all.
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = { '': connections.length };
    for (const session of connections)
      for (const folder of folderChain(folders, session.folderId)) counts[folder.id] = (counts[folder.id] ?? 0) + 1;
    return counts;
  }, [connections, folders]);
  const [treeDialog, setTreeDialog] = useState<TreeDialogState | null>(null);
  // Window menu: windows and their terminal tabs, the shown window's tmux panes (hooks/useWorkspace).
  const ws = useWorkspace(connections);
  const { setAllTabs, windowIdRef, allTabs, windows, windowId, tabSeq, activeTabIdRef, allTabsRef, setTerminalTabs, setActiveId } = ws;
  const { currentWindow, setWindows, terminalTabs, activeTabId, setWindowIdState, windowSeq, layout, active, activeTab } = ws;
  const { connectionById, setLayout, tmuxZoomed } = ws;
  /** New-session dialog: open with the folder it creates the session in. */
  const [newConnection, setNewConnectionState] = useState<{ folderId: string | null } | null>(null);
  /** Session whose Properties dialog is open. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savingAsId, setSavingAsId] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => {
    const saved = readSettings().recent;
    const list = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
    const first = allTabs[0]?.connectionId; // the terminal opened at startup counts as opened
    return (first ? [first, ...list.filter(id => id !== first)] : list).slice(0, RECENT_MAX);
  });
  const [preferencesDialog, setPreferencesDialog] = useState<'settings' | 'defaults' | null>(null);
  /** Session → Proxy… / Log… / Keyboard Shortcuts…, Help → About. */
  const [appDialog, setAppDialog] = useState<'proxy' | 'log' | 'keys' | 'about' | 'tunnels' | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Only the number of running tunnels: the app re-renders when it changes, not on every poll. */
  const runningTunnels = useSyncExternalStore(tunnelRuntime.subscribe, tunnelRuntime.getRunningCount);
  /** Backend version for About (ping); null = not known. */
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  // ---------- Lock Screen (status bar → Lock Screen; settings.json → lock) ----------
  const lock = useLockScreen();
  const { lockSettings, locked, lockedRef, lockNow } = lock;

  // ---------- Focus Mode (menu bar → Focus Mode, Ctrl+Shift+F; settings.json → focus) ----------
  const focus = useFocusMode(titleBar, syncWindowModes);
  const { focusConfig, focusActive, setFocusDialog, toggleFocus } = focus;
  // Settings → WINDOW OPACITY (desktop): applied at start and when saved (Focus Mode keeps it).
  const showOpacity = useCallback((percent: number) => {
    if (!isDesktop()) return;
    void windowFrame.setState({ opacity: percent / 100 }).catch(() => undefined);
  }, []);
  useEffect(() => {
    showOpacity(appearance.windowOpacity);
  }, [appearance.windowOpacity, showOpacity]);
  /** View → Zoom: font size offset per terminal tab (px, relative to Settings' font size; not saved). */
  const [zoom, setZoom] = useState<Record<string, number>>({});
  /** Explorer "Filter sessions" text, per Explorer panel (leaf id): panels never share it. */
  const [filters, setFilters] = useState<Record<string, string>>({});
  /** Size and cursor position of the visible terminal (status bar). */
  // Status bar Window / Ln, Ch: in a store of their own, so terminal output doesn't re-render the app.
  const onCursor = useCallback((tabId: string, info: CursorInfo) => cursorStore.set({ tabId, ...info }), []);
  /** Shells installed on this computer (backend `system.shells`); null = unknown (static preview / not loaded yet). */
  const [shells, setShells] = useState<{ name: string; path: string }[] | null>(null);
  // No browser / webview context menu anywhere in the app (custom menus such as Filer's still open).
  useEffect(() => {
    // Never the browser's menu — text fields get the app's own Undo / Cut / Copy / Paste menu (FieldContextMenu).
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  useEffect(() => installCustomScrollbars(), []);
  useEffect(() => {
    if (backend.live) void backend.call<{ name: string; path: string }[]>('system.shells').then(setShells, () => setShells(null));
  }, []);
  const missingShell = (connection: ManagedConnection) => {
    if (!shells || connection.transport !== 'local' || !connection.shell) return false;
    const wanted = connection.shell.trim();
    return !shells.some(shell => shell.name === wanted || shell.path === wanted || shell.path.endsWith(`/${wanted}`));
  };

  // Persist configuration to ~/.metroterm (layout.json · settings.json · sessions.json).
  usePersistence({
    windows,
    allTabs,
    windowId,
    connections,
    folders,
    explorerFolds,
    settings: {
      theme,
      language,
      titleBar,
      swatches,
      recent,
      terminalPrefs,
      sessionDefaults,
      lockSettings,
      locked,
      focusConfig,
      appearance,
      proxy,
      logPrefs,
      keyBindings,
      mcpPrefs,
    },
  });
  // "Start when MetroTerm starts" tunnels (once per app load; the sessions are loaded before the first render).
  useEffect(() => {
    autoStartTunnels(connections, log);
  }, []);
  /** Password prompt → Remember password: sealed password (null = forget it) per connection, until it logs in. */
  const pendingPasswords = useRef(new Map<string, string | null>());
  const rememberPassword = useCallback(
    async (connectionId: string, password: string, remember: boolean) => {
      const saved = connections.find(item => item.id === connectionId)?.savedPassword;
      if (!remember) {
        if (saved) pendingPasswords.current.set(connectionId, null);
        else pendingPasswords.current.delete(connectionId);
        return;
      }
      try {
        pendingPasswords.current.set(connectionId, await backend.call<string>('secret.seal', { text: password }));
      } catch (error) {
        log.error(t('Cannot remember the password'), error);
      }
    },
    [connections],
  );
  /** Per-tab reconnect counter: Reconnect (pane toolbar ↻, terminal menu, Session menu) restarts that tab only. */
  const [tabEpochs, setTabEpochs] = useState<Record<string, number>>({});
  // Real connection state from the backend (SSH connect / auth / disconnect, local shell running).
  useEffect(
    () =>
      backend.on((event: BackendEvent) => {
        if (event.type !== 'connection.state') return;
        const status = event.state === 'online' ? 'online' : event.state === 'connecting' ? 'connecting' : 'offline';
        setConnections(current =>
          current.map(item => (item.id === event.connectionId && item.status !== status ? { ...item, status } : item)),
        );
        const name = connections.find(item => item.id === event.connectionId)?.name ?? 'session';
        // "Remember password" in the password prompt: kept only once that password has logged in.
        const remembered = pendingPasswords.current.get(event.connectionId);
        if (remembered !== undefined && event.state === 'online') {
          pendingPasswords.current.delete(event.connectionId);
          setConnections(current =>
            current.map(item => (item.id === event.connectionId ? { ...item, savedPassword: remembered ?? undefined } : item)),
          );
          log(`${name} · ${remembered ? 'password remembered' : 'saved password removed'}`);
        } else if (remembered !== undefined && event.state !== 'connecting') pendingPasswords.current.delete(event.connectionId);
        if (event.state === 'error' && event.message) log.error(`${name} · ${event.message}`);
        else if (event.state === 'offline' && event.message)
          log.warn(t('{{name}} · disconnected ({{message}})', { name, message: event.message }));
      }),
    [connections],
  );

  // Terminal tabs: open / select / rename / close, fullscreen, tmux panes (hooks/useTabActions).
  const tabActions = useTabActions({ ws, setRecent, setConnections, connections, setTabEpochs });
  const { setTabMenu, setBarRename, leaveTerminalFull, setBackgroundStarts, terminalTitle, defaultTitle, reconnectTab } = tabActions;
  const { openTerminal, cloneSession, closeTabs, updateTmux, focusTmuxPane, splitTerminal, closeTmuxPane, breakTab } = tabActions;
  const { activateTerminal, moveTabToPane, barRename, commitBarRename, closeSession, terminalFull, enterTerminalFull } = tabActions;
  const { backgroundStarts, renameTab, tabMenu, closeConfirm, setCloseConfirm, doCloseTabs } = tabActions;

  // Window menu: windows switched like tabs (hooks/useWindowActions).
  const windowActions = useWindowActions({ ws, setTabMenu, setBarRename, leaveTerminalFull, connections, openTerminal, terminalTitle });
  const { newWindow, setWindowDialog, closeWindow, stepWindow, switchWindow, moveTabToWindow, moveWindow, windowDialog } = windowActions;
  const { renameWindow, doCloseWindow } = windowActions;
  // ---------- MCP server (src-rust/src/mcp): agent CLIs see and arrange windows, panes and tabs ----------
  const { mcpConfirm, answerMcpConfirm } = useMcpUi({
    windows,
    allTabsRef,
    windowIdRef,
    connectionsRef,
    tabSeq,
    windowSeq,
    setWindows,
    setAllTabs,
    setWindowIdState,
    setActiveId,
    setConnections,
    setRecent,
    setBackgroundStarts,
    setTabMenu,
    setBarRename,
    leaveTerminalFull,
    terminalTitle,
    defaultTitle,
    reconnectTab,
  });
  /** Right-click menu of a status-bar window button. */
  const [statusWindowMenu, setStatusWindowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** Save the Properties dialog: replace the config, keep its place in the tree unless the folder changed. */
  const updateConnection = (updated: ManagedConnection) => {
    setConnections(current => {
      const before = current.find(item => item.id === updated.id);
      if (!before) return current;
      if ((before.folderId ?? null) === (updated.folderId ?? null)) return current.map(item => (item.id === updated.id ? updated : item));
      // Moved to another folder: append it there, like a drop into that folder.
      return [...current.filter(item => item.id !== updated.id), updated];
    });
    revealFolder(updated.folderId);
    setEditingId(null);
    log(t('{{name}} · properties saved', { name: updated.name }));
  };
  const toggleFavorite = (id: string) =>
    setConnections(current =>
      current.map(connection => (connection.id === id ? { ...connection, favorite: !connection.favorite } : connection)),
    );
  const addConnection = (connection: ManagedConnection, openIt = true) => {
    setConnections(current => [...current, connection]);
    revealFolder(connection.folderId);
    if (openIt) openTerminal(connection.id);
    setNewConnectionState(null);
    setSavingAsId(null);
    log(t('{{name}} saved', { name: connection.name }));
  };

  // ---------- Explorer session tree ----------
  const {
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
  } = useExplorerTree({
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
  });
  /** Folder that new items go into for a context-menu target (a folder, a session's folder, or the default). */
  const defaultFolder = () => (folders.some(folder => folder.id === ROOT_FOLDER_ID) ? ROOT_FOLDER_ID : (folders[0]?.id ?? null));
  const folderFor = (target: TreeRef | null): string | null =>
    target?.kind === 'folder'
      ? target.id
      : target?.kind === 'session'
        ? (connections.find(item => item.id === target.id)?.folderId ?? null)
        : null;
  const setNewConnection = (folderId: string | null | undefined = undefined) =>
    setNewConnectionState({
      folderId: folderId === undefined ? (active.id !== FALLBACK_SESSION.id ? active.folderId : defaultFolder()) : folderId,
    });

  // ---------- menu bar: Session ----------
  /** Save dialog → local file (terminal selection / output); see lib/platform/saveText. */
  const saveText = (text: string, filename: string, title: string, what: string) => {
    void saveTextAs(text, filename, title)
      .then(saved => log(saved ? t('{{what}} saved to {{saved}}', { what, saved }) : t('Save {{v}} cancelled', { v: what.toLowerCase() })))
      .catch(error => log.error(t('{{what}} not saved', { what }), error));
  };
  /** Disconnect the active terminal only. The SSH link is dropped when no other terminal uses it. */
  const disconnectTab = (tab: TerminalTab) => {
    const connection = connections.find(item => item.id === tab.connectionId);
    if (!terminalRegistry.get(tab.id)?.disconnect()) {
      log.warn(t('{{v}} is not connected', { v: connection?.name ?? 'Session' }));
      return;
    }
    if (allTabs.some(item => item.id !== tab.id && item.connectionId === tab.connectionId)) return;
    if (backend.live) void backend.call('connection.disconnect', { connectionId: tab.connectionId }).catch(() => undefined);
    else setConnections(current => current.map(item => (item.id === tab.connectionId ? { ...item, status: 'offline' } : item)));
  };
  const saveSelection = (tab: TerminalTab) => {
    const text = terminalRegistry.get(tab.id)?.selection() ?? '';
    if (!text.trim()) {
      log(t('Nothing selected in the terminal'));
      return;
    }
    saveText(text, `${fileSafe(terminalTitle(tab))}-selection-${stamp()}.txt`, 'Save Selection As', 'Selection');
  };
  /** `ansi`: with colours (Save Output As ANSI…, `cat` / `less -R` show it as it was). */
  const saveOutput = (tab: TerminalTab, ansi = false) => {
    const handle = terminalRegistry.get(tab.id);
    const text = (ansi ? handle?.ansi() : handle?.output()) ?? '';
    if (!text.trim()) {
      log(t('The terminal has no output yet'));
      return;
    }
    const name = `${fileSafe(terminalTitle(tab))}-${stamp()}.${ansi ? 'ansi' : 'log'}`;
    saveText(text, name, ansi ? 'Save Output As ANSI' : 'Save Output As', 'Terminal output');
  };
  useEffect(() => {
    if (appDialog !== 'about' || !backend.live) return;
    void backend.call<{ version: string }>('ping').then(
      result => setBackendVersion(result?.version ?? null),
      () => setBackendVersion(null),
    );
  }, [appDialog]);
  /** Profiles Directory…: ~/.metroterm in the system file manager (opened by the backend). */
  const openProfilesDirectory = () => {
    void backend
      .call<string>('config.open')
      .then(dir => log(t('Profiles directory: {{dir}}', { dir })))
      .catch(error => log.error(t('Cannot open the profiles directory ({{v}})', { v: configLocation() }), error));
  };
  /**
   * Title bar ✕ / Exit: asks first while terminal tabs are open (their shells and connections end),
   * then saves pending config and closes. The browser usually refuses to close the tab.
   */
  const [quitAsk, setQuitAsk] = useState<'window' | 'exit' | null>(null);
  const quit = async (kind: 'window' | 'exit', confirmed = false) => {
    if (!confirmed && allTabsRef.current.length) {
      setQuitAsk(kind);
      return;
    }
    flushConfig();
    try {
      if (!(await closeApp(kind))) log(t('The browser does not let a page close its own tab — close it from the browser'));
    } catch (error) {
      log.error(kind === 'exit' ? t('Cannot exit') : t('Cannot close the window'), error);
    }
  };
  // Closing from outside the UI (native ✕, Alt+F4 / ⌘Q by the system, taskbar, Dock): the desktop
  // app holds it back while terminals are open and asks here; a browser shows its own leave prompt.
  const hasTabs = allTabs.length > 0;
  useEffect(() => {
    void windowFrame.setCloseGuard(hasTabs).catch(() => undefined);
    if (isDesktop() || !hasTabs) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [hasTabs]);
  useEffect(
    () =>
      backend.on(event => {
        if (event.type === 'window.closeRequested') void quitRef.current('window');
        // Started again while running: the window came to the front — type into the terminal right
        // away, unless something (a dialog field, a menu) already has the keyboard.
        if (event.type === 'window.activated' && (!document.activeElement || document.activeElement === document.body)) {
          const tab = activeTabIdRef.current;
          if (tab) terminalRegistry.get(tab)?.focus();
        }
      }),
    [],
  );
  // ---------- window frame ----------
  /** Title of the window (frameless title bar and native title bar alike): active tab — where it runs. */
  const windowTitle = activeTab
    ? `${terminalTitle(activeTab)} — ${
        active.transport === 'ssh' || active.transport === 'local'
          ? `${active.username ? `${active.username}@` : ''}${active.host || 'localhost'}`
          : describeConnection(active)
      }`
    : t('MetroTerm');
  useEffect(() => {
    document.title = windowTitle;
    void windowFrame.setTitle(windowTitle).catch(() => undefined);
  }, [windowTitle]);
  const quitRef = useRef(quit);
  quitRef.current = quit;

  const clampSize = (size: number) => Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, size));
  const zoomedSize = (tabId: string) => clampSize(terminalPrefs.fontSize + (zoom[tabId] ?? 0));
  /** Prefs of the zoomed terminals, one stable object each until the zoom or Settings change (TerminalView is memoized). */
  const zoomedPrefs = useMemo(() => {
    const byTab = new Map<string, TerminalPrefs>();
    for (const [tabId, step] of Object.entries(zoom))
      if (step) byTab.set(tabId, { ...terminalPrefs, fontSize: clampSize(terminalPrefs.fontSize + step) });
    return byTab;
  }, [zoom, terminalPrefs]);
  /** Zoom the active terminal: +1 / -1 px, or 0 = back to the font size from Settings. */
  const zoomActive = (step: 1 | -1 | 0) => {
    const tab = activeTab;
    if (!tab) return;
    const next = step === 0 ? terminalPrefs.fontSize : clampSize(zoomedSize(tab.id) + step);
    setZoom(current => ({ ...current, [tab.id]: next - terminalPrefs.fontSize }));
    log(t('Zoom {{v}}% · {{next}}px', { v: Math.round((next / terminalPrefs.fontSize) * 100), next }));
  };
  const keyMode = terminalPrefs.keyMode;
  const setKeyMode = (mode: KeyMode) => {
    setTerminalPrefs(prefs => ({ ...prefs, keyMode: mode }));
    log(
      mode === 'remote'
        ? t('Remote Mode — keys in the terminal go to the remote side as typed')
        : t('Local Mode — MetroTerm shortcuts work in the terminal (Ctrl+C copies a selection, Ctrl+V pastes)'),
    );
  };
  /** Context-menu entries of a terminal by tab id: one stable function for every TerminalView (advanced-use-latest). */
  const terminalMenuOf = useStableCallback((tabId: string): MenuItem[] => {
    const tab = allTabs.find(item => item.id === tabId);
    return tab ? terminalMenuItems(tab) : [];
  });
  const menuBar = buildMenuBar({
    fullScreen,
    toggleFullScreen,
    alwaysOnTop,
    toggleAlwaysOnTop,
    keyMode,
    setKeyMode,
    runningTunnels,
    setAppDialog,
    activeTab,
    zoomedSize,
    terminalPrefs,
    setTerminalPrefs,
    zoomActive,
    focusActive,
    toggleFocus,
    setFocusDialog,
    lockNow,
    connectionById,
    recent,
    setRecent,
    setNewConnection,
    cloneSession,
    disconnectTab,
    reconnectTab,
    openTerminal,
    setSavingAsId,
    saveSelection,
    proxy,
    logPrefs,
    setPreferencesDialog,
    setEditingId,
    openProfilesDirectory,
    closeTabs,
    terminalTabs,
    quit,
    windows,
    currentWindow,
    newWindow,
    setWindowDialog,
    closeWindow,
    stepWindow,
    switchWindow,
  });
  // Keyboard: tmux prefix keys and the app shortcuts, before the terminal sees them (hooks/useShortcuts).
  const { prefix } = useShortcuts({
    ws,
    updateTmux,
    focusTmuxPane,
    splitTerminal,
    closeTmuxPane,
    breakTab,
    openTerminal,
    activateTerminal,
    closeTabs,
    setBarRename,
    terminalTitle,
    lockedRef,
    terminalPrefs,
    toggleFocus,
    setPaletteOpen,
    toggleFullScreen,
    setNewConnection,
    setSavingAsId,
    zoomActive,
    switchWindow,
    stepWindow,
    quit,
  });

  // ---------- dynamic panel layout ----------
  const panelLabel = (view: ContentView) =>
    view === 'empty' ? t('Empty') : t(PANEL_VIEWS.find(item => item.view === view)?.label ?? view);
  /**
   * Settings → view: open it as a tab in this panel; already open here → just shown. Each view is open in
   * one panel only, so one open in another panel is closed there first (openTab).
   */
  const openPanelTab = (leaf: LeafNode, panelView: PanelView) => {
    const open = panelOf(layout, panelView);
    setLayout(current => openTab(current, leaf.id, panelView));
    if (open && open.id !== leaf.id) carryPanelState(panelView, open.id, leaf.id);
    log(
      open?.id === leaf.id
        ? t('{{v}} is already open in this panel', { v: panelLabel(panelView) })
        : open
          ? t('{{v}} closed in its other panel and opened here', { v: panelLabel(panelView) })
          : t('{{v}} opened in panel', { v: panelLabel(panelView) }),
    );
  };
  /** A view moved to another panel keeps its per-panel state: Explorer's expanded / collapsed folders. */
  const carryPanelState = (view: PanelView, fromId: string, toId: string) => {
    if (view !== 'explorer') return;
    setExplorerFolds(current => (current[fromId] ? { ...current, [toId]: current[fromId] } : current));
  };
  /** Drag a terminal tab (a pane's tab bar or the Session panel): reorder the terminal tabs, or move one to another pane. */
  const startTerminalTabDrag = (event: React.PointerEvent<HTMLElement>, strip: string, id: string, label: string) =>
    startTabDrag(event, {
      group: 'terminal',
      key: id,
      strip,
      label,
      // A pane's tab bar (`tmux:<pane>`): the tab joins that pane; the Session panel only reorders.
      onDrop: ({ strip: target, before }) =>
        target.startsWith('tmux:')
          ? moveTabToPane(id, target.slice(5), before)
          : setTerminalTabs(current => moveBefore(current, tab => tab.id, id, before)),
    });
  // Right-click and ⋮ menus: tabs, status bar windows, Explorer, terminal, panel settings, tmux pane (menus/contextMenus).
  const { tabMenuItems, statusWindowMenuItems, treeMenu, terminalMenuItems, panelMenu, tmuxPaneMenu } = buildContextMenus({
    ws,
    splitTerminal,
    breakTab,
    reconnectTab,
    disconnectTab,
    moveTabToWindow,
    closeTabs,
    closeTmuxPane,
    switchWindow,
    setWindowDialog,
    moveWindow,
    newWindow,
    closeWindow,
    folderFor,
    setNewConnection,
    defaultFolder,
    setTreeDialog,
    setAllFolders,
    duplicateItem,
    connections,
    openTerminal,
    toggleFavorite,
    setEditingId,
    saveSelection,
    saveOutput,
    cloneSession,
    panelLabel,
    openPanelTab,
    tmuxZoomed,
    focusTmuxPane,
  });
  /** Panels of a window that is not shown stay mounted (detached) and keep following that window. */
  const windowCtx = (item: WorkWindow): WindowCtx => {
    const tabs = allTabs.filter(tab => tab.windowId === item.id);
    const tab = tabs.find(entry => entry.id === item.activeTabId);
    return {
      terminalTabs: tabs,
      activeTabId: tab?.id ?? null,
      activeTab: tab,
      active: (tab && connectionById.get(tab.connectionId)) ?? active,
    };
  };
  const renderNode = (node: LayoutNode): React.ReactNode => {
    if (node.kind === 'split') {
      return (
        <SplitPane
          key={node.id}
          direction={node.direction}
          title={node.direction === 'horizontal' ? t('Drag · hide left or right panel') : t('Drag · hide top or bottom panel')}
          state={node.state}
          onChange={next => setLayout(current => applySplitChange(current, node.id, next))}
          onAutoCollapse={side => setLayout(current => removeEmptySide(current, node.id, side))}
          preferCollapse={hasTerminal(node.first) || (node.second.kind === 'leaf' && node.second.view === 'empty') ? 'second' : 'first'}
          edgeHandle={!isUserSplit(node)}
          minFirst={minSizeOf(node, 'first')}
          minSecond={minSizeOf(node, 'second')}
          first={renderNode(node.first)}
          second={renderNode(node.second)}
        />
      );
    }
    return <PanelSlot key={node.id} host={panelHost(node.id)} />;
  };
  const panelHosts = useRef(new Map<string, HTMLDivElement>());
  const panelHost = (id: string) => {
    let host = panelHosts.current.get(id);
    if (!host) {
      host = document.createElement('div');
      host.className = 'panel-host';
      panelHosts.current.set(id, host);
    }
    return host;
  };
  const leaves = collectLeaves(layout);
  /** Content panels of the windows that are not shown (rendered into detached hosts, see renderLeaf). */
  const hiddenLeaves = windows
    .filter(item => item.id !== currentWindow.id)
    .flatMap(item => {
      const ctx = windowCtx(item);
      return collectLeaves(item.layout)
        .filter(leaf => leaf.view !== 'terminal')
        .map(leaf => ({ leaf, ctx }));
    });
  /** Focus Mode's panes (shown / hidden for rendering only; the saved layout is not changed). */
  const focusPanes = focusActive && !panesUnchanged(focusConfig.panes) ? focusLayout(layout, focusConfig.panes) : null;
  useEffect(() => {
    const live = new Set([...leaves, ...hiddenLeaves.map(item => item.leaf)].map(leaf => leaf.id));
    for (const id of [...panelHosts.current.keys()]) if (!live.has(id)) panelHosts.current.delete(id);
  });
  const renderLeaf = (node: LeafNode, ctx?: WindowCtx): React.ReactNode => {
    // tmux panes (views/TmuxPanes): each a tab group with its own tab bar and toolbar, over every window's terminals.
    if (node.view === 'terminal')
      return (
        <TmuxPanes
          {...{ ws, updateTmux, barRename, activateTerminal, startTerminalTabDrag, terminalTitle, setBarRename, setTabMenu, defaultTitle }}
          {...{ commitBarRename, closeSession, focusActive, focusConfig, terminalFull, leaveTerminalFull, enterTerminalFull, cloneSession }}
          {...{ reconnectTab, folders, toggleFavorite, tmuxPaneMenu, focusTmuxPane, setNewConnection, theme, tabEpochs, terminalMenuOf }}
          {...{ onCursor, zoomedPrefs, terminalPrefs, backgroundStarts }}
        />
      );
    // Content panels (views/ContentPanel): tab bar, ⚙ menu and the open views (Explorer, Filer, Monitor, Session, Sender).
    return (
      <ContentPanel
        {...{ ws, node, ctx, focusPanes, leaves, panelLabel, carryPanelState, swatches, panelMenu, openPanelTab, lastExplorer, filters }}
        {...{ setFilters, setNewConnection, folders, isCollapsedIn, connections, missingShell, openTerminal, toggleFolder, toggleFavorite }}
        {...{ moveTreeItem, treeMenu, activateTerminal, renameTab, startTerminalTabDrag, tabMenuItems, terminalTitle, defaultTitle }}
      />
    );
  };

  const uiFamily = appearance.uiFontFamily || defaultUiFamily();
  return (
    <main
      className={`metroterm-shell ${theme === 'gold' ? 'dark gold' : theme}`}
      style={uiFamily ? ({ '--ui-font-family': withFallback(uiFamily, UI_FONT_STACK) } as React.CSSProperties) : undefined}
    >
      {/* Title bar (frameless desktop window), menu bar with its tools, Focus Mode's exit zone (views/AppHeader). */}
      <AppHeader {...{ frame, focus, windowTitle, quit, menuBar, paletteOpen, setPaletteOpen, appDialog, runningTunnels, setAppDialog }} />

      <div className="workbench-split">
        {(() => {
          // Fullscreen terminal: the terminal panel's host moves into a single slot; every other
          // panel keeps its state in its (detached) host and comes back with the layout on exit.
          const terminalLeaf = terminalFull ? leaves.find(leaf => leaf.view === 'terminal') : undefined;
          return terminalLeaf ? (
            <PanelSlot key={`full-${terminalLeaf.id}`} host={panelHost(terminalLeaf.id)} />
          ) : (
            renderNode(focusPanes?.tree ?? layout)
          );
        })()}
      </div>
      {[
        ...leaves.map(leaf => createPortal(renderLeaf(leaf), panelHost(leaf.id), leaf.id)),
        ...hiddenLeaves.map(({ leaf, ctx }) => createPortal(renderLeaf(leaf, ctx), panelHost(leaf.id), leaf.id)),
      ]}
      {/* Status bar: activity, windows, tmux prefix, cursor, key mode, lock, theme (views/StatusBar). */}
      <StatusBar
        {...{ focus, ws, lock, prefs, switchWindow, setWindowDialog, setStatusWindowMenu, newWindow, prefix, keyMode, setKeyMode }}
      />
      {/* Dialogs, context menus and overlays (views/DialogHost). */}
      <DialogHost
        {...{ prefs, ws, frame, lock, focus, connections, rememberPassword, newConnection, setNewConnectionState, addConnection }}
        {...{ folders, folderCounts, shells, editingId, setEditingId, updateConnection, savingAsId, setSavingAsId, treeDialog }}
        {...{ setTreeDialog, createFolder, renameItem, deleteItem, statusWindowMenu, setStatusWindowMenu, statusWindowMenuItems }}
        {...{ tabMenu, setTabMenu, setBarRename, terminalTitle, renameTab, tabMenuItems, preferencesDialog, showOpacity }}
        {...{ setPreferencesDialog, appDialog, setAppDialog, paletteOpen, menuBar, setPaletteOpen, backendVersion, quitAsk, setQuitAsk }}
        {...{ quit, windowDialog, setWindowDialog, renameWindow, doCloseWindow, mcpConfirm, answerMcpConfirm, closeConfirm }}
        {...{ setCloseConfirm, doCloseTabs }}
      />
    </main>
  );
}
