/**
 * Settings → FONTS: font families installed on this computer, from a list of common terminal and
 * interface fonts. A webview cannot enumerate system fonts, so each candidate is measured on a
 * canvas against the generic fallbacks: a different width means the family is present.
 */

const MONO = [
  'RobotoMono Nerd Font',
  'JetBrains Mono',
  'JetBrainsMono Nerd Font',
  'Fira Code',
  'FiraCode Nerd Font',
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'SF Mono',
  'Menlo',
  'Monaco',
  'Source Code Pro',
  'Hack',
  'Hack Nerd Font',
  'IBM Plex Mono',
  'Iosevka',
  'Inconsolata',
  'Maple Mono',
  'Sarasa Mono SC',
  'Noto Sans Mono',
  'Noto Sans Mono CJK SC',
  'DejaVu Sans Mono',
  'Ubuntu Mono',
  'Liberation Mono',
  'Roboto Mono',
  'Courier New',
];

const UI = [
  'Inter',
  'Segoe UI',
  'Roboto',
  'Noto Sans',
  'Noto Sans CJK SC',
  'Ubuntu',
  'Cantarell',
  'DejaVu Sans',
  'Liberation Sans',
  'Helvetica Neue',
  'Arial',
  'PingFang SC',
  'Microsoft YaHei',
  'Source Han Sans SC',
];

const SAMPLE = 'mmmmmmmmmmlli1WQ@#中文';
let cache: { mono: string[]; ui: string[] } | null = null;

function installed(candidates: string[]) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return [];
  const width = (font: string) => {
    context.font = `32px ${font}`;
    return context.measureText(SAMPLE).width;
  };
  const bases = ['monospace', 'serif', 'sans-serif'].map(base => [base, width(base)] as const);
  return candidates.filter(family => bases.some(([base, size]) => Math.abs(width(`"${family}", ${base}`) - size) > 0.5));
}

/** Installed candidates: monospace ones (terminal) and interface ones (monospace included). */
export function installedFonts() {
  if (!cache) {
    const mono = installed(MONO);
    cache = { mono, ui: [...mono, ...installed(UI)] };
  }
  return cache;
}
