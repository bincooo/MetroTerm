import { tabsOf, type LayoutNode, type LeafNode, type LeafView, type PanelView } from '../layout';

/**
 * Focus Mode (menu bar → Focus Mode, Ctrl+Shift+F): the window is maximized without a title bar or
 * window buttons, optionally full screen / always on top, and chosen bars and panes are
 * shown or hidden. Settings live in settings.json → `focus`; the mode itself is not saved.
 */
export type TriState = 'yes' | 'no' | 'preserve';
export type Visibility = 'show' | 'hide' | 'preserve';
export type FocusBar = 'menu' | 'tool' | 'status';

export type FocusConfig = {
  fullScreen: TriState;
  alwaysOnTop: TriState;
  bars: Record<FocusBar, Visibility>;
  panes: Record<PanelView, Visibility>;
  /** "Show this dialog when focus mode starts". */
  showDialog: boolean;
};

export const FOCUS_BARS: { id: FocusBar; label: string }[] = [
  { id: 'menu', label: 'Menu Bar' },
  { id: 'tool', label: 'Tool Bar' },
  { id: 'status', label: 'Status Bar' },
];

const DEFAULT_FOCUS: FocusConfig = {
  fullScreen: 'yes',
  alwaysOnTop: 'preserve',
  bars: { menu: 'preserve', tool: 'preserve', status: 'preserve' },
  panes: { explorer: 'preserve', filer: 'preserve', sender: 'preserve', sessions: 'preserve', monitor: 'preserve' },
  showDialog: true,
};

const tri = (value: unknown, fallback: TriState): TriState =>
  value === 'yes' || value === 'no' || value === 'preserve' ? value : fallback;
const vis = (value: unknown): Visibility => (value === 'show' || value === 'hide' ? value : 'preserve');

export function sanitizeFocusConfig(value: unknown): FocusConfig {
  const doc = (value && typeof value === 'object' ? value : {}) as Partial<FocusConfig>;
  const bars = (doc.bars ?? {}) as Partial<Record<FocusBar, unknown>>;
  const panes = (doc.panes ?? {}) as Partial<Record<PanelView, unknown>>;
  return {
    fullScreen: tri(doc.fullScreen, DEFAULT_FOCUS.fullScreen),
    alwaysOnTop: tri(doc.alwaysOnTop, DEFAULT_FOCUS.alwaysOnTop),
    bars: { menu: vis(bars.menu), tool: vis(bars.tool), status: vis(bars.status) },
    panes: {
      explorer: vis(panes.explorer),
      filer: vis(panes.filer),
      sender: vis(panes.sender),
      sessions: vis(panes.sessions),
      monitor: vis(panes.monitor),
    },
    showDialog: doc.showDialog !== false,
  };
}

/** What one panel shows in Focus Mode: its visible tabs (in order) and the active one. */
export type FocusLeaf = { tabs: PanelView[]; view: LeafView };
type FocusLayout = { tree: LayoutNode; leaves: Map<string, FocusLeaf> };

const allLeaves = (node: LayoutNode): LeafNode[] => (node.kind === 'leaf' ? [node] : [...allLeaves(node.first), ...allLeaves(node.second)]);
const firstContentLeaf = (node: LayoutNode | undefined): LeafNode | undefined =>
  node ? allLeaves(node).find(leaf => leaf.view !== 'terminal') : undefined;

/**
 * The layout as rendered in Focus Mode (the saved layout is not changed, so everything comes back on
 * exit, and panels keep their state meanwhile):
 * - hide: the view's tabs are left out; a panel left without a tab disappears with its splitter;
 * - show: a panel holding the view is un-hidden (a collapsed splitter side opens). A view that is
 *   open nowhere is added as a tab to its usual place — Explorer / Filer / Session on the left,
 *   Sender at the bottom — and made the active tab there;
 * - preserve: as it is.
 */
export function focusLayout(root: LayoutNode, panes: Record<PanelView, Visibility>): FocusLayout {
  const hidden = new Set((Object.keys(panes) as PanelView[]).filter(view => panes[view] === 'hide'));
  const shown = new Set((Object.keys(panes) as PanelView[]).filter(view => panes[view] === 'show'));
  const open = new Set(allLeaves(root).flatMap(tabsOf));
  // Views to show that are open nowhere: added to the panel of their usual slot.
  const added = new Map<string, PanelView[]>();
  const left = root.kind === 'split' && root.id === 'main' ? root.first : undefined;
  const right = root.kind === 'split' && root.id === 'main' ? root.second : undefined;
  const bottom = right?.kind === 'split' && right.id === 'right' ? right.second : undefined;
  for (const view of shown) {
    if (open.has(view)) continue;
    const target = firstContentLeaf(view === 'sender' ? bottom : left) ?? firstContentLeaf(root);
    if (target) added.set(target.id, [...(added.get(target.id) ?? []), view]);
  }

  const leaves = new Map<string, FocusLeaf>();
  const visibleShown = new Set<string>(); // leaves holding a view to show
  const build = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'leaf') {
      if (node.view === 'terminal') return node;
      const extra = added.get(node.id) ?? [];
      const all = [...tabsOf(node), ...extra.filter(view => !tabsOf(node).includes(view))];
      const tabs = all.filter(view => !hidden.has(view));
      if (all.length && !tabs.length) return null; // every tab hidden: the panel goes too
      const current = node.view !== 'empty' && tabs.includes(node.view as PanelView) ? node.view : undefined;
      const view: LeafView = extra.find(item => tabs.includes(item)) ?? current ?? tabs[0] ?? 'empty';
      if (tabs.some(item => shown.has(item))) visibleShown.add(node.id);
      leaves.set(node.id, { tabs, view });
      return tabs.length === tabsOf(node).length && view === node.view ? node : { ...node, tabs, view };
    }
    const first = build(node.first);
    const second = build(node.second);
    if (!first) return second;
    if (!second) return first;
    let state = node.state;
    // A hidden side that holds a view to show opens.
    const holds = (side: LayoutNode) => allLeaves(side).some(leaf => visibleShown.has(leaf.id));
    if (state.collapsed !== 'none' && holds(state.collapsed === 'first' ? first : second)) state = { ...state, collapsed: 'none' };
    if (first === node.first && second === node.second && state === node.state) return node;
    return { ...node, first, second, state };
  };
  const tree = build(root) ?? root;
  return { tree, leaves };
}

/** True when nothing in the config changes the panes (the plain layout is rendered). */
export const panesUnchanged = (panes: Record<PanelView, Visibility>) => Object.values(panes).every(value => value === 'preserve');
