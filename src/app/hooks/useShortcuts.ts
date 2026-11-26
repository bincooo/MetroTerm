import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import type { TerminalTab, TmuxNode } from '../../types';
import { tmuxResize, tmuxSwap, tmuxToward, type TmuxDirection } from '../../lib/workspace/tmux';
import { isDesktop } from '../../lib/platform/tauri';
import type { TerminalPrefs } from '../../lib/settings/preferences';
import { terminalRegistry } from '../../lib/platform/backend';
import { bindingOf, matchesKey } from '../../lib/settings/keybindings';
import type { useWorkspace } from './useWorkspace';

const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const;
/** Keys that only change the modifiers: they neither run nor end a tmux command. */
const MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'];

/**
 * Keyboard: the tmux prefix (Ctrl+B, then a command key; `prefix` is shown in the status bar while it waits) and
 * the app shortcuts (Session menu, Focus Mode, menu search, zoom, windows …), in the capture phase so they win
 * over the terminal. Remote Mode leaves the keys typed in a terminal to the remote side.
 */
type ShortcutDeps = {
  ws: ReturnType<typeof useWorkspace>;
  updateTmux: (change: (tree: TmuxNode) => TmuxNode) => void;
  focusTmuxPane: (paneId: string) => void;
  splitTerminal: (dir: TmuxDirection, tabId?: string | null) => void;
  closeTmuxPane: (paneId: string) => void;
  breakTab: (tabId: string) => void;
  openTerminal: (connectionId: string, pane?: string, activate?: boolean) => string;
  activateTerminal: (tab: TerminalTab) => void;
  closeTabs: (tabIds: string[]) => void;
  setBarRename: Dispatch<SetStateAction<{ id: string; value: string } | null>>;
  terminalTitle: (tab: TerminalTab) => string;
  lockedRef: MutableRefObject<boolean>;
  terminalPrefs: TerminalPrefs;
  toggleFocus: () => void;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  toggleFullScreen: () => Promise<void>;
  setNewConnection: (folderId?: string | null | undefined) => void;
  setSavingAsId: Dispatch<SetStateAction<string | null>>;
  zoomActive: (step: 1 | -1 | 0) => void;
  switchWindow: (id: string) => void;
  stepWindow: (delta: number) => void;
  quit: (kind: 'window' | 'exit', confirmed?: boolean) => Promise<void>;
};

export function useShortcuts(deps: ShortcutDeps) {
  const { activeTab, tmuxPaneOfTab, tmux, tmuxTree, tmuxPaneTabs, updateWindow, windows } = deps.ws;
  const { updateTmux, focusTmuxPane, splitTerminal, closeTmuxPane, breakTab, openTerminal, activateTerminal, closeTabs } = deps;
  const { setBarRename, terminalTitle, lockedRef, terminalPrefs, toggleFocus, setPaletteOpen, toggleFullScreen, setNewConnection } = deps;
  const { setSavingAsId, zoomActive, switchWindow, stepWindow, quit } = deps;
  /**
   * tmux key bindings (Local Mode, keyboard in a terminal): Ctrl+B, then a key. `prefix` is
   * shown in the status bar while MetroTerm waits for that key.
   */
  const [prefix, setPrefix] = useState(false);
  const prefixRef = useRef(false);
  const setPrefixOn = (on: boolean) => {
    prefixRef.current = on;
    setPrefix(on);
  };
  /**
   * Repeatable resize (tmux `bind -r C-arrow`): after Ctrl+B Ctrl+arrow (or Alt+arrow), further arrows resize the
   * pane again without Ctrl+B for as long as that modifier stays held; releasing it (or any other key) ends it.
   */
  const resizeRepeatRef = useRef<'ctrl' | 'alt' | null>(null);
  /** resize-pane on Ctrl+arrow (small step) / Alt+arrow (larger step); false for other keys. */
  const resizeKey = (event: KeyboardEvent): boolean => {
    const toward = ARROWS[event.key as keyof typeof ARROWS];
    if (!toward || !(event.ctrlKey || event.altKey)) return false;
    const tab = activeTab;
    if (tab && tmux.panes.length > 1) {
      const paneId = tmuxPaneOfTab(tab.id);
      updateTmux(tree => tmuxResize(tree, paneId, toward, event.altKey ? 0.1 : 0.03));
    }
    resizeRepeatRef.current = event.altKey ? 'alt' : 'ctrl';
    return true;
  };
  /** The previous / next tab in the focused pane's tab bar, wrapping around (Ctrl+B p / n, Ctrl+PgUp / PgDn). */
  const stepTab = (delta: number) => {
    const tab = activeTab;
    if (!tab) return;
    const own = tmuxPaneTabs(tmuxPaneOfTab(tab.id));
    const index = own.findIndex(item => item.id === tab.id);
    const next = own[(index + delta + own.length) % own.length];
    if (next && next.id !== tab.id) activateTerminal(next);
  };
  /** Handle the key after Ctrl+B. Returns false for keys that aren't bound (they are swallowed, like tmux). */
  const tmuxCommand = (event: KeyboardEvent): boolean => {
    const tab = activeTab;
    if (!tab) return false;
    const paneId = tmuxPaneOfTab(tab.id);
    const split = tmux.panes.length > 1;
    const key = event.key;
    const toward = ARROWS[key as keyof typeof ARROWS];
    if (resizeKey(event)) return true;
    if (event.ctrlKey && event.code === 'KeyB') {
      // Ctrl+B Ctrl+B: send Ctrl+B itself to the terminal.
      terminalRegistry.write(tab.id, '\u0002');
      return true;
    }
    if (toward) {
      const next = split ? tmuxToward(tmuxTree, paneId, toward) : null;
      if (next) focusTmuxPane(next);
      return true;
    }
    const ids = tmux.panes.map(pane => pane.id);
    const at = ids.indexOf(paneId);
    // Tabs of the focused pane (its tab bar).
    const own = tmuxPaneTabs(paneId);
    switch (key) {
      case '%':
        splitTerminal('row');
        return true;
      case '"':
        splitTerminal('column');
        return true;
      case 'o':
        if (split) focusTmuxPane(ids[(at + 1) % ids.length]);
        return true;
      case ';':
        if (split) focusTmuxPane(ids[(at - 1 + ids.length) % ids.length]);
        return true;
      case 'x':
        closeTmuxPane(paneId);
        return true;
      case 'z':
        if (split) updateWindow(item => ({ tmuxZoomed: item.tmuxZoomed ? undefined : true }));
        return true;
      case '!':
        breakTab(tab.id);
        return true;
      case '{':
      case '}':
        if (split) {
          const other = ids[(at + (key === '{' ? -1 : 1) + ids.length) % ids.length];
          updateTmux(tree => tmuxSwap(tree, paneId, other));
        }
        return true;
      case 'c':
        openTerminal(tab.connectionId, paneId);
        return true;
      case 'n':
      case 'p':
        stepTab(key === 'n' ? 1 : -1);
        return true;
      case '&':
        closeTabs([tab.id]);
        return true;
      case ',':
        setBarRename({ id: tab.id, value: terminalTitle(tab) });
        return true;
      default:
        if (/^[0-9]$/.test(key)) {
          const target = own[Number(key)];
          if (target) activateTerminal(target);
          return true;
        }
        return false;
    }
  };
  // Session menu shortcuts. Capture phase, so they win over the terminal (Alt+N …).
  const shortcutRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  shortcutRef.current = event => {
    if (lockedRef.current) return false; // the lock screen takes every key
    // Remote Mode: keys typed in a terminal are not MetroTerm shortcuts, they all go to the remote side.
    const inTerminal = Boolean((event.target as Element | null)?.closest?.('.xterm'));
    if (terminalPrefs.keyMode === 'remote' && inTerminal) return false;
    // Ctrl (Alt) still held after Ctrl+B Ctrl+arrow (Alt+arrow): every arrow resizes the pane again.
    if (resizeRepeatRef.current) {
      if (MODIFIERS.includes(event.key)) return false;
      const held = resizeRepeatRef.current === 'ctrl' ? event.ctrlKey && !event.altKey : event.altKey && !event.ctrlKey;
      if (held && resizeKey(event)) return true;
      resizeRepeatRef.current = null; // any other key: handled as usual below
    }
    // tmux prefix Ctrl+B in a terminal, then the command key (Esc cancels).
    if (prefixRef.current) {
      if (MODIFIERS.includes(event.key) || event.isComposing) return false;
      setPrefixOn(false);
      if (event.key !== 'Escape') tmuxCommand(event);
      return true;
    }
    // Preferences → Keyboard Shortcuts… is recording a key: it is the field's.
    if ((event.target as Element | null)?.closest?.('.key-capture')) return false;
    const binding = bindingOf(event);
    if (binding === null) return false;
    const is = (action: Parameters<typeof matchesKey>[0]) => matchesKey(action, event, binding);
    if (inTerminal && is('tmuxPrefix')) {
      setPrefixOn(true);
      return true;
    }
    const modalOpen = Boolean(document.querySelector('.modal-backdrop:not(.is-leaving)'));
    // Focus Mode on / off (not while a dialog is open: the dialog has its own OK).
    if (is('focusMode') && !modalOpen) {
      toggleFocus();
      return true;
    }
    // Menu search opens / closes; while it is open its keys are its own.
    if (is('menuSearch')) {
      if (!modalOpen) setPaletteOpen(open => !open);
      return true;
    }
    if ((event.target as Element | null)?.closest?.('.command-palette')) return false;
    if (modalOpen) return false;
    if (is('fullScreen')) {
      void toggleFullScreen();
      return true;
    }
    if (is('newSession')) {
      setNewConnection();
      return true;
    }
    if (is('saveAs')) {
      if (activeTab) setSavingAsId(activeTab.connectionId);
      return true;
    }
    // View → Zoom on the active terminal, instead of the browser's page zoom.
    if (is('zoomIn')) {
      zoomActive(1);
      return true;
    }
    if (is('zoomOut')) {
      zoomActive(-1);
      return true;
    }
    // Window menu: Ctrl+Shift+1…9 (fixed) shows a window; previous / next window.
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && /^Digit[1-9]$/.test(event.code)) {
      const target = windows[Number(event.code.slice(5)) - 1];
      if (target) switchWindow(target.id);
      return true;
    }
    if (is('prevWindow') || is('nextWindow')) {
      stepWindow(is('prevWindow') ? -1 : 1);
      return true;
    }
    // Tabs of the focused pane (split view: each pane has its own tab bar).
    if (is('prevTab') || is('nextTab')) {
      stepTab(is('prevTab') ? -1 : 1);
      return true;
    }
    if (is('closeTab')) {
      if (activeTab) closeTabs([activeTab.id]);
      return true;
    }
    const plainAlt = event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey;
    // Alt+F4 normally reaches the window manager first; handled here for desktops where it doesn't.
    if (plainAlt && event.code === 'F4' && isDesktop()) {
      void quit('exit');
      return true;
    }
    return false;
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.type === 'keydown' && shortcutRef.current(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Releasing the held modifier (or leaving the window) ends the repeatable resize.
    const onKeyUp = (event: KeyboardEvent) => {
      const mode = resizeRepeatRef.current;
      if ((mode === 'ctrl' && event.key === 'Control') || (mode === 'alt' && event.key === 'Alt')) resizeRepeatRef.current = null;
    };
    const onBlur = () => {
      resizeRepeatRef.current = null;
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  return { prefix };
}
