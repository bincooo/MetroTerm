import type { IDisposable, Terminal } from '@xterm/xterm';
import { activeRenderer } from './xtermInternals';

/**
 * Sub-pixel exact character widths for xterm's DOM renderer.
 *
 * The DOM renderer keeps text on the cell grid with CSS letter-spacing: every character gets
 * `cell width − measured glyph width`. It measures a glyph by laying out 32 copies and reading
 * `offsetWidth / 32` — but `offsetWidth` is rounded to a whole pixel, so the measurement is off by up
 * to 1/64 px per character. With a fractional cell width (most font / display-scaling
 * combinations) that error adds up along a line: after 100 columns of ASCII text the text sits
 * about 1.5 px right of the grid, and Chinese, full-width punctuation and other glyphs from fallback
 * fonts drift by several pixels. A table with Chinese in its rows then no longer lines up with its
 * borders.
 *
 * This replaces the measurement with the exact (fractional) layout width and re-measures. The patch
 * goes on the width cache's prototype, so it also covers width caches xterm creates later.
 */
const REPEAT = 32;
let patched = false;

interface WidthCacheLike {
  _measureElements?: HTMLElement[];
  _measure?: (c: string, variant: number) => number;
  clear?: () => void;
}

interface DomRendererLike {
  _widthCache?: WidthCacheLike;
  _setDefaultSpacing?: () => void;
}

const renderer = (terminal: Terminal) => activeRenderer<DomRendererLike>(terminal);

export function attachExactCharWidths(terminal: Terminal): IDisposable {
  const apply = () => {
    const current = renderer(terminal);
    const cache = current?._widthCache;
    if (!current || !cache || typeof cache._measure !== 'function' || !Array.isArray(cache._measureElements)) return;
    if (!patched) {
      const proto = Object.getPrototypeOf(cache) as WidthCacheLike;
      proto._measure = function (this: WidthCacheLike, c: string, variant: number): number {
        const el = this._measureElements![variant];
        el.textContent = c.repeat(REPEAT);
        return el.getBoundingClientRect().width / REPEAT;
      };
      patched = true;
    }
    cache.clear?.();
    current._setDefaultSpacing?.();
    terminal.refresh(0, terminal.rows - 1);
  };
  apply();
  // Fonts load after the terminal opens; xterm re-measures then (with the patched function), but the
  // first rows may already have been laid out with the unpatched widths.
  let cancelled = false;
  document.fonts?.ready.then(() => {
    if (!cancelled) apply();
  });
  return {
    dispose: () => {
      cancelled = true;
    },
  };
}
