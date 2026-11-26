import type { ITheme } from '@xterm/xterm';
import type { ThemeMode } from '../../types';

/** Kinds of text coloured by output highlighting (lib/terminal/highlight). */
export type HighlightKind =
  | 'error'
  | 'warning'
  | 'success'
  | 'stopped'
  | 'info'
  | 'debug'
  | 'address'
  | 'time'
  | 'uuid'
  | 'string'
  | 'number'
  | 'bracket'
  | 'option'
  | 'prompt'
  | 'permission';
export type HighlightColors = Record<HighlightKind, string>;

/**
 * Each app theme (dark / light / gold; dark and Gold share DARK_PALETTE):
 * - `theme`: the xterm palette (16 ANSI colours, cursor, selection);
 * - `highlight`: the colours of output highlighting, `#rrggbb` only (written into the cells as true colour).
 */
type TerminalScheme = { theme: ITheme; highlight: HighlightColors };

/**
 * The dark theme's xterm palette, also the Gold theme's: the two dark app themes share one default
 * terminal scheme (“MetroTerm Dark”).
 */
const DARK_PALETTE: ITheme = {
  // Background = var(--terminal) in the dark theme.
  // ANSI palette: Monokai / Molokai as in VS Code's terminal (blue #819aff directories, cyan #66d9ef links).
  background: '#171717',
  foreground: '#f8f8f2',
  cursor: '#ffaa5c',
  cursorAccent: '#171717', // orange block cursor
  selectionBackground: '#f8f8f255',
  selectionInactiveBackground: '#f8f8f22a',
  black: '#333333',
  red: '#c4265e',
  green: '#86b42b',
  yellow: '#b3b42b',
  blue: '#6a7ec8',
  magenta: '#8c6bc8',
  cyan: '#56adbc',
  white: '#e3e3dd',
  brightBlack: '#666666',
  brightRed: '#f92672',
  brightGreen: '#a6e22e',
  brightYellow: '#e2e22e',
  brightBlue: '#819aff',
  brightMagenta: '#ae81ff',
  brightCyan: '#66d9ef',
  brightWhite: '#f8f8f2',
};

export const TERMINAL_SCHEMES: Record<ThemeMode, TerminalScheme> = {
  dark: {
    theme: DARK_PALETTE,
    highlight: {
      error: '#f92672',
      warning: '#e6db74',
      success: '#a6e22e',
      stopped: '#fd971f',
      info: '#819aff',
      debug: '#75715e',
      address: '#ae81ff',
      time: '#a6e22e',
      uuid: '#fd971f',
      string: '#e6db74',
      number: '#ae81ff',
      bracket: '#a6e22e',
      option: '#fd971f',
      prompt: '#f92672',
      permission: '#8a8a8a',
    },
  },
  light: {
    // Full palette darkened for contrast on white (xterm's defaults are made for dark backgrounds).
    theme: {
      // Background = var(--panel) in the light theme.
      background: '#fafafa',
      foreground: '#1e1e1e',
      cursor: '#ff8a2e',
      cursorAccent: '#fafafa', // orange block cursor
      // Selection: a translucent dark grey.
      selectionBackground: '#1e1e1e30',
      selectionInactiveBackground: '#1e1e1e1a',
      // The same Monokai hues, darkened so they stay readable on #fafafa.
      black: '#1e1e1e',
      red: '#c4265e',
      green: '#5c8a00',
      yellow: '#8a7f00',
      blue: '#3d55c4',
      magenta: '#7a4fc4',
      cyan: '#1a8296',
      white: '#6e6e6e',
      brightBlack: '#5c5c5c',
      brightRed: '#d81b60',
      brightGreen: '#669900',
      brightYellow: '#968a00',
      brightBlue: '#4762d6',
      brightMagenta: '#8a5cd6',
      brightCyan: '#1690a8',
      brightWhite: '#3a3a3a',
    },
    highlight: {
      error: '#c4265e',
      warning: '#8a6d00',
      success: '#5c8a00',
      stopped: '#b35c00',
      info: '#3d55c4',
      debug: '#8a8a8a',
      address: '#7a4fc4',
      time: '#5c8a00',
      uuid: '#b35c00',
      string: '#8a6d00',
      number: '#7a4fc4',
      bracket: '#5c8a00',
      option: '#b35c00',
      prompt: '#c4265e',
      permission: '#7a7a7a',
    },
  },
  gold: {
    // The dark theme's palette (DARK_PALETTE); only the output highlighting has Gold's own warmer yellows.
    theme: DARK_PALETTE,
    highlight: {
      error: '#f92672',
      warning: '#f0cf6a',
      success: '#a6e22e',
      stopped: '#e8a33d',
      info: '#819aff',
      debug: '#7d7461',
      address: '#ae81ff',
      time: '#a6e22e',
      uuid: '#e8a33d',
      string: '#e6c86e',
      number: '#ae81ff',
      bracket: '#a6e22e',
      option: '#e8a33d',
      prompt: '#f92672',
      permission: '#8c8473',
    },
  },
};
