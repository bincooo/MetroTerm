import type { TerminalTab } from '../../types';
import { SenderBody } from '../../components/sender/SenderPanel';
import Filer from '../../components/filer/Filer';
import { MenuButton, type MenuItem } from '../../components/common/MenuButton';
import { SessionsPanel } from '../../components/sessions/SessionsPanel';
import { MonitorPanel } from '../../components/monitor/MonitorPanel';
import {
  activateTab,
  closeNode,
  closeTab,
  moveTab,
  PANEL_VIEWS,
  tabsOf,
  type LayoutNode,
  type LeafNode,
  type PanelView,
} from '../../lib/workspace/layout';
import { Icon } from '../../components/common/Icon';
import { log } from '../../lib/platform/log';
import { describeConnection, hasFiles, transportName } from '../../lib/sessions/transports';
import { startTabDrag } from '../../lib/ui/tabDrag';
import { SessionTree } from '../../components/sessions/SessionTree';
import type { FocusLeaf } from '../../lib/workspace/focusMode';
import { folderPath, type SessionFolder, type TreeRef } from '../../lib/sessions/tree';
import { t } from '../../i18n';
import type { ManagedConnection } from '../sessionsDoc';
import { type ContentView, type WindowCtx, panelClass } from '../helpers';
import type { useWorkspace } from '../hooks/useWorkspace';
import type { PaneId } from '../settingsDoc';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import type { DropTarget } from '../../lib/sessions/tree';

/**
 * A content panel of the layout: its tab bar (drag to reorder or move a view to another panel), the ⚙ menu and the
 * open views. Every open view stays mounted (hidden when inactive) so its state survives tab switches. `ctx` = the
 * panel belongs to a window that is not shown; Focus Mode may show other tabs than the layout (`focusPanes`).
 */
type ContentPanelProps = {
  ws: ReturnType<typeof useWorkspace>;
  panelLabel: (view: ContentView) => string;
  leaves: LeafNode[];
  carryPanelState: (view: PanelView, fromId: string, toId: string) => void;
  swatches: Record<PaneId, string>;
  panelMenu: (leaf: LeafNode & { view: ContentView }) => MenuItem[];
  openPanelTab: (leaf: LeafNode, panelView: PanelView) => void;
  lastExplorer: MutableRefObject<string | null>;
  filters: Record<string, string>;
  setFilters: Dispatch<SetStateAction<Record<string, string>>>;
  setNewConnection: (folderId?: string | null | undefined) => void;
  folders: SessionFolder[];
  isCollapsedIn: (panel: string, folder: SessionFolder) => boolean;
  connections: ManagedConnection[];
  missingShell: (connection: ManagedConnection) => boolean;
  openTerminal: (connectionId: string, pane?: string, activate?: boolean) => string;
  toggleFolder: (panel: string, id: string) => void;
  toggleFavorite: (id: string) => void;
  moveTreeItem: (dragged: TreeRef, target: DropTarget) => void;
  treeMenu: (target: TreeRef | null) => MenuItem[];
  activateTerminal: (tab: TerminalTab) => void;
  renameTab: (tabId: string, title: string | null) => void;
  startTerminalTabDrag: (event: React.PointerEvent<HTMLElement>, strip: string, id: string, label: string) => void;
  tabMenuItems: (tabId: string) => MenuItem[];
  terminalTitle: (tab: TerminalTab) => string;
  defaultTitle: (tab: TerminalTab) => string;
  node: LeafNode;
  ctx?: WindowCtx;
  focusPanes: { tree: LayoutNode; leaves: Map<string, FocusLeaf> } | null;
};

export function ContentPanel(props: ContentPanelProps) {
  const { setLayout, shownTabs, shownTabId, shownTab, shownActive, connectionById, agentStatuses } = props.ws;
  const { panelLabel, leaves, carryPanelState, swatches, panelMenu, openPanelTab, lastExplorer, filters, setFilters } = props;
  const { setNewConnection, folders, isCollapsedIn, connections, missingShell, openTerminal, toggleFolder, toggleFavorite } = props;
  const { moveTreeItem, treeMenu, activateTerminal, renameTab, startTerminalTabDrag, tabMenuItems, terminalTitle, defaultTitle } = props;
  const { node, ctx, focusPanes } = props;
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
        if (strip === fromId) return;
        carryPanelState(view, fromId, strip);
        log(t('{{v}} moved to another panel', { v: panelLabel(view) }));
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
        <MenuButton title={t('Settings')} items={panelMenu(leaf)} menuClassName="panel-settings-menu">
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
                agent: agentStatuses.get(tab.id) ?? null,
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
  const leaf = node as LeafNode & { view: ContentView };
  const shown = ctx ? undefined : focusPanes?.leaves.get(leaf.id);
  const headerLeaf = shown ? { ...leaf, tabs: shown.tabs, view: shown.view as ContentView } : leaf;
  return (
    <section key={leaf.id} className={`panel content-pane${tabsOf(headerLeaf).length ? '' : ' empty-pane'}`} data-panel={leaf.id}>
      {panelHeader(headerLeaf)}
      {panelBody(leaf, shown, ctx)}
    </section>
  );
}
