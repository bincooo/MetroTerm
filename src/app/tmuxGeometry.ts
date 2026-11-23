import type { CSSProperties } from 'react';
import type { Rect, TmuxSplitter } from '../lib/workspace/tmux';

/** tmux panes: a pane that is not at the left / top edge leaves 1px free there (the divider shows the stage's --tmux-line). */
export const TMUX_GAP = 1;
export const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 };
export const tmuxStyle = (rect: Rect): CSSProperties => {
  const left = rect.x > 0.0001 ? TMUX_GAP : 0;
  const top = rect.y > 0.0001 ? TMUX_GAP : 0;
  return {
    left: `calc(${rect.x * 100}% + ${left}px)`,
    top: `calc(${rect.y * 100}% + ${top}px)`,
    width: `calc(${rect.w * 100}% - ${left}px)`,
    height: `calc(${rect.h * 100}% - ${top}px)`,
  };
};
/** Where a pane's terminal goes: its body box (px, measured in the stage). */
export type TmuxBox = { x: number; y: number; w: number; h: number };
export const sameBoxes = (a: Record<string, TmuxBox>, b: Record<string, TmuxBox>) => {
  const keys = Object.keys(b);
  return (
    keys.length === Object.keys(a).length &&
    keys.every(key => a[key] && a[key].x === b[key].x && a[key].y === b[key].y && a[key].w === b[key].w && a[key].h === b[key].h)
  );
};
/** A splitter's hit area: centred on the border, across the split's box. */
export const tmuxSplitterStyle = ({ dir, box, ratio }: TmuxSplitter): CSSProperties =>
  dir === 'row'
    ? { left: `${(box.x + box.w * ratio) * 100}%`, top: `${box.y * 100}%`, height: `${box.h * 100}%` }
    : { top: `${(box.y + box.h * ratio) * 100}%`, left: `${box.x * 100}%`, width: `${box.w * 100}%` };
export const tabNumber = (id: string) => Number(id.slice(id.lastIndexOf('-') + 1)) || 0;
