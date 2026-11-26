import type { TerminalTab, TmuxNode } from '../../types';

/**
 * tmux panes of the terminal area (each pane is a tab group). Each window splits its terminal
 * area into panes (`WorkWindow.tmux`, a tree whose leaves are pane ids); every pane is a tab group
 * with its own tab bar and toolbar, and every terminal tab belongs to one pane
 * (`TerminalTab.tmuxPane`). A pane shows one of its tabs: the window's selected tab in the
 * focused pane, `WorkWindow.tmuxActive[pane]` in the others. All functions here are pure.
 *
 *   row    = left | right   (tmux `%`, split-window -h)
 *   column = top / bottom   (tmux `"`, split-window -v)
 */
export type TmuxDirection = 'row' | 'column';
type TmuxToward = 'left' | 'right' | 'up' | 'down';
export type Rect = { x: number; y: number; w: number; h: number };
/** A splitter: the split's box, its direction and its path in the tree ('' = root, then 'a' / 'b'). */
export type TmuxSplitter = { path: string; dir: TmuxDirection; box: Rect; ratio: number };

const TMUX_MIN_RATIO = 0.1;
/** The pane of a window that was never split. */
export const TMUX_FIRST_PANE = 'p-1';
export const tmuxLeaf = (id = TMUX_FIRST_PANE): TmuxNode => ({ kind: 'pane', id });
const clampRatio = (ratio: number) => Math.min(1 - TMUX_MIN_RATIO, Math.max(TMUX_MIN_RATIO, ratio));

export const tmuxIds = (node: TmuxNode): string[] => (node.kind === 'pane' ? [node.id] : [...tmuxIds(node.first), ...tmuxIds(node.second)]);

/** A pane id not used in the tree yet (`p-<n>`). */
export const tmuxNewId = (root: TmuxNode): string => {
  const taken = new Set(tmuxIds(root));
  let n = taken.size + 1;
  while (taken.has(`p-${n}`)) n++;
  return `p-${n}`;
};

/** Split pane `target`: it keeps the left / top half, `added` gets the other one. */
export const tmuxSplit = (root: TmuxNode, target: string, added: string, dir: TmuxDirection): TmuxNode => {
  if (root.kind === 'pane')
    return root.id === target ? { kind: 'split', dir, ratio: 0.5, first: root, second: { kind: 'pane', id: added } } : root;
  return { ...root, first: tmuxSplit(root.first, target, added, dir), second: tmuxSplit(root.second, target, added, dir) };
};

/** Keep only the panes in `keep`; a split left with one side becomes that side. null when nothing is left. */
export const tmuxPrune = (root: TmuxNode, keep: Set<string>): TmuxNode | null => {
  if (root.kind === 'pane') return keep.has(root.id) ? root : null;
  const first = tmuxPrune(root.first, keep);
  const second = tmuxPrune(root.second, keep);
  if (!first) return second;
  if (!second) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
};

const nodeAt = (root: TmuxNode, path: string): TmuxNode | null => {
  let node: TmuxNode = root;
  for (const step of path) {
    if (node.kind !== 'split') return null;
    node = step === 'a' ? node.first : node.second;
  }
  return node;
};
const mapAt = (root: TmuxNode, path: string, fn: (node: TmuxNode) => TmuxNode): TmuxNode => {
  if (!path) return fn(root);
  if (root.kind !== 'split') return root;
  return path[0] === 'a'
    ? { ...root, first: mapAt(root.first, path.slice(1), fn) }
    : { ...root, second: mapAt(root.second, path.slice(1), fn) };
};

/** Drag a splitter. */
export const tmuxSetRatio = (root: TmuxNode, path: string, ratio: number): TmuxNode =>
  mapAt(root, path, node => (node.kind === 'split' ? { ...node, ratio: clampRatio(ratio) } : node));

/** Path of a pane ('' = root). */
const pathOf = (root: TmuxNode, id: string, path = ''): string | null => {
  if (root.kind === 'pane') return root.id === id ? path : null;
  return pathOf(root.first, id, `${path}a`) ?? pathOf(root.second, id, `${path}b`);
};

/**
 * tmux resize-pane -L / -R / -U / -D: move the nearest border of that orientation around the
 * pane (`step` = share of the split's size).
 */
export const tmuxResize = (root: TmuxNode, id: string, toward: TmuxToward, step = 0.05): TmuxNode => {
  const path = pathOf(root, id);
  if (path === null) return root;
  const dir: TmuxDirection = toward === 'left' || toward === 'right' ? 'row' : 'column';
  for (let length = path.length - 1; length >= 0; length--) {
    const at = path.slice(0, length);
    const node = nodeAt(root, at);
    if (node?.kind === 'split' && node.dir === dir) {
      const delta = toward === 'left' || toward === 'up' ? -step : step;
      return tmuxSetRatio(root, at, node.ratio + delta);
    }
  }
  return root;
};

/** Exchange two panes (tmux swap-pane `{` / `}`). */
export const tmuxSwap = (root: TmuxNode, a: string, b: string): TmuxNode => {
  if (root.kind === 'pane') return root.id === a ? { kind: 'pane', id: b } : root.id === b ? { kind: 'pane', id: a } : root;
  return { ...root, first: tmuxSwap(root.first, a, b), second: tmuxSwap(root.second, a, b) };
};

/** Where every pane and splitter is, as fractions (0…1) of the terminal area. */
export const tmuxLayout = (root: TmuxNode): { rects: Map<string, Rect>; splitters: TmuxSplitter[] } => {
  const rects = new Map<string, Rect>();
  const splitters: TmuxSplitter[] = [];
  const walk = (node: TmuxNode, box: Rect, path: string) => {
    if (node.kind === 'pane') {
      rects.set(node.id, box);
      return;
    }
    splitters.push({ path, dir: node.dir, box, ratio: node.ratio });
    if (node.dir === 'row') {
      const w = box.w * node.ratio;
      walk(node.first, { ...box, w }, `${path}a`);
      walk(node.second, { ...box, x: box.x + w, w: box.w - w }, `${path}b`);
    } else {
      const h = box.h * node.ratio;
      walk(node.first, { ...box, h }, `${path}a`);
      walk(node.second, { ...box, y: box.y + h, h: box.h - h }, `${path}b`);
    }
  };
  walk(root, { x: 0, y: 0, w: 1, h: 1 }, '');
  return { rects, splitters };
};

const EPS = 1e-6;
/** tmux select-pane -L / -R / -U / -D: the touching pane in that direction (most overlap). */
export const tmuxToward = (root: TmuxNode, from: string, toward: TmuxToward): string | null => {
  const { rects } = tmuxLayout(root);
  const at = rects.get(from);
  if (!at) return null;
  let best: { id: string; overlap: number } | null = null;
  for (const [id, rect] of rects) {
    if (id === from) continue;
    const touches =
      toward === 'left'
        ? Math.abs(rect.x + rect.w - at.x) < EPS
        : toward === 'right'
          ? Math.abs(at.x + at.w - rect.x) < EPS
          : toward === 'up'
            ? Math.abs(rect.y + rect.h - at.y) < EPS
            : Math.abs(at.y + at.h - rect.y) < EPS;
    if (!touches) continue;
    const overlap =
      toward === 'left' || toward === 'right'
        ? Math.min(at.y + at.h, rect.y + rect.h) - Math.max(at.y, rect.y)
        : Math.min(at.x + at.w, rect.x + rect.w) - Math.max(at.x, rect.x);
    if (overlap > EPS && (!best || overlap > best.overlap)) best = { id, overlap };
  }
  return best?.id ?? null;
};

/** Letter of the n-th pane (tab bar, right side): A, B … Z, AA … */
const tmuxLetter = (index: number): string =>
  (index >= 26 ? tmuxLetter(Math.floor(index / 26) - 1) : '') + String.fromCharCode(65 + (index % 26));

export type TmuxPaneView = { id: string; letter: string; tabs: TerminalTab[]; active: TerminalTab | undefined };
type TmuxView = {
  /** The tree without empty panes (one empty pane when the window has no tab). */
  tree: TmuxNode;
  panes: TmuxPaneView[];
  /** Pane of each tab of the window. */
  paneOf: Map<string, string>;
  /** Pane of the selected tab (else the first pane). */
  focus: string;
};

/**
 * What a window shows: its panes in tree order with their tabs and shown tab. Tabs whose pane is
 * not in the tree go to the first pane; panes without tabs are left out.
 */
export function tmuxView(
  root: TmuxNode | undefined,
  tabs: TerminalTab[],
  activeTabId: string | null,
  tmuxActive: Record<string, string> | undefined,
): TmuxView {
  const stored = root ?? tmuxLeaf();
  const ids = tmuxIds(stored);
  const known = new Set(ids);
  const paneOf = new Map<string, string>();
  for (const tab of tabs) paneOf.set(tab.id, tab.tmuxPane && known.has(tab.tmuxPane) ? tab.tmuxPane : ids[0]);
  const used = new Set(paneOf.values());
  const tree = tmuxPrune(stored, used) ?? tmuxLeaf(ids[0]);
  const focus = (activeTabId && paneOf.get(activeTabId)) || tmuxIds(tree)[0];
  const panes = tmuxIds(tree).map((id, index): TmuxPaneView => {
    const own = tabs.filter(tab => paneOf.get(tab.id) === id);
    const wanted = id === focus ? activeTabId : tmuxActive?.[id];
    return { id, letter: tmuxLetter(index), tabs: own, active: own.find(tab => tab.id === wanted) ?? own[0] };
  });
  return { tree, panes, paneOf, focus };
}
