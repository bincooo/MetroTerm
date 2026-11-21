import type { IDisposable, Terminal } from '@xterm/xterm';
import { bufferRowOf } from './domRendererSpeed';
import { tryDrawCustomChar } from './vendor/xtermCustomGlyphs';
import { renderDimensions } from './xtermInternals';

/**
 * Seamless box-drawing and block characters for xterm's DOM renderer.
 *
 * The terminal uses a line height above 1 (rows are taller than the font), so characters like
 * │ ┌ ┼ █ ▐ — drawn by the font only as tall as the font itself — leave a gap at every row
 * boundary: tables drawn by Claude Code, `tree`, htop and dialog boxes, and the Claude logo, look
 * cut into stripes. xterm's WebGL/canvas renderers draw these characters themselves so they fill
 * the cell ("custom glyphs"); the DOM renderer — which the app's cursor and line-highlight styling
 * relies on — uses the font.
 *
 * Here xterm's own custom-glyph drawing (vendor/xtermCustomGlyphs) renders each such character
 * once into a cell-sized image at the device pixel ratio. After every render, runs of identical
 * characters in the changed rows are wrapped in a `.xterm-box` span exactly one row high that paints
 * the text colour through that image (CSS mask, one copy per character). The font's glyph stays in the
 * span but is transparent, so the text is unchanged for selection, copy and search. The span
 * reaches one device pixel into the rows above and below: at fractional display scaling (125 %,
 * 150 %) row edges fall between device pixels and would otherwise show a faint seam.
 *
 * Horizontally the span keeps the width the text itself takes (glyph advances plus xterm's
 * letter-spacing), each character getting an equal share of it, and the runs of rows with such
 * characters are snapped to the cell grid (`snapRow`), so borders line up from row to row whatever
 * text — Chinese included — is between them.
 */
const BOX = String.raw`[\u2500-\u259f\ue0b0-\ue0bf]`;
/** A run of one repeated box/block character. */
const CANDIDATES = new RegExp(`(${BOX})\\1*`, 'gu');
const HAS_CANDIDATE = new RegExp(BOX, 'u');

let scopes = 0;

export const attachBoxGlyphs = (terminal: Terminal): IDisposable => {
  const root = terminal.element;
  const rows = root?.querySelector<HTMLElement>('.xterm-rows');
  if (!root || !rows) return { dispose: () => undefined };
  const scope = `xterm-box-scope-${++scopes}`;
  root.classList.add(scope);
  const sheet = document.createElement('style');
  document.head.append(sheet);

  /** Glyph images for the current cell size: character → CSS rule written (false: not drawable). */
  let glyphs = new Map<string, boolean>();
  let rules: string[] = [];
  let size = { key: '', cssWidth: 0, cssHeight: 0, deviceWidth: 0, deviceHeight: 0, dpr: 1 };

  /** Cell size changed (font, zoom, display): images are redrawn and existing spans re-sized. */
  const updateSize = () => {
    const dims = renderDimensions(terminal);
    if (!dims?.device.cell.width || !dims.device.cell.height) return false;
    const dpr = window.devicePixelRatio || 1;
    // Rows are laid out in CSS pixels (xterm's device cell size can differ by a pixel from the CSS
    // size × ratio), so the images are drawn for the CSS cell at the device pixel ratio.
    const key = `${dims.css.cell.width}x${dims.css.cell.height}@${dpr}`;
    if (key === size.key) return true;
    size = {
      key,
      cssWidth: dims.css.cell.width,
      cssHeight: dims.css.cell.height,
      deviceWidth: Math.max(1, Math.round(dims.css.cell.width * dpr)),
      deviceHeight: Math.max(1, Math.round(dims.css.cell.height * dpr)),
      dpr,
    };
    rows.style.setProperty('--xterm-box-w', `${size.cssWidth}px`);
    rows.style.setProperty('--xterm-box-h', `${size.cssHeight}px`);
    rows.style.setProperty('--xterm-box-pad', `${1 / dpr}px`);
    glyphs = new Map();
    rules = [];
    sheet.textContent = '';
    // Characters already on screen get images for the new size.
    rows.querySelectorAll<HTMLElement>('.xterm-box').forEach(span => {
      const char = span.dataset.char;
      if (char) drawable(char);
    });
    return true;
  };

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  /** Draw `char` into an image (once per size) and add its mask rule; false if xterm has no definition. */
  const drawable = (char: string) => {
    const known = glyphs.get(char);
    if (known !== undefined) return known;
    let ok = false;
    if (context) {
      // One extra device pixel above and below, repeating the cell's edge rows: the span overlaps
      // the neighbouring rows by that pixel, so strokes meet without a seam even when row edges
      // fall between device pixels, and nothing is scaled (lines stay crisp).
      const { deviceWidth: width, deviceHeight: height } = size;
      canvas.width = width;
      canvas.height = height + 2;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      ok = tryDrawCustomChar(context, char, 0, 1, width, height, terminal.options.fontSize ?? 13, size.dpr);
      if (ok) {
        context.drawImage(canvas, 0, 1, width, 1, 0, 0, width, 1);
        context.drawImage(canvas, 0, height, width, 1, 0, height + 1, width, 1);
        const url = canvas.toDataURL();
        const code = char.codePointAt(0)!.toString(16);
        rules.push(`.${scope} .xterm-box[data-code="${code}"]{-webkit-mask-image:url(${url});mask-image:url(${url})}`);
        sheet.textContent = rules.join('\n');
      }
    }
    glyphs.set(char, ok);
    return ok;
  };

  const wrapText = (text: Text) => {
    const value = text.data;
    if (!HAS_CANDIDATE.test(value)) return;
    const parts: Node[] = [];
    let last = 0;
    for (const match of value.matchAll(CANDIDATES)) {
      const char = match[1];
      if (!drawable(char)) continue;
      const index = match.index ?? 0;
      if (index > last) parts.push(document.createTextNode(value.slice(last, index)));
      const span = document.createElement('span');
      span.className = 'xterm-box';
      span.dataset.char = char;
      span.dataset.code = char.codePointAt(0)!.toString(16);
      span.style.setProperty('--xterm-box-n', String([...match[0]].length));
      span.textContent = match[0];
      parts.push(span);
      last = index + match[0].length;
    }
    if (!parts.length) return;
    if (last < value.length) parts.push(document.createTextNode(value.slice(last)));
    text.replaceWith(...parts);
  };

  /**
   * Put every run of the row (xterm's spans) exactly on the cell grid: each becomes an inline block
   * whose width is the distance between its start and end column, both rounded to Chromium's layout
   * unit (1/64 px). Rounding the positions rather than the widths keeps the error from adding up:
   * otherwise each span is off by up to 1/128 px and a row with many coloured runs ends up a few
   * tenths of a pixel away from a row of border characters — enough for a 1-pixel border line to land
   * on a different device pixel and look grey and broken.
   */
  const snapRow = (row: Element, bufferRow: number) => {
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(bufferRow);
    if (!line) return;
    const cell = buffer.getNullCell();
    // Text length and width of each rendered cell (the second half of a wide character has width 0
    // and no text of its own).
    const lengths: number[] = [];
    const widths: number[] = [];
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      const width = cell.getWidth();
      if (!width) continue;
      lengths.push((cell.getChars() || ' ').length);
      widths.push(width);
    }
    const children = Array.from(row.children) as HTMLElement[];
    const unit = (col: number) => Math.round(col * size.cssWidth * 64) / 64;
    let next = 0;
    let col = 0;
    const plan: [HTMLElement, number][] = [];
    for (const child of children) {
      const length = child.textContent?.length ?? 0;
      let consumed = 0;
      let cells = 0;
      while (consumed < length && next < lengths.length) {
        consumed += lengths[next];
        cells += widths[next];
        next++;
      }
      if (consumed !== length) return; // row no longer matches the buffer (being re-rendered): leave it
      plan.push([child, unit(col + cells) - unit(col)]);
      col += cells;
    }
    for (const [child, width] of plan) {
      child.classList.add('xterm-snap');
      child.style.width = `${width}px`;
    }
  };

  const processRow = (row: Element) => {
    // A kept row (see domRendererSpeed's row pool) attached again unchanged was done already: the
    // pool gives a row a new `__metro` each time it builds it.
    const built = (row as Element & { __metro?: object | null; __boxFor?: object }).__metro;
    if (built && (row as Element & { __boxFor?: object }).__boxFor === built) return;
    if (built) (row as Element & { __boxFor?: object }).__boxFor = built;
    if (!HAS_CANDIDATE.test(row.textContent ?? '')) return;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.classList.contains('xterm-box')) texts.push(node as Text);
    }
    texts.forEach(wrapText);
    // Buffer line of this element (with the row pool, DOM order is not screen order, and rows can be
    // built hidden ahead of time).
    const bufferRow = bufferRowOf(terminal, row);
    if (bufferRow >= 0) snapRow(row, bufferRow);
  };

  const observer = new MutationObserver(records => {
    if (!updateSize()) return;
    const changed = new Set<Element>();
    for (const record of records) {
      if (record.target === rows) {
        record.addedNodes.forEach(added => {
          if (added instanceof Element) changed.add(added);
        });
        continue;
      }
      let node: Node | null = record.target;
      while (node && node.parentNode !== rows) node = node.parentNode;
      if (node instanceof Element) changed.add(node);
    }
    changed.forEach(processRow);
    observer.takeRecords(); // our own wrapping
  });
  observer.observe(rows, { childList: true, subtree: true, characterData: true });
  if (updateSize()) for (const row of Array.from(rows.children)) processRow(row);
  const resize = terminal.onResize(() => updateSize());
  const render = terminal.onRender(() => updateSize());

  return {
    dispose: () => {
      observer.disconnect();
      resize.dispose();
      render.dispose();
      sheet.remove();
      root.classList.remove(scope);
    },
  };
};
