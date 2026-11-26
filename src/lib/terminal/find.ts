import type { Terminal } from '@xterm/xterm';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { tokenHex } from '../ui/cssToken';

/**
 * Find in the terminal, on @xterm/addon-search (whole buffer, case-insensitive, across soft wraps).
 *
 * - The addon only counts matches while decorating them, so matches are always decorated — without a
 *   colour while "Find all" is off. At most HIGHLIGHT_LIMIT are counted ("1000+").
 * - Typing searches from the top of the view as it was when the bar opened (`anchor`).
 */
export type FindState = { count: number; index: number; capped: boolean; all: boolean };

const HIGHLIGHT_LIMIT = 1000;
const colorsNow = () => ({ current: tokenHex('--find-current-bg', '#23718a'), other: tokenHex('--find-other-bg', '#1f3f4b') });

export function attachFind(
  terminal: Terminal,
  options: { onFocusLine?: (line: number) => void; onChange?: (state: FindState) => void; onActive?: (active: boolean) => void },
) {
  const addon = new SearchAddon({ highlightLimit: HIGHLIGHT_LIMIT });
  terminal.loadAddon(addon);
  let query = '';
  let active = false;
  let all = false;
  let count = 0;
  let index = -1;
  /** Top row of the view when the find bar opened: typing searches from there, not from the last jump. */
  let anchor = 0;
  let colors = colorsNow();

  const emit = () => options.onChange?.({ count, index, capped: count >= HIGHLIGHT_LIMIT, all });
  const searchOptions = (): ISearchOptions => ({
    caseSensitive: false,
    decorations: {
      matchBackground: all ? colors.other : undefined,
      matchOverviewRuler: colors.other,
      activeMatchBackground: colors.current,
      activeMatchColorOverviewRuler: colors.current,
    },
  });
  /** The match the addon selected: highlight its line (the find bar keeps the keyboard). */
  const focusLine = () => {
    const position = terminal.getSelectionPosition();
    if (position) options.onFocusLine?.(position.start.y);
  };
  const clearResults = () => {
    addon.clearDecorations();
    count = 0;
    index = -1;
    emit();
  };

  const subscriptions = [
    addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!active) return;
      count = resultCount;
      index = resultIndex;
      emit();
    }),
    // Another screen (vim, less …): its own text is searched.
    terminal.buffer.onBufferChange(() => {
      if (active && query) find('anchor');
    }),
  ];

  /**
   * Search `query`: from `anchor` (new text), the current match again (`same`: colours / Find all
   * changed), or the next / previous match.
   */
  const find = (from: 'anchor' | 'same' | 'next' | 'previous') => {
    if (!query) {
      terminal.clearSelection();
      clearResults();
      return;
    }
    if (from === 'anchor' || from === 'same') {
      // The addon colours the matches again only for a new search text, and searches a new text
      // from the selection's start (the same text: from its end). Forgetting the text gives both:
      // `same` finds the selected (current) match again, `anchor` the first one from a one-cell
      // selection at the anchor row.
      addon.clearDecorations();
      if (from === 'anchor') terminal.select(0, Math.min(anchor, terminal.buffer.active.length - 1), 1);
    }
    const found = from === 'previous' ? addon.findPrevious(query, searchOptions()) : addon.findNext(query, searchOptions());
    if (!found) {
      if (from === 'anchor') terminal.clearSelection();
      count = 0;
      index = -1;
      emit();
      return;
    }
    if (from !== 'same') focusLine();
  };

  return {
    /** Find bar opened / closed. Closing removes every colour block. */
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      options.onActive?.(value);
      if (!value) {
        clearResults();
        return;
      }
      anchor = terminal.buffer.active.viewportY;
      if (query) find('anchor');
    },
    /** New search text: jumps to the match nearest to the view. */
    search(text: string) {
      query = text;
      if (active) find('anchor');
    },
    next() {
      if (count) find('next');
    },
    previous() {
      if (count) find('previous');
    },
    /** "Find all": colour every match as well as the current one. */
    setAll(value: boolean) {
      all = value;
      if (active && query) find('same');
      else emit();
    },
    /** Theme changed: re-read the `--find-*-bg` tokens and repaint. */
    refresh() {
      // Next frame: the app switches the theme class on <html> in an effect of its own.
      requestAnimationFrame(() => {
        const next = colorsNow();
        if (next.current === colors.current && next.other === colors.other) return;
        colors = next;
        if (active && query) find('same');
      });
    },
    dispose() {
      subscriptions.forEach(item => item.dispose());
      addon.dispose();
    },
  };
}
