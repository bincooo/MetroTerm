/**
 * Keyboard shortcuts (Session → Preferences → Keyboard Shortcuts…): the actions that can be bound,
 * their defaults, the key-combination format, matching and the conflict check.
 *
 * A binding is written `Ctrl+Alt+Shift+Meta+Key` (modifiers in that order, only those held); the key
 * comes from `KeyboardEvent.code`, so it does not depend on the keyboard layout or on Shift
 * (`Ctrl+Shift+1`, not `Ctrl+!`). `''` = no shortcut. settings.json → `keys` keeps only the bindings
 * that differ from the defaults.
 *
 * The App handler (capture phase, App.tsx) runs the `app` actions; TerminalView runs the `terminal`
 * ones, so they act only in a focused terminal. FIXED_BINDINGS cannot be changed but count as used.
 */

export type KeyAction =
  | 'focusMode'
  | 'menuSearch'
  | 'fullScreen'
  | 'newSession'
  | 'saveAs'
  | 'closeTab'
  | 'zoomIn'
  | 'zoomOut'
  | 'prevWindow'
  | 'nextWindow'
  | 'prevTab'
  | 'nextTab'
  | 'tmuxPrefix'
  | 'find'
  | 'copy'
  | 'paste'
  | 'clearScrollback';

export type KeyBindings = Record<KeyAction, string>;

type KeyActionInfo = { id: KeyAction; label: string; group: 'app' | 'terminal'; keys: string };

/** In the editor's order. `label` is an i18n key. */
export const KEY_ACTIONS: readonly KeyActionInfo[] = [
  { id: 'newSession', label: 'New Session…', group: 'app', keys: 'Alt+N' },
  { id: 'saveAs', label: 'Save Session As…', group: 'app', keys: 'Ctrl+Shift+S' },
  { id: 'closeTab', label: 'Close tab', group: 'app', keys: 'Ctrl+Shift+W' },
  { id: 'menuSearch', label: 'Search menus', group: 'app', keys: 'Ctrl+Shift+P' },
  { id: 'focusMode', label: 'Focus Mode', group: 'app', keys: 'Ctrl+Shift+F' },
  { id: 'fullScreen', label: 'Full Screen', group: 'app', keys: 'F11' },
  { id: 'zoomIn', label: 'Zoom In', group: 'app', keys: 'Ctrl+=' },
  { id: 'zoomOut', label: 'Zoom Out', group: 'app', keys: 'Ctrl+-' },
  { id: 'prevWindow', label: 'Previous Window', group: 'app', keys: 'Ctrl+Shift+PageUp' },
  { id: 'nextWindow', label: 'Next Window', group: 'app', keys: 'Ctrl+Shift+PageDown' },
  { id: 'prevTab', label: 'Previous Tab (in the pane)', group: 'app', keys: 'Ctrl+PageUp' },
  { id: 'nextTab', label: 'Next Tab (in the pane)', group: 'app', keys: 'Ctrl+PageDown' },
  { id: 'tmuxPrefix', label: 'tmux prefix (then the command key)', group: 'terminal', keys: 'Ctrl+B' },
  { id: 'find', label: 'Find…', group: 'terminal', keys: 'Ctrl+F' },
  { id: 'copy', label: 'Copy', group: 'terminal', keys: 'Ctrl+Shift+C' },
  { id: 'paste', label: 'Paste', group: 'terminal', keys: 'Ctrl+Shift+V' },
  { id: 'clearScrollback', label: 'Clear Scrollback', group: 'terminal', keys: 'Ctrl+Shift+L' },
];

export const DEFAULT_KEY_BINDINGS = Object.fromEntries(KEY_ACTIONS.map(action => [action.id, action.keys])) as KeyBindings;

/** Shortcuts that cannot be changed (shown read-only in the editor; a new binding may not take them). */
export const FIXED_BINDINGS: readonly { keys: string; label: string; test: (binding: string) => boolean }[] = [
  { keys: 'Ctrl+Shift+1 … 9', label: 'Show window 1–9', test: binding => /^Ctrl\+Shift\+[1-9]$/.test(binding) },
  { keys: 'Ctrl+C', label: 'Copy (with a selection, else sent to the shell)', test: binding => binding === 'Ctrl+C' },
  { keys: 'Ctrl+V', label: 'Paste', test: binding => binding === 'Ctrl+V' },
  { keys: 'Alt+F4', label: 'Exit', test: binding => binding === 'Alt+F4' },
];

/** Extra keys of a default binding (numpad / Shift variants); none once the user rebinds it. */
const DEFAULT_ALIASES: Partial<Record<KeyAction, string[]>> = {
  zoomIn: ['Ctrl+Shift+=', 'Ctrl+Num+'],
  zoomOut: ['Ctrl+Num-'],
};

const CODE_NAMES: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  NumpadAdd: 'Num+',
  NumpadSubtract: 'Num-',
  NumpadMultiply: 'Num*',
  NumpadDivide: 'Num/',
  NumpadDecimal: 'Num.',
  NumpadEnter: 'Enter',
};
const PLAIN_CODES = new Set(['PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete', 'Backspace', 'Tab', 'Enter', 'Space']);

/** `KeyboardEvent.code` → the key part of a binding; null for modifiers and unknown keys. */
const keyName = (code: string): string | null => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (PLAIN_CODES.has(code)) return code;
  return CODE_NAMES[code] ?? null;
};

/** The binding a key press stands for (`Ctrl+Shift+L`), or null for a lone modifier / unknown key. */
export function bindingOf(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  const key = keyName(event.code);
  if (!key) return null;
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key]
    .filter(Boolean)
    .join('+');
}

/**
 * Can this be a shortcut? It needs Ctrl, Alt or Meta, or be a function key — a plain or Shift+ key
 * would take a character away from typing.
 */
export const isBindable = (binding: string) => /(^|\+)(Ctrl|Alt|Meta)\+/.test(binding) || /(^|\+)F\d{1,2}$/.test(binding);

/** settings.json → `keys` → every action's binding (unknown actions and malformed keys are dropped). */
export function sanitizeKeyBindings(value: unknown): KeyBindings {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const result = { ...DEFAULT_KEY_BINDINGS };
  for (const action of KEY_ACTIONS) {
    const keys = raw[action.id];
    if (keys === '' || (typeof keys === 'string' && isBindable(keys))) result[action.id] = keys;
  }
  return result;
}

/** Only what differs from the defaults (for settings.json). */
export const keyBindingOverrides = (bindings: KeyBindings): Partial<KeyBindings> =>
  Object.fromEntries(KEY_ACTIONS.filter(action => bindings[action.id] !== action.keys).map(action => [action.id, bindings[action.id]]));

/** What else uses `binding`: another action (its id) or a fixed shortcut (its label); null = free. */
export function conflictOf(
  bindings: KeyBindings,
  action: KeyAction,
  binding: string,
): { action: KeyAction; label: string } | { action: null; label: string } | null {
  if (!binding) return null;
  const other = KEY_ACTIONS.find(item => item.id !== action && keysOf(bindings, item.id).includes(binding));
  if (other) return { action: other.id, label: other.label };
  const fixed = FIXED_BINDINGS.find(item => item.test(binding));
  return fixed ? { action: null, label: fixed.label } : null;
}

/** Ctrl+letter (no Shift / Alt) is also a shell key (readline Ctrl+A, Ctrl+R …) that the terminal would no longer get. */
export const takesShellKey = (binding: string) => /^Ctrl\+[A-Z\][\\]$/.test(binding);

const keysOf = (bindings: KeyBindings, action: KeyAction) => {
  const keys = bindings[action];
  if (!keys) return [];
  return keys === DEFAULT_KEY_BINDINGS[action] ? [keys, ...(DEFAULT_ALIASES[action] ?? [])] : [keys];
};

// ---------- the bindings in use (set by App, read by key handlers and menu hints) ----------

let current: KeyBindings = DEFAULT_KEY_BINDINGS;

export const setKeyBindings = (bindings: KeyBindings) => {
  current = bindings;
};

/** Does this key press trigger `action` (with the bindings in use)? */
export const matchesKey = (action: KeyAction, event: KeyboardEvent, binding = bindingOf(event)) =>
  binding !== null && keysOf(current, action).includes(binding);

/** A binding as shown in menus and the editor (`Ctrl+Shift+PgUp`). */
export const formatKeys = (binding: string) => binding.replace(/PageUp$/, 'PgUp').replace(/PageDown$/, 'PgDn');

/** The binding of `action` for a menu hint / tooltip (undefined when it has none). */
export const keyHint = (action: KeyAction) => (current[action] ? formatKeys(current[action]) : undefined);

/** `text (Ctrl+Shift+P)` for a tooltip, or just `text` when the action has no shortcut. */
export const withKey = (text: string, action: KeyAction) => {
  const hint = keyHint(action);
  return hint ? `${text} (${hint})` : text;
};

/** A tmux command's hint: the prefix, then the command key (`Ctrl+B %`). */
export const prefixHint = (key: string) => (current.tmuxPrefix ? `${formatKeys(current.tmuxPrefix)} ${key}` : undefined);
