/**
 * The menu bar (Session · View · Mode · Tool · Window · Help), also searched by the menu search
 * (CommandPalette). Pure builders: App passes its state and actions in `MenuBarContext`.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { TerminalTab } from '../../types';
import type { BarMenu, BarMenuItem } from '../../components/common/MenuBar';
import { backend } from '../../lib/platform/backend';
import { log } from '../../lib/platform/log';
import { APP_VERSION } from '../../lib/platform/version';
import { isDesktop } from '../../lib/platform/tauri';
import { keyHint } from '../../lib/settings/keybindings';
import {
  describeProxy,
  FONT_SIZE_RANGE,
  proxyActive,
  type KeyMode,
  type LogPrefs,
  type ProxyPrefs,
  type TerminalPrefs,
} from '../../lib/settings/preferences';
import { describeConnection, transportIcon } from '../../lib/sessions/transports';
import type { WorkWindow } from '../../lib/workspace/windows';
import { t } from '../../i18n';
import type { ManagedConnection } from '../sessionsDoc';

type MenuBarContext = {
  // Mode
  fullScreen: boolean;
  toggleFullScreen: () => Promise<void>;
  alwaysOnTop: boolean;
  toggleAlwaysOnTop: () => Promise<void>;
  keyMode: KeyMode;
  setKeyMode: (mode: KeyMode) => void;
  // Tool
  runningTunnels: number;
  setAppDialog: (dialog: 'proxy' | 'log' | 'keys' | 'about' | 'tunnels') => void;
  // View
  activeTab: TerminalTab | undefined;
  zoomedSize: (tabId: string) => number;
  terminalPrefs: TerminalPrefs;
  setTerminalPrefs: Dispatch<SetStateAction<TerminalPrefs>>;
  zoomActive: (step: 1 | -1 | 0) => void;
  focusActive: boolean;
  toggleFocus: () => void;
  setFocusDialog: (open: boolean) => void;
  lockNow: () => void;
  // Session
  connectionById: Map<string, ManagedConnection>;
  recent: string[];
  setRecent: Dispatch<SetStateAction<string[]>>;
  setNewConnection: () => void;
  cloneSession: (id: string) => void;
  disconnectTab: (tab: TerminalTab) => void;
  reconnectTab: (tab: TerminalTab) => void;
  openTerminal: (connectionId: string) => void;
  setSavingAsId: (id: string) => void;
  saveSelection: (tab: TerminalTab) => void;
  proxy: ProxyPrefs;
  logPrefs: LogPrefs;
  setPreferencesDialog: (dialog: 'settings' | 'defaults') => void;
  setEditingId: (id: string) => void;
  openProfilesDirectory: () => void;
  closeTabs: (tabIds: string[]) => void;
  terminalTabs: TerminalTab[];
  quit: (kind: 'window' | 'exit') => Promise<void>;
  // Window
  windows: WorkWindow[];
  currentWindow: WorkWindow;
  newWindow: () => void;
  setWindowDialog: (dialog: { kind: 'rename' | 'close'; id: string }) => void;
  closeWindow: (id: string) => void;
  stepWindow: (delta: number) => void;
  switchWindow: (id: string) => void;
};

const modeMenu = (c: MenuBarContext): BarMenuItem[] => [
  {
    type: 'item',
    id: 'full-screen',
    label: t('Full Screen'),
    icon: c.fullScreen ? 'fullscreenExit' : 'fullscreen',
    hint: keyHint('fullScreen'),
    checked: c.fullScreen,
    onSelect: () => void c.toggleFullScreen(),
  },
  {
    type: 'item',
    id: 'always-on-top',
    label: t('Always On Top'),
    hint: isDesktop() ? undefined : t('Desktop app'),
    checked: c.alwaysOnTop,
    disabled: !isDesktop(),
    onSelect: () => void c.toggleAlwaysOnTop(),
  },
  { type: 'separator', id: 'mode-sep-keys' },
  { type: 'item', id: 'remote-mode', label: t('Remote Mode'), checked: c.keyMode === 'remote', onSelect: () => c.setKeyMode('remote') },
  { type: 'item', id: 'local-mode', label: t('Local Mode'), checked: c.keyMode === 'local', onSelect: () => c.setKeyMode('local') },
];
const toolMenu = (c: MenuBarContext): BarMenuItem[] => [
  {
    type: 'item',
    id: 'tunnels',
    label: t('Tunnels…'),
    icon: 'tunnel',
    hint: c.runningTunnels ? t('{{runningTunnels}} running', { runningTunnels: c.runningTunnels }) : undefined,
    onSelect: () => c.setAppDialog('tunnels'),
  },
  { type: 'item', id: 'triggers', label: t('Triggers…'), hint: 'Coming soon', disabled: true, onSelect: () => undefined },
];
const viewMenu = (c: MenuBarContext): BarMenuItem[] => {
  const size = c.activeTab ? c.zoomedSize(c.activeTab.id) : c.terminalPrefs.fontSize;
  return [
    {
      type: 'submenu',
      id: 'zoom',
      label: t('Zoom'),
      disabled: !c.activeTab,
      items: [
        {
          type: 'item',
          id: 'zoom-in',
          label: t('Zoom In'),
          icon: 'zoomIn',
          hint: keyHint('zoomIn'),
          disabled: size >= FONT_SIZE_RANGE.max,
          onSelect: () => c.zoomActive(1),
        },
        {
          type: 'item',
          id: 'zoom-out',
          label: t('Zoom Out'),
          icon: 'zoomOut',
          hint: keyHint('zoomOut'),
          disabled: size <= FONT_SIZE_RANGE.min,
          onSelect: () => c.zoomActive(-1),
        },
        { type: 'separator', id: 'zoom-sep' },
        {
          type: 'item',
          id: 'zoom-reset',
          label: t('Reset Zoom'),
          disabled: size === c.terminalPrefs.fontSize,
          onSelect: () => c.zoomActive(0),
        },
      ],
    },
    { type: 'separator', id: 'view-sep-gutter' },
    {
      type: 'item',
      id: 'show-time',
      label: t('Show Time'),
      checked: c.terminalPrefs.gutterTime,
      onSelect: () => c.setTerminalPrefs(prefs => ({ ...prefs, gutterTime: !prefs.gutterTime })),
    },
    {
      type: 'item',
      id: 'show-line',
      label: t('Show Line Number'),
      checked: c.terminalPrefs.gutterLine,
      onSelect: () => c.setTerminalPrefs(prefs => ({ ...prefs, gutterLine: !prefs.gutterLine })),
    },
    {
      type: 'item',
      id: 'highlight',
      label: t('Highlight Keywords'),
      checked: c.terminalPrefs.highlight,
      onSelect: () => c.setTerminalPrefs(prefs => ({ ...prefs, highlight: !prefs.highlight })),
    },
    {
      type: 'item',
      id: 'agent-sound',
      label: t('Agent Done Sound'),
      checked: c.terminalPrefs.agentSound,
      onSelect: () => c.setTerminalPrefs(prefs => ({ ...prefs, agentSound: !prefs.agentSound })),
    },
    { type: 'separator', id: 'view-sep-focus' },
    { type: 'item', id: 'focus-mode', label: t('Focus Mode'), hint: keyHint('focusMode'), checked: c.focusActive, onSelect: c.toggleFocus },
    { type: 'item', id: 'focus-settings', label: t('Focus Mode Settings…'), onSelect: () => c.setFocusDialog(true) },
    { type: 'separator', id: 'view-sep-lock' },
    { type: 'item', id: 'lock-screen', label: t('Lock Screen'), icon: 'lock', onSelect: () => c.lockNow() },
  ];
};
const sessionMenu = (c: MenuBarContext): BarMenuItem[] => {
  const tab = c.activeTab;
  const current = tab ? c.connectionById.get(tab.connectionId) : undefined;
  const recentSessions = c.recent.map(id => c.connectionById.get(id)).filter((item): item is ManagedConnection => Boolean(item));
  return [
    { type: 'item', id: 'new', label: t('New Session…'), icon: 'plus', hint: keyHint('newSession'), onSelect: () => c.setNewConnection() },
    {
      type: 'item',
      id: 'duplicate',
      label: t('Duplicate Session'),
      icon: 'copy',
      disabled: !current,
      onSelect: () => current && c.cloneSession(current.id),
    },
    { type: 'separator', id: 's1' },
    {
      type: 'item',
      id: 'disconnect',
      label: t('Disconnect Session'),
      icon: 'unplug',
      disabled: !tab,
      onSelect: () => tab && c.disconnectTab(tab),
    },
    {
      type: 'item',
      id: 'reconnect',
      label: t('Reconnect Session'),
      icon: 'refresh',
      disabled: !tab,
      onSelect: () => tab && c.reconnectTab(tab),
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
          onSelect: () => c.openTerminal(item.id),
        })),
        { type: 'separator', id: 'recent-sep' },
        {
          type: 'item',
          id: 'recent-clear',
          label: t('Clear Recent List'),
          onSelect: () => {
            c.setRecent([]);
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
      hint: keyHint('saveAs'),
      disabled: !current,
      onSelect: () => current && c.setSavingAsId(current.id),
    },
    {
      type: 'item',
      id: 'save-selection',
      label: t('Save Selection As…'),
      icon: 'download',
      disabled: !tab,
      onSelect: () => tab && c.saveSelection(tab),
    },
    { type: 'separator', id: 's4' },
    {
      type: 'item',
      id: 'proxy',
      label: t('Proxy…'),
      icon: 'proxy',
      hint: proxyActive(c.proxy) ? describeProxy(c.proxy) : undefined,
      onSelect: () => c.setAppDialog('proxy'),
    },
    {
      type: 'submenu',
      id: 'log',
      label: t('Log'),
      icon: 'log',
      items: [
        { type: 'item', id: 'log-settings', label: t('Log Settings…'), icon: 'settings', onSelect: () => c.setAppDialog('log') },
        {
          type: 'item',
          id: 'log-folder',
          label: t('Open Log Folder'),
          icon: 'folder',
          disabled: !backend.live,
          onSelect: () =>
            void backend
              .call<string>('log.open', c.logPrefs)
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
        { type: 'item', id: 'settings', label: t('Settings…'), icon: 'settings', onSelect: () => c.setPreferencesDialog('settings') },
        {
          type: 'item',
          id: 'session-settings',
          label: t('Session Settings…'),
          disabled: !current,
          onSelect: () => current && c.setEditingId(current.id),
        },
        {
          type: 'item',
          id: 'default-session-settings',
          label: t('Default Session Settings…'),
          onSelect: () => c.setPreferencesDialog('defaults'),
        },
        { type: 'item', id: 'keyboard-shortcuts', label: t('Keyboard Shortcuts…'), onSelect: () => c.setAppDialog('keys') },
        { type: 'separator', id: 'pref-sep' },
        {
          type: 'item',
          id: 'profiles-directory',
          label: t('Profiles Directory…'),
          icon: 'folder',
          disabled: !backend.live,
          onSelect: c.openProfilesDirectory,
        },
      ],
    },
    { type: 'separator', id: 's5' },
    {
      type: 'item',
      id: 'close',
      label: t('Close View'),
      icon: 'close',
      hint: keyHint('closeTab'),
      disabled: !c.activeTab,
      onSelect: () => c.activeTab && c.closeTabs([c.activeTab.id]),
    },
    {
      type: 'item',
      id: 'close-all',
      label: t('Close All Views'),
      disabled: !c.terminalTabs.length,
      onSelect: () => c.closeTabs(c.terminalTabs.map(item => item.id)),
    },
    { type: 'separator', id: 's6' },
    { type: 'item', id: 'exit', label: t('Exit'), hint: 'Alt+F4', onSelect: () => void c.quit('exit') },
  ];
};
/** Window menu: new / rename / close, previous / next, and the list of c.windows. */
const windowMenu = (c: MenuBarContext): BarMenuItem[] => [
  { type: 'item', id: 'window-new', label: t('New Window'), icon: 'plus', onSelect: c.newWindow },
  {
    type: 'item',
    id: 'window-rename',
    label: t('Rename Window…'),
    icon: 'rename',
    onSelect: () => c.setWindowDialog({ kind: 'rename', id: c.currentWindow.id }),
  },
  {
    type: 'item',
    id: 'window-close',
    label: t('Close Window'),
    icon: 'close',
    disabled: c.windows.length < 2,
    onSelect: () => c.closeWindow(c.currentWindow.id),
  },
  { type: 'separator', id: 'window-sep-step' },
  {
    type: 'item',
    id: 'window-prev',
    label: t('Previous Window'),
    hint: keyHint('prevWindow'),
    disabled: c.windows.length < 2,
    onSelect: () => c.stepWindow(-1),
  },
  {
    type: 'item',
    id: 'window-next',
    label: t('Next Window'),
    hint: keyHint('nextWindow'),
    disabled: c.windows.length < 2,
    onSelect: () => c.stepWindow(1),
  },
  { type: 'separator', id: 'window-sep-list' },
  ...c.windows.map((item, index): BarMenuItem => ({
    type: 'item',
    id: `window-${item.id}`,
    label: item.name,
    checked: item.id === c.currentWindow.id,
    hint: index < 9 ? `Ctrl+Shift+${index + 1}` : undefined,
    onSelect: () => c.switchWindow(item.id),
  })),
];

export const buildMenuBar = (c: MenuBarContext): BarMenu[] => [
  { id: 'session', label: t('Session'), items: sessionMenu(c) },
  { id: 'view', label: t('View'), items: viewMenu(c) },
  { id: 'mode', label: t('Mode'), items: modeMenu(c) },
  { id: 'tool', label: t('Tool'), items: toolMenu(c) },
  { id: 'window', label: t('Window'), items: windowMenu(c) },
  {
    id: 'help',
    label: t('Help'),
    items: [
      { type: 'item', id: 'about', label: t('About MetroTerm…'), icon: 'info', onSelect: () => c.setAppDialog('about') },
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
