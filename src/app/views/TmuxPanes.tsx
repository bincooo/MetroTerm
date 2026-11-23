import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { TerminalTab, ThemeMode, TmuxNode } from '../../types';
import { PaneLetter } from '../../components/terminal/PaneLetter';
import TerminalView, { type CursorInfo } from '../../components/terminal/TerminalView';
import { MenuButton, type MenuItem } from '../../components/common/MenuButton';
import { Icon } from '../../components/common/Icon';
import { tmuxLayout, tmuxSetRatio, type Rect, type TmuxPaneView, type TmuxSplitter } from '../../lib/workspace/tmux';
import type { TerminalPrefs } from '../../lib/settings/preferences';
import { terminalRegistry } from '../../lib/platform/backend';
import { transportIcon } from '../../lib/sessions/transports';
import { folderPath, type SessionFolder } from '../../lib/sessions/tree';
import { t } from '../../i18n';
import { FULL_RECT, sameBoxes, tmuxSplitterStyle, tmuxStyle, type TmuxBox } from '../tmuxGeometry';
import type { useWorkspace } from '../hooks/useWorkspace';
import type { FocusConfig } from '../../lib/workspace/focusMode';

/**
 * The terminal panel: tmux panes, each one a tab group with its own tab bar and toolbar (actions, breadcrumb, pane
 * letter, ⋮ pane menu). All terminals (of every window) stay mounted in the stage, each placed over its pane's body
 * while it is that pane's shown tab, hidden otherwise. Splitters resize the panes.
 */
type TmuxPanesProps = {
  ws: ReturnType<typeof useWorkspace>;
  updateTmux: (change: (tree: TmuxNode) => TmuxNode) => void;
  barRename: { id: string; value: string } | null;
  activateTerminal: (tab: TerminalTab) => void;
  startTerminalTabDrag: (event: React.PointerEvent<HTMLElement>, strip: string, id: string, label: string) => void;
  terminalTitle: (tab: TerminalTab) => string;
  setBarRename: Dispatch<SetStateAction<{ id: string; value: string } | null>>;
  setTabMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  defaultTitle: (tab: TerminalTab) => string;
  commitBarRename: () => void;
  closeSession: (tabId: string, event: React.MouseEvent) => void;
  focusActive: boolean;
  focusConfig: FocusConfig;
  terminalFull: boolean;
  leaveTerminalFull: () => void;
  enterTerminalFull: (paneId: string) => void;
  cloneSession: (id: string) => void;
  reconnectTab: (tab: { id: string; connectionId: string }) => void;
  folders: SessionFolder[];
  toggleFavorite: (id: string) => void;
  tmuxPaneMenu: (pane: { id: string; active: TerminalTab | undefined; tabs: TerminalTab[] }) => MenuItem[];
  focusTmuxPane: (paneId: string) => void;
  setNewConnection: (folderId?: string | null | undefined) => void;
  theme: ThemeMode;
  tabEpochs: Record<string, number>;
  terminalMenuOf: (tabId: string) => MenuItem[];
  onCursor: (tabId: string, info: CursorInfo) => void;
  zoomedPrefs: Map<string, TerminalPrefs>;
  terminalPrefs: TerminalPrefs;
  backgroundStarts: ReadonlySet<string>;
};

export function TmuxPanes(props: TmuxPanesProps) {
  const { tmuxZoomed, tmux, tmuxTree, connectionById, active, terminalStack, activeTab } = props.ws;
  const { updateTmux, barRename, activateTerminal, startTerminalTabDrag, terminalTitle, setBarRename, setTabMenu, defaultTitle } = props;
  const { commitBarRename, closeSession, focusActive, focusConfig, terminalFull, leaveTerminalFull, enterTerminalFull } = props;
  const { cloneSession, reconnectTab, folders, toggleFavorite, tmuxPaneMenu, focusTmuxPane, setNewConnection, theme, tabEpochs } = props;
  const { terminalMenuOf, onCursor, zoomedPrefs, terminalPrefs, backgroundStarts } = props;
  /** tmux panes on screen: rects (fractions of the stage); zoomed = the focused pane only. */
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
          <button title={t('Find (Ctrl+F)')} aria-label={t('Find in terminal')} onClick={() => terminalRegistry.get(tab.id)?.find()}>
            <Icon name="search" />
          </button>
          <i />
          <button title={t('Clone session')} aria-label={t('Clone session')} onClick={() => cloneSession(connection.id)}>
            <Icon name="copy" />
          </button>
          <button onClick={() => reconnectTab(tab)} title={t('Reconnect')} aria-label={t('Reconnect')}>
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
                reconnectToken={tabEpochs[tab.id] ?? 0}
                active={focused}
                menuItems={terminalMenuOf}
                onCursor={onCursor}
                prefs={zoomedPrefs.get(tab.id) ?? terminalPrefs}
                startHidden={backgroundStarts.has(tab.id)}
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
}
