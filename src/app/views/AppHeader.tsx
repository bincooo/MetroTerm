import { Icon } from '../../components/common/Icon';
import { MenuBar } from '../../components/common/MenuBar';
import { isDesktop } from '../../lib/platform/tauri';
import { keyHint, withKey } from '../../lib/settings/keybindings';
import { t } from '../../i18n';
import { isMacHost } from '../../lib/platform/hostOs';
import type { useWindowFrame } from '../hooks/useWindowFrame';
import type { useFocusMode } from '../hooks/useFocusMode';
import { loadCommandPalette } from './commandPalette';
import type { BarMenu } from '../../components/common/MenuBar';
import type { Dispatch, SetStateAction } from 'react';

/**
 * The bars above the workbench: the title bar of a frameless desktop window (drag, double-click, window buttons),
 * the menu bar with its tools (menu search, Tunnels, Focus Mode) and, in Focus Mode with the menu bar hidden, the
 * exit zone at the top edge.
 */
type AppHeaderProps = {
  frame: ReturnType<typeof useWindowFrame>;
  focus: ReturnType<typeof useFocusMode>;
  windowTitle: string;
  quit: (kind: 'window' | 'exit', confirmed?: boolean) => Promise<void>;
  menuBar: BarMenu[];
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  appDialog: 'tunnels' | 'proxy' | 'log' | 'keys' | 'about' | null;
  runningTunnels: number;
  setAppDialog: Dispatch<SetStateAction<'tunnels' | 'proxy' | 'log' | 'keys' | 'about' | null>>;
};

export function AppHeader(props: AppHeaderProps) {
  const { titleBar, startWindowDrag, zoomWindow, toggleMaximize, minimizeWindow, maximized } = props.frame;
  const { focusActive, focusConfig, toggleFocus, exitFocus } = props.focus;
  const { windowTitle, quit, menuBar, paletteOpen, setPaletteOpen, appDialog, runningTunnels, setAppDialog } = props;

  return (
    <>
      {/* Desktop only: in a browser the page already sits in the browser's own window and tab. */}
      {isDesktop() && titleBar === 'frameless' && !focusActive && (
        <header
          className="window-chrome"
          onMouseDown={startWindowDrag}
          onDoubleClick={event => {
            if ((event.target as HTMLElement).closest('.window-controls')) return;
            // macOS: the double-click zooms (maximizes) the window; the □ button goes to full screen.
            if (isMacHost()) void zoomWindow();
            else void toggleMaximize();
          }}
        >
          <div className="app-mark" />
          <div className="window-name">{windowTitle}</div>
          <div className="window-controls">
            <button title={t('Minimize')} onClick={() => void minimizeWindow()}>
              <Icon name="minimize" />
            </button>
            <button
              title={isMacHost() ? (maximized ? t('Exit Full Screen') : t('Full Screen')) : maximized ? t('Restore') : t('Maximize')}
              onClick={() => void toggleMaximize()}
            >
              <Icon name={maximized ? 'restore' : 'maximize'} size={12} />
            </button>
            <button className="window-close" title={t('Close')} onClick={() => void quit('window')}>
              <Icon name="close" />
            </button>
          </div>
        </header>
      )}
      <nav className="menu-bar" hidden={focusActive && focusConfig.bars.menu === 'hide'}>
        <MenuBar menus={menuBar} />
        <div className="menu-tools">
          <button
            className={paletteOpen ? 'selected' : undefined}
            data-palette-toggle
            aria-label={t('Search menus')}
            title={withKey(t('Search menus'), 'menuSearch')}
            onPointerEnter={() => void loadCommandPalette()}
            onFocus={() => void loadCommandPalette()}
            // pointerdown (like the menu titles) so the terminal keeps focus and gets it back on Esc.
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.preventDefault();
              setPaletteOpen(open => !open);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setPaletteOpen(open => !open);
              }
            }}
          >
            <Icon name="search" />
          </button>
          <button
            className={appDialog === 'tunnels' ? 'selected' : undefined}
            title={runningTunnels ? t('SSH tunnels — {{runningTunnels}} running', { runningTunnels }) : t('SSH tunnels (port forwarding)')}
            onClick={() => setAppDialog(current => (current === 'tunnels' ? null : 'tunnels'))}
          >
            <Icon name="tunnel" />
            <span>{t('Tunnels')}</span>
            {runningTunnels ? <em className="menu-tools-count">{runningTunnels}</em> : null}
          </button>
          <button
            className={focusActive ? 'is-on' : undefined}
            aria-pressed={focusActive}
            aria-label={t('Focus Mode')}
            title={withKey(focusActive ? t('Leave Focus Mode') : t('Focus Mode'), 'focusMode')}
            onClick={toggleFocus}
          >
            <Icon name="focus" />
            <span>{t('Focus Mode')}</span>
          </button>
        </div>
      </nav>
      {focusActive && focusConfig.bars.menu === 'hide' && (
        <div className="focus-exit-zone">
          <button onClick={exitFocus} title={keyHint('focusMode')}>
            <Icon name="focus" />
            <span>{t('Exit Focus Mode')}</span>
            {keyHint('focusMode') && <small>{keyHint('focusMode')}</small>}
          </button>
        </div>
      )}
    </>
  );
}
