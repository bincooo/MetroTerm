#!/usr/bin/env node
/**
 * @xterm/addon-webgl draws the underline cursor 1 device pixel (1 CSS px at 100 %) thick and has no
 * option for it (`cursorWidth` only covers the bar). This patches the built addon after `npm install`
 * (package.json → postinstall) so the underline is UNDERLINE_CSS_PX thick, at the bottom of the cell.
 * The outline (unfocused block) shares that code path and keeps 1 device pixel.
 *
 * Idempotent; fails loudly if the addon's code changed (the version is pinned in package.json).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UNDERLINE_CSS_PX = 3;
const MARK = '/*metroterm-underline*/';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js');

if (!existsSync(file)) {
  console.log('patch-xterm-webgl: @xterm/addon-webgl not installed, skipped');
  process.exit(0);
}
const source = readFileSync(file, 'utf8');
if (source.includes(MARK)) process.exit(0);

// RectangleRenderer.updateCursor, "Bottom edge": y = bottom - dpr, height = dpr.
const original = '(i.y+1)*this._dimensions.device.cell.height-i.dpr,i.width*this._dimensions.device.cell.width,i.dpr,this._cursorFloat)';
const thickness = `("underline"===i.style?Math.max(1,Math.round(i.dpr*${UNDERLINE_CSS_PX})):i.dpr)`;
const patched = `(i.y+1)*this._dimensions.device.cell.height-${MARK}${thickness},i.width*this._dimensions.device.cell.width,${thickness},this._cursorFloat)`;

const count = source.split(original).length - 1;
if (count !== 1) {
  console.error(
    `patch-xterm-webgl: expected the underline cursor code once, found it ${count} times — check the @xterm/addon-webgl version`,
  );
  process.exit(1);
}
writeFileSync(file, source.replace(original, patched));
console.log(`patch-xterm-webgl: underline cursor ${UNDERLINE_CSS_PX}px`);
