import type { TerminalTab, TmuxNode } from '../types';
import { tmuxIds, tmuxLeaf, tmuxPrune, tmuxView } from './tmux';
import { defaultLayout, ensureFrame, isValidLayout, normalizeLayout, type LayoutNode } from '../layout';
import { readConfig } from './config';

/**
 * Window menu: MetroTerm's "windows" are workspaces inside the one app window, switched like
 * tabs. Each has its own panel layout (starting from the fixed frame of defaultLayout) and its
 * own terminal tabs. Terminals of the windows that are not shown keep running (their views stay
 * mounted, hidden), and so do their panels (portals into detached hosts).
 */
export type WorkWindow = {
  id: string;
  name: string;
  layout: LayoutNode;
  /** The window's selected terminal tab (in the focused tmux pane). */
  activeTabId: string | null;
  /** tmux panes of the terminal area (lib/tmux.ts); absent = one pane. */
  tmux?: TmuxNode;
  /** Shown tab of each pane (the focused pane shows `activeTabId`). */
  tmuxActive?: Record<string, string>;
  /** tmux zoom: only the focused pane is shown. */
  tmuxZoomed?: boolean;
};

/**
 * sessions.json → `windows`: every window with its layout and terminal tabs (custom names included).
 * A split terminal area is saved as `tmux` (a tree whose leaves are pane numbers), each tab's
 * `tmuxPane` (pane number), `tmuxActive` (index of the shown tab, per pane number) and `tmuxZoomed`.
 */
type SavedTmux = { pane: number } | { dir: 'row' | 'column'; ratio: number; first: SavedTmux; second: SavedTmux };
export type SavedTab = { connectionId: string; title?: string; tmuxPane?: number };
/** Before tmux panes were tab groups (≤ 0.0.1 deb73): a tab held the pane tree of its own split. */
type LegacyPane = { i: number } | { dir: 'row' | 'column'; ratio: number; first: LegacyPane; second: LegacyPane };
type LegacyTab = { paneOf?: number; panes?: LegacyPane; focus?: number; zoomed?: true };
type SavedWindow = {
  name?: string;
  layout?: unknown;
  tabs?: (SavedTab & LegacyTab)[];
  active?: number;
  tmux?: unknown;
  tmuxActive?: unknown;
  tmuxZoomed?: unknown;
};
type SavedWindowOut = {
  name: string;
  layout: LayoutNode;
  tabs: SavedTab[];
  active: number;
  tmux?: SavedTmux;
  tmuxActive?: number[];
  tmuxZoomed?: true;
};
export type WindowsDoc = { version: 1; active: number; list: SavedWindowOut[] };
/** Before the Window menu: one layout (`layout`) and one tab list (`tabs`, older: tabs.json). */
type LegacyTabsDoc = { open?: SavedTab[]; tabs?: SavedTab[]; active?: number };

export const WINDOW_NAME_MAX = 40;
export const defaultWindowName = (index: number) => `Window ${index + 1}`;

/** Leaf ids are unique across all windows (their panels stay mounted); the terminal panel is always `terminal`. */
const leafIds = (node: LayoutNode): string[] => (node.kind === 'leaf' ? [node.id] : [...leafIds(node.first), ...leafIds(node.second)]);
const mapLeaves = (node: LayoutNode, fn: (id: string, view: string) => string): LayoutNode =>
  node.kind === 'leaf'
    ? { ...node, id: fn(node.id, node.view) }
    : { ...node, first: mapLeaves(node.first, fn), second: mapLeaves(node.second, fn) };

/** Rename leaves whose id is already used (by another window, or twice in this one). */
export const uniqueLeaves = (layout: LayoutNode, windowId: string, taken: Set<string>): LayoutNode =>
  mapLeaves(layout, (id, view) => {
    if (view === 'terminal') return 'terminal';
    let next = id;
    for (let n = 1; taken.has(next) || next === 'terminal'; n++) next = `${windowId}/${id}${n > 1 ? `-${n}` : ''}`;
    taken.add(next);
    return next;
  });

/** The fixed frame for a new window: main = left | right, right = top / Sender, right-top = terminal | top-right. */
export const newWindowLayout = (windowId: string, existing: WorkWindow[]): LayoutNode => {
  const taken = new Set(existing.flatMap(window => leafIds(window.layout)));
  return uniqueLeaves(defaultLayout(), windowId, taken);
};

const restoreLayout = (saved: unknown): LayoutNode => (isValidLayout(saved) ? ensureFrame(normalizeLayout(saved)) : defaultLayout());

const restoreTabList = (saved: unknown, known: Set<string>): { tabs: (SavedTab & LegacyTab)[]; index: number[] } => {
  const list = Array.isArray(saved) ? saved : [];
  const tabs: (SavedTab & LegacyTab)[] = [];
  const index: number[] = [];
  list.forEach((tab, at) => {
    if (!tab || typeof tab.connectionId !== 'string' || !known.has(tab.connectionId)) return;
    tabs.push({
      ...tab,
      connectionId: tab.connectionId,
      title: typeof tab.title === 'string' && tab.title.trim() ? tab.title.trim().slice(0, 80) : undefined,
    });
    index.push(at);
  });
  return { tabs, index };
};

/** A saved tree → a tmux tree; `leaf` names (or drops: undefined) each saved leaf. */
const restoreTree = (saved: unknown, leaf: (node: { i?: unknown; pane?: unknown }) => string | undefined): TmuxNode | null => {
  const node = saved as Partial<{ i: number; pane: number; dir: string; ratio: number; first: unknown; second: unknown }> | null;
  if (!node || typeof node !== 'object') return null;
  if (!('first' in node) || !('second' in node)) {
    const id = leaf(node);
    return id ? tmuxLeaf(id) : null;
  }
  const first = restoreTree(node.first, leaf);
  const second = restoreTree(node.second, leaf);
  if (!first || !second) return first ?? second;
  const ratio = typeof node.ratio === 'number' && node.ratio > 0 && node.ratio < 1 ? node.ratio : 0.5;
  return { kind: 'split', dir: node.dir === 'column' ? 'column' : 'row', ratio, first, second };
};
const saveTree = (node: TmuxNode, numberOf: (id: string) => number): SavedTmux =>
  node.kind === 'pane'
    ? { pane: numberOf(node.id) }
    : { dir: node.dir, ratio: node.ratio, first: saveTree(node.first, numberOf), second: saveTree(node.second, numberOf) };
const paneName = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 64 ? `p-${n + 1}` : undefined);

type RestoredPanes = {
  tmux?: TmuxNode;
  paneOf: (string | undefined)[];
  tmuxActive?: Record<string, string>;
  tmuxZoomed?: true;
  active?: string;
};

/** Panes of a saved window: `tmux` + `tmuxPane`; tab ids are `idOf(savedIndex)`. */
function restoreTmux(
  item: SavedWindow,
  kept: { tabs: (SavedTab & LegacyTab)[]; index: number[] },
  idOf: (i: number) => string | undefined,
): RestoredPanes {
  const tree = restoreTree(item.tmux, node => paneName(node.pane));
  if (!tree || tree.kind === 'pane') return { paneOf: [] };
  const paneOf = kept.tabs.map(tab => paneName(tab.tmuxPane));
  const tmuxActive: Record<string, string> = {};
  if (Array.isArray(item.tmuxActive))
    item.tmuxActive.forEach((index, n) => {
      const pane = paneName(n);
      const id = typeof index === 'number' ? idOf(index) : undefined;
      if (pane && id) tmuxActive[pane] = id;
    });
  return { tmux: tree, paneOf, tmuxActive, tmuxZoomed: item.tmuxZoomed === true ? true : undefined };
}

/**
 * Older sessions.json (a tab with `panes` + its panes with `paneOf`): the selected (else the first)
 * split tab becomes the window's panes, one pane per terminal of it; every other tab — and the
 * panes of other split tabs — join the pane of that tab's own terminal.
 */
function migrateLegacyPanes(
  item: SavedWindow,
  kept: { tabs: (SavedTab & LegacyTab)[]; index: number[] },
  idOf: (i: number) => string | undefined,
): RestoredPanes {
  const activeAt = kept.index.indexOf(typeof item.active === 'number' ? item.active : 0);
  const hosts = kept.tabs
    .map((tab, at) => ({ tab, at }))
    .filter(({ tab }) => tab.panes && !('paneOf' in tab && typeof tab.paneOf === 'number'));
  const host = hosts.find(({ at }) => at === activeAt) ?? hosts[0];
  if (!host) return { paneOf: [] };
  const leafOf = new Map<string, string>();
  let n = 0;
  const tree = restoreTree(host.tab.panes, node => {
    const id = typeof node.i === 'number' ? idOf(node.i) : undefined;
    if (!id || leafOf.has(id)) return undefined;
    const pane = `p-${++n}`;
    leafOf.set(id, pane);
    return pane;
  });
  if (!tree || tree.kind === 'pane') return { paneOf: [] };
  const hostId = idOf(kept.index[host.at])!;
  const home = leafOf.get(hostId) ?? tmuxIds(tree)[0];
  const paneOf = kept.tabs.map((_, at) => leafOf.get(idOf(kept.index[at])!) ?? home);
  const focus = typeof host.tab.focus === 'number' ? idOf(host.tab.focus) : undefined;
  return {
    tmux: tree,
    paneOf,
    tmuxZoomed: host.tab.zoomed ? true : undefined,
    active: host.at === activeAt ? (focus ?? hostId) : undefined,
  };
}

/**
 * Windows and terminal tabs open when the app was last closed. Nothing saved yet → one window
 * with one local shell (works without any credentials). Older configs become window 1.
 */
export function restoreWindows(connections: { id: string; transport: string }[]): {
  windows: WorkWindow[];
  tabs: TerminalTab[];
  activeWindowId: string;
} {
  const known = new Set(connections.map(item => item.id));
  const doc = readConfig<{ active?: number; list?: SavedWindow[] }>('windows');
  let saved: SavedWindow[];
  let activeIndex = 0;
  if (doc && Array.isArray(doc.list) && doc.list.length) {
    saved = doc.list.filter(item => item && typeof item === 'object');
    activeIndex = typeof doc.active === 'number' ? doc.active : 0;
  } else {
    const legacy = readConfig<LegacyTabsDoc>('tabs');
    saved = [
      {
        layout: readConfig<unknown>('layout'),
        tabs: Array.isArray(legacy?.open) ? legacy.open : Array.isArray(legacy?.tabs) ? legacy.tabs : [],
        active: legacy?.active,
      },
    ];
  }
  if (!saved.length) saved = [{}];
  const windows: WorkWindow[] = [];
  const tabs: TerminalTab[] = [];
  const taken = new Set<string>();
  saved.forEach((item, at) => {
    const id = `win-${at + 1}`;
    const layout = uniqueLeaves(restoreLayout(item.layout), id, taken);
    const kept = restoreTabList(item.tabs, known);
    const base = tabs.length;
    const idOf = (savedIndex: number) => {
      const at = kept.index.indexOf(savedIndex);
      return at >= 0 ? `tab-${base + at + 1}` : undefined;
    };
    const legacy = kept.tabs.some(tab => tab.panes || typeof tab.paneOf === 'number');
    const panes = item.tmux ? restoreTmux(item, kept, idOf) : legacy ? migrateLegacyPanes(item, kept, idOf) : { paneOf: [] };
    const own: TerminalTab[] = kept.tabs.map((tab, n) => {
      const restored: TerminalTab = { id: `tab-${base + n + 1}`, connectionId: tab.connectionId, windowId: id };
      if (tab.title) restored.title = tab.title;
      const pane = panes.paneOf[n];
      if (panes.tmux && pane) restored.tmuxPane = pane;
      return restored;
    });
    tabs.push(...own);
    const activeAt = kept.index.indexOf(typeof item.active === 'number' ? item.active : 0);
    const activeTab = panes.active ?? own[activeAt]?.id ?? own[0]?.id ?? null;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, WINDOW_NAME_MAX) : defaultWindowName(at);
    const window: WorkWindow = { id, name, layout, activeTabId: activeTab };
    if (panes.tmux) {
      // Panes left without a tab (sessions deleted since) are dropped.
      const tree = tmuxPrune(panes.tmux, new Set(own.map(tab => tab.tmuxPane ?? '')));
      if (tree?.kind === 'split') {
        window.tmux = tree;
        if (panes.tmuxActive) window.tmuxActive = panes.tmuxActive;
        if (panes.tmuxZoomed) window.tmuxZoomed = true;
      } else for (const tab of own) delete tab.tmuxPane;
    }
    windows.push(window);
  });
  // First start / no tab left anywhere: one local shell in the first window.
  if (!tabs.length) {
    const first = connections.find(item => item.transport === 'local') ?? connections[0];
    if (first) {
      tabs.push({ id: 'tab-1', connectionId: first.id, windowId: windows[0].id });
      windows[0] = { ...windows[0], activeTabId: 'tab-1' };
    }
  }
  const active = windows[Math.min(Math.max(0, activeIndex), windows.length - 1)];
  return { windows, tabs, activeWindowId: active.id };
}

/** The `windows` document written to sessions.json. */
export function windowsDoc(windows: WorkWindow[], tabs: TerminalTab[], activeWindowId: string): WindowsDoc {
  return {
    version: 1,
    active: Math.max(
      0,
      windows.findIndex(window => window.id === activeWindowId),
    ),
    list: windows.map(window => {
      const own = tabs.filter(tab => tab.windowId === window.id);
      const view = tmuxView(window.tmux, own, window.activeTabId, window.tmuxActive);
      const split = view.tree.kind === 'split';
      const numbers = tmuxIds(view.tree);
      const saved: SavedWindowOut = {
        name: window.name,
        layout: window.layout,
        tabs: own.map(tab => {
          const entry: SavedTab = { connectionId: tab.connectionId };
          if (tab.title) entry.title = tab.title;
          if (split) entry.tmuxPane = numbers.indexOf(view.paneOf.get(tab.id) ?? numbers[0]);
          return entry;
        }),
        active: Math.max(
          0,
          own.findIndex(tab => tab.id === window.activeTabId),
        ),
      };
      if (split) {
        saved.tmux = saveTree(view.tree, id => numbers.indexOf(id));
        saved.tmuxActive = view.panes.map(pane => (pane.active ? own.indexOf(pane.active) : 0));
        if (window.tmuxZoomed) saved.tmuxZoomed = true;
      }
      return saved;
    }),
  };
}
