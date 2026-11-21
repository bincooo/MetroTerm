import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';
import { ContextMenu, type MenuItem } from './MenuButton';
import { transportIcon, transportName } from '../lib/transports';
import type { Transport } from '../types';
import { t } from '../i18n';

type OpenTab = {
  id: string;
  /** Shown name: the custom tab name, else the default one. */
  title: string;
  /** Name the tab gets without a custom name (session name, numbered when open more than once). */
  defaultTitle: string;
  renamed: boolean;
  transport: Transport;
  status: string;
  /** user@host:port or the local shell. */
  detail: string;
  /** Explorer folder path of the session, for the tooltip. */
  folder: string;
};

/** Tooltip as a table (label left, value right), like Filer's rows — TooltipLayer reads "label\tvalue" lines. */
function tabTip(tab: OpenTab) {
  const rows: [string, string][] = [['Name', tab.title]];
  if (tab.renamed) rows.push(['Session', tab.defaultTitle]);
  rows.push(['Type', transportName(tab.transport)]);
  rows.push([
    tab.transport === 'local' ? t('Shell') : tab.transport === 'serial' ? t('Port') : t('Host'),
    tab.transport === 'local' ? tab.detail.replace(/^local · /, '') : tab.detail,
  ]);
  rows.push(['Status', tab.status]);
  if (tab.folder) rows.push(['Folder', tab.folder]);
  rows.push(['Rename', 'Right-click or F2']);
  return rows.map(([label, value]) => `${label}\t${(value || '—').replace(/[\t\n]/g, ' ')}`).join('\n');
}

type SessionsPanelProps = {
  tabs: OpenTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  /** `null` = back to the default name. */
  onRename: (id: string, title: string | null) => void;
  /** Pointer down on a row: may start dragging it to another place in the tab order (see lib/tabDrag). */
  onDragStart: (event: React.PointerEvent<HTMLElement>, strip: string, id: string, label: string) => void;
  /** Extra items of the right-click menu (duplicate, reconnect, close …), after "Rename". */
  menuFor: (id: string) => MenuItem[];
  /** Ask the panel to start renaming this tab (e.g. from the terminal tab bar), with a counter so the same tab can be asked twice. */
  renameRequest?: { id: string; seq: number } | null;
};

/**
 * Session panel: the open terminal tabs (not the saved sessions of the Explorer).
 * Click = switch to the tab. Right-click = menu with Rename… (F2 / double-click also rename in place;
 * Enter saves, Esc cancels, an empty name restores the default one). Drag a row to change the tab
 * order (the same order as the terminal tab bar; rows can also be dropped on the tab bar and back).
 */
export function SessionsPanel({ tabs, activeId, onActivate, onRename, onDragStart, menuFor, renameRequest }: SessionsPanelProps) {
  const strip = useId();
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = (id: string) => {
    const tab = tabs.find(item => item.id === id);
    if (tab) setEditing({ id, value: tab.title });
  };
  useEffect(() => {
    if (renameRequest) startRename(renameRequest.id);
  }, [renameRequest?.seq]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing?.id]);
  // The tab being renamed was closed.
  useEffect(() => {
    if (editing && !tabs.some(tab => tab.id === editing.id)) setEditing(null);
  }, [tabs, editing]);

  const commit = () => {
    if (!editing) return;
    const tab = tabs.find(item => item.id === editing.id);
    const value = editing.value.trim();
    setEditing(null);
    if (!tab) return;
    if (!value || value === tab.defaultTitle) {
      if (tab.renamed) onRename(tab.id, null);
      return;
    }
    if (value !== tab.title) onRename(tab.id, value);
  };

  const query = filter.trim().toLowerCase();
  const shown = query ? tabs.filter(tab => `${tab.title} ${tab.defaultTitle} ${tab.detail}`.toLowerCase().includes(query)) : tabs;

  return (
    <>
      <div className="pane-filter">
        <input value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('Filter open tabs')} />
        <button aria-label={t('Filter')} title={t('Filter')}>
          <Icon name="filter" />
        </button>
      </div>
      <div className="session-quickbar open-tabs-bar">
        <span>{tabs.length === 1 ? t('1 open tab') : t('{{count}} open tabs', { count: tabs.length })}</span>
      </div>
      <div
        className="tree-list open-tabs"
        role="listbox"
        aria-label={t('Open tabs')}
        data-tab-strip={strip}
        data-tab-group="terminal"
        data-tab-axis="y"
      >
        {!tabs.length && <div className="open-tabs-empty">{t('No open tabs. Double-click a session in Explorer to open one.')}</div>}
        {tabs.length > 0 && !shown.length && <div className="open-tabs-empty">{t('No tab matches “{{filter}}”.', { filter })}</div>}
        {shown.map(tab => {
          const isEditing = editing?.id === tab.id;
          return (
            <div
              key={tab.id}
              role="option"
              aria-selected={tab.id === activeId}
              tabIndex={0}
              data-tab={tab.id}
              data-tab-key={tab.id}
              className={`tree-row open-tab${tab.id === activeId ? ' is-current' : ''}${isEditing ? ' is-editing' : ''}`}
              data-tip={isEditing ? undefined : tabTip(tab)}
              onClick={() => !isEditing && onActivate(tab.id)}
              onPointerDown={event => !isEditing && onDragStart(event, strip, tab.id, tab.title)}
              onDoubleClick={() => startRename(tab.id)}
              onKeyDown={event => {
                if (isEditing) return;
                if (event.key === 'F2') {
                  event.preventDefault();
                  startRename(tab.id);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  onActivate(tab.id);
                }
              }}
              onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                onActivate(tab.id);
                setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
              }}
            >
              <i className={tab.status === 'online' ? 'session-online' : tab.status === 'connecting' ? 'session-connecting' : ''}>
                <Icon name={transportIcon(tab.transport)} />
              </i>
              {isEditing ? (
                <input
                  ref={inputRef}
                  className="open-tab-input"
                  value={editing.value}
                  spellCheck={false}
                  aria-label="Tab name"
                  placeholder={tab.defaultTitle}
                  onChange={event => setEditing({ id: tab.id, value: event.target.value })}
                  onClick={event => event.stopPropagation()}
                  onDoubleClick={event => event.stopPropagation()}
                  onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commit();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditing(null);
                    }
                  }}
                  onBlur={commit}
                />
              ) : (
                <span className="open-tab-title">{tab.title}</span>
              )}
              {!isEditing && <small className="open-tab-detail">{tab.detail}</small>}
              {!isEditing && <em className={`open-tab-status ${tab.status}`} />}
            </div>
          );
        })}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { type: 'item', id: 'rename', label: t('Rename tab…'), icon: 'rename', hint: 'F2', onSelect: () => startRename(menu.id) },
            {
              type: 'item',
              id: 'reset-name',
              label: t('Restore default name'),
              disabled: !tabs.find(tab => tab.id === menu.id)?.renamed,
              onSelect: () => onRename(menu.id, null),
            },
            { type: 'separator', id: 'sep-rename' },
            ...menuFor(menu.id),
          ]}
        />
      )}
    </>
  );
}
