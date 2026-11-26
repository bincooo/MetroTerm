import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { TerminalTab } from '../../types';
import { backend, terminalRegistry, type BackendEvent } from '../../lib/platform/backend';
import { log } from '../../lib/platform/log';
import { useStableCallback } from '../../lib/ui/useStableCallback';
import type { WorkWindow } from '../../lib/workspace/windows';
import {
  closeTabs as closeTabsStep,
  closeWindow as closeWindowStep,
  closingTabs,
  fail,
  focusTerminal,
  focusWindow,
  freshWindow,
  layoutOf,
  moveTab as moveTabStep,
  newWindow as newWindowStep,
  openTab as openTabStep,
  paneShownTab,
  renameTab as renameTabStep,
  renameWindow as renameWindowStep,
  sessionTab,
  resizePane,
  sideParam,
  splitPane,
  stringParam,
  tabOf,
  targetPane,
  UiError,
  zoomPane,
  type UiState,
  type UiStep,
} from '../../lib/workspace/mcpUi';
import { t } from '../../i18n';
import type { ManagedConnection } from '../sessionsDoc';
import { RECENT_MAX } from '../settingsDoc';

/** What the MCP UI steps need from App: its window / tab state and a few of its actions. */
type McpUiDeps = {
  windows: WorkWindow[];
  allTabsRef: MutableRefObject<TerminalTab[]>;
  windowIdRef: MutableRefObject<string>;
  connectionsRef: MutableRefObject<ManagedConnection[]>;
  tabSeq: MutableRefObject<number>;
  windowSeq: MutableRefObject<number>;
  setWindows: Dispatch<SetStateAction<WorkWindow[]>>;
  setAllTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setWindowIdState: Dispatch<SetStateAction<string>>;
  setActiveId: Dispatch<SetStateAction<string>>;
  setConnections: Dispatch<SetStateAction<ManagedConnection[]>>;
  setRecent: Dispatch<SetStateAction<string[]>>;
  setBackgroundStarts: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setTabMenu: (menu: null) => void;
  setBarRename: (rename: null) => void;
  leaveTerminalFull: () => void;
  terminalTitle: (tab: TerminalTab) => string;
  defaultTitle: (tab: TerminalTab) => string;
  reconnectTab: (tab: { id: string; connectionId: string }) => void;
};

/**
 * MCP server (src-rust/src/mcp): agent CLIs see and arrange windows, panes and tabs. Each `mcp.ui`
 * event is one pure step of lib/workspace/mcpUi.ts on the current state (any window), applied here;
 * closing / disconnecting what the user opened waits for their answer (`mcpConfirm`).
 */
export function useMcpUi(deps: McpUiDeps) {
  const {
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
  } = deps;
  const windowsRef = useRef(windows);
  windowsRef.current = windows;
  /** Tabs an agent opened: closing them by MCP needs no confirmation. */
  const mcpOpened = useRef(new Set<string>());
  /** "An agent wants to close …": the call waits for the user's answer. */
  const [mcpConfirm, setMcpConfirm] = useState<{ requestId: string; title: string; message: string; run: () => unknown } | null>(null);
  const mcpConfirmRef = useRef(mcpConfirm);
  mcpConfirmRef.current = mcpConfirm;
  const mcpReply = (requestId: string, outcome: { result: unknown } | { error: unknown }) => {
    const answer =
      'result' in outcome
        ? { requestId, result: outcome.result }
        : outcome.error instanceof UiError
          ? { requestId, code: outcome.error.code, error: outcome.error.message }
          : { requestId, code: 'ui_failed', error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) };
    void backend.call('mcp.reply', answer).catch(() => undefined);
  };
  const uiState = (): UiState => ({ windows: windowsRef.current, tabs: allTabsRef.current, shown: windowIdRef.current });
  /** Apply a step: windows, tabs and the shown window (the refs at once, for the next event). */
  const applyUi = (next: UiState) => {
    const before = uiState();
    const activeBefore = before.windows.find(item => item.id === before.shown)?.activeTabId;
    windowsRef.current = next.windows;
    allTabsRef.current = next.tabs;
    setWindows(next.windows);
    setAllTabs(next.tabs);
    if (next.shown !== before.shown) {
      windowIdRef.current = next.shown;
      setWindowIdState(next.shown);
      setTabMenu(null);
      setBarRename(null);
      leaveTerminalFull();
    }
    const activeNow = next.windows.find(item => item.id === next.shown)?.activeTabId;
    const tab = next.tabs.find(item => item.id === activeNow);
    if (tab && (activeNow !== activeBefore || next.shown !== before.shown)) setActiveId(tab.connectionId);
  };
  /** A saved session by id or name (any case); none given = `fallback`, else the first local shell. */
  const mcpSession = (wanted: string | undefined, fallback?: string) => {
    const list = connectionsRef.current;
    if (!wanted) {
      const target = list.find(item => item.id === fallback) ?? list.find(item => item.transport === 'local');
      return target ?? fail('session_not_found', 'No local shell session is saved');
    }
    return (
      list.find(item => item.id === wanted) ??
      list.find(item => item.name.toLowerCase() === wanted.toLowerCase()) ??
      fail('session_not_found', `No saved session "${wanted}" (saved: ${list.map(item => item.name).join(', ')})`)
    );
  };
  /** A tab an agent adds: it starts its session even while hidden. */
  const mcpNewTab = (connectionId: string) => {
    const id = `tab-${++tabSeq.current}`;
    mcpOpened.current.add(id);
    setBackgroundStarts(current => new Set(current).add(id));
    setRecent(current => [connectionId, ...current.filter(item => item !== connectionId)].slice(0, RECENT_MAX));
    if (!backend.live)
      setConnections(current =>
        current.map(item => (item.id === connectionId && item.status === 'offline' ? { ...item, status: 'online' } : item)),
      );
    return { id, connectionId };
  };
  /** Ending sessions by MCP: at once when an agent opened all of them, else after the user agrees. */
  const mcpConfirmed = (requestId: string, ids: string[], title: string, message: string, apply: () => unknown) => {
    if (ids.every(id => mcpOpened.current.has(id))) return apply();
    if (mcpConfirmRef.current) return fail('busy', 'MetroTerm is already asking the user about closing something else');
    const pending = { requestId, title, message, run: apply };
    mcpConfirmRef.current = pending;
    setMcpConfirm(pending);
    return undefined;
  };
  useEffect(() => {
    if (!mcpConfirm) return;
    const timer = window.setTimeout(() => {
      setMcpConfirm(null);
      mcpReply(mcpConfirm.requestId, { error: new UiError('cancelled', 'The user did not answer in time') });
    }, 120_000);
    return () => window.clearTimeout(timer);
  }, [mcpConfirm]);
  /** Close tabs / a window by MCP (asking first unless an agent opened all of them). */
  const mcpClose = (requestId: string, ids: string[], title: string, message: string, run: () => UiStep) =>
    mcpConfirmed(requestId, ids, title, message, () => {
      const step = run();
      for (const id of ids) mcpOpened.current.delete(id);
      applyUi(step.state);
      return step.result;
    });
  /** One `mcp.ui` request; undefined = answered later (the user is asked first). */
  const mcpAction = (requestId: string, action: string, params: Record<string, unknown>): unknown => {
    const state = uiState();
    const focus = params.focus === true;
    const run = (step: UiStep) => {
      applyUi(step.state);
      return step.result;
    };
    switch (action) {
      case 'layout':
        return layoutOf(state, terminalTitle);
      case 'focus':
        return run(focusTerminal(state, stringParam(params, 'terminal') ?? ''));
      case 'focus_window':
        return run(focusWindow(state, stringParam(params, 'window') ?? ''));
      case 'open': {
        const at = targetPane(state, params);
        // With `terminal`: a clone of that tab (its session, its pane).
        const like = stringParam(params, 'terminal');
        const session = mcpSession(stringParam(params, 'session'), like ? tabOf(state, like).connectionId : undefined);
        const step = openTabStep(state, at, mcpNewTab(session.id), focus);
        log(t('MCP: an agent opened {{name}}', { name: session.name }));
        return run(step);
      }
      case 'split': {
        const at = targetPane(state, params);
        const shown = paneShownTab(state, at);
        const session = mcpSession(stringParam(params, 'session'), shown?.connectionId);
        const step = splitPane(state, at, sideParam(params, 'direction') ?? 'right', mcpNewTab(session.id), focus);
        log(t('MCP: an agent split a pane · {{name}}', { name: session.name }));
        return run(step);
      }
      case 'new_window': {
        const session = mcpSession(stringParam(params, 'session'));
        const fresh = freshWindow(state, windowSeq.current);
        windowSeq.current = fresh.seq;
        const step = newWindowStep(state, fresh.id, stringParam(params, 'name') ?? fresh.name, mcpNewTab(session.id), focus);
        log(t('MCP: an agent opened the window {{name}}', { name: String(step.result.name) }));
        return run(step);
      }
      case 'resize': {
        const toward = stringParam(params, 'direction');
        if (toward !== 'left' && toward !== 'right' && toward !== 'up' && toward !== 'down')
          return fail('invalid_arguments', 'direction must be left, right, up or down');
        const amount = typeof params.amount === 'number' ? Math.min(0.8, Math.max(0.01, params.amount)) : 0.1;
        return run(resizePane(state, targetPane(state, params), toward, amount));
      }
      case 'zoom':
        return run(zoomPane(state, targetPane(state, params), params.zoom !== false));
      case 'move': {
        const tabId = stringParam(params, 'terminal') ?? '';
        return run(moveTabStep(state, tabId, params));
      }
      case 'rename': {
        const tabId = stringParam(params, 'terminal') ?? '';
        const step = renameTabStep(state, tabId, stringParam(params, 'name'));
        const tab = tabOf(step.state, tabId);
        const name = tab.title ?? defaultTitle(tab);
        log(t('MCP: an agent renamed a tab → {{name}}', { name }));
        applyUi(step.state);
        return { ...step.result, name };
      }
      case 'reconnect': {
        const tab = sessionTab(state, params);
        if (!connectionsRef.current.some(item => item.id === tab.connectionId))
          return fail('session_not_found', 'The saved session of this tab was deleted');
        setBackgroundStarts(current => new Set(current).add(tab.id));
        reconnectTab(tab);
        return { terminal: tab.id };
      }
      case 'disconnect': {
        const tab = sessionTab(state, params);
        return mcpConfirmed(
          requestId,
          [tab.id],
          t('DISCONNECT'),
          t('An agent (MCP) wants to disconnect {{v}}. Its shell or connection ends; the tab stays.', { v: terminalTitle(tab) }),
          () => {
            if (!terminalRegistry.get(tab.id)?.disconnect()) return fail('not_connected', 'The terminal is not connected');
            const others = allTabsRef.current.some(item => item.id !== tab.id && item.connectionId === tab.connectionId);
            if (backend.live && !others)
              void backend.call('connection.disconnect', { connectionId: tab.connectionId }).catch(() => undefined);
            return { terminal: tab.id, disconnected: true };
          },
        );
      }
      case 'rename_window':
        return run(renameWindowStep(state, stringParam(params, 'window') ?? '', stringParam(params, 'name') ?? ''));
      case 'close':
      case 'close_pane': {
        const ids = closingTabs(state, action, params);
        const tabs = ids.map(id => tabOf(state, id));
        const names = tabs.map(tab => terminalTitle(tab));
        const list = names.slice(0, 4).join(', ') + (names.length > 4 ? ', …' : '');
        return mcpClose(
          requestId,
          ids,
          action === 'close' ? t('CLOSE TAB') : t('CLOSE PANE'),
          action === 'close'
            ? t('An agent (MCP) wants to close {{v}}. Its shell or connection ends.', { v: list })
            : t('An agent (MCP) wants to close the pane with {{v}}. Their shells and connections end.', { v: list }),
          () => closeTabsStep(uiState(), ids),
        );
      }
      case 'close_window': {
        const id = stringParam(params, 'window') ?? '';
        const ids = closingTabs(state, action, params);
        const name = state.windows.find(item => item.id === id)?.name ?? id;
        return mcpClose(
          requestId,
          ids,
          t('CLOSE WINDOW'),
          t('An agent (MCP) wants to close the window {{name}} with its {{count}} tab(s). Their shells and connections end.', {
            name,
            count: ids.length,
          }),
          () => closeWindowStep(uiState(), id),
        );
      }
      default:
        return fail('invalid_arguments', `Unknown action ${action} (update MetroTerm)`);
    }
  };
  const onMcpEvent = useStableCallback((event: BackendEvent) => {
    if (event.type !== 'mcp.ui') return;
    try {
      const result = mcpAction(event.requestId, event.action, event.params ?? {});
      if (result !== undefined) mcpReply(event.requestId, { result });
    } catch (error) {
      mcpReply(event.requestId, { error });
    }
  });
  useEffect(() => backend.on(onMcpEvent), [onMcpEvent]);
  /** The user's answer in the confirm dialog: run the step (and reply its result) or reply `cancelled`. */
  const answerMcpConfirm = (accept: boolean) => {
    const pending = mcpConfirm;
    if (!pending) return;
    setMcpConfirm(null);
    if (!accept) {
      mcpReply(pending.requestId, { error: new UiError('cancelled', 'The user said no') });
      return;
    }
    try {
      mcpReply(pending.requestId, { result: pending.run() });
    } catch (error) {
      mcpReply(pending.requestId, { error });
    }
  };
  return { mcpConfirm, answerMcpConfirm };
}
