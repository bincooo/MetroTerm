import { MIN_PANEL_SIZE, SENDER_MIN_PANEL_SIZE } from '../components/common/SplitPane';
import { SENDER_SLOT, type LayoutNode, type LeafNode, type LeafView, type PanelView } from '../lib/workspace/layout';
import type { TerminalTab } from '../types';
import type { TreeRef } from '../lib/sessions/tree';
import type { ManagedConnection } from './sessionsDoc';
import { pad2 } from '../lib/format';

/** Pure helpers of App (no state, no new closure per render). */

/** Local time as YYYYMMDD-hhmmss, for default file names. */
export const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
};
export const fileSafe = (name: string) => name.replace(/[^\w.-]+/g, '_') || 'session';
export const hasTerminal = (node: LayoutNode): boolean =>
  node.kind === 'leaf' ? node.view === 'terminal' : hasTerminal(node.first) || hasTerminal(node.second);
export const panelClass: Record<PanelView, string> = {
  explorer: 'session-explorer',
  filer: 'filer-pane',
  sender: 'sender-pane',
  sessions: 'sessions-pane',
  monitor: 'monitor-pane',
};
/**
 * Hide-below size of one side of a splitter. The Sender panel of the frame (bottom of the `right`
 * split) has its own, halved minimum. It belongs to that panel, not to the Sender view: moving the
 * Sender tab elsewhere doesn't move it, and the panel keeps it whatever it shows.
 */
export const minSizeOf = (split: LayoutNode, side: 'first' | 'second') =>
  split.id === SENDER_SLOT.split && side === SENDER_SLOT.side ? SENDER_MIN_PANEL_SIZE : MIN_PANEL_SIZE;
export const collectLeaves = (node: LayoutNode): LeafNode[] =>
  node.kind === 'leaf' ? [node] : [...collectLeaves(node.first), ...collectLeaves(node.second)];

/** A panel's view other than the terminal (Explorer, Filer, Sender …, or empty). */
export type ContentView = Exclude<LeafView, 'terminal'>;
/** Explorer dialogs: new folder / rename / delete. */
export type TreeDialogState = { kind: 'new-folder'; parentId: string | null } | { kind: 'rename' | 'delete'; target: TreeRef };
/** What the panels of a window show: its terminal tabs and the session of its selected tab. */
export type WindowCtx = {
  terminalTabs: TerminalTab[];
  activeTabId: string | null;
  activeTab: TerminalTab | undefined;
  active: ManagedConnection;
};
