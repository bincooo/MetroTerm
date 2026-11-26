import { Icon } from '../../components/common/Icon';
import type { KeyMode } from '../../lib/settings/preferences';
import { THEME_NAMES, nextTheme } from '../../lib/settings/themes';
import { keyHint } from '../../lib/settings/keybindings';
import { t } from '../../i18n';
import { StatusCursor } from '../StatusCursor';
import { useActivity } from '../../lib/platform/log';
import type { useLockScreen } from '../hooks/useLockScreen';
import type { useFocusMode } from '../hooks/useFocusMode';
import type { useWorkspace } from '../hooks/useWorkspace';
import type { usePreferences } from '../hooks/usePreferences';
import type { Dispatch, SetStateAction } from 'react';

/**
 * The status bar: activity, the windows (click shows one, double-click renames, right-click opens its menu, + opens
 * a new one; hidden with one window), the tmux prefix, the cursor of the active terminal, Local / Remote Mode,
 * Lock Screen and the theme switch.
 */
type StatusBarProps = {
  focus: ReturnType<typeof useFocusMode>;
  ws: ReturnType<typeof useWorkspace>;
  lock: ReturnType<typeof useLockScreen>;
  prefs: ReturnType<typeof usePreferences>;
  switchWindow: (id: string) => void;
  setWindowDialog: Dispatch<SetStateAction<{ kind: 'rename' | 'close'; id: string } | null>>;
  setStatusWindowMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  newWindow: () => void;
  prefix: boolean;
  keyMode: KeyMode;
  setKeyMode: (mode: KeyMode) => void;
};

export function StatusBar(props: StatusBarProps) {
  const { focusActive, focusConfig } = props.focus;
  const { windows, currentWindow, allTabs, terminalTabOpen, activeTab } = props.ws;
  const { lockSettings, lockNow } = props.lock;
  const { theme, setTheme } = props.prefs;
  const { switchWindow, setWindowDialog, setStatusWindowMenu, newWindow, prefix, keyMode, setKeyMode } = props;

  // The last log message, subscribed here: a new message re-renders the status bar only, not the app.
  const activity = useActivity();

  return (
    <footer className="status-bar" hidden={focusActive && focusConfig.bars.status === 'hide'}>
      <span>
        <i>
          <Icon name="activity" />
        </i>
      </span>
      <span>{activity === 'Ready' ? t('Ready') : activity}</span>
      <span className="status-spacer" />
      {/* Window menu: the windows, click to show one (double-click renames, right-click opens its menu, + opens a new one). Hidden with one window. */}
      <div className="status-windows" role="tablist" aria-label={t('Windows')} hidden={windows.length < 2}>
        {windows.map((item, index) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={item.id === currentWindow.id}
            className={item.id === currentWindow.id ? 'status-window is-active' : 'status-window'}
            title={`${item.name} — ${allTabs.filter(tab => tab.windowId === item.id).length} tab(s)${index < 9 ? ` · Ctrl+Shift+${index + 1}` : ''}`}
            onClick={() => switchWindow(item.id)}
            onDoubleClick={() => setWindowDialog({ kind: 'rename', id: item.id })}
            onContextMenu={event => {
              event.preventDefault();
              event.stopPropagation();
              setStatusWindowMenu({ id: item.id, x: event.clientX, y: event.clientY });
            }}
          >
            {item.name}
          </button>
        ))}
        <button className="status-window-new" aria-label={t('New Window')} title={t('New Window')} onClick={newWindow}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {prefix && (
        <em className="status-prefix" title={t('tmux prefix: press a key (Esc cancels)')}>
          {keyHint('tmuxPrefix')}
        </em>
      )}
      {terminalTabOpen && activeTab && <StatusCursor tabId={activeTab.id} />}
      <button
        className="status-mode"
        title={`${keyMode === 'remote' ? 'Remote Mode: keys in the terminal go to the remote side' : 'Local Mode: MetroTerm shortcuts work in the terminal'} — click for ${keyMode === 'remote' ? 'Local' : 'Remote'} Mode`}
        onClick={() => setKeyMode(keyMode === 'remote' ? 'local' : 'remote')}
      >
        {keyMode === 'remote' ? t('Remote Mode') : t('Local Mode')}
      </button>
      <button
        className="status-lock"
        aria-label={t('Lock Screen')}
        title={
          lockSettings.idleMinutes
            ? t('Lock the screen (auto lock after {{idleMinutes}} min idle)', { idleMinutes: lockSettings.idleMinutes })
            : t('Lock the screen')
        }
        onClick={() => lockNow()}
      >
        <Icon name="lock" />
      </button>
      <button
        className="status-theme"
        aria-label={t('Theme')}
        title={`Theme: ${THEME_NAMES[theme]} — click for ${THEME_NAMES[nextTheme(theme)]}`}
        onClick={() => setTheme(nextTheme)}
      >
        <Icon name={theme === 'gold' ? 'crown' : theme === 'light' ? 'sun' : 'moon'} />
      </button>
    </footer>
  );
}
