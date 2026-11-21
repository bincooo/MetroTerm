import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalTab, ThemeMode, TmuxNode } from './types';
import { PaneLetter } from './components/PaneLetter';
import { canSendToSender, sendToSender, SenderBody } from './components/SenderPanel';
import { NewConnectionDialog, SessionDefaultsDialog } from './components/SessionDialogs';
import { SettingsDialog, type TitleBarMode } from './components/SettingsDialog';
import TerminalView, { type CursorInfo } from './components/TerminalView';
import Filer from './components/Filer';
import { MIN_PANEL_SIZE, SENDER_MIN_PANEL_SIZE, SplitPane, SPLITTER_SIZE } from './components/SplitPane';
import { ContextMenu, MenuButton, type MenuItem } from './components/MenuButton';
import { SessionsPanel } from './components/SessionsPanel';
import { MonitorPanel } from './components/MonitorPanel';
import {
  SENDER_SLOT,
  activateTab,
  applySplitChange,
  isUserSplit,
  closeNode,
  removeEmptySide,
  closeTab,
  moveTab,
  openTab,
  PANEL_VIEWS,
  splitDirectionFor,
  splitLeaf,
  tabsOf,
  type LayoutNode,
  type LeafNode,
  type LeafView,
  type PanelView,
} from './layout';
import { Icon } from './components/Icon';
import { MenuBar, type BarMenu, type BarMenuItem } from './components/MenuBar';
// Menu search: loaded on first use, prefetched when the pointer reaches its button (bundle-conditional, bundle-preload).
const loadCommandPalette = () => import('./components/CommandPalette');
const CommandPalette = lazy(loadCommandPalette);
import { log, useActivity } from './lib/log';
import { configLocation, dropConfig, flushConfig, readConfig, writeConfig } from './lib/config';
import {
  TMUX_FIRST_PANE,
  tmuxIds,
  tmuxLayout,
  tmuxLeaf,
  tmuxNewId,
  tmuxResize,
  tmuxSetRatio,
  tmuxSplit,
  tmuxSwap,
  tmuxToward,
  tmuxView,
  type Rect,
  type TmuxDirection,
  type TmuxPaneView,
  type TmuxSplitter,
} from './lib/tmux';
import { defaultWindowName, newWindowLayout, restoreWindows, WINDOW_NAME_MAX, windowsDoc, type WorkWindow } from './lib/windows';
import { applyWindowBackground, closeApp, isDesktop, windowFrame, type WindowState } from './lib/tauri';
import {
  FONT_SIZE_RANGE,
  UI_FONT_STACK,
  describeProxy,
  proxyActive,
  sanitizeAppearance,
  sanitizeLog,
  sanitizeProxy,
  sanitizeSessionDefaults,
  sanitizeTerminalPrefs,
  withFallback,
  type AppearancePrefs,
  type KeyMode,
  type LogPrefs,
  type ProxyPrefs,
  type SessionDefaults,
  type TerminalPrefs,
} from './lib/preferences';
import { AboutDialog, LogSettingsDialog, ProxyDialog } from './components/AppDialogs';
import { APP_VERSION } from './lib/version';
import { backend, terminalRegistry, type BackendEvent } from './lib/backend';
import { saveTextAs } from './lib/saveText';
import { describeConnection, hasFiles, transportIcon, transportName } from './lib/transports';
import { FieldContextMenu } from './components/FieldMenu';
import { TooltipLayer } from './components/TooltipLayer';
import { installCustomScrollbars } from './lib/customScrollbars';
import { moveBefore, startTabDrag } from './lib/tabDrag';
import { useStableCallback } from './lib/useStableCallback';
import { AuthPromptDialog } from './components/AuthPromptDialog';
import { SessionTree, TreeDialog, type TreeSession } from './components/SessionTree';
import { THEME_NAMES, nextTheme, sanitizeTheme } from './lib/themes';
import { LockOverlay, LockPasswordDialog, LockSetupDialog } from './components/LockScreen';
import { FocusModeDialog } from './components/FocusModeDialog';
import { TunnelsDialog } from './components/TunnelsDialog';
import { autoStartTunnels, tunnelRuntime } from './lib/tunnelRuntime';
import { hashLockPassword, hasLockPassword, sanitizeLockSettings, type LockSettings } from './lib/lockScreen';
import { focusLayout, panesUnchanged, sanitizeFocusConfig, type FocusConfig, type FocusLeaf } from './lib/focusMode';
import {
  makeSessionId,
  folderAndDescendants,
  folderPath,
  foldersFromGroups,
  makeFolderId,
  moveFolder,
  moveSession,
  ROOT_FOLDER_ID,
  type DropTarget,
  type SessionFolder,
  type TreeRef,
} from './lib/sessionTree';
import i18n, { sanitizeLanguage, setLanguage, t, tc, type Language } from './i18n';
import { isMacHost, isWindowsHost } from './lib/hostOs';
import { useTranslation } from 'react-i18next';

/** A saved session config (Explorer item) inside a folder of the session tree. */
type ManagedConnection = TreeSession;
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
 * runs on (lib/hostOs) — cmd and PowerShell on Windows (Windows PowerShell is part of every
 * Windows; pwsh can be added by the user), bash and zsh elsewhere. Shells missing on this computer
 * are greyed out in Explorer.
 */
const builtinShells = (): ManagedConnection[] =>
  isWindowsHost()
    ? [localShell('local', 'cmd'), localShell('local-powershell', 'powershell')]
    : [localShell('local', 'bash'), localShell('local-zsh', 'zsh')];
/** The Linux / macOS built-ins, which earlier versions also gave Windows (see the v3 → v4 repair). */
const UNIX_BUILTINS: Record<string, string> = { local: 'bash', 'local-zsh': 'zsh' };
const defaultFolders: SessionFolder[] = [
  { id: ROOT_FOLDER_ID, name: 'Shell sessions', parentId: null },
  { id: 'folder-local', name: 'Local', parentId: ROOT_FOLDER_ID },
];
/** Terminal / Filer / Sender target when no session config exists at all (every folder deleted). */
const FALLBACK_SESSION: ManagedConnection = {
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

// ---------- persisted configuration (~/.metroterm/*.json, see src/lib/config.ts) ----------
type SettingsDoc = {
  version: 1;
  theme: ThemeMode;
  titleBar?: TitleBarMode;
  swatches: Record<PaneId, string>;
  recent?: string[];
  terminal?: TerminalPrefs;
  sessionDefaults?: SessionDefaults;
  lock?: LockSettings;
  focus?: FocusConfig;
  /** Settings → WINDOW OPACITY / FONTS (interface font). */
  appearance?: AppearancePrefs;
  /** Settings → LANGUAGE: 'en' (default) | 'zh'. */
  language?: Language;
  /** Session → Proxy… (read by the backend for SSH / Telnet / TCP). */
  proxy?: ProxyPrefs;
  /** Session → Log… (read by the backend at start-up, applied live with `log.configure`). */
  log?: LogPrefs;
};
/** Session menu → Open Recent: most recently opened session configs (ids), newest first. */
const RECENT_MAX = 10;
/** v1 / v2: flat `group` names. v3: nested folders (`folders` + `folderId`). */
type SavedSession = Omit<ManagedConnection, 'status' | 'folderId'> & { folderId?: string | null; group?: string };
type SessionsDoc = { version: 1 | 2 | 3 | 4; folders?: SessionFolder[]; sessions: SavedSession[] };
/** sessions.json → explorer: open / closed folders of each Explorer panel. */
type ExplorerDoc = { panels: Record<string, Record<string, boolean>> };
const readSettings = () => readConfig<Partial<SettingsDoc>>('settings') ?? {};

/** Saved session tree (Explorer). Runtime status is not persisted. */
function initialSessions(): { folders: SessionFolder[]; sessions: ManagedConnection[] } {
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

// Panel title swatches: one random color per panel type, generated once and saved in
// settings.json so it stays stable across restarts. Hues are spread apart so panels differ;
// saturation / lightness are kept moderate to sit well on both dark and light themes.
const swatchKey = 'monoterm-pane-swatches';
type PaneId = 'explorer' | 'filer' | 'sender' | 'sessions' | 'monitor';
function initialSwatches(): Record<PaneId, string> {
  const fromSettings = readSettings().swatches;
  // Panels added later (Session, Monitor) get a colour of their own; existing colours are kept.
  const random = () =>
    `hsl(${Math.round(Math.random() * 360)} ${Math.round(45 + Math.random() * 20)}% ${Math.round(52 + Math.random() * 10)}%)`;
  const withNew = (saved: Partial<Record<PaneId, string>>) =>
    ({ ...saved, sessions: saved.sessions ?? random(), monitor: saved.monitor ?? random() }) as Record<PaneId, string>;
  if (fromSettings?.explorer && fromSettings?.filer && fromSettings?.sender) return withNew(fromSettings);
  try {
    // migrate colors stored by earlier builds
    const saved = JSON.parse(window.localStorage.getItem(swatchKey) || 'null');
    if (saved?.explorer && saved?.filer && saved?.sender) return withNew(saved);
  } catch {
    /* regenerate */
  }
  const start = Math.random() * 360;
  const ids: PaneId[] = ['explorer', 'filer', 'sender', 'sessions', 'monitor'];
  const colors = Object.fromEntries(
    ids.map((id, index) => {
      const hue = Math.round((start + index * (72 + Math.random() * 20 - 10)) % 360);
      const saturation = Math.round(45 + Math.random() * 20);
      const lightness = Math.round(52 + Math.random() * 10);
      return [id, `hsl(${hue} ${saturation}% ${lightness}%)`];
    }),
  ) as Record<PaneId, string>;
  return colors;
}

/** tmux panes: a pane that is not at the left / top edge leaves 1px free there (the divider shows the stage's --tmux-line). */
const TMUX_GAP = 1;
const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 };
const tmuxStyle = (rect: Rect): React.CSSProperties => {
  const left = rect.x > 0.0001 ? TMUX_GAP : 0;
  const top = rect.y > 0.0001 ? TMUX_GAP : 0;
  return {
    left: `calc(${rect.x * 100}% + ${left}px)`,
    top: `calc(${rect.y * 100}% + ${top}px)`,
    width: `calc(${rect.w * 100}% - ${left}px)`,
    height: `calc(${rect.h * 100}% - ${top}px)`,
  };
};
/** Where a pane's terminal goes: its body box (px, measured in the stage). */
type TmuxBox = { x: number; y: number; w: number; h: number };
const sameBoxes = (a: Record<string, TmuxBox>, b: Record<string, TmuxBox>) => {
  const keys = Object.keys(b);
  return (
    keys.length === Object.keys(a).length &&
    keys.every(key => a[key] && a[key].x === b[key].x && a[key].y === b[key].y && a[key].w === b[key].w && a[key].h === b[key].h)
  );
};
/** A splitter's hit area: centred on the border, across the split's box. */
const tmuxSplitterStyle = ({ dir, box, ratio }: TmuxSplitter): React.CSSProperties =>
  dir === 'row'
    ? { left: `${(box.x + box.w * ratio) * 100}%`, top: `${box.y * 100}%`, height: `${box.h * 100}%` }
    : { top: `${(box.y + box.h * ratio) * 100}%`, left: `${box.x * 100}%`, width: `${box.w * 100}%` };
const tabNumber = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;

/**
 * Placeholder in the layout tree. The real panel content is rendered (via portal) into a
 * persistent host element that is moved into this slot, so panels keep their React state
 * and DOM (Sender text, xterm buffer) when the tree is restructured by split / close.
 */
function PanelSlot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(host);
    return () => {
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [host]);
  return <div className="panel-slot" ref={ref} />;
}

// ----- Pure helpers, hoisted out of App (rendering-hoist-jsx / js-hoist): no state, no new closure per render. -----
/** Local time as YYYYMMDD-hhmmss, for default file names. */
const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const fileSafe = (name: string) => name.replace(/[^\w.-]+/g, '_') || 'session';
const hasTerminal = (node: LayoutNode): boolean =>
  node.kind === 'leaf' ? node.view === 'terminal' : hasTerminal(node.first) || hasTerminal(node.second);
const panelClass: Record<PanelView, string> = {
  explorer: 'session-explorer',
  filer: 'filer-pane',
  sender: 'sender-pane',
  sessions: 'sessions-pane',
  monitor: 'monitor-pane',
};
/**
 * Hide-below size of one side of a splitter. The Sender panel of the frame (bottom of the `right`
 * split) has its own, halved minimum. It belongs to that panel, not to the Sender view: moving the
 * Sender tab elsewhere doesn't move it, and the panel keeps it whatever it shows.
 */
const minSizeOf = (split: LayoutNode, side: 'first' | 'second') =>
  split.id === SENDER_SLOT.split && side === SENDER_SLOT.side ? SENDER_MIN_PANEL_SIZE : MIN_PANEL_SIZE;
const collectLeaves = (node: LayoutNode): LeafNode[] =>
  node.kind === 'leaf' ? [node] : [...collectLeaves(node.first), ...collectLeaves(node.second)];

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => sanitizeTheme(readSettings().theme));
  const [language, setLanguageState] = useState<Language>(() => sanitizeLanguage(readSettings().language));
  useTranslation(); // re-render on a language change (`t` reads the current language; main.tsx sets the saved one)
  useLayoutEffect(() => applyWindowBackground(theme), [theme]);
  const [titleBar, setTitleBar] = useState<TitleBarMode>(() => (readSettings().titleBar === 'native' ? 'native' : 'frameless'));
  // The desktop window opens with the saved style already (src-rust/src/desktop.rs); this follows later changes.
  const firstTitleBar = useRef(true);
  useEffect(() => {
    if (firstTitleBar.current) {
      firstTitleBar.current = false;
      return;
    }
    void windowFrame.setNativeFrame(titleBar === 'native').catch(error => log.error(t('Title bar'), error));
  }, [titleBar]);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const sync = () => {
      void windowFrame
        .isMaximized()
        .then(value => {
          if (typeof value === 'boolean') setMaximized(value);
        })
        .catch(() => undefined);
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  // Mode → Full Screen / Always On Top: the window's current state (Focus Mode changes it too).
  const [fullScreen, setFullScreen] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const syncWindowModes = useCallback(() => {
    if (!isDesktop()) {
      setFullScreen(Boolean(document.fullscreenElement));
      return;
    }
    void windowFrame
      .getState()
      .then(state => {
        if (!state) return;
        setFullScreen(Boolean(state.fullscreen));
        setAlwaysOnTop(Boolean(state.alwaysOnTop));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    syncWindowModes();
    window.addEventListener('resize', syncWindowModes);
    document.addEventListener('fullscreenchange', syncWindowModes);
    return () => {
      window.removeEventListener('resize', syncWindowModes);
      document.removeEventListener('fullscreenchange', syncWindowModes);
    };
  }, [syncWindowModes]);
  const [initialTree] = useState(initialSessions);
  const [connections, setConnections] = useState<ManagedConnection[]>(initialTree.sessions);
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
    const byId = new Map(folders.map(folder => [folder.id, folder]));
    for (const session of connections) {
      const seen = new Set<string>();
      let folder = session.folderId ? byId.get(session.folderId) : undefined;
      while (folder && !seen.has(folder.id)) {
        seen.add(folder.id);
        counts[folder.id] = (counts[folder.id] ?? 0) + 1;
        folder = folder.parentId ? byId.get(folder.parentId) : undefined;
      }
    }
    return counts;
  }, [connections, folders]);
  /** Explorer dialogs: new folder / rename / delete. */
  type TreeDialogState = { kind: 'new-folder'; parentId: string | null } | { kind: 'rename' | 'delete'; target: TreeRef };
  const [treeDialog, setTreeDialog] = useState<TreeDialogState | null>(null);
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
  const [swatches] = useState(initialSwatches);
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
  /** Preferences (settings.json): terminal options and the New Session defaults. */
  const [terminalPrefs, setTerminalPrefs] = useState(() => sanitizeTerminalPrefs(readSettings().terminal));
  const [sessionDefaults, setSessionDefaults] = useState(() => sanitizeSessionDefaults(readSettings().sessionDefaults));
  const [preferencesDialog, setPreferencesDialog] = useState<'settings' | 'defaults' | null>(null);
  const [appearance, setAppearance] = useState(() => sanitizeAppearance(readSettings().appearance));
  const [proxy, setProxy] = useState(() => sanitizeProxy(readSettings().proxy));
  const [logPrefs, setLogPrefs] = useState(() => sanitizeLog(readSettings().log));
  /** Session → Proxy… / Log…, Help → About. */
  const [appDialog, setAppDialog] = useState<'proxy' | 'log' | 'about' | 'tunnels' | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Only the number of running tunnels: the app re-renders when it changes, not on every poll. */
  const runningTunnels = useSyncExternalStore(tunnelRuntime.subscribe, tunnelRuntime.getRunningCount);
  /** Backend version for About (ping); null = not known. */
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  // ---------- Lock Screen (status bar → Lock Screen; settings.json → lock) ----------
  const [lockSettings, setLockSettings] = useState(() => sanitizeLockSettings(readSettings().lock));
  /** Locked when the app was closed while locked with a password: starts locked again. */
  const [locked, setLocked] = useState(() => hasLockPassword(lockSettings) && Boolean(lockSettings.locked));
  const [lockPrompt, setLockPrompt] = useState<'setup' | 'password' | null>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const lockNow = useCallback(
    (fromIdle = false) => {
      if (lockedRef.current) return;
      // No password yet: offer to set one (unless turned off) — not when locking because of idling.
      if (!fromIdle && !hasLockPassword(lockSettings) && !lockSettings.skipPrompt) {
        setLockPrompt('setup');
        return;
      }
      lockedRef.current = true;
      setLockPrompt(null);
      setLocked(true);
    },
    [lockSettings],
  );
  // The app was used: keyboard / mouse input (terminal output doesn't count). Auto lock after idling.
  useEffect(() => {
    if (locked || !lockSettings.idleMinutes) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const types = ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart'] as const;
    types.forEach(type => window.addEventListener(type, touch, { capture: true, passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - last >= lockSettings.idleMinutes * 60_000) lockNow(true);
    }, 5_000);
    return () => {
      types.forEach(type => window.removeEventListener(type, touch, { capture: true }));
      window.clearInterval(timer);
    };
  }, [locked, lockSettings.idleMinutes, lockNow]);
  const saveLockPassword = async (password: string | null) => {
    const secret = password === null ? {} : await hashLockPassword(password);
    setLockSettings(current => {
      const { hash: _h, salt: _s, iterations: _i, locked: _l, ...rest } = current;
      return { ...rest, ...secret };
    });
    return secret;
  };

  // ---------- Focus Mode (menu bar → Focus Mode, Ctrl+Shift+F; settings.json → focus) ----------
  const [focusConfig, setFocusConfig] = useState(() => sanitizeFocusConfig(readSettings().focus));
  const [focusActive, setFocusActive] = useState(false);
  const [focusDialog, setFocusDialog] = useState(false);
  /** Window state before Focus Mode, restored when it ends. */
  const focusRestore = useRef<WindowState | null>(null);
  const applyFocusWindow = async (config: FocusConfig, entering: boolean) => {
    if (isDesktop()) {
      if (entering && !focusRestore.current) focusRestore.current = (await windowFrame.getState()) ?? null;
      const before = focusRestore.current ?? {};
      await windowFrame.setState({
        decorated: false,
        maximized: true,
        fullscreen: config.fullScreen === 'preserve' ? before.fullscreen : config.fullScreen === 'yes',
        alwaysOnTop: config.alwaysOnTop === 'preserve' ? before.alwaysOnTop : config.alwaysOnTop === 'yes',
      });
      return;
    }
    // Browser: full screen through the Fullscreen API (needs the click / key press that started it).
    const full = Boolean(document.fullscreenElement);
    if (entering && !focusRestore.current) focusRestore.current = { fullscreen: full };
    const want = config.fullScreen === 'preserve' ? (focusRestore.current?.fullscreen ?? full) : config.fullScreen === 'yes';
    if (want && !full) await document.documentElement.requestFullscreen?.().catch(() => undefined);
    else if (!want && full) await document.exitFullscreen?.().catch(() => undefined);
  };
  const enterFocus = (config: FocusConfig) => {
    setFocusConfig(config);
    setFocusDialog(false);
    setFocusActive(true);
    void applyFocusWindow(config, true)
      .catch(error => log.error(t('Focus Mode'), error))
      .finally(syncWindowModes);
    log(t('Focus Mode on — Ctrl+Shift+F to leave'));
  };
  const exitFocus = () => {
    const before = focusRestore.current;
    focusRestore.current = null;
    setFocusActive(false);
    if (isDesktop()) {
      void windowFrame
        .setState({
          fullscreen: before?.fullscreen ?? false,
          maximized: before?.maximized ?? false,
          decorated: before?.decorated ?? titleBar === 'native',
          alwaysOnTop: before?.alwaysOnTop ?? false,
        })
        .catch(error => log.error(t('Focus Mode'), error))
        .finally(syncWindowModes);
    } else if (document.fullscreenElement && !before?.fullscreen) void document.exitFullscreen?.().catch(() => undefined);
    log(t('Focus Mode off'));
  };
  const startFocus = () => {
    if (focusConfig.showDialog) setFocusDialog(true);
    else enterFocus(focusConfig);
  };
  const toggleFocus = () => {
    if (focusActive) exitFocus();
    else startFocus();
  };
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
  const activity = useActivity();
  /** Size and cursor position of the visible terminal (status bar). */
  const [cursorInfo, setCursorInfo] = useState<(CursorInfo & { tabId: string }) | null>(null);
  const onCursor = useCallback((tabId: string, info: CursorInfo) => setCursorInfo({ tabId, ...info }), []);
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
  /** Sessions by id, for lookups inside loops (js-index-maps). */
  const connectionById = useMemo(() => new Map(connections.map(connection => [connection.id, connection])), [connections]);
  // Persist configuration to ~/.metroterm (layout.json · settings.json · sessions.json).
  useEffect(() => {
    writeConfig('windows', windowsDoc(windows, allTabs, windowId));
    // `layout` / `tabs` (one window, before the Window menu) were read into window 1.
    dropConfig('layout');
    dropConfig('tabs');
  }, [windows, allTabs, windowId]);
  useEffect(() => {
    // The locked state is kept only with a password (a lock without one is just a cover).
    const lock = sanitizeLockSettings({ ...lockSettings, locked: locked && hasLockPassword(lockSettings) });
    writeConfig('settings', {
      version: 1,
      theme,
      language,
      titleBar,
      swatches,
      recent,
      terminal: terminalPrefs,
      sessionDefaults,
      lock,
      focus: focusConfig,
      appearance,
      proxy,
      log: logPrefs,
    } satisfies SettingsDoc);
  }, [
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
  ]);
  useEffect(() => {
    const sessions = connections.map(({ status: _status, ...config }) => config);
    writeConfig('sessions', { version: 4, folders, sessions } satisfies SessionsDoc);
  }, [connections, folders]);
  useEffect(() => {
    // Only panels (of any window) that still show an Explorer and folders that still exist.
    const panels = new Set(
      windows
        .flatMap(item => collectLeaves(item.layout))
        .filter(leaf => (leaf.tabs ?? []).includes('explorer'))
        .map(leaf => leaf.id),
    );
    const ids = new Set(folders.map(folder => folder.id));
    const kept = Object.fromEntries(
      Object.entries(explorerFolds)
        .filter(([panel]) => panels.has(panel))
        .map(([panel, folds]) => [panel, Object.fromEntries(Object.entries(folds).filter(([id]) => ids.has(id)))]),
    );
    writeConfig('explorer', { panels: kept } satisfies ExplorerDoc);
  }, [explorerFolds, windows, folders]);
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
  /** Per-connection reconnect counter: bumping it restarts that connection's terminals. */
  const [epochs, setEpochs] = useState<Record<string, number>>({});
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

  /** Always opens a NEW terminal for a saved connection (Explorer double-click, Clone Session …). */
  const openTerminal = useCallback((connectionId: string, pane?: string) => {
    const id = `tab-${++tabSeq.current}`;
    // In the given tmux pane, else the focused one.
    setTerminalTabs(current => [...current, { id, connectionId, tmuxPane: pane ?? tmuxFocusRef.current }]);
    setRecent(current => [connectionId, ...current.filter(item => item !== connectionId)].slice(0, RECENT_MAX));
    // Preview only: no backend reports real states.
    if (!backend.live)
      setConnections(current =>
        current.map(item => (item.id === connectionId && item.status === 'offline' ? { ...item, status: 'online' } : item)),
      );
    setActiveTabId(id);
    setActiveId(connectionId);
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
  /** Right-click menu of an open tab (Session panel and terminal tab bar), after Rename. */
  const tabMenuItems = (tabId: string): MenuItem[] => {
    const tab = terminalTabs.find(item => item.id === tabId);
    if (!tab) return [];
    const paneId = tmuxPaneOfTab(tab.id);
    const paneTabs = tmuxPaneTabs(paneId);
    return [
      // tmux split-window: the tab's pane; the new pane gets a new terminal of the same session.
      {
        type: 'item',
        id: 'split-row',
        label: t('Split Left / Right'),
        icon: 'splitRow',
        hint: 'Ctrl+B %',
        onSelect: () => splitTerminal('row', tab.id),
      },
      {
        type: 'item',
        id: 'split-column',
        label: t('Split Top / Bottom'),
        icon: 'splitColumn',
        hint: 'Ctrl+B "',
        onSelect: () => splitTerminal('column', tab.id),
      },
      {
        type: 'item',
        id: 'break-pane',
        label: t('Move Tab to New Pane'),
        hint: 'Ctrl+B !',
        disabled: paneTabs.length < 2,
        onSelect: () => breakTab(tab.id),
      },
      { type: 'separator', id: 'sep-split' },
      { type: 'item', id: 'reconnect', label: t('Reconnect'), icon: 'refresh', onSelect: () => reconnect(tab.connectionId) },
      { type: 'item', id: 'disconnect', label: t('Disconnect'), icon: 'unplug', onSelect: () => disconnectTab(tab) },
      // Window menu: hand the running session over to another window.
      ...(windows.length > 1
        ? [
            { type: 'separator', id: 'sep-move' } as MenuItem,
            ...windows
              .filter(item => item.id !== tab.windowId)
              .map((item): MenuItem => ({
                type: 'item',
                id: `move-${item.id}`,
                label: t('Move to {{name}}', { name: item.name }),
                icon: 'layout',
                onSelect: () => moveTabToWindow(tab.id, item.id),
              })),
          ]
        : []),
      { type: 'separator', id: 'sep-close' },
      { type: 'item', id: 'close', label: t('Close tab'), icon: 'close', hint: 'Ctrl+Shift+W', onSelect: () => closeTabs([tab.id]) },
      // Other / all tabs of this tab bar (= this pane).
      {
        type: 'item',
        id: 'close-others',
        label: t('Close other tabs'),
        disabled: paneTabs.length < 2,
        onSelect: () => closeTabs(paneTabs.filter(item => item.id !== tab.id).map(item => item.id)),
      },
      ...(tmux.panes.length > 1
        ? [
            {
              type: 'item',
              id: 'close-pane',
              label: t('Close pane'),
              hint: 'Ctrl+B x',
              onSelect: () => closeTmuxPane(paneId),
            } as MenuItem,
          ]
        : [
            {
              type: 'item',
              id: 'close-all',
              label: t('Close all tabs'),
              onSelect: () => closeTabs(paneTabs.map(item => item.id)),
            } as MenuItem,
          ]),
    ];
  };

  const reconnect = (id: string) => {
    const connection = connections.find(item => item.id === id);
    if (!connection) return;
    log(t('Reconnecting {{name}}…', { name: connection.name }));
    if (backend.live) {
      // Drop the shared SSH connection, then every open terminal of this session reconnects.
      void backend
        .call('connection.disconnect', { connectionId: id })
        .catch(() => undefined)
        .finally(() => {
          setEpochs(current => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
          if (!terminalTabs.some(tab => tab.connectionId === id)) openTerminal(id);
        });
      return;
    }
    setConnections(current => current.map(item => (item.id === id ? { ...item, status: 'connecting' } : item)));
    if (!terminalTabs.some(tab => tab.connectionId === id)) openTerminal(id);
    window.setTimeout(() => {
      setConnections(current => current.map(item => (item.id === id ? { ...item, status: 'online' } : item)));
      log(t('{{name}} connected', { name: connection.name }));
    }, 650);
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
  /** Right-click menu of a status-bar window button. */
  const [statusWindowMenu, setStatusWindowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const statusWindowMenuItems = (id: string): MenuItem[] => {
    const index = windows.findIndex(item => item.id === id);
    const target = windows[index];
    if (!target) return [];
    return [
      {
        type: 'item',
        id: 'status-window-show',
        label: t('Show Window'),
        icon: 'layout',
        hint: index < 9 ? `Ctrl+Shift+${index + 1}` : undefined,
        disabled: id === currentWindow.id,
        onSelect: () => switchWindow(id),
      },
      {
        type: 'item',
        id: 'status-window-rename',
        label: t('Rename Window…'),
        icon: 'rename',
        onSelect: () => setWindowDialog({ kind: 'rename', id }),
      },
      { type: 'separator', id: 'status-window-sep-move' },
      { type: 'item', id: 'status-window-left', label: t('Move Left'), disabled: index === 0, onSelect: () => moveWindow(id, -1) },
      {
        type: 'item',
        id: 'status-window-right',
        label: t('Move Right'),
        disabled: index === windows.length - 1,
        onSelect: () => moveWindow(id, 1),
      },
      { type: 'separator', id: 'status-window-sep-new' },
      { type: 'item', id: 'status-window-new', label: t('New Window'), icon: 'plus', onSelect: newWindow },
      {
        type: 'item',
        id: 'status-window-close',
        label: t('Close Window'),
        icon: 'close',
        disabled: windows.length < 2,
        onSelect: () => closeWindow(id),
      },
    ];
  };
  /** Window menu: new / rename / close, previous / next, and the list of windows. */
  const windowMenu = (): BarMenuItem[] => [
    { type: 'item', id: 'window-new', label: t('New Window'), icon: 'plus', onSelect: newWindow },
    {
      type: 'item',
      id: 'window-rename',
      label: t('Rename Window…'),
      icon: 'rename',
      onSelect: () => setWindowDialog({ kind: 'rename', id: currentWindow.id }),
    },
    {
      type: 'item',
      id: 'window-close',
      label: t('Close Window'),
      icon: 'close',
      disabled: windows.length < 2,
      onSelect: () => closeWindow(currentWindow.id),
    },
    { type: 'separator', id: 'window-sep-step' },
    {
      type: 'item',
      id: 'window-prev',
      label: t('Previous Window'),
      hint: 'Ctrl+Shift+PgUp',
      disabled: windows.length < 2,
      onSelect: () => stepWindow(-1),
    },
    {
      type: 'item',
      id: 'window-next',
      label: t('Next Window'),
      hint: 'Ctrl+Shift+PgDn',
      disabled: windows.length < 2,
      onSelect: () => stepWindow(1),
    },
    { type: 'separator', id: 'window-sep-list' },
    ...windows.map((item, index): BarMenuItem => ({
      type: 'item',
      id: `window-${item.id}`,
      label: item.name,
      checked: item.id === currentWindow.id,
      hint: index < 9 ? `Ctrl+Shift+${index + 1}` : undefined,
      onSelect: () => switchWindow(item.id),
    })),
  ];
  /** Save the Properties dialog: replace the config, keep its place in the tree unless the folder changed. */
  const updateConnection = (updated: ManagedConnection) => {
    setConnections(current => {
      const before = current.find(item => item.id === updated.id);
      if (!before) return current;
      if ((before.folderId ?? null) === (updated.folderId ?? null)) return current.map(item => (item.id === updated.id ? updated : item));
      // Moved to another folder: append it there, like a drop into that folder.
      return [...current.filter(item => item.id !== updated.id), updated];
    });
    if (updated.folderId) revealFolders([updated.folderId]);
    setEditingId(null);
    log(t('{{name}} · properties saved', { name: updated.name }));
  };
  const toggleFavorite = (id: string) =>
    setConnections(current =>
      current.map(connection => (connection.id === id ? { ...connection, favorite: !connection.favorite } : connection)),
    );
  const addConnection = (connection: ManagedConnection, openIt = true) => {
    setConnections(current => [...current, connection]);
    // Show the new session: open its folder and every folder above it.
    const open = new Set<string>();
    for (let at = connection.folderId; at && !open.has(at); at = folders.find(folder => folder.id === at)?.parentId ?? null) open.add(at);
    revealFolders(open);
    if (openIt) openTerminal(connection.id);
    setNewConnectionState(null);
    setSavingAsId(null);
    log(t('{{name}} saved', { name: connection.name }));
  };

  // ---------- Explorer session tree ----------
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
  /** Open folders (and nothing else) so an item shows — in the Explorer panel being used, else in all of them. */
  const revealFolders = (ids: Iterable<string>) => {
    const open = Object.fromEntries([...ids].map(id => [id, false]));
    const panels = explorerPanels();
    setFolds(lastExplorer.current && panels.includes(lastExplorer.current) ? [lastExplorer.current] : panels, () => open);
  };
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
    if (target.kind === 'folder' && target.mode === 'into') revealFolders([target.id]);
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
    if (parentId) revealFolders([parentId]);
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
  const treeMenu = (target: TreeRef | null): MenuItem[] => {
    const into = folderFor(target);
    const add: MenuItem[] = [
      {
        type: 'item',
        id: 'new-session',
        label: t('New session…'),
        icon: 'plus',
        onSelect: () => setNewConnection(target ? into : defaultFolder()),
      },
      {
        type: 'item',
        id: 'new-folder',
        label: t('New folder…'),
        icon: 'folderPlus',
        onSelect: () => setTreeDialog({ kind: 'new-folder', parentId: target ? into : null }),
      },
    ];
    if (!target)
      return [
        ...add,
        { type: 'separator', id: 's1' },
        { type: 'item', id: 'expand', label: t('Expand all'), onSelect: () => setAllFolders(false) },
        { type: 'item', id: 'collapse', label: t('Collapse all'), onSelect: () => setAllFolders(true) },
      ];
    if (target.kind === 'folder') {
      return [
        ...add,
        { type: 'separator', id: 's1' },
        { type: 'item', id: 'duplicate', label: t('Duplicate'), icon: 'copy', onSelect: () => duplicateItem(target) },
        { type: 'item', id: 'rename', label: t('Rename…'), icon: 'rename', onSelect: () => setTreeDialog({ kind: 'rename', target }) },
        { type: 'item', id: 'delete', label: t('Delete…'), icon: 'trash', onSelect: () => setTreeDialog({ kind: 'delete', target }) },
      ];
    }
    const session = connections.find(item => item.id === target.id);
    return [
      {
        type: 'item',
        id: 'open',
        label: t('Open new terminal'),
        icon: 'terminal',
        onSelect: () => {
          openTerminal(target.id);
          log(t('{{v}} · new terminal opened', { v: session?.name ?? 'session' }));
        },
      },
      {
        type: 'item',
        id: 'favorite',
        label: session?.favorite ? t('Remove from favorites') : t('Add to favorites'),
        icon: session?.favorite ? 'starFilled' : 'star',
        onSelect: () => toggleFavorite(target.id),
      },
      { type: 'separator', id: 's1' },
      { type: 'item', id: 'duplicate', label: t('Duplicate'), icon: 'copy', onSelect: () => duplicateItem(target) },
      { type: 'item', id: 'rename', label: t('Rename…'), icon: 'rename', onSelect: () => setTreeDialog({ kind: 'rename', target }) },
      { type: 'item', id: 'delete', label: t('Delete…'), icon: 'trash', onSelect: () => setTreeDialog({ kind: 'delete', target }) },
      { type: 'separator', id: 's2' },
      { type: 'item', id: 'properties', label: t('Properties…'), icon: 'settings', onSelect: () => setEditingId(target.id) },
    ];
  };

  // ---------- menu bar: Session ----------
  /** Save dialog → local file (terminal selection / output); see lib/saveText. */
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
    const others = allTabs.some(item => item.id !== tab.id && item.connectionId === tab.connectionId);
    if (backend.live && !others) void backend.call('connection.disconnect', { connectionId: tab.connectionId }).catch(() => undefined);
    else if (!backend.live && !others)
      setConnections(current => current.map(item => (item.id === tab.connectionId ? { ...item, status: 'offline' } : item)));
  };
  const saveSelection = (tab: TerminalTab) => {
    const text = terminalRegistry.get(tab.id)?.selection() ?? '';
    if (!text.trim()) {
      log(t('Nothing selected in the terminal'));
      return;
    }
    saveText(text, `${fileSafe(terminalTitle(tab))}-selection-${stamp()}.txt`, 'Save Selection As', 'Selection');
  };
  const saveOutput = (tab: TerminalTab) => {
    const text = terminalRegistry.get(tab.id)?.output() ?? '';
    if (!text.trim()) {
      log(t('The terminal has no output yet'));
      return;
    }
    saveText(text, `${fileSafe(terminalTitle(tab))}-${stamp()}.log`, 'Save Output As', 'Terminal output');
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
  /** Title bar ✕ / Exit: save pending config first. The browser usually refuses to close the tab. */
  const quit = async (kind: 'window' | 'exit') => {
    flushConfig();
    try {
      if (!(await closeApp(kind))) log(t('The browser does not let a page close its own tab — close it from the browser'));
    } catch (error) {
      log.error(kind === 'exit' ? t('Cannot exit') : t('Cannot close the window'), error);
    }
  };
  // ---------- window frame ----------
  /** Title of the window (frameless title bar and native title bar alike): active tab — where it runs. */
  const windowTitle = activeTab
    ? `${terminalTitle(activeTab)} — ${
        active.transport === 'ssh'
          ? `${active.username ? `${active.username}@` : ''}${active.host}`
          : active.transport === 'local'
            ? `${active.username ? `${active.username}@` : ''}${active.host || 'localhost'}`
            : describeConnection(active)
      }`
    : t('MetroTerm');
  useEffect(() => {
    document.title = windowTitle;
    void windowFrame.setTitle(windowTitle).catch(() => undefined);
  }, [windowTitle]);
  const minimizeWindow = async () => {
    if (!isDesktop()) {
      log(t('Minimize is only available in the desktop app'));
      return;
    }
    try {
      await windowFrame.minimize();
    } catch (error) {
      log.error(t('Cannot minimize'), error);
    }
  };
  /** Desktop: maximize ⇄ restore (macOS: full-screen Space ⇄ window, like the green button). Browser: full screen ⇄ window. */
  const toggleMaximize = async () => {
    if (!isDesktop()) {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        log(t('Full screen is not available here'));
      }
      window.setTimeout(() => setMaximized(Boolean(document.fullscreenElement)), 100);
      return;
    }
    try {
      const next = await windowFrame.toggleMaximize();
      if (typeof next === 'boolean') setMaximized(next);
      // macOS animates into / out of the full-screen Space: read the state again once it settled.
      if (isMacHost())
        window.setTimeout(() => {
          void windowFrame
            .isMaximized()
            .then(value => typeof value === 'boolean' && setMaximized(value))
            .catch(() => undefined);
        }, 900);
    } catch (error) {
      log.error(t('Cannot maximize'), error);
    }
  };
  /** Frameless title bar: drag the window from any empty part of it (not the buttons); double-click maximizes / restores. */
  const startWindowDrag = (event: React.MouseEvent) => {
    if (event.button !== 0 || event.detail > 1 || (event.target as HTMLElement).closest('button, .window-controls')) return;
    // The move starts only once the pointer really moves: handing the pointer to the window manager
    // on the press itself would swallow the second click of a double-click.
    const x = event.screenX,
      y = event.screenY;
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    const move = (moveEvent: MouseEvent) => {
      if (!(moveEvent.buttons & 1)) {
        stop();
        return;
      }
      if (Math.abs(moveEvent.screenX - x) + Math.abs(moveEvent.screenY - y) < 4) return;
      stop();
      void windowFrame.startDragging().catch(() => undefined);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };

  const zoomedSize = (tabId: string) =>
    Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, terminalPrefs.fontSize + (zoom[tabId] ?? 0)));
  /** Prefs of the zoomed terminals, one stable object each until the zoom or Settings change (TerminalView is memoized). */
  const zoomedPrefs = useMemo(() => {
    const byTab = new Map<string, TerminalPrefs>();
    for (const [tabId, step] of Object.entries(zoom))
      if (step)
        byTab.set(tabId, {
          ...terminalPrefs,
          fontSize: Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, terminalPrefs.fontSize + step)),
        });
    return byTab;
  }, [zoom, terminalPrefs]);
  /** Zoom the active terminal: +1 / -1 px, or 0 = back to the font size from Settings. */
  const zoomActive = (step: 1 | -1 | 0) => {
    const tab = activeTab;
    if (!tab) return;
    const next =
      step === 0 ? terminalPrefs.fontSize : Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, zoomedSize(tab.id) + step));
    setZoom(current => ({ ...current, [tab.id]: next - terminalPrefs.fontSize }));
    log(t('Zoom {{v}}% · {{next}}px', { v: Math.round((next / terminalPrefs.fontSize) * 100), next }));
  };
  const toggleFullScreen = async () => {
    try {
      if (!isDesktop()) {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
        return;
      }
      const next = !(await windowFrame.getState())?.fullscreen;
      await windowFrame.setState({ fullscreen: next });
      setFullScreen(next);
    } catch {
      log(t('Full screen is not available here'));
    }
  };
  const toggleAlwaysOnTop = async () => {
    try {
      const next = !(await windowFrame.getState())?.alwaysOnTop;
      await windowFrame.setState({ alwaysOnTop: next });
      setAlwaysOnTop(next);
      log(next ? t('Always on top') : t('Always on top off'));
    } catch (error) {
      log.error(t('Cannot change always on top'), error);
    }
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
  const modeMenu = (): BarMenuItem[] => [
    {
      type: 'item',
      id: 'full-screen',
      label: t('Full Screen'),
      icon: fullScreen ? 'fullscreenExit' : 'fullscreen',
      hint: 'F11',
      checked: fullScreen,
      onSelect: () => void toggleFullScreen(),
    },
    {
      type: 'item',
      id: 'always-on-top',
      label: t('Always On Top'),
      hint: isDesktop() ? undefined : t('Desktop app'),
      checked: alwaysOnTop,
      disabled: !isDesktop(),
      onSelect: () => void toggleAlwaysOnTop(),
    },
    { type: 'separator', id: 'mode-sep-keys' },
    { type: 'item', id: 'remote-mode', label: t('Remote Mode'), checked: keyMode === 'remote', onSelect: () => setKeyMode('remote') },
    { type: 'item', id: 'local-mode', label: t('Local Mode'), checked: keyMode === 'local', onSelect: () => setKeyMode('local') },
  ];
  const toolMenu = (): BarMenuItem[] => [
    {
      type: 'item',
      id: 'tunnels',
      label: t('Tunnels…'),
      icon: 'tunnel',
      hint: runningTunnels ? t('{{runningTunnels}} running', { runningTunnels }) : undefined,
      onSelect: () => setAppDialog('tunnels'),
    },
    { type: 'item', id: 'triggers', label: t('Triggers…'), hint: 'Coming soon', disabled: true, onSelect: () => undefined },
  ];
  const viewMenu = (): BarMenuItem[] => {
    const size = activeTab ? zoomedSize(activeTab.id) : terminalPrefs.fontSize;
    return [
      {
        type: 'submenu',
        id: 'zoom',
        label: t('Zoom'),
        disabled: !activeTab,
        items: [
          {
            type: 'item',
            id: 'zoom-in',
            label: t('Zoom In'),
            icon: 'zoomIn',
            hint: 'Ctrl+=',
            disabled: size >= FONT_SIZE_RANGE.max,
            onSelect: () => zoomActive(1),
          },
          {
            type: 'item',
            id: 'zoom-out',
            label: t('Zoom Out'),
            icon: 'zoomOut',
            hint: 'Ctrl+-',
            disabled: size <= FONT_SIZE_RANGE.min,
            onSelect: () => zoomActive(-1),
          },
          { type: 'separator', id: 'zoom-sep' },
          {
            type: 'item',
            id: 'zoom-reset',
            label: t('Reset Zoom'),
            disabled: size === terminalPrefs.fontSize,
            onSelect: () => zoomActive(0),
          },
        ],
      },
      { type: 'separator', id: 'view-sep-gutter' },
      {
        type: 'item',
        id: 'show-time',
        label: t('Show Time'),
        checked: terminalPrefs.gutterTime,
        onSelect: () => setTerminalPrefs(prefs => ({ ...prefs, gutterTime: !prefs.gutterTime })),
      },
      {
        type: 'item',
        id: 'show-line',
        label: t('Show Line Number'),
        checked: terminalPrefs.gutterLine,
        onSelect: () => setTerminalPrefs(prefs => ({ ...prefs, gutterLine: !prefs.gutterLine })),
      },
      { type: 'separator', id: 'view-sep-focus' },
      { type: 'item', id: 'focus-mode', label: t('Focus Mode'), hint: 'Ctrl+Shift+F', checked: focusActive, onSelect: toggleFocus },
      { type: 'item', id: 'focus-settings', label: t('Focus Mode Settings…'), onSelect: () => setFocusDialog(true) },
      { type: 'separator', id: 'view-sep-lock' },
      { type: 'item', id: 'lock-screen', label: t('Lock Screen'), icon: 'lock', onSelect: () => lockNow() },
    ];
  };
  const sessionMenu = (): BarMenuItem[] => {
    const tab = activeTab;
    const current = tab ? connectionById.get(tab.connectionId) : undefined;
    const recentSessions = recent.map(id => connectionById.get(id)).filter((item): item is ManagedConnection => Boolean(item));
    return [
      { type: 'item', id: 'new', label: t('New Session…'), icon: 'plus', hint: 'Alt+N', onSelect: () => setNewConnection() },
      {
        type: 'item',
        id: 'duplicate',
        label: t('Duplicate Session'),
        icon: 'copy',
        disabled: !current,
        onSelect: () => current && cloneSession(current.id),
      },
      { type: 'separator', id: 's1' },
      {
        type: 'item',
        id: 'disconnect',
        label: t('Disconnect Session'),
        icon: 'unplug',
        disabled: !tab,
        onSelect: () => tab && disconnectTab(tab),
      },
      {
        type: 'item',
        id: 'reconnect',
        label: t('Reconnect Session'),
        icon: 'refresh',
        disabled: !current,
        onSelect: () => current && reconnect(current.id),
      },
      { type: 'separator', id: 's2' },
      {
        type: 'submenu',
        id: 'recent',
        label: t('Open Recent'),
        icon: 'history',
        disabled: !recentSessions.length,
        items: [
          ...recentSessions.map((item): BarMenuItem => ({
            type: 'item',
            id: `recent-${item.id}`,
            label: item.name,
            icon: transportIcon(item.transport),
            hint: describeConnection(item),
            onSelect: () => openTerminal(item.id),
          })),
          { type: 'separator', id: 'recent-sep' },
          {
            type: 'item',
            id: 'recent-clear',
            label: t('Clear Recent List'),
            onSelect: () => {
              setRecent([]);
              log(t('Recent sessions cleared'));
            },
          },
        ],
      },
      { type: 'separator', id: 's3' },
      {
        type: 'item',
        id: 'save-as',
        label: t('Save Session As…'),
        icon: 'save',
        hint: 'Ctrl+Shift+S',
        disabled: !current,
        onSelect: () => current && setSavingAsId(current.id),
      },
      {
        type: 'item',
        id: 'save-selection',
        label: t('Save Selection As…'),
        icon: 'download',
        disabled: !tab,
        onSelect: () => tab && saveSelection(tab),
      },
      { type: 'separator', id: 's4' },
      {
        type: 'item',
        id: 'proxy',
        label: t('Proxy…'),
        icon: 'proxy',
        hint: proxyActive(proxy) ? describeProxy(proxy) : undefined,
        onSelect: () => setAppDialog('proxy'),
      },
      {
        type: 'submenu',
        id: 'log',
        label: t('Log'),
        icon: 'log',
        items: [
          { type: 'item', id: 'log-settings', label: t('Log Settings…'), icon: 'settings', onSelect: () => setAppDialog('log') },
          {
            type: 'item',
            id: 'log-folder',
            label: t('Open Log Folder'),
            icon: 'folder',
            disabled: !backend.live,
            onSelect: () =>
              void backend
                .call<string>('log.open', logPrefs)
                .then(dir => log(t('Log folder: {{dir}}', { dir })))
                .catch(error => log.error(t('Cannot open the log folder'), error)),
          },
        ],
      },
      {
        type: 'submenu',
        id: 'preferences',
        label: t('Preferences'),
        items: [
          { type: 'item', id: 'settings', label: t('Settings…'), icon: 'settings', onSelect: () => setPreferencesDialog('settings') },
          {
            type: 'item',
            id: 'session-settings',
            label: t('Session Settings…'),
            disabled: !current,
            onSelect: () => current && setEditingId(current.id),
          },
          {
            type: 'item',
            id: 'default-session-settings',
            label: t('Default Session Settings…'),
            onSelect: () => setPreferencesDialog('defaults'),
          },
          { type: 'separator', id: 'pref-sep' },
          {
            type: 'item',
            id: 'profiles-directory',
            label: t('Profiles Directory…'),
            icon: 'folder',
            disabled: !backend.live,
            onSelect: openProfilesDirectory,
          },
        ],
      },
      { type: 'separator', id: 's5' },
      {
        type: 'item',
        id: 'close',
        label: t('Close View'),
        icon: 'close',
        hint: 'Ctrl+Shift+W',
        disabled: !activeTab,
        onSelect: () => activeTab && closeTabs([activeTab.id]),
      },
      {
        type: 'item',
        id: 'close-all',
        label: t('Close All Views'),
        disabled: !terminalTabs.length,
        onSelect: () => closeTabs(terminalTabs.map(item => item.id)),
      },
      { type: 'separator', id: 's6' },
      { type: 'item', id: 'exit', label: t('Exit'), hint: 'Alt+F4', onSelect: () => void quit('exit') },
    ];
  };
  /** Session part of the terminal's right-click menu (the terminal adds copy / paste / clear above it). */
  /** Context-menu entries of a terminal by tab id: one stable function for every TerminalView (advanced-use-latest). */
  const terminalMenuOf = useStableCallback((tabId: string): MenuItem[] => {
    const tab = allTabs.find(item => item.id === tabId);
    return tab ? terminalMenuItems(tab) : [];
  });
  const terminalMenuItems = (tab: TerminalTab): MenuItem[] => {
    const current = connections.find(item => item.id === tab.connectionId);
    const selection = terminalRegistry.get(tab.id)?.selection() ?? '';
    return [
      {
        type: 'item',
        id: 'to-sender',
        label: t('Send Selection to Sender'),
        icon: 'send',
        disabled: !selection.trim() || !canSendToSender(),
        onSelect: () => {
          sendToSender(selection.replace(/\s+$/, ''));
          log(t('Selection added to Sender'));
        },
      },
      {
        type: 'item',
        id: 'save-selection',
        label: t('Save Selection As…'),
        disabled: !selection.trim(),
        onSelect: () => saveSelection(tab),
      },
      { type: 'item', id: 'save-output', label: t('Save Output As…'), icon: 'download', onSelect: () => saveOutput(tab) },
      { type: 'separator', id: 'tm-s1' },
      {
        type: 'item',
        id: 'duplicate',
        label: t('Duplicate Session'),
        disabled: !current,
        onSelect: () => current && cloneSession(current.id),
      },
      {
        type: 'item',
        id: 'reconnect',
        label: t('Reconnect Session'),
        icon: 'refresh',
        disabled: !current,
        onSelect: () => current && reconnect(current.id),
      },
      { type: 'item', id: 'disconnect', label: t('Disconnect Session'), icon: 'unplug', onSelect: () => disconnectTab(tab) },
      ...paneMenuItems(tab),
    ];
  };
  /** tmux part of the terminal's right-click menu: split, and when split zoom / break / close the pane. */
  const paneMenuItems = (tab: TerminalTab): MenuItem[] => {
    const paneId = tmuxPaneOfTab(tab.id);
    const split = tmux.panes.length > 1;
    return [
      { type: 'separator', id: 'tm-panes' },
      {
        type: 'item',
        id: 'split-row',
        label: t('Split Left / Right'),
        icon: 'splitRow',
        hint: 'Ctrl+B %',
        onSelect: () => splitTerminal('row', tab.id),
      },
      {
        type: 'item',
        id: 'split-column',
        label: t('Split Top / Bottom'),
        icon: 'splitColumn',
        hint: 'Ctrl+B "',
        onSelect: () => splitTerminal('column', tab.id),
      },
      {
        type: 'item',
        id: 'break-pane',
        label: t('Move Tab to New Pane'),
        hint: 'Ctrl+B !',
        disabled: tmuxPaneTabs(paneId).length < 2,
        onSelect: () => breakTab(tab.id),
      },
      ...(split
        ? ([
            {
              type: 'item',
              id: 'zoom-pane',
              label: t('Zoom Pane'),
              hint: 'Ctrl+B z',
              checked: Boolean(currentWindow.tmuxZoomed),
              onSelect: () => {
                focusTmuxPane(paneId);
                updateWindow(item => ({ tmuxZoomed: item.tmuxZoomed ? undefined : true }));
              },
            },
            {
              type: 'item',
              id: 'close-pane',
              label: t('Close Pane'),
              hint: 'Ctrl+B x',
              onSelect: () => closeTmuxPane(paneId),
            },
          ] as MenuItem[])
        : []),
    ];
  };
  /**
   * tmux key bindings (Local Mode, keyboard in a terminal): Ctrl+B, then a key. `prefix` is
   * shown in the status bar while MetroTerm waits for that key.
   */
  const [prefix, setPrefix] = useState(false);
  const prefixRef = useRef(false);
  const setPrefixOn = (on: boolean) => {
    prefixRef.current = on;
    setPrefix(on);
  };
  /** Handle the key after Ctrl+B. Returns false for keys that aren't bound (they are swallowed, like tmux). */
  const tmuxCommand = (event: KeyboardEvent): boolean => {
    const tab = activeTab;
    if (!tab) return false;
    const paneId = tmuxPaneOfTab(tab.id);
    const split = tmux.panes.length > 1;
    const key = event.key;
    const arrow = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const;
    const toward = arrow[key as keyof typeof arrow];
    if (toward && (event.ctrlKey || event.altKey)) {
      // resize-pane: Ctrl+arrow by a small step, Alt+arrow by a larger one.
      if (split) updateTmux(tree => tmuxResize(tree, paneId, toward, event.altKey ? 0.1 : 0.03));
      return true;
    }
    if (event.ctrlKey && event.code === 'KeyB') {
      // Ctrl+B Ctrl+B: send Ctrl+B itself to the terminal.
      terminalRegistry.write(tab.id, '\u0002');
      return true;
    }
    if (toward) {
      const next = split ? tmuxToward(tmuxTree, paneId, toward) : null;
      if (next) focusTmuxPane(next);
      return true;
    }
    const ids = tmux.panes.map(pane => pane.id);
    const at = ids.indexOf(paneId);
    // Tabs of the focused pane (its tab bar).
    const own = tmuxPaneTabs(paneId);
    switch (key) {
      case '%':
        splitTerminal('row');
        return true;
      case '"':
        splitTerminal('column');
        return true;
      case 'o':
        if (split) focusTmuxPane(ids[(at + 1) % ids.length]);
        return true;
      case ';':
        if (split) focusTmuxPane(ids[(at - 1 + ids.length) % ids.length]);
        return true;
      case 'x':
        closeTmuxPane(paneId);
        return true;
      case 'z':
        if (split) updateWindow(item => ({ tmuxZoomed: item.tmuxZoomed ? undefined : true }));
        return true;
      case '!':
        breakTab(tab.id);
        return true;
      case '{':
      case '}':
        if (split) {
          const other = ids[(at + (key === '{' ? -1 : 1) + ids.length) % ids.length];
          updateTmux(tree => tmuxSwap(tree, paneId, other));
        }
        return true;
      case 'c':
        openTerminal(tab.connectionId, paneId);
        return true;
      case 'n':
      case 'p': {
        const index = own.findIndex(item => item.id === tab.id);
        const next = own[(index + (key === 'n' ? 1 : -1) + own.length) % own.length];
        if (next) activateTerminal(next);
        return true;
      }
      case '&':
        closeTabs([tab.id]);
        return true;
      case ',':
        setBarRename({ id: tab.id, value: terminalTitle(tab) });
        return true;
      default:
        if (/^[0-9]$/.test(key)) {
          const target = own[Number(key)];
          if (target) activateTerminal(target);
          return true;
        }
        return false;
    }
  };
  const menuBar: BarMenu[] = [
    { id: 'session', label: t('Session'), items: sessionMenu() },
    { id: 'view', label: t('View'), items: viewMenu() },
    { id: 'mode', label: t('Mode'), items: modeMenu() },
    { id: 'tool', label: t('Tool'), items: toolMenu() },
    { id: 'window', label: t('Window'), items: windowMenu() },
    {
      id: 'help',
      label: t('Help'),
      items: [
        { type: 'item', id: 'about', label: t('About MetroTerm…'), icon: 'info', onSelect: () => setAppDialog('about') },
        { type: 'separator', id: 'help-sep' },
        {
          type: 'item',
          id: 'version',
          label: t('MetroTerm {{APP_VERSION}}', { APP_VERSION }),
          hint: 'Version',
          disabled: true,
          onSelect: () => undefined,
        },
      ],
    },
  ];
  // Session menu shortcuts. Capture phase, so they win over the terminal (like WindTerm's Alt+N / Alt+O).
  const shortcutRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  shortcutRef.current = event => {
    if (lockedRef.current) return false; // the lock screen takes every key
    // Remote Mode: keys typed in a terminal are not MetroTerm shortcuts, they all go to the remote side.
    const inTerminal = Boolean((event.target as Element | null)?.closest?.('.xterm'));
    if (terminalPrefs.keyMode === 'remote' && inTerminal) return false;
    // tmux prefix Ctrl+B in a terminal, then the command key (Esc cancels).
    if (prefixRef.current) {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'].includes(event.key) || event.isComposing) return false;
      setPrefixOn(false);
      if (event.key !== 'Escape') tmuxCommand(event);
      return true;
    }
    if (inTerminal && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyB') {
      setPrefixOn(true);
      return true;
    }
    // Focus Mode on / off (also while a dialog is open is not needed: the dialog has its own OK).
    if (
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.code === 'KeyF' &&
      !document.querySelector('.modal-backdrop:not(.is-leaving), .file-dialog')
    ) {
      toggleFocus();
      return true;
    }
    // Menu search: Ctrl+Shift+P opens / closes it; while it is open its keys are its own.
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyP') {
      if (!document.querySelector('.modal-backdrop:not(.is-leaving), .file-dialog')) setPaletteOpen(open => !open);
      return true;
    }
    if ((event.target as Element | null)?.closest?.('.command-palette')) return false;
    if (event.metaKey || document.querySelector('.modal-backdrop:not(.is-leaving), .file-dialog')) return false;
    const plainAlt = event.altKey && !event.ctrlKey && !event.shiftKey;
    if (event.code === 'F11' && !event.altKey && !event.ctrlKey && !event.shiftKey) {
      void toggleFullScreen();
      return true;
    }
    if (plainAlt && event.code === 'KeyN') {
      setNewConnection();
      return true;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyS') {
      if (activeTab) setSavingAsId(activeTab.connectionId);
      return true;
    }
    // View → Zoom: Ctrl+= (also Ctrl++ / numpad +) and Ctrl+- on the active terminal, instead of the browser's page zoom.
    if (event.ctrlKey && !event.altKey && (event.code === 'Equal' || event.code === 'NumpadAdd')) {
      zoomActive(1);
      return true;
    }
    if (event.ctrlKey && !event.altKey && !event.shiftKey && (event.code === 'Minus' || event.code === 'NumpadSubtract')) {
      zoomActive(-1);
      return true;
    }
    // Window menu: Ctrl+Shift+1…9 shows a window, Ctrl+Shift+PgUp / PgDn the previous / next one.
    if (event.ctrlKey && event.shiftKey && !event.altKey && /^Digit[1-9]$/.test(event.code)) {
      const target = windows[Number(event.code.slice(5)) - 1];
      if (target) switchWindow(target.id);
      return true;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && (event.code === 'PageUp' || event.code === 'PageDown')) {
      stepWindow(event.code === 'PageUp' ? -1 : 1);
      return true;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyW') {
      if (activeTab) closeTabs([activeTab.id]);
      return true;
    }
    // Alt+F4 normally reaches the window manager first; handled here for desktops where it doesn't.
    if (plainAlt && event.code === 'F4' && isDesktop()) {
      void quit('exit');
      return true;
    }
    return false;
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.type === 'keydown' && shortcutRef.current(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------- dynamic panel layout ----------
  type ContentView = Exclude<LeafView, 'terminal'>;
  const panelLabel = (view: ContentView) =>
    view === 'empty' ? t('Empty') : t(PANEL_VIEWS.find(item => item.view === view)?.label ?? view);
  const panelMenu = (leaf: LeafNode & { view: ContentView }): MenuItem[] => [
    {
      type: 'item',
      id: 'split',
      label: t('Split'),
      icon: 'layout',
      onSelect: () => {
        // Only split when both halves can be at least MIN_PANEL_SIZE; otherwise the new half would be hidden at once.
        const box = document.querySelector(`[data-panel="${leaf.id}"]`)?.getBoundingClientRect();
        const size = box ? (splitDirectionFor(leaf.view) === 'horizontal' ? box.width : box.height) : Infinity;
        if (size < MIN_PANEL_SIZE * 2 + SPLITTER_SIZE) {
          log(t('Not enough space to split this panel (needs {{v}}px)', { v: MIN_PANEL_SIZE * 2 + SPLITTER_SIZE }));
          return;
        }
        setLayout(current => splitLeaf(current, leaf.id));
        log(t('{{v}} panel split', { v: panelLabel(leaf.view) }));
      },
    },
    { type: 'separator', id: 'sep' },
    ...PANEL_VIEWS.map(({ view: panelView, label }): MenuItem => ({
      type: 'item',
      id: panelView,
      label: t(label),
      checked: tabsOf(leaf).includes(panelView),
      onSelect: () => openPanelTab(leaf, panelView),
    })),
  ];
  /** Settings → view: open it as a tab in this panel; already open → ignored (just shown). */
  const openPanelTab = (leaf: LeafNode, panelView: PanelView) => {
    const already = tabsOf(leaf).includes(panelView);
    setLayout(current => openTab(current, leaf.id, panelView));
    log(
      already
        ? t('{{v}} is already open in this panel', { v: panelLabel(panelView) })
        : t('{{v}} opened in panel', { v: panelLabel(panelView) }),
    );
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
  /** Drag a panel tab: reorder it, or drop it on another panel's tab bar to move it there. */
  const startPanelTabDrag = (event: React.PointerEvent<HTMLElement>, fromId: string, view: PanelView) =>
    startTabDrag(event, {
      group: 'panel',
      key: view,
      strip: fromId,
      label: panelLabel(view),
      canDrop: ({ strip }) => {
        const target = leaves.find(item => item.id === strip);
        return !!target && !tabsOf(target).includes(view);
      },
      onDrop: ({ strip, before }) => {
        setLayout(current => moveTab(current, fromId, view, strip, before as PanelView | null));
        if (strip !== fromId) log(t('{{v}} moved to another panel', { v: panelLabel(view) }));
      },
    });
  const panelHeader = (leaf: LeafNode & { view: ContentView }) => (
    <div className="pane-title">
      <div className="pane-tabs" role="tablist" data-tab-strip={leaf.id} data-tab-group="panel">
        {tabsOf(leaf).length ? (
          tabsOf(leaf).map(tab => (
            <button
              key={tab}
              role="tab"
              aria-selected={tab === leaf.view}
              className={tab === leaf.view ? 'pane-tab active' : 'pane-tab'}
              data-tab-key={tab}
              onClick={() => setLayout(current => activateTab(current, leaf.id, tab))}
              onPointerDown={event => startPanelTabDrag(event, leaf.id, tab)}
            >
              <i className="pane-swatch" aria-hidden="true" style={{ background: swatches[tab] }} />
              <span>{panelLabel(tab)}</span>
              <b
                title={t('Close tab')}
                data-tab-close
                onClick={event => {
                  event.stopPropagation();
                  setLayout(current => closeTab(current, leaf.id, tab));
                  log(t('{{v}} tab closed', { v: panelLabel(tab) }));
                }}
              >
                <Icon name="close" size={12} />
              </b>
            </button>
          ))
        ) : (
          <span className="pane-title-empty">{t('Empty')}</span>
        )}
      </div>
      <div className="pane-actions">
        <MenuButton title={t('Settings')} items={panelMenu(leaf)}>
          <Icon name="settings" />
        </MenuButton>
        <button
          title={t('Close panel')}
          onClick={() => {
            setLayout(current => closeNode(current, leaf.id));
            log(t('{{v}} panel closed', { v: panelLabel(leaf.view) }));
          }}
        >
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
  const panelBody = (leaf: LeafNode & { view: ContentView }, shown?: FocusLeaf, ctx?: WindowCtx) => {
    // Focus Mode: tabs it hides stay mounted (hidden), tabs it adds are mounted too.
    const tabs = shown ? [...tabsOf(leaf), ...shown.tabs.filter(tab => !tabsOf(leaf).includes(tab))] : tabsOf(leaf);
    const active = shown ? shown.view : leaf.view;
    if (!tabs.length)
      return (
        <div className="panel-empty">
          <span>{t('Empty panel')}</span>
          <div>
            {PANEL_VIEWS.map(({ view: panelView, label }) => (
              <button key={panelView} onClick={() => openPanelTab(leaf, panelView)}>
                {t(label)}
              </button>
            ))}
          </div>
        </div>
      );
    // Every open tab stays mounted (hidden when inactive) so its state survives tab switches.
    return (
      <>
        {tabs.map(tab => (
          <div
            key={tab}
            className={`pane-tab-body ${panelClass[tab]}`}
            hidden={tab !== active}
            onPointerDownCapture={
              tab === 'explorer'
                ? () => {
                    lastExplorer.current = leaf.id;
                  }
                : undefined
            }
          >
            {viewBody(tab, leaf.id, ctx)}
          </div>
        ))}
      </>
    );
  };
  /** What the panels of a window show: its terminal tabs and the session of its selected tab. */
  type WindowCtx = {
    terminalTabs: TerminalTab[];
    activeTabId: string | null;
    activeTab: TerminalTab | undefined;
    active: ManagedConnection;
  };
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
  const viewBody = (view: PanelView, panel: string, ctx?: WindowCtx) => {
    const { terminalTabs, activeTabId, activeTab, active } = ctx ?? {
      terminalTabs: shownTabs,
      activeTabId: shownTabId,
      activeTab: shownTab,
      active: shownActive,
    };
    if (view === 'explorer')
      return (
        <>
          <div className="session-quickbar">
            <input
              className="session-filter"
              value={filters[panel] ?? ''}
              onChange={event => {
                const text = event.target.value;
                setFilters(current => ({ ...current, [panel]: text }));
              }}
              placeholder={t('Filter sessions')}
              aria-label={t('Filter sessions')}
            />
            <button onClick={() => setNewConnection()} title={t('New session')}>
              <Icon name="plus" />
              <span>{t('NEW')}</span>
            </button>
          </div>
          <SessionTree
            folders={folders.map(folder =>
              isCollapsedIn(panel, folder) === Boolean(folder.collapsed) ? folder : { ...folder, collapsed: !folder.collapsed },
            )}
            sessions={connections}
            filter={filters[panel] ?? ''}
            isMissing={missingShell}
            onOpen={id => {
              openTerminal(id);
              log(t('{{v}} · new terminal opened', { v: connections.find(item => item.id === id)?.name ?? 'session' }));
            }}
            onToggleFolder={id => toggleFolder(panel, id)}
            onToggleFavorite={toggleFavorite}
            onMove={moveTreeItem}
            menuFor={treeMenu}
          />
        </>
      );
    if (view === 'filer')
      return hasFiles(active.transport) ? (
        <Filer connection={active} terminalTabId={activeTab?.id ?? null} />
      ) : (
        <div className="panel-empty">
          <span>
            {t('{{name}} is a {{type}} session — no file system to browse. The Filer works with local and SSH sessions.', {
              name: active.name,
              type: transportName(active.transport),
            })}
          </span>
        </div>
      );
    if (view === 'monitor') return <MonitorPanel connection={active} />;
    if (view === 'sessions')
      return (
        <SessionsPanel
          activeId={activeTabId}
          onActivate={id => {
            const tab = terminalTabs.find(item => item.id === id);
            if (tab) activateTerminal(tab);
          }}
          onRename={renameTab}
          onDragStart={startTerminalTabDrag}
          menuFor={tabMenuItems}
          renameRequest={null}
          tabs={terminalTabs.flatMap(tab => {
            const connection = connectionById.get(tab.connectionId);
            if (!connection) return [];
            return [
              {
                id: tab.id,
                title: terminalTitle(tab),
                defaultTitle: defaultTitle(tab),
                renamed: Boolean(tab.title),
                transport: connection.transport,
                status: connection.status,
                detail:
                  connection.transport === 'local'
                    ? t('local · {{v}}', { v: connection.shell || '$SHELL' })
                    : describeConnection(connection),
                folder: folderPath(folders, connection.folderId),
              },
            ];
          })}
        />
      );
    return (
      <SenderBody
        active={active}
        activeTabId={activeTab?.id ?? null}
        terminalTabs={terminalTabs}
        connections={connections}
        tabTitle={terminalTitle}
      />
    );
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
  /** tmux panes on screen: rects (fractions of the stage); zoomed = the focused pane only. */
  const tmuxZoomed = Boolean(currentWindow.tmuxZoomed) && tmux.panes.length > 1;
  const tmuxShown = tmuxZoomed ? null : tmux.panes.length > 1 ? tmuxLayout(tmuxTree) : null;
  const tmuxRectOf = (paneId: string): Rect | undefined =>
    tmuxShown ? tmuxShown.rects.get(paneId) : !tmuxZoomed || paneId === tmux.focus ? FULL_RECT : undefined;
  /** Shown tab → its pane (tabs of the shown window that are on screen). */
  const tmuxShownTabs = new Map(
    tmux.panes.filter(pane => pane.active && tmuxRectOf(pane.id)).map(pane => [pane.active!.id, pane.id] as const),
  );
  const tmuxStageRef = useRef<HTMLDivElement>(null);
  /** Body box of every pane (below its tab bar and toolbar), where its shown terminal is placed. */
  const [tmuxBodies, setTmuxBodies] = useState<Record<string, TmuxBox>>({});
  const tmuxBodiesRef = useRef(tmuxBodies);
  const measureTmux = useCallback(() => {
    const stage = tmuxStageRef.current;
    if (!stage || !stage.offsetWidth) return;
    const next: Record<string, TmuxBox> = {};
    // Exact (fractional) edges, rounded *inwards* to whole pixels. offsetLeft / offsetWidth round each
    // value on its own, so at some split ratios a terminal grew half a pixel past its pane on each side
    // and its opaque background covered the 1px gap that is the divider line — the line vanished.
    // Inwards, a terminal never reaches the gap; the sliver it may leave shows the pane's own
    // background, which is the terminal colour.
    const origin = stage.getBoundingClientRect();
    for (const body of stage.querySelectorAll<HTMLElement>('[data-tmux-body]')) {
      const frame = body.offsetParent as HTMLElement | null;
      if (!frame || frame.parentElement !== stage) continue;
      const box = body.getBoundingClientRect();
      const x = Math.ceil(box.left - origin.left - 0.001);
      const y = Math.ceil(box.top - origin.top - 0.001);
      next[body.dataset.tmuxBody!] = {
        x,
        y,
        w: Math.max(0, Math.floor(box.right - origin.left + 0.001) - x),
        h: Math.max(0, Math.floor(box.bottom - origin.top + 0.001) - y),
      };
    }
    // Only a real change re-renders (this runs after every render).
    if (sameBoxes(tmuxBodiesRef.current, next)) return;
    tmuxBodiesRef.current = next;
    setTmuxBodies(next);
  }, []);
  useLayoutEffect(measureTmux);
  useEffect(() => {
    const stage = tmuxStageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => measureTmux());
    observer.observe(stage);
    stage.querySelectorAll('[data-tmux-body]').forEach(body => observer.observe(body));
    return () => observer.disconnect();
  });
  /**
   * Drag a tmux splitter: the ratio follows the pointer inside the split's box. The handle has no look of its own,
   * only the resize cursor, kept on the whole page while dragging (a class on <html>). Pointer moves are coalesced
   * to one layout update per frame (rerender-use-ref-transient-values: the pending position is not state).
   */
  const startTmuxDrag = (event: React.PointerEvent<HTMLDivElement>, splitter: TmuxSplitter) => {
    const stage = tmuxStageRef.current?.getBoundingClientRect();
    if (!stage || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const root = document.documentElement;
    const resizing = splitter.dir === 'row' ? 'is-tmux-resizing-row' : 'is-tmux-resizing-column';
    root.classList.add(resizing);
    let pending: PointerEvent | null = null;
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (!pending) return;
      const ratio =
        splitter.dir === 'row'
          ? ((pending.clientX - stage.left) / stage.width - splitter.box.x) / splitter.box.w
          : ((pending.clientY - stage.top) / stage.height - splitter.box.y) / splitter.box.h;
      pending = null;
      updateTmux(tree => tmuxSetRatio(tree, splitter.path, ratio));
    };
    const move = (moveEvent: PointerEvent) => {
      pending = moveEvent;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const end = () => {
      if (frame) cancelAnimationFrame(frame);
      apply();
      root.classList.remove(resizing);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  /** One tab of a pane's tab bar. */
  const tmuxTabButton = (tab: TerminalTab, paneId: string, shown: boolean) => {
    const connection = connectionById.get(tab.connectionId);
    if (!connection) return null;
    return (
      <button
        key={tab.id}
        className={`${shown ? 'session-tab active' : 'session-tab'}${barRename?.id === tab.id ? ' is-editing' : ''}`}
        data-tab-key={tab.id}
        onClick={() => activateTerminal(tab)}
        onPointerDown={event => startTerminalTabDrag(event, `tmux:${paneId}`, tab.id, terminalTitle(tab))}
        onDoubleClick={() => setBarRename({ id: tab.id, value: terminalTitle(tab) })}
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          activateTerminal(tab);
          setTabMenu({ id: tab.id, x: event.clientX, y: event.clientY });
        }}
      >
        <i>
          <Icon name={transportIcon(connection.transport)} />
        </i>
        {barRename?.id === tab.id ? (
          <input
            className="session-tab-input"
            autoFocus
            onFocus={event => event.currentTarget.select()}
            value={barRename.value}
            placeholder={defaultTitle(tab)}
            spellCheck={false}
            aria-label="Tab name"
            size={Math.max(6, barRename.value.length + 1)}
            onChange={event => setBarRename({ id: tab.id, value: event.target.value })}
            onClick={event => event.stopPropagation()}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitBarRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setBarRename(null);
              } else if (event.key === ' ') {
                event.stopPropagation();
              }
            }}
            onBlur={commitBarRename}
          />
        ) : (
          <span>{terminalTitle(tab)}</span>
        )}
        <em className={connection.status} />
        <b title={t('Close')} data-tab-close onClick={event => closeSession(tab.id, event)}>
          <Icon name="close" size={12} />
        </b>
      </button>
    );
  };
  /** A pane's ⋮ menu (split / zoom / close; time and line numbers are in the View menu). */
  const tmuxPaneMenu = (pane: { id: string; active: TerminalTab | undefined; tabs: TerminalTab[] }): MenuItem[] => {
    const split = tmux.panes.length > 1;
    return [
      {
        type: 'item',
        id: 'pane-split-row',
        label: t('Split Left / Right'),
        icon: 'splitRow',
        hint: 'Ctrl+B %',
        disabled: !pane.active,
        onSelect: () => pane.active && splitTerminal('row', pane.active.id),
      },
      {
        type: 'item',
        id: 'pane-split-column',
        label: t('Split Top / Bottom'),
        icon: 'splitColumn',
        hint: 'Ctrl+B "',
        disabled: !pane.active,
        onSelect: () => pane.active && splitTerminal('column', pane.active.id),
      },
      ...(split
        ? ([
            {
              type: 'item',
              id: 'pane-zoom',
              label: t('Zoom Pane'),
              hint: 'Ctrl+B z',
              checked: tmuxZoomed,
              onSelect: () => {
                focusTmuxPane(pane.id);
                updateWindow(item => ({ tmuxZoomed: item.tmuxZoomed ? undefined : true }));
              },
            },
            { type: 'separator', id: 'pane-sep-close' },
            { type: 'item', id: 'pane-close', label: t('Close Pane'), hint: 'Ctrl+B x', onSelect: () => closeTmuxPane(pane.id) },
          ] as MenuItem[])
        : ([
            { type: 'separator', id: 'pane-sep-close' },
            {
              type: 'item',
              id: 'pane-close-all',
              label: t('Close all tabs'),
              disabled: !pane.tabs.length,
              onSelect: () => closeTabs(pane.tabs.map(item => item.id)),
            },
          ] as MenuItem[])),
    ];
  };
  /** A pane's toolbar: actions and breadcrumb of the tab it shows; on the right the pane letter (split only), favorite and the ⋮ pane menu. */
  const tmuxToolbar = (pane: TmuxPaneView & { active: TerminalTab }) => {
    const tab = pane.active;
    const connection = connectionById.get(tab.connectionId) ?? active;
    return (
      <div className="terminal-toolbar" hidden={focusActive && focusConfig.bars.tool === 'hide'}>
        <div className="toolbar-icons">
          <button
            className={terminalFull ? 'is-on' : undefined}
            aria-pressed={terminalFull}
            aria-label={t('Fullscreen')}
            title={terminalFull ? t('Exit fullscreen — show the other panels again') : t('Fullscreen — hide all other panels')}
            onClick={() => (terminalFull ? leaveTerminalFull() : enterTerminalFull(pane.id))}
          >
            <Icon name={terminalFull ? 'fullscreenExit' : 'fullscreen'} />
          </button>
          <button title={t('Find (Ctrl+F)')} aria-label={t('Find')} onClick={() => terminalRegistry.get(tab.id)?.find()}>
            <Icon name="search" />
          </button>
          <i />
          <button title={t('Clone session')} onClick={() => cloneSession(connection.id)}>
            <Icon name="copy" />
          </button>
          <button onClick={() => reconnect(connection.id)} title={t('Reconnect')}>
            <Icon name="refresh" />
          </button>
        </div>
        <div className="terminal-breadcrumb">
          {folderPath(folders, connection.folderId)
            .split(' / ')
            .filter(Boolean)
            .map((name, index) => (
              <Fragment key={index}>
                <span>{name}</span>
                <b>
                  <Icon name="chevronRight" size={12} />
                </b>
              </Fragment>
            ))}
          <strong>{connection.name}</strong>
          <em className={connection.status} />
        </div>
        <div className="toolbar-right">
          {tmux.panes.length > 1 && (
            <PaneLetter letter={pane.letter} focused={pane.id === tmux.focus} title={t('Pane {{v}}', { v: pane.letter })} />
          )}
          <button title={t('Favorite')} onClick={() => toggleFavorite(connection.id)}>
            <Icon name={connection.favorite ? 'starFilled' : 'star'} />
          </button>
          <MenuButton title={t('Pane menu')} className="tmux-pane-menu" items={tmuxPaneMenu(pane)}>
            <Icon name="kebab" size={16} />
          </MenuButton>
        </div>
      </div>
    );
  };
  const renderLeaf = (node: LeafNode, ctx?: WindowCtx): React.ReactNode => {
    if (node.view === 'terminal')
      return (
        <section className="panel terminal-main">
          {/* tmux panes: each one is a tab group with its own tab bar and toolbar. All terminals (of every window) stay
              mounted in the stage, each placed over its pane's body while it is that pane's shown tab, hidden otherwise. */}
          <div className={`terminal-stage tmux-stage${tmux.panes.length > 1 ? ' is-split' : ''}`} ref={tmuxStageRef}>
            {tmux.panes.map(pane => {
              const rect = tmuxRectOf(pane.id);
              const focused = pane.id === tmux.focus;
              return (
                <div
                  key={pane.id}
                  className={`tmux-pane${focused ? ' is-focused' : ''}`}
                  data-tmux-pane={pane.id}
                  hidden={!rect}
                  style={rect ? tmuxStyle(rect) : undefined}
                  onPointerDownCapture={focused ? undefined : () => focusTmuxPane(pane.id)}
                >
                  <div className="tab-bar">
                    <div className="session-tabs" data-tab-strip={`tmux:${pane.id}`} data-tab-group="terminal">
                      {pane.tabs.map(tab => tmuxTabButton(tab, pane.id, tab.id === pane.active?.id))}
                    </div>
                  </div>
                  {pane.active && tmuxToolbar({ ...pane, active: pane.active })}
                  <div className="tmux-body" data-tmux-body={pane.id}>
                    {!pane.active && (
                      <div className="terminal-empty">
                        <b>{t('No open tabs')}</b>
                        <span>{t('Double-click a session in Explorer to open a terminal.')}</span>
                        <div>
                          <button onClick={() => setNewConnection()}>
                            <Icon name="plus" />
                            <span>{t('New session')}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {terminalStack.map(tab => {
              const connection = connectionById.get(tab.connectionId);
              if (!connection) return null;
              const paneId = tmuxShownTabs.get(tab.id);
              const box = paneId ? tmuxBodies[paneId] : undefined;
              const focused = tab.id === activeTab?.id;
              return (
                <div
                  key={tab.id}
                  className="terminal-instance"
                  data-tab={tab.id}
                  hidden={!box}
                  style={box ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined}
                  onPointerDownCapture={paneId && !focused ? () => activateTerminal(tab) : undefined}
                >
                  <TerminalView
                    tabId={tab.id}
                    connection={connection}
                    theme={theme}
                    reconnectToken={epochs[connection.id] ?? 0}
                    active={focused}
                    menuItems={terminalMenuOf}
                    onCursor={onCursor}
                    prefs={zoomedPrefs.get(tab.id) ?? terminalPrefs}
                  />
                </div>
              );
            })}
            {tmuxShown?.splitters.map(splitter => (
              <div
                key={`split-${splitter.path}`}
                className={`tmux-splitter ${splitter.dir === 'row' ? 'is-row' : 'is-column'}`}
                style={tmuxSplitterStyle(splitter)}
                onPointerDown={event => startTmuxDrag(event, splitter)}
              />
            ))}
          </div>
        </section>
      );
    const leaf = node as LeafNode & { view: ContentView };
    const shown = ctx ? undefined : focusPanes?.leaves.get(leaf.id);
    const headerLeaf = shown ? { ...leaf, tabs: shown.tabs, view: shown.view as ContentView } : leaf;
    return (
      <section key={leaf.id} className={`panel content-pane${tabsOf(headerLeaf).length ? '' : ' empty-pane'}`} data-panel={leaf.id}>
        {panelHeader(headerLeaf)}
        {panelBody(leaf, shown, ctx)}
      </section>
    );
  };

  return (
    <main
      className={`metroterm-shell ${theme === 'gold' ? 'dark gold' : theme}`}
      style={
        appearance.uiFontFamily
          ? ({ '--ui-font-family': withFallback(appearance.uiFontFamily, UI_FONT_STACK) } as React.CSSProperties)
          : undefined
      }
    >
      {/* Desktop only: in a browser the page already sits in the browser's own window and tab. */}
      {isDesktop() && titleBar === 'frameless' && !focusActive && (
        <header
          className="window-chrome"
          onMouseDown={startWindowDrag}
          onDoubleClick={event => {
            if (!(event.target as HTMLElement).closest('.window-controls')) void toggleMaximize();
          }}
        >
          <div className="app-mark" />
          <div className="window-name">{windowTitle}</div>
          <div className="window-controls">
            <button title={t('Minimize')} onClick={() => void minimizeWindow()}>
              <Icon name="minimize" />
            </button>
            <button
              title={isMacHost() ? (maximized ? t('Exit Full Screen') : t('Full Screen')) : maximized ? t('Restore') : t('Maximize')}
              onClick={() => void toggleMaximize()}
            >
              <Icon name={maximized ? 'restore' : 'maximize'} size={12} />
            </button>
            <button className="window-close" title={t('Close')} onClick={() => void quit('window')}>
              <Icon name="close" />
            </button>
          </div>
        </header>
      )}
      <nav className="menu-bar" hidden={focusActive && focusConfig.bars.menu === 'hide'}>
        <MenuBar menus={menuBar} />
        <div className="menu-tools">
          <button
            className={paletteOpen ? 'selected' : undefined}
            data-palette-toggle
            aria-label={t('Search menus')}
            title={t('Search menus (Ctrl+Shift+P)')}
            onPointerEnter={() => void loadCommandPalette()}
            onFocus={() => void loadCommandPalette()}
            // pointerdown (like the menu titles) so the terminal keeps focus and gets it back on Esc.
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.preventDefault();
              setPaletteOpen(open => !open);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setPaletteOpen(open => !open);
              }
            }}
          >
            <Icon name="search" />
          </button>
          <button
            className={appDialog === 'tunnels' ? 'selected' : undefined}
            title={runningTunnels ? t('SSH tunnels — {{runningTunnels}} running', { runningTunnels }) : t('SSH tunnels (port forwarding)')}
            onClick={() => setAppDialog(current => (current === 'tunnels' ? null : 'tunnels'))}
          >
            <Icon name="tunnel" />
            <span>{t('Tunnels')}</span>
            {runningTunnels ? <em className="menu-tools-count">{runningTunnels}</em> : null}
          </button>
          <button
            className={focusActive ? 'is-on' : undefined}
            aria-pressed={focusActive}
            aria-label={t('Focus Mode')}
            title={focusActive ? t('Leave Focus Mode (Ctrl+Shift+F)') : t('Focus Mode (Ctrl+Shift+F)')}
            onClick={toggleFocus}
          >
            <Icon name="focus" />
            <span>{t('Focus Mode')}</span>
          </button>
        </div>
      </nav>
      {focusActive && focusConfig.bars.menu === 'hide' && (
        <div className="focus-exit-zone">
          <button onClick={exitFocus} title="Ctrl+Shift+F">
            <Icon name="focus" />
            <span>{t('Exit Focus Mode')}</span>
            <small>Ctrl+Shift+F</small>
          </button>
        </div>
      )}

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
      <footer className="status-bar" hidden={focusActive && focusConfig.bars.status === 'hide'}>
        <span>
          <i>
            <Icon name="activity" />
          </i>
        </span>
        <span>{activity === 'Ready' ? t('Ready') : activity}</span>
        <span className="status-spacer" />
        {/* Window menu: the windows, click to show one (double-click renames, right-click opens its menu, + opens a new one). Hidden with one window. */}
        <div className="status-windows" role="tablist" aria-label={t('Windows')} hidden={windows.length < 2}>
          {windows.map((item, index) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={item.id === currentWindow.id}
              className={item.id === currentWindow.id ? 'status-window is-active' : 'status-window'}
              title={`${item.name} — ${allTabs.filter(tab => tab.windowId === item.id).length} tab(s)${index < 9 ? ` · Ctrl+Shift+${index + 1}` : ''}`}
              onClick={() => switchWindow(item.id)}
              onDoubleClick={() => setWindowDialog({ kind: 'rename', id: item.id })}
              onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                setStatusWindowMenu({ id: item.id, x: event.clientX, y: event.clientY });
              }}
            >
              {item.name}
            </button>
          ))}
          <button className="status-window-new" aria-label={t('New Window')} title={t('New Window')} onClick={newWindow}>
            <Icon name="plus" size={12} />
          </button>
        </div>
        {prefix && (
          <em className="status-prefix" title={t('tmux prefix: press a key (Esc cancels)')}>
            Ctrl+B
          </em>
        )}
        {terminalTabOpen && cursorInfo && cursorInfo.tabId === activeTab?.id && (
          <>
            <span>{t('Window {{cols}}×{{rows}}', { cols: cursorInfo.cols, rows: cursorInfo.rows })}</span>
            <span>
              Ln {cursorInfo.line}, Ch {cursorInfo.column}
            </span>
          </>
        )}
        <button
          className="status-mode"
          title={`${keyMode === 'remote' ? 'Remote Mode: keys in the terminal go to the remote side' : 'Local Mode: MetroTerm shortcuts work in the terminal'} — click for ${keyMode === 'remote' ? 'Local' : 'Remote'} Mode`}
          onClick={() => setKeyMode(keyMode === 'remote' ? 'local' : 'remote')}
        >
          {keyMode === 'remote' ? t('Remote Mode') : t('Local Mode')}
        </button>
        <button
          className="status-lock"
          aria-label={t('Lock Screen')}
          title={
            lockSettings.idleMinutes
              ? t('Lock the screen (auto lock after {{idleMinutes}} min idle)', { idleMinutes: lockSettings.idleMinutes })
              : t('Lock the screen')
          }
          onClick={() => lockNow()}
        >
          <Icon name="lock" />
        </button>
        <button
          className="status-theme"
          aria-label={t('Theme')}
          title={`Theme: ${THEME_NAMES[theme]} — click for ${THEME_NAMES[nextTheme(theme)]}`}
          onClick={() => setTheme(nextTheme)}
        >
          <Icon name={theme === 'gold' ? 'crown' : theme === 'light' ? 'sun' : 'moon'} />
        </button>
      </footer>
      <AuthPromptDialog connections={connections} onRemember={(id, password, remember) => void rememberPassword(id, password, remember)} />
      <TooltipLayer />
      <FieldContextMenu />
      {newConnection && (
        <NewConnectionDialog
          onClose={() => setNewConnectionState(null)}
          onSave={addConnection}
          folders={folders}
          folderCounts={folderCounts}
          folderId={newConnection.folderId}
          shells={shells ?? []}
          defaults={sessionDefaults}
          proxy={proxy}
        />
      )}
      {(() => {
        const editing = editingId ? connections.find(item => item.id === editingId) : undefined;
        return (
          editing && (
            <NewConnectionDialog
              key={editing.id}
              initial={editing}
              onClose={() => setEditingId(null)}
              onSave={updateConnection}
              folders={folders}
              folderCounts={folderCounts}
              folderId={editing.folderId}
              shells={shells ?? []}
              openTerminals={allTabs.filter(tab => tab.connectionId === editing.id).length}
              proxy={proxy}
            />
          )
        );
      })()}
      {(() => {
        const source = savingAsId ? connections.find(item => item.id === savingAsId) : undefined;
        return (
          source && (
            <NewConnectionDialog
              key={`copy-${source.id}`}
              initial={source}
              copy
              onClose={() => setSavingAsId(null)}
              onSave={connection => addConnection(connection, false)}
              folders={folders}
              folderCounts={folderCounts}
              folderId={source.folderId}
              shells={shells ?? []}
              proxy={proxy}
            />
          )
        );
      })()}
      {treeDialog &&
        (() => {
          const close = () => setTreeDialog(null);
          if (treeDialog.kind === 'new-folder') {
            const where = folderPath(folders, treeDialog.parentId);
            return (
              <TreeDialog
                section={t('EXPLORER')}
                title={t('NEW FOLDER')}
                label={t('FOLDER NAME')}
                initial="New folder"
                confirm={t('CREATE')}
                message={<>{tc('Create a folder in <c>{{where}}</c>.', { where: where || t('the top level') })}</>}
                onCancel={close}
                onSubmit={name => {
                  createFolder(treeDialog.parentId, name);
                  close();
                }}
              />
            );
          }
          const { target } = treeDialog;
          const folder = target.kind === 'folder' ? folders.find(item => item.id === target.id) : undefined;
          const session = target.kind === 'session' ? connections.find(item => item.id === target.id) : undefined;
          const name = folder?.name ?? session?.name ?? '';
          if (!folder && !session) return null;
          if (treeDialog.kind === 'rename')
            return (
              <TreeDialog
                section={t('EXPLORER')}
                title={folder ? t('RENAME FOLDER') : t('RENAME SESSION')}
                label={t('NAME')}
                initial={name}
                confirm={t('RENAME')}
                onCancel={close}
                onSubmit={value => {
                  renameItem(target, value);
                  close();
                }}
              />
            );
          const ids = folder ? folderAndDescendants(folders, folder.id) : null;
          const inside = ids ? connections.filter(item => item.folderId !== null && ids.has(item.folderId)).length : 0;
          const subfolders = ids ? ids.size - 1 : 0;
          const openTabs = allTabs.filter(tab =>
            session
              ? tab.connectionId === session.id
              : connections.some(item => item.id === tab.connectionId && item.folderId !== null && ids!.has(item.folderId)),
          ).length;
          return (
            <TreeDialog
              section={t('EXPLORER')}
              title={folder ? t('DELETE FOLDER') : t('DELETE SESSION')}
              confirm={t('DELETE')}
              danger
              message={
                <>
                  {folder && (inside || subfolders)
                    ? tc('Delete <c>{{name}}</c> and everything inside it ({{content}})?', {
                        name,
                        content: [
                          subfolders && t('{{count}} folder(s)', { count: subfolders }),
                          inside && t('{{count}} session(s)', { count: inside }),
                        ]
                          .filter(Boolean)
                          .join(', '),
                      })
                    : tc('Delete <c>{{name}}</c>?', { name })}
                  {openTabs ? t(' {{openTabs}} open terminal(s) will be closed.', { openTabs }) : ''}
                  {t(' This cannot be undone.')}
                </>
              }
              onCancel={close}
              onSubmit={() => {
                deleteItem(target);
                close();
              }}
            />
          );
        })()}
      {statusWindowMenu && (
        <ContextMenu
          x={statusWindowMenu.x}
          y={statusWindowMenu.y}
          onClose={() => setStatusWindowMenu(null)}
          items={statusWindowMenuItems(statusWindowMenu.id)}
        />
      )}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          items={[
            {
              type: 'item',
              id: 'rename',
              label: t('Rename tab…'),
              icon: 'rename',
              onSelect: () => {
                const tab = terminalTabs.find(item => item.id === tabMenu.id);
                if (tab) setBarRename({ id: tab.id, value: terminalTitle(tab) });
              },
            },
            {
              type: 'item',
              id: 'reset-name',
              label: t('Restore default name'),
              disabled: !terminalTabs.find(item => item.id === tabMenu.id)?.title,
              onSelect: () => renameTab(tabMenu.id, null),
            },
            { type: 'separator', id: 'sep-rename' },
            ...tabMenuItems(tabMenu.id),
          ]}
        />
      )}
      {preferencesDialog === 'settings' && (
        <SettingsDialog
          theme={theme}
          language={language}
          titleBar={titleBar}
          desktop={isDesktop()}
          prefs={terminalPrefs}
          appearance={appearance}
          lock={lockSettings}
          onLockPassword={() => setLockPrompt('password')}
          onPreviewOpacity={showOpacity}
          onClose={() => {
            showOpacity(appearance.windowOpacity); // slider preview → back to the saved value
            setPreferencesDialog(null);
          }}
          onSave={(nextTheme, nextTitleBar, prefs, lock, nextAppearance, nextLanguage) => {
            setTheme(nextTheme);
            setLanguageState(nextLanguage);
            setLanguage(nextLanguage);
            setTitleBar(nextTitleBar);
            setTerminalPrefs(prefs);
            setLockSettings(current => sanitizeLockSettings({ ...current, ...lock }));
            setAppearance(nextAppearance);
            showOpacity(nextAppearance.windowOpacity);
            setPreferencesDialog(null);
            log(i18n.t('Settings saved', { lng: nextLanguage }));
          }}
        />
      )}
      {appDialog === 'proxy' && (
        <ProxyDialog
          value={proxy}
          onClose={() => setAppDialog(null)}
          onSave={next => {
            setProxy(next);
            setAppDialog(null);
            log(t('Proxy: {{v}} — used by new SSH / Telnet / TCP connections', { v: describeProxy(next) }));
          }}
        />
      )}
      {appDialog === 'log' && (
        <LogSettingsDialog
          value={logPrefs}
          onClose={() => setAppDialog(null)}
          onSave={next => {
            setLogPrefs(next);
            setAppDialog(null);
            log(t('Log settings saved — level {{level}}, {{format}}', { level: next.level, format: next.format }));
          }}
        />
      )}
      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette menus={menuBar} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      ) : null}
      {appDialog === 'tunnels' && <TunnelsDialog sessions={connections} onClose={() => setAppDialog(null)} />}
      {appDialog === 'about' && <AboutDialog version={APP_VERSION} backendVersion={backendVersion} onClose={() => setAppDialog(null)} />}
      {focusDialog && (
        <FocusModeDialog
          value={focusConfig}
          swatches={swatches}
          desktop={isDesktop()}
          onCancel={() => setFocusDialog(false)}
          onConfirm={config => {
            if (focusActive) {
              setFocusConfig(config);
              setFocusDialog(false);
              void applyFocusWindow(config, false).catch(error => log.error(t('Focus Mode'), error));
              log(t('Focus Mode settings applied'));
            } else enterFocus(config);
          }}
        />
      )}
      {windowDialog &&
        (() => {
          const target = windows.find(item => item.id === windowDialog.id);
          const close = () => setWindowDialog(null);
          if (!target) return null;
          if (windowDialog.kind === 'rename')
            return (
              <TreeDialog
                section={t('WINDOW')}
                title={t('RENAME WINDOW')}
                label={t('Name')}
                initial={target.name}
                confirm={t('RENAME')}
                onCancel={close}
                onSubmit={value => {
                  renameWindow(target.id, value);
                  close();
                }}
              />
            );
          const count = allTabs.filter(tab => tab.windowId === target.id).length;
          return (
            <TreeDialog
              section={t('WINDOW')}
              title={t('CLOSE WINDOW')}
              confirm={t('CLOSE')}
              danger
              message={
                <>
                  {count === 1
                    ? tc('Close <c>{{name}}</c> with its tab? Its shell or connection ends.', { name: target.name })
                    : tc('Close <c>{{name}}</c> with its {{count}} tabs? Their shells and connections end.', { name: target.name, count })}
                </>
              }
              onCancel={close}
              onSubmit={() => {
                close();
                doCloseWindow(target.id);
              }}
            />
          );
        })()}
      {closeConfirm &&
        (() => {
          const closing = closeConfirm.ids
            .map(id => terminalTabs.find(tab => tab.id === id))
            .filter((tab): tab is TerminalTab => Boolean(tab));
          const paneMode = Boolean(closeConfirm.pane);
          const close = () => setCloseConfirm(null);
          if (!closing.length) return null;
          const one = closing.length === 1;
          return (
            <TreeDialog
              section={t('SESSION')}
              title={paneMode ? t('CLOSE PANE') : one ? t('CLOSE TAB') : t('CLOSE {{length}} TABS', { length: closing.length })}
              confirm={t('CLOSE')}
              danger
              message={
                one ? (
                  <>
                    {paneMode
                      ? tc('Close the pane <c>{{name}}</c>? Its shell or connection ends.', { name: terminalTitle(closing[0]) })
                      : tc('Close <c>{{name}}</c>? Its shell or connection ends.', { name: terminalTitle(closing[0]) })}
                  </>
                ) : (
                  <>
                    {t('Close {{count}} tabs ({{names}})? Their shells and connections end.', {
                      count: closing.length,
                      names:
                        closing
                          .slice(0, 4)
                          .map(tab => terminalTitle(tab))
                          .join(', ') + (closing.length > 4 ? ', …' : ''),
                    })}
                  </>
                )
              }
              onCancel={close}
              onSubmit={() => {
                close();
                doCloseTabs(closing.map(tab => tab.id));
              }}
            />
          );
        })()}
      {lockPrompt === 'setup' && (
        <LockSetupDialog
          onCancel={() => setLockPrompt(null)}
          onSkip={dontAsk => {
            if (dontAsk) setLockSettings(current => ({ ...current, skipPrompt: true }));
            setLockPrompt(null);
            lockedRef.current = true;
            setLocked(true);
          }}
          onSetAndLock={async (password, dontAsk) => {
            await saveLockPassword(password);
            if (dontAsk) setLockSettings(current => ({ ...current, skipPrompt: true }));
            setLockPrompt(null);
            lockedRef.current = true;
            setLocked(true);
            log(t('Lock password set'));
          }}
        />
      )}
      {lockPrompt === 'password' && (
        <LockPasswordDialog
          settings={lockSettings}
          onClose={() => setLockPrompt(null)}
          onSave={async password => {
            await saveLockPassword(password);
            setLockPrompt(null);
            log(password === null ? t('Lock password removed') : t('Lock password saved'));
          }}
        />
      )}
      {locked && (
        <LockOverlay
          settings={lockSettings}
          onUnlock={() => {
            lockedRef.current = false;
            setLocked(false);
            log(t('Unlocked'));
          }}
        />
      )}
      {preferencesDialog === 'defaults' && (
        <SessionDefaultsDialog
          value={sessionDefaults}
          shells={shells ?? []}
          onClose={() => setPreferencesDialog(null)}
          onSave={value => {
            setSessionDefaults(value);
            setPreferencesDialog(null);
            log(t('Default session settings saved'));
          }}
        />
      )}
    </main>
  );
}
