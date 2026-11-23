/**
 * A colour token of the current theme (colors.css) as xterm decorations need it: `#rrggbb`
 * (anything else, or a missing token, gives `fallback`).
 */
export const tokenHex = (name: string, fallback: string) => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
};
