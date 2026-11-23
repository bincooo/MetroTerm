import type { TerminalTab, TmuxNode } from '../../types';
import { TMUX_FIRST_PANE, tmuxNewId, tmuxResize, tmuxSplit, tmuxSwap, tmuxView } from './tmux';
import { defaultWindowName, newWindowLayout, WINDOW_NAME_MAX, type WorkWindow } from './windows';

/**
 * MCP (src-rust/src/mcp/tools/ui.rs): what the agent tools do to MetroTerm's windows, tmux panes and
 * terminal tabs. App answers each `mcp.ui` event with one of these pure steps on the current
 * state (any window, not only the shown one) and applies the result.
 *
 * Ids as the MCP server sees them: window `win-1`, pane `win-1:p-2` (window + pane of its tmux
 * tree), terminal = tab id (the server turns it into the terminal id of the tab's session).
 */
export type UiState = { windows: WorkWindow[]; tabs: TerminalTab[]; shown: string };
export type UiCode =
  | 'window_not_found'
  | 'pane_not_found'
  | 'terminal_not_found'
  | 'session_not_found'
  | 'own_terminal'
  | 'cancelled'
  | 'busy'
  | 'last_window'
  | 'no_split'
  | 'invalid_arguments'
  | 'not_connected';
export class UiError extends Error {
  constructor(
    readonly code: UiCode,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (code: UiCode, message: string): never => {
  throw new UiError(code, message);
};
/** A step's outcome: the new state and the answer for the agent. */
export type UiStep = { state: UiState; result: Record<string, unknown> };
export type Side = 'right' | 'down' | 'left' | 'up';
type At = { window: WorkWindow; pane: string };

export const paneRef = (windowId: string, paneId: string) => `${windowId}:${paneId}`;

/** A string argument (trimmed; '' = absent). */
export const stringParam = (params: Record<string, unknown>, key: string): string | undefined => {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};
export const sideParam = (params: Record<string, unknown>, key: string): Side | undefined => {
  const value = stringParam(params, key);
  if (value === undefined) return undefined;
  if (value === 'right' || value === 'down' || value === 'left' || value === 'up') return value;
  return fail('invalid_arguments', `${key} must be right, down, left or up`);
};

const windowOf = (state: UiState, id: string): WorkWindow =>
  state.windows.find(item => item.id === id) ?? fail('window_not_found', `No window ${id} (take the ids from list_windows)`);
const viewOf = (state: UiState, window: WorkWindow) =>
  tmuxView(
    window.tmux,
    state.tabs.filter(tab => tab.windowId === window.id),
    window.activeTabId,
    window.tmuxActive,
  );
export const tabOf = (state: UiState, id: string): TerminalTab =>
  state.tabs.find(tab => tab.id === id) ?? fail('terminal_not_found', `Terminal ${id} is not open in this MetroTerm window`);

const paneAt = (state: UiState, ref: string): At => {
  const colon = ref.lastIndexOf(':');
  if (colon < 0) return fail('pane_not_found', `No pane ${ref} (pane ids look like win-1:p-2, see list_windows)`);
  const window = windowOf(state, ref.slice(0, colon));
  const pane = ref.slice(colon + 1);
  if (!viewOf(state, window).panes.some(item => item.id === pane)) fail('pane_not_found', `No pane ${ref} (see list_windows)`);
  return { window, pane };
};
/** The tab a pane shows. */
export const paneShownTab = (state: UiState, at: At): TerminalTab | undefined =>
  viewOf(state, at.window).panes.find(pane => pane.id === at.pane)?.active;
const paneOfTab = (state: UiState, tab: TerminalTab): At => {
  const window = windowOf(state, tab.windowId ?? state.shown);
  return { window, pane: viewOf(state, window).paneOf.get(tab.id) ?? TMUX_FIRST_PANE };
};

/** The pane meant: `pane`, else the pane of `terminal`, else the focused pane of `window`, else of the shown window. */
export const targetPane = (state: UiState, params: Record<string, unknown>): At => {
  const pane = stringParam(params, 'pane');
  if (pane) return paneAt(state, pane);
  const terminal = stringParam(params, 'terminal');
  if (terminal) return paneOfTab(state, tabOf(state, terminal));
  const window = windowOf(state, stringParam(params, 'window') ?? state.shown);
  return { window, pane: viewOf(state, window).focus };
};

const patchWindow = (state: UiState, id: string, change: (window: WorkWindow) => Partial<WorkWindow>): UiState => ({
  ...state,
  windows: state.windows.map(item => (item.id === id ? { ...item, ...change(item) } : item)),
});
const current = (state: UiState, id: string) => windowOf(state, id);

/** Select a tab in its window (its pane gets the focus; the pane losing it keeps showing its tab). */
const select = (state: UiState, tabId: string): UiState => {
  const tab = tabOf(state, tabId);
  const window = windowOf(state, tab.windowId ?? state.shown);
  if (window.activeTabId === tabId) return state;
  const view = viewOf(state, window);
  const old = window.activeTabId ? view.paneOf.get(window.activeTabId) : undefined;
  return patchWindow(state, window.id, item => ({
    activeTabId: tabId,
    tmuxActive: old && item.activeTabId ? { ...item.tmuxActive, [old]: item.activeTabId } : item.tmuxActive,
  }));
};

/** Show a tab in its pane: in the focused pane that selects it, in another pane the focus stays. */
const showInPane = (state: UiState, tabId: string): UiState => {
  const tab = tabOf(state, tabId);
  const { window, pane } = paneOfTab(state, tab);
  if (!window.activeTabId || viewOf(state, window).focus === pane) return select(state, tabId);
  return patchWindow(state, window.id, item => ({ tmuxActive: { ...item.tmuxActive, [pane]: tabId } }));
};

/**
 * Tabs about to leave their windows: a window whose selected tab leaves selects its neighbour in
 * that pane (right, else left), else the shown tab of another pane; panes forget leaving tabs.
 */
const handOver = (state: UiState, leaving: Set<string>): UiState => {
  let next = state;
  for (const window of state.windows) {
    const view = viewOf(state, window);
    const own = view.panes.flatMap(pane => pane.tabs);
    if (!own.some(tab => leaving.has(tab.id))) continue;
    let activeTabId = window.activeTabId;
    if (activeTabId && leaving.has(activeTabId)) {
      const pane = view.panes.find(item => item.tabs.some(tab => tab.id === activeTabId));
      const siblings = pane?.tabs ?? [];
      const index = siblings.findIndex(tab => tab.id === activeTabId);
      const others = view.panes.flatMap(item => [item.active, ...item.tabs]).filter((tab): tab is TerminalTab => Boolean(tab));
      const heir =
        siblings.slice(index + 1).find(tab => !leaving.has(tab.id)) ??
        siblings
          .slice(0, Math.max(index, 0))
          .reverse()
          .find(tab => !leaving.has(tab.id)) ??
        others.find(tab => !leaving.has(tab.id));
      activeTabId = heir?.id ?? null;
    }
    const tmuxActive = Object.fromEntries(Object.entries(window.tmuxActive ?? {}).filter(([, id]) => !leaving.has(id)));
    next = patchWindow(next, window.id, () => ({ activeTabId, tmuxActive }));
  }
  return next;
};

/** list_windows: every window, its pane tree, its panes (letters as in their tab bars) and their tabs. */
export function layoutOf(state: UiState, titleOf: (tab: TerminalTab) => string) {
  return {
    windows: state.windows.map(window => {
      const view = viewOf(state, window);
      const letters = new Map(view.panes.map(pane => [pane.id, pane.letter]));
      const tree = (node: TmuxNode): unknown =>
        node.kind === 'pane'
          ? { pane: paneRef(window.id, node.id), letter: letters.get(node.id) }
          : {
              split: node.dir === 'row' ? 'left_right' : 'top_bottom',
              ratio: Math.round(node.ratio * 100) / 100,
              first: tree(node.first),
              second: tree(node.second),
            };
      return {
        window: window.id,
        name: window.name,
        shown: window.id === state.shown,
        zoomed: Boolean(window.tmuxZoomed) && view.panes.length > 1,
        focused_pane: paneRef(window.id, view.focus),
        layout: tree(view.tree),
        panes: view.panes.map(pane => ({
          pane: paneRef(window.id, pane.id),
          letter: pane.letter,
          focused: pane.id === view.focus,
          tabs: pane.tabs.map(tab => ({ terminal: tab.id, name: titleOf(tab), shown: tab.id === pane.active?.id })),
        })),
      };
    }),
  };
}

const where = (state: UiState, tabId: string) => {
  const { window, pane } = paneOfTab(state, tabOf(state, tabId));
  return { terminal: tabId, window: window.id, pane: paneRef(window.id, pane) };
};

/** focus_terminal: show the tab (its window, its pane focused). */
export function focusTerminal(state: UiState, tabId: string): UiStep {
  const tab = tabOf(state, tabId);
  const next = { ...select(state, tabId), shown: tab.windowId ?? state.shown };
  return { state: next, result: { ...where(next, tabId), focused: true } };
}

export function focusWindow(state: UiState, windowId: string): UiStep {
  const window = windowOf(state, windowId);
  return { state: { ...state, shown: window.id }, result: { window: window.id, shown: true } };
}

/** open_terminal: a new tab in a pane (the focused pane of a window by default). */
export function openTab(state: UiState, at: At, tab: { id: string; connectionId: string }, focus: boolean): UiStep {
  let next: UiState = { ...state, tabs: [...state.tabs, { ...tab, windowId: at.window.id, tmuxPane: at.pane }] };
  if (focus || !at.window.activeTabId) next = select(next, tab.id);
  if (focus) next = { ...next, shown: at.window.id };
  return { state: next, result: where(next, tab.id) };
}

/** Split tree: the new pane on `side` of `target`. */
const splitTree = (root: TmuxNode, target: string, added: string, side: Side): TmuxNode => {
  const tree = tmuxSplit(root, target, added, side === 'left' || side === 'right' ? 'row' : 'column');
  return side === 'left' || side === 'up' ? tmuxSwap(tree, target, added) : tree;
};

/** split_pane: a new pane beside `at` with a new tab. */
export function splitPane(state: UiState, at: At, side: Side, tab: { id: string; connectionId: string }, focus: boolean): UiStep {
  const view = viewOf(state, at.window);
  const root = at.window.tmux ?? view.tree;
  const added = tmuxNewId(root);
  let next: UiState = { ...state, tabs: [...state.tabs, { ...tab, windowId: at.window.id, tmuxPane: added }] };
  next = patchWindow(next, at.window.id, item => ({
    tmux: splitTree(root, at.pane, added, side),
    tmuxZoomed: undefined,
    tmuxActive: { ...item.tmuxActive, [added]: tab.id },
  }));
  if (focus || !at.window.activeTabId) next = select(next, tab.id);
  if (focus) next = { ...next, shown: at.window.id };
  return { state: next, result: where(next, tab.id) };
}

/** A free window id and name (`win-<n>`, "Window <n>"). */
export function freshWindow(state: UiState, seq: number): { id: string; seq: number; name: string } {
  const ids = new Set(state.windows.map(item => item.id));
  let n = seq;
  let id = `win-${++n}`;
  while (ids.has(id)) id = `win-${++n}`;
  const names = new Set(state.windows.map(item => item.name));
  let index = state.windows.length;
  while (names.has(defaultWindowName(index))) index++;
  return { id, seq: n, name: defaultWindowName(index) };
}

/** new_window: the fixed frame layout and one tab. */
export function newWindow(state: UiState, id: string, name: string, tab: { id: string; connectionId: string }, focus: boolean): UiStep {
  const window: WorkWindow = { id, name: name.slice(0, WINDOW_NAME_MAX), layout: newWindowLayout(id, state.windows), activeTabId: tab.id };
  const next: UiState = {
    windows: [...state.windows, window],
    tabs: [...state.tabs, { ...tab, windowId: id, tmuxPane: TMUX_FIRST_PANE }],
    shown: focus ? id : state.shown,
  };
  return { state: next, result: { ...where(next, tab.id), name: window.name } };
}

/** resize_pane: move the border of that orientation around the pane. */
export function resizePane(state: UiState, at: At, toward: 'left' | 'right' | 'up' | 'down', amount: number): UiStep {
  const view = viewOf(state, at.window);
  const root = at.window.tmux ?? view.tree;
  const tree = tmuxResize(root, at.pane, toward, amount);
  if (tree === root) {
    const across = toward === 'left' || toward === 'right' ? 'left | right' : 'top / bottom';
    return fail('no_split', `Pane ${paneRef(at.window.id, at.pane)} is not in a ${across} split`);
  }
  const next = patchWindow(state, at.window.id, () => ({ tmux: tree }));
  return { state: next, result: { pane: paneRef(at.window.id, at.pane), resized: true } };
}

/** zoom_pane: only this pane is shown (and focused), or all again. */
export function zoomPane(state: UiState, at: At, zoom: boolean): UiStep {
  const view = viewOf(state, at.window);
  let next = state;
  if (zoom) {
    if (view.panes.length < 2) return fail('no_split', `Window ${at.window.id} has only one pane`);
    const shown = view.panes.find(pane => pane.id === at.pane)?.active;
    if (shown) next = select(next, shown.id);
  }
  next = patchWindow(next, at.window.id, () => ({ tmuxZoomed: zoom ? true : undefined }));
  return { state: next, result: { window: at.window.id, pane: paneRef(at.window.id, at.pane), zoomed: zoom } };
}

/**
 * move_terminal: into another pane / window, or into a new pane on `split` side of the target pane;
 * `before` (a tab: into its pane, right before it) / `last` (end of the target pane) reorder tabs.
 */
export function moveTab(state: UiState, tabId: string, params: Record<string, unknown>): UiStep {
  const tab = tabOf(state, tabId);
  const split = sideParam(params, 'split');
  const beforeId = stringParam(params, 'before');
  const last = params.last === true;
  if (beforeId === tabId) return fail('invalid_arguments', 'A tab cannot go before itself');
  if (beforeId && (split || last)) return fail('invalid_arguments', 'before does not go with split or last');
  const before = beforeId ? tabOf(state, beforeId) : undefined;
  const from = paneOfTab(state, tab);
  const to = before
    ? paneOfTab(state, before)
    : stringParam(params, 'pane') || stringParam(params, 'window')
      ? targetPane(state, { ...params, terminal: undefined })
      : from;
  if (!split && !before && !last && to.window.id === from.window.id && to.pane === from.pane)
    return fail('invalid_arguments', 'The terminal is already in that pane: give another pane, a window, before, last or split');
  if (
    split &&
    to.window.id === from.window.id &&
    to.pane === from.pane &&
    viewOf(state, from.window).panes.find(pane => pane.id === from.pane)?.tabs.length === 1
  )
    return fail('invalid_arguments', 'The terminal is the only tab of its pane: there is nothing to split it from');
  // Only reordered within its pane: what each pane shows stays.
  const reordered = !split && to.window.id === from.window.id && to.pane === from.pane;
  let next = reordered ? state : handOver(state, new Set([tabId]));
  let pane = to.pane;
  if (split) {
    const window = current(next, to.window.id);
    const root = window.tmux ?? viewOf(next, window).tree;
    pane = tmuxNewId(root);
    next = patchWindow(next, window.id, () => ({ tmux: splitTree(root, to.pane, pane, split), tmuxZoomed: undefined }));
  }
  const moved = { ...tab, windowId: to.window.id, tmuxPane: pane };
  const rest = next.tabs.filter(item => item.id !== tabId);
  const at = before ? rest.findIndex(item => item.id === before.id) : -1;
  next = { ...next, tabs: at >= 0 ? [...rest.slice(0, at), moved, ...rest.slice(at)] : [...rest, moved] };
  if (!reordered) next = showInPane(next, tabId);
  return { state: next, result: where(next, tabId) };
}

export function renameWindow(state: UiState, windowId: string, name: string): UiStep {
  const window = windowOf(state, windowId);
  const value = name.trim().slice(0, WINDOW_NAME_MAX);
  if (!value) return fail('invalid_arguments', 'The name is empty');
  return { state: patchWindow(state, window.id, () => ({ name: value })), result: { window: window.id, name: value } };
}

/** The tabs a close_* call ends (the caller's own tab refused). */
export function closingTabs(state: UiState, action: 'close' | 'close_pane' | 'close_window', params: Record<string, unknown>) {
  const selfTab = stringParam(params, 'selfTab');
  let ids: string[];
  let label: string;
  if (action === 'close') {
    const list = Array.isArray(params.terminals) ? params.terminals.filter((id): id is string => typeof id === 'string') : [];
    const wanted = list.length ? list : [stringParam(params, 'terminal') ?? ''];
    ids = [...new Set(wanted.map(id => tabOf(state, id).id))];
    label = 'terminal';
  } else if (action === 'close_pane') {
    const at = targetPane(state, params);
    ids = (viewOf(state, at.window).panes.find(pane => pane.id === at.pane)?.tabs ?? []).map(tab => tab.id);
    label = 'pane';
  } else {
    const window = windowOf(state, stringParam(params, 'window') ?? '');
    if (state.windows.length < 2) fail('last_window', 'The last window cannot be closed');
    ids = state.tabs.filter(tab => tab.windowId === window.id).map(tab => tab.id);
    label = 'window';
  }
  if (selfTab && ids.includes(selfTab)) fail('own_terminal', `That ${label} holds your own terminal`);
  return ids;
}

/** Close tabs (close_terminal / close_pane). */
export function closeTabs(state: UiState, ids: string[]): UiStep {
  const closing = new Set(ids.filter(id => state.tabs.some(tab => tab.id === id)));
  if (!closing.size) return fail('terminal_not_found', 'Those terminals are not open any more');
  const next = handOver(state, closing);
  return { state: { ...next, tabs: next.tabs.filter(tab => !closing.has(tab.id)) }, result: { closed: closing.size } };
}

/** close_window: the window and its tabs; when it was shown, its neighbour is shown. */
export function closeWindow(state: UiState, windowId: string): UiStep {
  const index = state.windows.findIndex(item => item.id === windowId);
  if (index < 0) return fail('window_not_found', `No window ${windowId}`);
  if (state.windows.length < 2) return fail('last_window', 'The last window cannot be closed');
  const closed = state.tabs.filter(tab => tab.windowId === windowId).length;
  const shown = state.shown === windowId ? (state.windows[index + 1] ?? state.windows[index - 1]).id : state.shown;
  return {
    state: {
      windows: state.windows.filter(item => item.id !== windowId),
      tabs: state.tabs.filter(tab => tab.windowId !== windowId),
      shown,
    },
    result: { window: windowId, closed: true, tabs_closed: closed },
  };
}

/** rename_terminal: a custom tab name, or the default one back (null / empty). */
export const TAB_NAME_MAX = 80;
export function renameTab(state: UiState, tabId: string, name: string | undefined): UiStep {
  tabOf(state, tabId);
  const title = name?.trim().slice(0, TAB_NAME_MAX) || undefined;
  return {
    state: { ...state, tabs: state.tabs.map(tab => (tab.id === tabId ? { ...tab, title } : tab)) },
    result: { terminal: tabId, renamed: Boolean(title) },
  };
}

/** The tab a reconnect / disconnect is about (not the caller's own). */
export function sessionTab(state: UiState, params: Record<string, unknown>): TerminalTab {
  const tab = tabOf(state, stringParam(params, 'terminal') ?? '');
  if (tab.id === stringParam(params, 'selfTab')) fail('own_terminal', 'This is the terminal you are running in');
  return tab;
}
