import { Suspense, type Dispatch, type SetStateAction } from 'react';
import type { TerminalTab } from '../../types';
import { NewConnectionDialog } from '../../components/sessions/NewConnectionDialog';
import { SessionDefaultsDialog } from '../../components/sessions/SessionDefaultsDialog';
import { SettingsDialog } from '../../components/dialogs/SettingsDialog';
import { ContextMenu, type MenuItem } from '../../components/common/MenuButton';
import { log } from '../../lib/platform/log';
import { isDesktop } from '../../lib/platform/tauri';
import { applyColorSchemes } from '../../lib/terminal/palettes';
import { describeProxy, type McpStatus } from '../../lib/settings/preferences';
import { AboutDialog, LogSettingsDialog, ProxyDialog } from '../../components/dialogs/AppDialogs';
import { KeyBindingsDialog } from '../../components/dialogs/KeyBindingsDialog';
import { APP_VERSION } from '../../lib/platform/version';
import { backend } from '../../lib/platform/backend';
import { FieldContextMenu } from '../../components/common/FieldMenu';
import { TooltipLayer } from '../../components/common/TooltipLayer';
import { AuthPromptDialog } from '../../components/terminal/AuthPromptDialog';
import { TreeDialog } from '../../components/sessions/SessionTree';
import { LockOverlay, LockPasswordDialog, LockSetupDialog } from '../../components/dialogs/LockScreen';
import { FocusModeDialog } from '../../components/dialogs/FocusModeDialog';
import { TunnelsDialog } from '../../components/dialogs/TunnelsDialog';
import { sanitizeLockSettings } from '../../lib/settings/lockScreen';
import { folderAndDescendants, folderPath, type SessionFolder, type TreeRef } from '../../lib/sessions/tree';
import i18n, { setLanguage, t, tc } from '../../i18n';
import type { ManagedConnection } from '../sessionsDoc';
import type { TreeDialogState } from '../helpers';
import type { useWindowFrame } from '../hooks/useWindowFrame';
import type { useLockScreen } from '../hooks/useLockScreen';
import type { useFocusMode } from '../hooks/useFocusMode';
import type { useWorkspace } from '../hooks/useWorkspace';
import type { usePreferences } from '../hooks/usePreferences';
import type { BarMenu } from '../../components/common/MenuBar';
import { CommandPalette } from './commandPalette';

/**
 * Everything App shows above the workbench: the session dialogs (New / Properties / Save As, Explorer folder and
 * item dialogs), the tab and status bar window context menus, Settings and the Tool / Help dialogs, menu search,
 * Focus Mode, the close confirmations (exit, window, tabs, MCP) and the lock screen, plus the tooltip layer.
 */
type DialogHostProps = {
  prefs: ReturnType<typeof usePreferences>;
  ws: ReturnType<typeof useWorkspace>;
  frame: ReturnType<typeof useWindowFrame>;
  lock: ReturnType<typeof useLockScreen>;
  focus: ReturnType<typeof useFocusMode>;
  connections: ManagedConnection[];
  rememberPassword: (connectionId: string, password: string, remember: boolean) => Promise<void>;
  newConnection: { folderId: string | null } | null;
  setNewConnectionState: Dispatch<SetStateAction<{ folderId: string | null } | null>>;
  addConnection: (connection: ManagedConnection, openIt?: boolean) => void;
  folders: SessionFolder[];
  folderCounts: Record<string, number>;
  shells: { name: string; path: string }[] | null;
  editingId: string | null;
  setEditingId: Dispatch<SetStateAction<string | null>>;
  updateConnection: (updated: ManagedConnection) => void;
  savingAsId: string | null;
  setSavingAsId: Dispatch<SetStateAction<string | null>>;
  treeDialog: TreeDialogState | null;
  setTreeDialog: Dispatch<SetStateAction<TreeDialogState | null>>;
  createFolder: (parentId: string | null, name: string) => void;
  renameItem: (target: TreeRef, name: string) => void;
  deleteItem: (target: TreeRef) => void;
  statusWindowMenu: { id: string; x: number; y: number } | null;
  setStatusWindowMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  statusWindowMenuItems: (id: string) => MenuItem[];
  tabMenu: { id: string; x: number; y: number } | null;
  setTabMenu: Dispatch<SetStateAction<{ id: string; x: number; y: number } | null>>;
  setBarRename: Dispatch<SetStateAction<{ id: string; value: string } | null>>;
  terminalTitle: (tab: TerminalTab) => string;
  renameTab: (tabId: string, title: string | null) => void;
  tabMenuItems: (tabId: string) => MenuItem[];
  preferencesDialog: 'settings' | 'defaults' | null;
  showOpacity: (percent: number) => void;
  setPreferencesDialog: Dispatch<SetStateAction<'settings' | 'defaults' | null>>;
  appDialog: 'keys' | 'tunnels' | 'proxy' | 'log' | 'about' | null;
  setAppDialog: Dispatch<SetStateAction<'keys' | 'tunnels' | 'proxy' | 'log' | 'about' | null>>;
  paletteOpen: boolean;
  menuBar: BarMenu[];
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  backendVersion: string | null;
  quitAsk: 'window' | 'exit' | null;
  setQuitAsk: Dispatch<SetStateAction<'window' | 'exit' | null>>;
  quit: (kind: 'window' | 'exit', confirmed?: boolean) => Promise<void>;
  windowDialog: { kind: 'rename' | 'close'; id: string } | null;
  setWindowDialog: Dispatch<SetStateAction<{ kind: 'rename' | 'close'; id: string } | null>>;
  renameWindow: (id: string, value: string) => void;
  doCloseWindow: (id: string) => void;
  mcpConfirm: { requestId: string; title: string; message: string; run: () => unknown } | null;
  answerMcpConfirm: (accept: boolean) => void;
  closeConfirm: { ids: string[]; pane?: boolean } | null;
  setCloseConfirm: Dispatch<SetStateAction<{ ids: string[]; pane?: boolean } | null>>;
  doCloseTabs: (tabIds: string[]) => void;
};

export function DialogHost(props: DialogHostProps) {
  const { sessionDefaults, proxy, theme, language, terminalPrefs, appearance, mcpPrefs, setTheme, setLanguageState } = props.prefs;
  const { setTerminalPrefs, setAppearance, setMcpPrefs, keyBindings, setKeyBindingState, setProxy, logPrefs, setLogPrefs } = props.prefs;
  const { swatches, setSessionDefaults } = props.prefs;
  const { allTabs, terminalTabs, windows } = props.ws;
  const { titleBar, setTitleBar } = props.frame;
  const { lockSettings, setLockPrompt, setLockSettings, lockPrompt, lockedRef, setLocked, saveLockPassword, locked } = props.lock;
  const { focusDialog, focusConfig, setFocusDialog, focusActive, setFocusConfig, applyFocusWindow, enterFocus } = props.focus;
  const { connections, rememberPassword, newConnection, setNewConnectionState, addConnection, folders, folderCounts, shells } = props;
  const { editingId, setEditingId, updateConnection, savingAsId, setSavingAsId, treeDialog, setTreeDialog, createFolder } = props;
  const { renameItem, deleteItem, statusWindowMenu, setStatusWindowMenu, statusWindowMenuItems, tabMenu, setTabMenu, setBarRename } = props;
  const { terminalTitle, renameTab, tabMenuItems, preferencesDialog, showOpacity, setPreferencesDialog, appDialog, setAppDialog } = props;
  const { paletteOpen, menuBar, setPaletteOpen, backendVersion, quitAsk, setQuitAsk, quit, windowDialog, setWindowDialog } = props;
  const { renameWindow, doCloseWindow, mcpConfirm, answerMcpConfirm, closeConfirm, setCloseConfirm, doCloseTabs } = props;

  return (
    <>
      <AuthPromptDialog connections={connections} onRemember={(id, password, remember) => void rememberPassword(id, password, remember)} />
      <TooltipLayer />
      <FieldContextMenu />
      {newConnection && (
        <NewConnectionDialog
          onClose={() => setNewConnectionState(null)}
          onSave={addConnection}
          folders={folders}
          folderCounts={folderCounts}
          folderId={newConnection.folderId}
          shells={shells ?? []}
          defaults={sessionDefaults}
          proxy={proxy}
          sessions={connections}
        />
      )}
      {(() => {
        const editing = editingId ? connections.find(item => item.id === editingId) : undefined;
        return (
          editing && (
            <NewConnectionDialog
              key={editing.id}
              initial={editing}
              onClose={() => setEditingId(null)}
              onSave={updateConnection}
              folders={folders}
              folderCounts={folderCounts}
              folderId={editing.folderId}
              shells={shells ?? []}
              openTerminals={allTabs.filter(tab => tab.connectionId === editing.id).length}
              proxy={proxy}
              sessions={connections}
            />
          )
        );
      })()}
      {(() => {
        const source = savingAsId ? connections.find(item => item.id === savingAsId) : undefined;
        return (
          source && (
            <NewConnectionDialog
              key={`copy-${source.id}`}
              initial={source}
              copy
              onClose={() => setSavingAsId(null)}
              onSave={connection => addConnection(connection, false)}
              folders={folders}
              folderCounts={folderCounts}
              folderId={source.folderId}
              shells={shells ?? []}
              proxy={proxy}
              sessions={connections}
            />
          )
        );
      })()}
      {treeDialog &&
        (() => {
          const close = () => setTreeDialog(null);
          if (treeDialog.kind === 'new-folder') {
            const where = folderPath(folders, treeDialog.parentId);
            return (
              <TreeDialog
                section={t('EXPLORER')}
                title={t('NEW FOLDER')}
                label={t('FOLDER NAME')}
                initial="New folder"
                confirm={t('CREATE')}
                message={<>{tc('Create a folder in <c>{{where}}</c>.', { where: where || t('the top level') })}</>}
                onCancel={close}
                onSubmit={name => {
                  createFolder(treeDialog.parentId, name);
                  close();
                }}
              />
            );
          }
          const { target } = treeDialog;
          const folder = target.kind === 'folder' ? folders.find(item => item.id === target.id) : undefined;
          const session = target.kind === 'session' ? connections.find(item => item.id === target.id) : undefined;
          const name = folder?.name ?? session?.name ?? '';
          if (!folder && !session) return null;
          if (treeDialog.kind === 'rename')
            return (
              <TreeDialog
                section={t('EXPLORER')}
                title={folder ? t('RENAME FOLDER') : t('RENAME SESSION')}
                label={t('NAME')}
                initial={name}
                confirm={t('RENAME')}
                onCancel={close}
                onSubmit={value => {
                  renameItem(target, value);
                  close();
                }}
              />
            );
          const ids = folder ? folderAndDescendants(folders, folder.id) : null;
          const inside = ids ? connections.filter(item => item.folderId !== null && ids.has(item.folderId)).length : 0;
          const subfolders = ids ? ids.size - 1 : 0;
          const openTabs = allTabs.filter(tab =>
            session
              ? tab.connectionId === session.id
              : connections.some(item => item.id === tab.connectionId && item.folderId !== null && ids!.has(item.folderId)),
          ).length;
          return (
            <TreeDialog
              section={t('EXPLORER')}
              title={folder ? t('DELETE FOLDER') : t('DELETE SESSION')}
              confirm={t('DELETE')}
              danger
              message={
                <>
                  {folder && (inside || subfolders)
                    ? tc('Delete <c>{{name}}</c> and everything inside it ({{content}})?', {
                        name,
                        content: [
                          subfolders && t('{{count}} folder(s)', { count: subfolders }),
                          inside && t('{{count}} session(s)', { count: inside }),
                        ]
                          .filter(Boolean)
                          .join(', '),
                      })
                    : tc('Delete <c>{{name}}</c>?', { name })}
                  {openTabs ? t(' {{openTabs}} open terminal(s) will be closed.', { openTabs }) : ''}
                  {t(' This cannot be undone.')}
                </>
              }
              onCancel={close}
              onSubmit={() => {
                deleteItem(target);
                close();
              }}
            />
          );
        })()}
      {statusWindowMenu && (
        <ContextMenu
          x={statusWindowMenu.x}
          y={statusWindowMenu.y}
          onClose={() => setStatusWindowMenu(null)}
          items={statusWindowMenuItems(statusWindowMenu.id)}
        />
      )}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          items={[
            {
              type: 'item',
              id: 'rename',
              label: t('Rename tab…'),
              icon: 'rename',
              onSelect: () => {
                const tab = terminalTabs.find(item => item.id === tabMenu.id);
                if (tab) setBarRename({ id: tab.id, value: terminalTitle(tab) });
              },
            },
            {
              type: 'item',
              id: 'reset-name',
              label: t('Restore default name'),
              disabled: !terminalTabs.find(item => item.id === tabMenu.id)?.title,
              onSelect: () => renameTab(tabMenu.id, null),
            },
            { type: 'separator', id: 'sep-rename' },
            ...tabMenuItems(tabMenu.id),
          ]}
        />
      )}
      {preferencesDialog === 'settings' && (
        <SettingsDialog
          theme={theme}
          language={language}
          titleBar={titleBar}
          desktop={isDesktop()}
          prefs={terminalPrefs}
          appearance={appearance}
          lock={lockSettings}
          mcp={mcpPrefs}
          onLockPassword={() => setLockPrompt('password')}
          onPreviewOpacity={showOpacity}
          onClose={() => {
            showOpacity(appearance.windowOpacity); // slider preview → back to the saved value
            setPreferencesDialog(null);
          }}
          onSave={(nextTheme, nextTitleBar, prefs, lock, nextAppearance, nextLanguage, nextMcp) => {
            setTheme(nextTheme);
            setLanguageState(nextLanguage);
            setLanguage(nextLanguage);
            setTitleBar(nextTitleBar);
            setTerminalPrefs(prefs);
            void applyColorSchemes(prefs.colorSchemes, true); // edited / replaced files are read again
            setLockSettings(current => sanitizeLockSettings({ ...current, ...lock }));
            setAppearance(nextAppearance);
            showOpacity(nextAppearance.windowOpacity);
            if (JSON.stringify(nextMcp) !== JSON.stringify(mcpPrefs)) {
              setMcpPrefs(nextMcp);
              // settings.json is written by the effect above; the backend applies it now.
              if (backend.live)
                void backend.call<McpStatus>('mcp.configure', nextMcp).then(
                  status =>
                    status.error
                      ? log.warn(t('MCP server: {{v}}', { v: status.error }))
                      : log(status.running ? t('MCP server running at {{v}}', { v: status.url }) : t('MCP server stopped')),
                  error => log.warn(t('MCP server: {{v}}', { v: String(error) })),
                );
            }
            setPreferencesDialog(null);
            log(i18n.t('Settings saved', { lng: nextLanguage }));
          }}
        />
      )}
      {appDialog === 'keys' && (
        <KeyBindingsDialog
          value={keyBindings}
          onClose={() => setAppDialog(null)}
          onSave={next => {
            setKeyBindingState(next);
            setAppDialog(null);
            log(t('Keyboard shortcuts saved'));
          }}
        />
      )}
      {appDialog === 'proxy' && (
        <ProxyDialog
          value={proxy}
          onClose={() => setAppDialog(null)}
          onSave={next => {
            setProxy(next);
            setAppDialog(null);
            log(t('Proxy: {{v}} — used by new SSH / Telnet / TCP connections', { v: describeProxy(next) }));
          }}
        />
      )}
      {appDialog === 'log' && (
        <LogSettingsDialog
          value={logPrefs}
          onClose={() => setAppDialog(null)}
          onSave={next => {
            setLogPrefs(next);
            setAppDialog(null);
            log(t('Log settings saved — level {{level}}, {{format}}', { level: next.level, format: next.format }));
          }}
        />
      )}
      {paletteOpen ? (
        <Suspense fallback={null}>
          <CommandPalette menus={menuBar} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      ) : null}
      {appDialog === 'tunnels' && <TunnelsDialog sessions={connections} onClose={() => setAppDialog(null)} />}
      {appDialog === 'about' && <AboutDialog version={APP_VERSION} backendVersion={backendVersion} onClose={() => setAppDialog(null)} />}
      {focusDialog && (
        <FocusModeDialog
          value={focusConfig}
          swatches={swatches}
          desktop={isDesktop()}
          onCancel={() => setFocusDialog(false)}
          onConfirm={config => {
            if (focusActive) {
              setFocusConfig(config);
              setFocusDialog(false);
              void applyFocusWindow(config, false).catch(error => log.error(t('Focus Mode'), error));
              log(t('Focus Mode settings applied'));
            } else enterFocus(config);
          }}
        />
      )}
      {quitAsk && (
        <TreeDialog
          section={t('METROTERM')}
          title={quitAsk === 'exit' ? t('EXIT') : t('CLOSE')}
          confirm={quitAsk === 'exit' ? t('EXIT') : t('CLOSE')}
          danger
          message={
            allTabs.length === 1
              ? t('A terminal is open. Close MetroTerm anyway? Its shell or connection ends.')
              : t('{{count}} terminals are open. Close MetroTerm anyway? Their shells and connections end.', { count: allTabs.length })
          }
          onCancel={() => setQuitAsk(null)}
          onSubmit={() => {
            const kind = quitAsk;
            setQuitAsk(null);
            void quit(kind, true);
          }}
        />
      )}
      {windowDialog &&
        (() => {
          const target = windows.find(item => item.id === windowDialog.id);
          const close = () => setWindowDialog(null);
          if (!target) return null;
          if (windowDialog.kind === 'rename')
            return (
              <TreeDialog
                section={t('WINDOW')}
                title={t('RENAME WINDOW')}
                label={t('Name')}
                initial={target.name}
                confirm={t('RENAME')}
                onCancel={close}
                onSubmit={value => {
                  renameWindow(target.id, value);
                  close();
                }}
              />
            );
          const count = allTabs.filter(tab => tab.windowId === target.id).length;
          return (
            <TreeDialog
              section={t('WINDOW')}
              title={t('CLOSE WINDOW')}
              confirm={t('CLOSE')}
              danger
              message={
                <>
                  {count === 1
                    ? tc('Close <c>{{name}}</c> with its tab? Its shell or connection ends.', { name: target.name })
                    : tc('Close <c>{{name}}</c> with its {{count}} tabs? Their shells and connections end.', { name: target.name, count })}
                </>
              }
              onCancel={close}
              onSubmit={() => {
                close();
                doCloseWindow(target.id);
              }}
            />
          );
        })()}
      {mcpConfirm && (
        <TreeDialog
          section={t('MCP')}
          title={mcpConfirm.title}
          confirm={t('CLOSE')}
          danger
          message={<>{mcpConfirm.message}</>}
          onCancel={() => answerMcpConfirm(false)}
          onSubmit={() => answerMcpConfirm(true)}
        />
      )}
      {closeConfirm &&
        (() => {
          const closing = closeConfirm.ids
            .map(id => terminalTabs.find(tab => tab.id === id))
            .filter((tab): tab is TerminalTab => Boolean(tab));
          const paneMode = Boolean(closeConfirm.pane);
          const close = () => setCloseConfirm(null);
          if (!closing.length) return null;
          const one = closing.length === 1;
          return (
            <TreeDialog
              section={t('SESSION')}
              title={paneMode ? t('CLOSE PANE') : one ? t('CLOSE TAB') : t('CLOSE {{length}} TABS', { length: closing.length })}
              confirm={t('CLOSE')}
              danger
              message={
                one ? (
                  <>
                    {paneMode
                      ? tc('Close the pane <c>{{name}}</c>? Its shell or connection ends.', { name: terminalTitle(closing[0]) })
                      : tc('Close <c>{{name}}</c>? Its shell or connection ends.', { name: terminalTitle(closing[0]) })}
                  </>
                ) : (
                  <>
                    {t('Close {{count}} tabs ({{names}})? Their shells and connections end.', {
                      count: closing.length,
                      names:
                        closing
                          .slice(0, 4)
                          .map(tab => terminalTitle(tab))
                          .join(', ') + (closing.length > 4 ? ', …' : ''),
                    })}
                  </>
                )
              }
              onCancel={close}
              onSubmit={() => {
                close();
                doCloseTabs(closing.map(tab => tab.id));
              }}
            />
          );
        })()}
      {lockPrompt === 'setup' && (
        <LockSetupDialog
          onCancel={() => setLockPrompt(null)}
          onSkip={dontAsk => {
            if (dontAsk) setLockSettings(current => ({ ...current, skipPrompt: true }));
            setLockPrompt(null);
            lockedRef.current = true;
            setLocked(true);
          }}
          onSetAndLock={async (password, dontAsk) => {
            await saveLockPassword(password);
            if (dontAsk) setLockSettings(current => ({ ...current, skipPrompt: true }));
            setLockPrompt(null);
            lockedRef.current = true;
            setLocked(true);
            log(t('Lock password set'));
          }}
        />
      )}
      {lockPrompt === 'password' && (
        <LockPasswordDialog
          settings={lockSettings}
          onClose={() => setLockPrompt(null)}
          onSave={async password => {
            await saveLockPassword(password);
            setLockPrompt(null);
            log(password === null ? t('Lock password removed') : t('Lock password saved'));
          }}
        />
      )}
      {locked && (
        <LockOverlay
          settings={lockSettings}
          onUnlock={() => {
            lockedRef.current = false;
            setLocked(false);
            log(t('Unlocked'));
          }}
        />
      )}
      {preferencesDialog === 'defaults' && (
        <SessionDefaultsDialog
          value={sessionDefaults}
          shells={shells ?? []}
          onClose={() => setPreferencesDialog(null)}
          onSave={value => {
            setSessionDefaults(value);
            setPreferencesDialog(null);
            log(t('Default session settings saved'));
          }}
        />
      )}
    </>
  );
}
