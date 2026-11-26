import type { TerminalTab } from '../../types';
import { canSendToSender, sendToSender } from '../../components/sender/SenderPanel';
import { MIN_PANEL_SIZE, SPLITTER_SIZE } from '../../components/common/SplitPane';
import type { MenuItem } from '../../components/common/MenuButton';
import { panelOf, PANEL_VIEWS, splitDirectionFor, splitLeaf, type LeafNode, type PanelView } from '../../lib/workspace/layout';
import { log } from '../../lib/platform/log';
import type { TmuxDirection } from '../../lib/workspace/tmux';
import { terminalRegistry } from '../../lib/platform/backend';
import { keyHint, prefixHint } from '../../lib/settings/keybindings';
import type { TreeRef } from '../../lib/sessions/tree';
import { t } from '../../i18n';
import type { ContentView, TreeDialogState } from '../helpers';
import type { useWorkspace } from '../hooks/useWorkspace';
import type { Dispatch, SetStateAction } from 'react';
import type { ManagedConnection } from '../sessionsDoc';

/**
 * Right-click and ⋮ menus: open tab (Session panel, tab bar), status bar window, Explorer tree, terminal (with its
 * pane items), panel settings (⚙) and tmux pane (⋮). Pure builders: App passes its state and actions in.
 */
type ContextMenuDeps = {
  ws: ReturnType<typeof useWorkspace>;
  splitTerminal: (dir: TmuxDirection, tabId?: string | null) => void;
  breakTab: (tabId: string) => void;
  reconnectTab: (tab: { id: string; connectionId: string }) => void;
  disconnectTab: (tab: TerminalTab) => void;
  moveTabToWindow: (tabId: string, targetId: string) => void;
  closeTabs: (tabIds: string[]) => void;
  closeTmuxPane: (paneId: string) => void;
  switchWindow: (id: string) => void;
  setWindowDialog: Dispatch<SetStateAction<{ kind: 'rename' | 'close'; id: string } | null>>;
  moveWindow: (id: string, delta: number) => void;
  newWindow: () => void;
  closeWindow: (id: string) => void;
  folderFor: (target: TreeRef | null) => string | null;
  setNewConnection: (folderId?: string | null | undefined) => void;
  defaultFolder: () => string;
  setTreeDialog: Dispatch<SetStateAction<TreeDialogState | null>>;
  setAllFolders: (collapsed: boolean) => void;
  duplicateItem: (target: TreeRef) => void;
  connections: ManagedConnection[];
  openTerminal: (connectionId: string, pane?: string, activate?: boolean) => string;
  toggleFavorite: (id: string) => void;
  setEditingId: Dispatch<SetStateAction<string | null>>;
  saveSelection: (tab: TerminalTab) => void;
  saveOutput: (tab: TerminalTab, ansi?: boolean) => void;
  cloneSession: (id: string) => void;
  panelLabel: (view: ContentView) => string;
  openPanelTab: (leaf: LeafNode, panelView: PanelView) => void;
  tmuxZoomed: boolean;
  focusTmuxPane: (paneId: string) => void;
};

export function buildContextMenus(deps: ContextMenuDeps) {
  const { terminalTabs, tmuxPaneOfTab, tmuxPaneTabs, windows, tmux, currentWindow, setLayout, layout, updateWindow } = deps.ws;
  const { splitTerminal, breakTab, reconnectTab, disconnectTab, moveTabToWindow, closeTabs, closeTmuxPane, switchWindow } = deps;
  const { setWindowDialog, moveWindow, newWindow, closeWindow, folderFor, setNewConnection, defaultFolder, setTreeDialog } = deps;
  const { setAllFolders, duplicateItem, connections, openTerminal, toggleFavorite, setEditingId, saveSelection, saveOutput } = deps;
  const { cloneSession, panelLabel, openPanelTab, tmuxZoomed, focusTmuxPane } = deps;
  const splitItems = (tabId: string): MenuItem[] => [
    {
      type: 'item',
      id: 'split-row',
      label: t('Split Left / Right'),
      icon: 'splitRow',
      hint: prefixHint('%'),
      onSelect: () => splitTerminal('row', tabId),
    },
    {
      type: 'item',
      id: 'split-column',
      label: t('Split Top / Bottom'),
      icon: 'splitColumn',
      hint: prefixHint('"'),
      onSelect: () => splitTerminal('column', tabId),
    },
  ];
  /** Right-click menu of an open tab (Session panel and terminal tab bar), after Rename. */
  const tabMenuItems = (tabId: string): MenuItem[] => {
    const tab = terminalTabs.find(item => item.id === tabId);
    if (!tab) return [];
    const paneId = tmuxPaneOfTab(tab.id);
    const paneTabs = tmuxPaneTabs(paneId);
    return [
      // tmux split-window: the tab's pane; the new pane gets a new terminal of the same session.
      ...splitItems(tab.id),
      {
        type: 'item',
        id: 'break-pane',
        label: t('Move Tab to New Pane'),
        hint: prefixHint('!'),
        disabled: paneTabs.length < 2,
        onSelect: () => breakTab(tab.id),
      },
      { type: 'separator', id: 'sep-split' },
      { type: 'item', id: 'reconnect', label: t('Reconnect'), icon: 'refresh', onSelect: () => reconnectTab(tab) },
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
      { type: 'item', id: 'close', label: t('Close tab'), icon: 'close', hint: keyHint('closeTab'), onSelect: () => closeTabs([tab.id]) },
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
              hint: prefixHint('x'),
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
  /** Session part of the terminal's right-click menu (the terminal adds copy / paste / clear above it). */
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
      { type: 'item', id: 'save-output-ansi', label: t('Save Output As ANSI…'), onSelect: () => saveOutput(tab, true) },
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
        onSelect: () => reconnectTab(tab),
      },
      { type: 'item', id: 'disconnect', label: t('Disconnect Session'), icon: 'unplug', onSelect: () => disconnectTab(tab) },
      ...paneMenuItems(tab),
    ];
  };
  /**
   * tmux part of the terminal's right-click menu: only the two splits. Moving the tab to a new pane,
   * zooming and closing the pane are on the tab's right-click menu / the pane's ⋮ menu and the
   * Ctrl+B keys (`!`, `z`, `x`), not here.
   */
  const paneMenuItems = (tab: TerminalTab): MenuItem[] => [{ type: 'separator', id: 'tm-panes' }, ...splitItems(tab.id)];
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
    // A view open in another panel is moved here when chosen (a view is open in one panel only).
    ...PANEL_VIEWS.map(({ view: panelView, label }): MenuItem => ({
      type: 'item',
      id: panelView,
      label: t(label),
      checked: panelOf(layout, panelView)?.id === leaf.id,
      onSelect: () => openPanelTab(leaf, panelView),
    })),
  ];
  /** A pane's ⋮ menu (split / zoom / close; time and line numbers are in the View menu). */
  const tmuxPaneMenu = (pane: { id: string; active: TerminalTab | undefined; tabs: TerminalTab[] }): MenuItem[] => {
    const split = tmux.panes.length > 1;
    return [
      {
        type: 'item',
        id: 'pane-split-row',
        label: t('Split Left / Right'),
        icon: 'splitRow',
        hint: prefixHint('%'),
        disabled: !pane.active,
        onSelect: () => pane.active && splitTerminal('row', pane.active.id),
      },
      {
        type: 'item',
        id: 'pane-split-column',
        label: t('Split Top / Bottom'),
        icon: 'splitColumn',
        hint: prefixHint('"'),
        disabled: !pane.active,
        onSelect: () => pane.active && splitTerminal('column', pane.active.id),
      },
      ...(split
        ? ([
            {
              type: 'item',
              id: 'pane-zoom',
              label: t('Zoom Pane'),
              hint: prefixHint('z'),
              checked: tmuxZoomed,
              onSelect: () => {
                focusTmuxPane(pane.id);
                updateWindow(item => ({ tmuxZoomed: item.tmuxZoomed ? undefined : true }));
              },
            },
            { type: 'separator', id: 'pane-sep-close' },
            { type: 'item', id: 'pane-close', label: t('Close Pane'), hint: prefixHint('x'), onSelect: () => closeTmuxPane(pane.id) },
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
  return { tabMenuItems, statusWindowMenuItems, treeMenu, terminalMenuItems, panelMenu, tmuxPaneMenu };
}
