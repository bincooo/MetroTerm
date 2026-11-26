import type { ITheme } from '@xterm/xterm';

/**
 * iTerm2 colour schemes (`.itermcolors`, an XML property list) → xterm theme colours. The files
 * come from ~/.metroterm/themes/{black,white} (src-rust/src/common/themes.rs), e.g. downloaded from
 * https://terminalthemes.com/themes or the iTerm2-Color-Schemes collection.
 *
 * Read: the 16 ANSI colours, background, foreground, cursor, cursor text and selection. Components
 * are 0–1 floats (`Red Component` …, optional `Alpha Component`); the colour space is ignored.
 * Not used: `Bold Color` (xterm draws bold in the bright ANSI colour), `Selected Text Color`
 * (selection stays translucent over the text's own colours), link / badge / guide colours.
 */

const ANSI: (keyof ITheme)[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];
const NAMED: Record<string, keyof ITheme> = {
  'Background Color': 'background',
  'Foreground Color': 'foreground',
  'Cursor Color': 'cursor',
  'Cursor Text Color': 'cursorAccent',
  'Selection Color': 'selectionBackground',
};

const hex2 = (value: number) =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');

/** `<dict>` children as key → value element. */
function entries(dict: Element): Map<string, Element> {
  const map = new Map<string, Element>();
  const children = Array.from(dict.children);
  for (let index = 0; index + 1 < children.length; index++) {
    if (children[index].tagName !== 'key') continue;
    map.set(children[index].textContent?.trim() ?? '', children[index + 1]);
    index++;
  }
  return map;
}

/** One colour `<dict>` → `#rrggbb` (`#rrggbbaa` when translucent); null when it is not one. */
function colorOf(dict: Element): { rgb: string; alpha: number } | null {
  if (dict.tagName !== 'dict') return null;
  const parts = entries(dict);
  const component = (name: string, fallback?: number) => {
    const element = parts.get(`${name} Component`);
    const value = element ? Number(element.textContent) : fallback;
    return value === undefined || Number.isNaN(value) ? null : value;
  };
  const red = component('Red');
  const green = component('Green');
  const blue = component('Blue');
  const alpha = component('Alpha', 1) ?? 1;
  if (red === null || green === null || blue === null) return null;
  return { rgb: `#${hex2(red)}${hex2(green)}${hex2(blue)}`, alpha };
}

/** Colours found in the scheme (missing ones are left out: the app theme's own fill in). Throws on a file that is not a colour scheme. */
export function parseItermcolors(text: string): ITheme {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('not an XML property list');
  const root = doc.querySelector('plist > dict');
  if (!root) throw new Error('not an iTerm2 colour scheme (no <plist><dict>)');
  const theme: Record<string, string> = {};
  let found = 0;
  for (const [key, value] of entries(root)) {
    const ansi = /^Ansi (\d+) Color$/.exec(key);
    const field = ansi ? ANSI[Number(ansi[1])] : NAMED[key];
    if (!field) continue;
    const color = colorOf(value);
    if (!color) continue;
    found++;
    if (field === 'selectionBackground') {
      // Selection is drawn over the text: a translucent colour as it is, an opaque one (iTerm2's
      // usual) at 30 % like xterm does, and half of that while the terminal is not focused.
      const alpha = color.alpha < 1 ? color.alpha : 0.3;
      theme.selectionBackground = `${color.rgb}${hex2(alpha)}`;
      theme.selectionInactiveBackground = `${color.rgb}${hex2(alpha / 2)}`;
    } else theme[field] = color.rgb;
  }
  if (!found || !theme.background || !theme.foreground) throw new Error('no background / foreground colour in the scheme');
  return theme as ITheme;
}
