import type { SplitDirection, SplitState } from './components/SplitPane';

/** Panel content types that can be opened in any (non-terminal) panel. */
export type PanelView = 'explorer' | 'filer' | 'sender' | 'sessions' | 'monitor';
/** `empty` = a panel with no open tab (new Split halves, all tabs closed). */
export type LeafView = PanelView | 'terminal' | 'empty';
/**
 * A panel. Content panels hold tabs (`tabs`, opened from the Settings menu, no duplicates);
 * `view` is the active tab, or 'empty' when no tab is open. The terminal panel has no tabs here.
 */
export type LeafNode = { kind: 'leaf'; id: string; view: LeafView; tabs?: PanelView[] };
export type SplitNode = { kind: 'split'; id: string; direction: SplitDirection; state: SplitState; first: LayoutNode; second: LayoutNode };
export type LayoutNode = LeafNode | SplitNode;
type Side = 'first' | 'second';

export const PANEL_VIEWS: { view: PanelView; label: string }[] = [
  { view: 'explorer', label: 'Explorer' },
  { view: 'filer', label: 'Filer' },
  { view: 'sender', label: 'Sender' },
  { view: 'sessions', label: 'Session' },
  { view: 'monitor', label: 'Monitor' },
];

const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * The fixed frame. Its three splitters always exist — closing or hiding a panel never removes them:
 *
 *   |        | terminal | top-right |      main      = left | right
 *   |  left  |----------------------|      right     = top / Sender
 *   |        |        Sender        |      right-top = terminal | top-right
 *
 * The top-right panel starts hidden (drag its splitter from the right edge to show it).
 * Splits created with "Split" and the Explorer/Filer split inside the left slot are not part
 * of the frame and disappear with their panels as before.
 */
const FRAME_SPLITS = ['main', 'right', 'right-top'] as const;
const isFrameSplit = (node: LayoutNode) => node.kind === 'split' && (FRAME_SPLITS as readonly string[]).includes(node.id);

/** The frame's Sender panel (bottom of `right`): its minimum size is halved (SENDER_MIN_PANEL_SIZE). */
export const SENDER_SLOT = { split: 'right', side: 'second' } as const;

const TOP_RIGHT_RATIO = 0.7;
export const defaultLayout = (): LayoutNode => ({
  kind: 'split',
  id: 'main',
  direction: 'horizontal',
  state: { ratio: 0.2, collapsed: 'none' },
  first: {
    kind: 'split',
    id: 'left',
    direction: 'vertical',
    state: { ratio: 0.5, collapsed: 'none' },
    first: { kind: 'leaf', id: 'explorer-1', view: 'explorer', tabs: ['explorer'] },
    second: { kind: 'leaf', id: 'filer-1', view: 'filer', tabs: ['filer'] },
  },
  second: {
    kind: 'split',
    id: 'right',
    direction: 'vertical',
    state: { ratio: 0.7, collapsed: 'none' },
    first: {
      kind: 'split',
      id: 'right-top',
      direction: 'horizontal',
      state: { ratio: TOP_RIGHT_RATIO, collapsed: 'second' },
      first: { kind: 'leaf', id: 'terminal', view: 'terminal' },
      second: { kind: 'leaf', id: 'top-right-1', view: 'empty', tabs: [] },
    },
    second: { kind: 'leaf', id: 'sender-1', view: 'sender', tabs: ['sender'] },
  },
});

/** Split direction for a panel: Sender panels split left | right, everything else top / bottom. */
export const splitDirectionFor = (view: LeafView): SplitDirection => (view === 'sender' ? 'horizontal' : 'vertical');

const mapNode = (node: LayoutNode, id: string, fn: (target: LayoutNode) => LayoutNode): LayoutNode => {
  if (node.id === id) return fn(node);
  if (node.kind === 'leaf') return node;
  const first = mapNode(node.first, id, fn);
  const second = mapNode(node.second, id, fn);
  return first === node.first && second === node.second ? node : { ...node, first, second };
};

const findParent = (node: LayoutNode, id: string): { parent: SplitNode; side: Side } | null => {
  if (node.kind === 'leaf') return null;
  if (node.first.id === id) return { parent: node, side: 'first' };
  if (node.second.id === id) return { parent: node, side: 'second' };
  return findParent(node.first, id) ?? findParent(node.second, id);
};

const setSplitState = (root: LayoutNode, splitId: string, state: SplitState) =>
  mapNode(root, splitId, node => (node.kind === 'split' ? { ...node, state } : node));

const emptyLeaf = (): LeafNode => ({ kind: 'leaf', id: newId('panel'), view: 'empty', tabs: [] });
const contentLeaves = (node: LayoutNode): LeafNode[] =>
  node.kind === 'leaf' ? (node.view === 'terminal' ? [] : [node]) : [...contentLeaves(node.first), ...contentLeaves(node.second)];
const hasContentDeep = (node: LayoutNode): boolean =>
  node.kind === 'leaf' ? node.view !== 'empty' : hasContentDeep(node.first) || hasContentDeep(node.second);
export const tabsOf = (leaf: LeafNode): PanelView[] => leaf.tabs ?? (leaf.view === 'terminal' || leaf.view === 'empty' ? [] : [leaf.view]);

/** Split a panel into two halves: the original panel plus a new EMPTY panel. */
export const splitLeaf = (root: LayoutNode, leafId: string): LayoutNode =>
  mapNode(root, leafId, node => {
    if (node.kind !== 'leaf' || node.view === 'terminal') return node;
    return {
      kind: 'split',
      id: newId('split'),
      direction: splitDirectionFor(node.view),
      state: { ratio: 0.5, collapsed: 'none' },
      first: node,
      second: emptyLeaf(),
    };
  });

/** Open a view as a tab in a panel (appended after existing tabs). Already open → just activate it. */
export const openTab = (root: LayoutNode, leafId: string, view: PanelView) =>
  mapNode(root, leafId, node => {
    if (node.kind !== 'leaf' || node.view === 'terminal') return node;
    const tabs = tabsOf(node);
    return { ...node, view, tabs: tabs.includes(view) ? tabs : [...tabs, view] };
  });

/** Activate an open tab. */
export const activateTab = (root: LayoutNode, leafId: string, view: PanelView) =>
  mapNode(root, leafId, node => (node.kind === 'leaf' && tabsOf(node).includes(view) ? { ...node, view } : node));

/**
 * Drag a tab: put `view` before `before` (`null` = last) in panel `toId`, and make it the active tab there.
 * Same panel = reorder. Another panel = move: it leaves `fromId` (whose neighbour tab becomes active,
 * or the panel is left empty) and is refused when `toId` already has that view.
 */
export const moveTab = (root: LayoutNode, fromId: string, view: PanelView, toId: string, before: PanelView | null): LayoutNode => {
  const place = (tabs: PanelView[]) => {
    const rest = tabs.filter(tab => tab !== view);
    const index = before === null ? -1 : rest.indexOf(before);
    if (index < 0) rest.push(view);
    else rest.splice(index, 0, view);
    return rest;
  };
  if (fromId === toId)
    return mapNode(root, toId, node =>
      node.kind === 'leaf' && tabsOf(node).includes(view) ? { ...node, tabs: place(tabsOf(node)), view } : node,
    );
  const target = findLeaf(root, toId);
  const source = findLeaf(root, fromId);
  if (!target || !source || target.view === 'terminal' || tabsOf(target).includes(view) || !tabsOf(source).includes(view)) return root;
  const removed = closeTab(root, fromId, view);
  return mapNode(removed, toId, node => (node.kind === 'leaf' ? { ...node, tabs: place(tabsOf(node)), view } : node));
};

const findLeaf = (node: LayoutNode, id: string): LeafNode | null =>
  node.kind === 'leaf' ? (node.id === id ? node : null) : (findLeaf(node.first, id) ?? findLeaf(node.second, id));

/** Close one tab; the neighbour becomes active. Closing the last tab leaves an empty panel. */
export const closeTab = (root: LayoutNode, leafId: string, view: PanelView) =>
  mapNode(root, leafId, node => {
    if (node.kind !== 'leaf' || node.view === 'terminal') return node;
    const tabs = tabsOf(node);
    const index = tabs.indexOf(view);
    if (index < 0) return node;
    const rest = tabs.filter(tab => tab !== view);
    const nextView: LeafView = node.view !== view ? node.view : (rest[Math.min(index, rest.length - 1)] ?? 'empty');
    return { ...node, tabs: rest, view: nextView };
  });

/**
 * Close (destroy) a panel.
 * - Inside a non-frame split: the panel is removed together with that splitter — the sibling
 *   takes the split's place, so no handle is left behind.
 * - Directly in a frame slot: the slot keeps its splitter; it is emptied and hidden, and the
 *   splitter stays at the edge so an (empty) panel can be dragged back out.
 * The terminal panel can't be closed. The last remaining content panel is only emptied
 * (its tabs are closed) so there is always a panel left to open views from.
 */
export const closeNode = (root: LayoutNode, id: string): LayoutNode => {
  const found = findParent(root, id);
  if (!found) return root;
  const target = found.parent[found.side];
  if (target.kind === 'leaf' && target.view === 'terminal') return root;
  const lastContent = contentLeaves(root).length <= 1;
  if (isFrameSplit(found.parent)) {
    const emptied = mapNode(root, id, () => emptyLeaf());
    if (lastContent) return emptied;
    const state = found.parent.state;
    return setSplitState(emptied, found.parent.id, { ratio: state.ratio, collapsed: found.side });
  }
  if (lastContent) return mapNode(root, id, node => (node.kind === 'leaf' ? { ...node, view: 'empty', tabs: [] } : node));
  const sibling = found.parent[found.side === 'first' ? 'second' : 'first'];
  return mapNode(root, found.parent.id, () => sibling);
};

/**
 * An EMPTY panel is never kept hidden: when one side of a split gets hidden (dragged
 * below the minimum, or no longer fits) and that side is an empty panel, the split and
 * its splitter are removed — so no stray handle is left next to another one.
 * Panels with content keep the normal hide / drag-back-to-restore behaviour.
 */
export const removeEmptySide = (root: LayoutNode, splitId: string, side: Side): LayoutNode => {
  let result = root;
  const visit = (node: LayoutNode) => {
    if (node.kind !== 'split') return;
    if (node.id === splitId) {
      if (isFrameSplit(node)) return; // frame slots stay (hidden) — their splitter is permanent
      const hidden = node[side];
      if (hidden.kind === 'leaf' && hidden.view === 'empty' && contentLeaves(root).length > 1)
        result = mapNode(root, splitId, () => node[side === 'first' ? 'second' : 'first']);
      return;
    }
    visit(node.first);
    visit(node.second);
  };
  visit(root);
  return result;
};

/**
 * Splits created by "Split" (vs. the fixed Explorer/Filer · Terminal/Sender frame) never leave
 * a handle behind: dragging one side below the minimum closes that side (like its × button),
 * and when a side just doesn't fit it is hidden without an edge handle.
 */
export const isUserSplit = (node: LayoutNode) => node.kind === 'split' && node.id.startsWith('split-');

const findNode = (node: LayoutNode, id: string): LayoutNode | null =>
  node.id === id ? node : node.kind === 'split' ? (findNode(node.first, id) ?? findNode(node.second, id)) : null;

/** Apply a splitter change; hiding an empty panel removes it instead (see removeEmptySide). */
export const applySplitChange = (root: LayoutNode, splitId: string, state: SplitState): LayoutNode => {
  const node = findNode(root, splitId);
  if (node && node.kind === 'split' && isUserSplit(node) && state.collapsed !== 'none') {
    const keep = node[state.collapsed === 'first' ? 'second' : 'first'];
    if (!hasContentDeep(keep) && hasContentDeep(node[state.collapsed]) && contentLeaves(root).length <= contentLeaves(node).length)
      return root;
    return mapNode(root, splitId, () => keep);
  }
  if (state.collapsed !== 'none') {
    const removed = removeEmptySide(root, splitId, state.collapsed);
    if (removed !== root) return removed;
  }
  return setSplitState(root, splitId, state);
};

/**
 * Normalize persisted layouts: add `tabs` to panels saved by older versions and drop
 * hidden empty panels left over from the previous close behaviour (with their splitter).
 */
export const normalizeLayout = (node: LayoutNode): LayoutNode => {
  if (node.kind === 'leaf') return node.view === 'terminal' ? node : { ...node, tabs: tabsOf(node) };
  const first = normalizeLayout(node.first);
  const second = normalizeLayout(node.second);
  if (isFrameSplit(node)) return { ...node, first, second };
  // Hidden sides without any content (old close behaviour / old splits) are dropped with their splitter.
  const isEmpty = (child: LayoutNode) => !hasContentDeep(child);
  if (node.state.collapsed === 'first' && isEmpty(first)) return second;
  if (node.state.collapsed === 'second' && isEmpty(second)) return first;
  // Split-created panels hidden by older versions come back instead of leaving an extra handle.
  if (isUserSplit(node) && node.state.collapsed !== 'none') return { ...node, first, second, state: { ratio: 0.5, collapsed: 'none' } };
  return { ...node, first, second };
};

/** Validate persisted layouts: well-formed tree with exactly one terminal panel. */
export const isValidLayout = (node: unknown): node is LayoutNode => {
  let terminals = 0;
  const walk = (value: any): boolean => {
    if (!value || typeof value.id !== 'string') return false;
    if (value.kind === 'leaf') {
      if (value.view === 'terminal') terminals++;
      return (
        ['explorer', 'filer', 'sender', 'sessions', 'monitor', 'terminal', 'empty'].includes(value.view) &&
        (value.tabs === undefined ||
          (Array.isArray(value.tabs) &&
            value.tabs.every((tab: unknown) => ['explorer', 'filer', 'sender', 'sessions', 'monitor'].includes(tab as string))))
      );
    }
    return (
      value.kind === 'split' &&
      ['horizontal', 'vertical'].includes(value.direction) &&
      typeof value.state?.ratio === 'number' &&
      walk(value.first) &&
      walk(value.second)
    );
  };
  return walk(node) && terminals === 1;
};

const emptySlot = (): LeafNode => emptyLeaf();
const containsTerminal = (node: LayoutNode): boolean =>
  node.kind === 'leaf' ? node.view === 'terminal' : containsTerminal(node.first) || containsTerminal(node.second);

/** True when the tree has the fixed frame: main(left | right(right-top(terminal | ·) / ·)). */
const hasFrame = (root: LayoutNode) =>
  root.kind === 'split' &&
  root.id === 'main' &&
  root.direction === 'horizontal' &&
  root.second.kind === 'split' &&
  root.second.id === 'right' &&
  root.second.direction === 'vertical' &&
  root.second.first.kind === 'split' &&
  root.second.first.id === 'right-top' &&
  root.second.first.direction === 'horizontal' &&
  root.second.first.first.kind === 'leaf' &&
  root.second.first.first.view === 'terminal' &&
  !containsTerminal(root.first) &&
  !containsTerminal(root.second.second) &&
  !containsTerminal(root.second.first.second);

/**
 * Bring layouts saved by older versions into the fixed frame. Their panels stay where they were;
 * slots that no longer existed (closed earlier, or the new top-right slot) come back hidden,
 * with their splitter at the edge.
 */
export const ensureFrame = (root: LayoutNode): LayoutNode => {
  if (hasFrame(root)) return root;
  const hidden = (collapsed: SplitState['collapsed'], ratio: number): SplitState => ({ ratio, collapsed });
  let left: LayoutNode = emptySlot();
  let mainState = hidden('first', 0.2);
  let rest: LayoutNode = root;
  if (root.kind === 'split' && root.id === 'main' && containsTerminal(root.second) && !containsTerminal(root.first)) {
    left = root.first;
    mainState = root.state;
    rest = root.second;
  }
  let top: LayoutNode = rest;
  let bottom: LayoutNode = emptySlot();
  let rightState = hidden('second', 0.7);
  if (rest.kind === 'split' && rest.id === 'right' && containsTerminal(rest.first) && !containsTerminal(rest.second)) {
    top = rest.first;
    bottom = rest.second;
    rightState = rest.state;
  }
  if (top.kind !== 'leaf' || top.view !== 'terminal') return defaultLayout();
  return {
    kind: 'split',
    id: 'main',
    direction: 'horizontal',
    state: mainState,
    first: left,
    second: {
      kind: 'split',
      id: 'right',
      direction: 'vertical',
      state: rightState,
      first: {
        kind: 'split',
        id: 'right-top',
        direction: 'horizontal',
        state: hidden('second', TOP_RIGHT_RATIO),
        first: top,
        second: emptySlot(),
      },
      second: bottom,
    },
  };
};
