import type { IDisposable, Terminal } from '@xterm/xterm';
import { renderDimensions } from './xtermInternals';

/**
 * Vertically centred terminal text.
 *
 * The terminal's rows are taller than the font (line height 1.32). The browser places the text by
 * the font's ascent / descent metrics, which rarely match where the glyphs actually are: with
 * DejaVu Sans Mono (Ubuntu's default monospace font), Liberation Mono and others the letters sit
 * 1–2 px above the middle of the row — at 125 % / 150 % / 200 % display scaling in Chrome and in
 * the WebKitGTK webview — while the cursor block, the click highlight and the table borders are
 * centred on the row.
 *
 * This measures where a capital letter really is in a row (baseline from a DOM probe laid out like
 * xterm's rows, cap height from canvas `measureText`) and shifts the row text so the letter is
 * centred, rounded to whole device pixels so glyphs stay sharp. The row spans get a line height of
 * row height + 2 × shift (`--xterm-text-line` on `.xterm-rows`): only the glyphs move — span
 * backgrounds, the cursor block and box-drawing spans (lib/boxGlyphs) keep filling the row.
 */
const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

/** Offset (CSS px, + = down) that centres capital letters of `font` in a line box `lineHeight` tall. */
export function centringOffset(fontFamily: string, fontSize: number, lineHeight: number, dpr = window.devicePixelRatio || 1): number {
  const context = canvas?.getContext('2d');
  if (!context || !lineHeight || !fontSize) return 0;
  context.font = `${fontSize}px ${fontFamily}`;
  const metrics = context.measureText('H');
  const capTop = metrics.actualBoundingBoxAscent;
  const capBottom = -metrics.actualBoundingBoxDescent;
  if (!Number.isFinite(capTop) || capTop <= 0) return 0;

  // Baseline position inside a row: same structure as xterm's DOM rows (a fixed line height and
  // inline-block spans filling the row).
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre;height:${lineHeight}px;line-height:${lineHeight}px;font-family:${fontFamily};font-size:${fontSize}px`;
  const span = document.createElement('span');
  span.style.cssText = 'display:inline-block;height:100%;vertical-align:top';
  span.textContent = 'H';
  const marker = document.createElement('span');
  marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  span.append(marker);
  probe.append(span);
  document.body.append(probe);
  const baseline = marker.getBoundingClientRect().top - probe.getBoundingClientRect().top;
  probe.remove();

  const inkCentre = baseline - (capTop + capBottom) / 2;
  const offset = lineHeight / 2 - inkCentre;
  // More than a third of the row would mean a broken measurement (font not loaded …): leave it.
  if (!Number.isFinite(offset) || Math.abs(offset) > lineHeight / 3) return 0;
  return Math.round(offset * dpr) / dpr;
}

export function attachTextCentering(terminal: Terminal): IDisposable {
  const rows = terminal.element?.querySelector<HTMLElement>('.xterm-rows');
  if (!rows) return { dispose: () => undefined };
  let key = '';
  const update = () => {
    const height = renderDimensions(terminal)?.css.cell.height;
    if (!height) return;
    const { fontFamily = 'monospace', fontSize = 13 } = terminal.options;
    const dpr = window.devicePixelRatio || 1;
    const next = `${fontFamily}|${fontSize}|${height}|${dpr}`;
    if (next === key) return;
    key = next;
    const offset = centringOffset(fontFamily, fontSize, height, dpr);
    rows.style.setProperty('--xterm-text-nudge', `${offset}px`);
    // The text is centred in its line box, so a line box 2 × offset taller moves it down by offset.
    rows.style.setProperty('--xterm-text-line', `${height + 2 * offset}px`);
  };
  update();
  const render = terminal.onRender(update);
  let cancelled = false;
  // Fallback fonts may finish loading after the first measurement.
  document.fonts?.ready.then(() => {
    if (!cancelled) {
      key = '';
      update();
    }
  });
  return {
    dispose: () => {
      cancelled = true;
      render.dispose();
    },
  };
}
