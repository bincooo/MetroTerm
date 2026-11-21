/**
 * Terminal row height independent of the font's own line metrics.
 *
 * xterm's row height is (font's natural line height) × `lineHeight`. Fonts differ a lot here:
 * RobotoMono Nerd Font is about 1.32 em tall, DejaVu Sans Mono about 1.16 em, so the same
 * `lineHeight` gives ~20 % taller rows with RobotoMono and fewer lines on screen. This picks the
 * `lineHeight` that keeps rows at the density the terminal was tuned for (19 px at 13 px).
 */
const ROW_PER_PX = 1.47; // 13px → 19px rows

export function densityLineHeight(fontFamily: string, fontSize: number): number {
  if (typeof document === 'undefined') return 1.32;
  const probe = document.createElement('span');
  probe.textContent = 'W'.repeat(16);
  probe.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre;font-family:${fontFamily};font-size:${fontSize}px;line-height:normal`;
  document.body.append(probe);
  const natural = probe.offsetHeight || Math.round(fontSize * 1.16);
  probe.remove();
  const target = Math.round(fontSize * ROW_PER_PX);
  // xterm floors natural × lineHeight; a hair over the target avoids landing 1px short.
  return Math.max(1, (target + 0.01) / natural);
}
