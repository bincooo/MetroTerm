import type { ITheme } from '@xterm/xterm';
import { useSyncExternalStore } from 'react';
import { t } from '../../i18n';
import type { ThemeMode } from '../../types';
import { backend } from '../platform/backend';
import { parseItermcolors } from './itermcolors';
import { log } from '../platform/log';
import { DEFAULT_COLOR_SCHEMES } from '../settings/preferences';
import { TERMINAL_SCHEMES } from './scheme';

/**
 * Terminal colour scheme of each app theme (Settings → TERMINAL COLORS): an iTerm2 scheme from
 * ~/.metroterm/themes/black (dark and Gold) or ~/.metroterm/themes/white (light), read through the
 * backend (`themes.list` / `themes.load`, src-rust/src/common/themes.rs) and parsed by lib/terminal/itermcolors.
 *
 * Colours the scheme does not set come from the built-in palette of that theme (scheme.ts),
 * which is also used when the file is missing or unreadable, and in the static preview (no backend).
 * The defaults “MetroTerm Dark” (dark and Gold share it) and “MetroTerm Light” are those built-in palettes
 * written out as files; a theme set to Default ('') reads its default file (so editing it works) and else uses the palette.
 * Output highlighting keeps the app theme's colours (scheme.ts `highlight`).
 */
type SchemeFolder = 'black' | 'white';
const SCHEME_FOLDER: Record<ThemeMode, SchemeFolder> = { dark: 'black', gold: 'black', light: 'white' };
const MODES: ThemeMode[] = ['dark', 'gold', 'light'];
const BUILT_IN: Record<ThemeMode, ITheme> = {
  dark: TERMINAL_SCHEMES.dark.theme,
  gold: TERMINAL_SCHEMES.gold.theme, // = the dark palette
  light: TERMINAL_SCHEMES.light.theme,
};

let palettes: Record<ThemeMode, ITheme> = { ...BUILT_IN };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The xterm theme of an app theme right now (re-renders when the chosen scheme is loaded). */
export const useTerminalPalette = (mode: ThemeMode) => useSyncExternalStore(subscribe, () => palettes[mode]);
export const terminalPalette = (mode: ThemeMode) => palettes[mode];

let applied = '';
/** Loads the chosen schemes (App, at start and when Settings change them). */
export async function applyColorSchemes(choice: Record<ThemeMode, string>, force = false) {
  const key = JSON.stringify(choice);
  if (!backend.live || (key === applied && !force)) return;
  applied = key;
  const next = { ...palettes };
  await Promise.all(
    MODES.map(async mode => {
      const name = choice[mode] || DEFAULT_COLOR_SCHEMES[mode];
      try {
        const text = await backend.call<string>('themes.load', { folder: SCHEME_FOLDER[mode], name });
        next[mode] = { ...BUILT_IN[mode], ...parseItermcolors(text) };
      } catch (error) {
        next[mode] = BUILT_IN[mode];
        if (!choice[mode]) return; // Default, and its file was deleted: the built-in palette is the default
        log.warn(
          t('Terminal colours “{{name}}” ({{folder}}): built-in colours used instead', { name, folder: SCHEME_FOLDER[mode] }),
          error,
        );
      }
    }),
  );
  if (key !== applied) return; // a newer choice is loading
  palettes = next;
  listeners.forEach(listener => listener());
}

type SchemeList = { dir: string; black: string[]; white: string[] };
/** The schemes each app theme can use (the names in its folder); none without a backend (static preview). */
export async function listColorSchemes(): Promise<Record<ThemeMode, string[]>> {
  const list: SchemeList = backend.live ? await backend.call<SchemeList>('themes.list') : { dir: '', black: [], white: [] };
  return { dark: list[SCHEME_FOLDER.dark], gold: list[SCHEME_FOLDER.gold], light: list[SCHEME_FOLDER.light] };
}
