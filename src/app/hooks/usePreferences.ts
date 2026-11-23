import { useEffect, useLayoutEffect, useState } from 'react';
import type { ThemeMode } from '../../types';
import { applyWindowBackground } from '../../lib/platform/tauri';
import { applyColorSchemes } from '../../lib/terminal/palettes';
import {
  sanitizeAppearance,
  sanitizeLog,
  sanitizeMcp,
  sanitizeProxy,
  sanitizeSessionDefaults,
  sanitizeTerminalPrefs,
} from '../../lib/settings/preferences';
import { sanitizeTheme } from '../../lib/settings/themes';
import { sanitizeKeyBindings, setKeyBindings } from '../../lib/settings/keybindings';
import { sanitizeLanguage, type Language } from '../../i18n';
import { useTranslation } from 'react-i18next';
import { initialSwatches, readSettings } from '../settingsDoc';

/**
 * The preferences saved in settings.json (written by usePersistence): theme, language, panel swatches, terminal
 * options (with the chosen colour schemes loaded), New Session defaults, appearance, proxy, log, MCP and keys.
 */
export function usePreferences() {
  const [theme, setTheme] = useState<ThemeMode>(() => sanitizeTheme(readSettings().theme));
  const [language, setLanguageState] = useState<Language>(() => sanitizeLanguage(readSettings().language));
  useTranslation(); // re-render on a language change (`t` reads the current language; main.tsx sets the saved one)
  useLayoutEffect(() => applyWindowBackground(theme), [theme]);
  const [swatches] = useState(initialSwatches);
  /** Preferences (settings.json): terminal options and the New Session defaults. */
  const [terminalPrefs, setTerminalPrefs] = useState(() => sanitizeTerminalPrefs(readSettings().terminal));
  // Settings → TERMINAL COLORS: load the chosen iTerm2 schemes (lib/terminal/palettes).
  const schemeChoice = JSON.stringify(terminalPrefs.colorSchemes);
  useEffect(() => {
    void applyColorSchemes(terminalPrefs.colorSchemes);
  }, [schemeChoice]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sessionDefaults, setSessionDefaults] = useState(() => sanitizeSessionDefaults(readSettings().sessionDefaults));
  const [appearance, setAppearance] = useState(() => sanitizeAppearance(readSettings().appearance));
  const [proxy, setProxy] = useState(() => sanitizeProxy(readSettings().proxy));
  const [logPrefs, setLogPrefs] = useState(() => sanitizeLog(readSettings().log));
  const [mcpPrefs, setMcpPrefs] = useState(() => sanitizeMcp(readSettings().mcp));
  const [keyBindings, setKeyBindingState] = useState(() => sanitizeKeyBindings(readSettings().keys));
  // In use right away: key handlers and the menu hints below read them (lib/settings/keybindings).
  setKeyBindings(keyBindings);
  return {
    theme,
    setTheme,
    language,
    setLanguageState,
    swatches,
    terminalPrefs,
    setTerminalPrefs,
    sessionDefaults,
    setSessionDefaults,
    appearance,
    setAppearance,
    proxy,
    setProxy,
    logPrefs,
    setLogPrefs,
    mcpPrefs,
    setMcpPrefs,
    keyBindings,
    setKeyBindingState,
  };
}
