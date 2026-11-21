import type { ThemeMode } from '../types';

/** App themes in menu / toggle order. */
export const THEMES: readonly ThemeMode[] = ['dark', 'light', 'gold'];

export const THEME_NAMES: Record<ThemeMode, string> = { dark: 'Dark', light: 'Light', gold: 'Gold' };

/** Status bar theme button: Dark → Light → Gold → Dark. */
export const nextTheme = (theme: ThemeMode): ThemeMode => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

/** `settings.json` → a known theme (anything else falls back to Dark). */
export const sanitizeTheme = (value: unknown): ThemeMode => (THEMES.includes(value as ThemeMode) ? (value as ThemeMode) : 'dark');
