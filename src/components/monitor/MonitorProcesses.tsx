import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { log } from '../../lib/platform/log';
import { readConfig, writeConfig } from '../../lib/platform/config';
import { Icon } from '../common/Icon';
import { ContextMenu, type MenuItem } from '../common/MenuButton';
import { TreeDialog } from '../sessions/SessionTree';
import { t, tc } from '../../i18n';
import { formatBytes, naturalCompare } from '../../lib/format';
import { highlightMatch } from '../common/MatchHighlight';

export type MonitorProcess = { pid: number; name: string; user: string; cpu: number; memory: number; command: string };
export type StopSignal = 'TERM' | 'KILL';

type SortKey = 'pid' | 'name' | 'user' | 'cpu' | 'memory';
type Sort = { key: SortKey; descending: boolean };
const COLUMNS: [SortKey, string][] = [
  ['pid', 'PID'],
  ['name', 'Name'],
  ['user', 'User'],
  ['cpu', 'CPU'],
  ['memory', 'Memory'],
];
/** Numbers start with the largest first, text A → Z. */
const NUMERIC: SortKey[] = ['pid', 'cpu', 'memory'];
const DEFAULT_SORT: Sort = { key: 'cpu', descending: true };
/** Rows shown: the first ones in the current sort order (after the name search). */
const LIMIT = 20;

const text = naturalCompare;
const ORDER: Record<SortKey, (a: MonitorProcess, b: MonitorProcess) => number> = {
  pid: (a, b) => a.pid - b.pid,
  name: (a, b) => text(a.name, b.name) || a.pid - b.pid,
  user: (a, b) => text(a.user, b.user) || b.cpu - a.cpu || a.pid - b.pid,
  cpu: (a, b) => a.cpu - b.cpu || a.memory - b.memory || b.pid - a.pid,
  memory: (a, b) => a.memory - b.memory || a.cpu - b.cpu || b.pid - a.pid,
};

/** sessions.json → `monitor`: refresh interval and process sort order. */
type MonitorDoc = { interval?: number; sort?: Partial<Sort> };
export const readMonitorDoc = (): MonitorDoc => readConfig<MonitorDoc>('monitor') ?? {};
export const saveMonitorDoc = (next: MonitorDoc) => writeConfig('monitor', { ...readMonitorDoc(), ...next }, 0);
const savedSort = (): Sort => {
  const sort = readMonitorDoc().sort;
  return COLUMNS.some(([key]) => key === sort?.key) ? { key: sort!.key as SortKey, descending: sort!.descending === true } : DEFAULT_SORT;
};

type MonitorProcessesProps = {
  processes: MonitorProcess[];
  /** Processes on the host (the list may be capped). */
  total: number;
  /** Where the processes run — "this computer" or user@host, for the confirmation. */
  where: string;
  /** Local Windows: there are no signals — Stop asks the program to close (taskkill). */
  windows: boolean;
  onSignal: (process: MonitorProcess, signal: StopSignal) => Promise<void>;
  /** Bumped by Ctrl+F anywhere in the Monitor panel: open (or focus) the search box. */
  searchRequest: number;
};

/**
 * Process list of the Monitor: the first {@link LIMIT} processes in the current sort order (click a
 * header; again = reverse). The search box (header button or Ctrl+F) filters by name. Select with
 * the mouse or ↑ ↓, Stop (SIGTERM, Del) or Kill (SIGKILL, Shift+Del) from the right-click menu —
 * always after a confirmation.
 */
export function MonitorProcesses({ processes, total, where, windows, onSignal, searchRequest }: MonitorProcessesProps) {
  const [sort, setSort] = useState<Sort>(savedSort);
  /** null = search box hidden. */
  const [search, setSearch] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; process: MonitorProcess } | null>(null);
  const [confirm, setConfirm] = useState<{ process: MonitorProcess; signal: StopSignal } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const query = (search ?? '').trim().toLowerCase();
  const { rows, matches } = useMemo(() => {
    const found = query ? processes.filter(process => process.name.toLowerCase().includes(query)) : processes;
    const order = ORDER[sort.key];
    const sorted = [...found].sort((a, b) => (sort.descending ? -order(a, b) : order(a, b)));
    return { rows: sorted.slice(0, LIMIT), matches: found.length };
  }, [processes, query, sort]);

  /** Bumped by openSearch; focusing happens after the render that shows the input. */
  const [searchFocus, setSearchFocus] = useState(0);
  const openSearch = () => {
    setSearch(current => current ?? '');
    setSearchFocus(value => value + 1);
  };
  useEffect(() => {
    if (!searchFocus) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchFocus]);
  const closeSearch = () => {
    setSearch(null);
    listRef.current?.focus({ preventScroll: true });
  };
  const firstRequest = useRef(searchRequest);
  useEffect(() => {
    if (searchRequest !== firstRequest.current) openSearch();
  }, [searchRequest]);
  const current = rows.find(process => process.pid === selected) ?? null;

  const sortBy = (key: SortKey) => {
    const next = sort.key === key ? { key, descending: !sort.descending } : { key, descending: NUMERIC.includes(key) };
    setSort(next);
    saveMonitorDoc({ sort: next });
  };

  // Keyboard selection scrolls the row into view (mouse selection never scrolls: a scroll would
  // close the context menu that a right-click opens).
  const reveal = useRef(false);
  useEffect(() => {
    if (selected === null || !reveal.current) return;
    reveal.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-pid="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const copy = (value: string, what: string) =>
    void navigator.clipboard?.writeText(value).then(
      () => log.info(t('{{what}} copied', { what })),
      () => log.warn(t('Clipboard not available')),
    );
  const ask = (process: MonitorProcess, signal: StopSignal) => {
    setMenu(null);
    setConfirm({ process, signal });
  };
  const menuItems = (process: MonitorProcess): MenuItem[] => [
    {
      type: 'item',
      id: 'stop',
      label: windows ? t('Stop (close)') : t('Stop (SIGTERM)'),
      icon: 'stop',
      hint: 'Del',
      onSelect: () => ask(process, 'TERM'),
    },
    {
      type: 'item',
      id: 'kill',
      label: windows ? t('Kill (end task)') : t('Kill (SIGKILL)'),
      icon: 'close',
      hint: 'Shift+Del',
      onSelect: () => ask(process, 'KILL'),
    },
    { type: 'separator', id: 'sep' },
    { type: 'item', id: 'pid', label: t('Copy PID'), icon: 'copy', onSelect: () => copy(String(process.pid), 'PID') },
    { type: 'item', id: 'name', label: t('Copy Name'), icon: 'copy', onSelect: () => copy(process.name, 'Name') },
    {
      type: 'item',
      id: 'command',
      label: t('Copy Command Line'),
      icon: 'copy',
      disabled: !process.command,
      onSelect: () => copy(process.command, 'Command line'),
    },
  ];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && search !== null) {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
      return;
    }
    if (!rows.length) return;
    const index = current ? rows.indexOf(current) : -1;
    const move = (to: number) => {
      event.preventDefault();
      reveal.current = true;
      setSelected(rows[Math.max(0, Math.min(rows.length - 1, to))].pid);
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index < 0 ? 0 : index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(rows.length - 1);
    else if (event.key === 'PageDown') move(index + 10);
    else if (event.key === 'PageUp') move(index - 10);
    else if (event.key === 'Delete' && current) {
      event.preventDefault();
      ask(current, event.shiftKey ? 'KILL' : 'TERM');
    } else if (event.key === 'ContextMenu' && current) {
      event.preventDefault();
      const row = listRef.current?.querySelector<HTMLElement>(`[data-pid="${current.pid}"]`)?.getBoundingClientRect();
      if (row) setMenu({ x: row.left + 24, y: row.bottom, process: current });
    }
  };
  const openMenu = (event: MouseEvent, process: MonitorProcess) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected(process.pid);
    setMenu({ x: event.clientX, y: event.clientY, process });
  };

  const tip = (process: MonitorProcess) =>
    [
      ['Name', process.name],
      ['PID', String(process.pid)],
      ['User', process.user || '—'],
      ['CPU', `${process.cpu.toFixed(1)}%`],
      ['Memory', formatBytes(process.memory)],
      ['Command', process.command || '—'],
      ['Stop / Kill', 'Del / Shift+Del or right-click'],
    ]
      .map(([label, value]) => `${label}\t${value.replace(/[\t\n]/g, ' ')}`)
      .join('\n');

  const signalName = (signal: StopSignal) =>
    windows ? (signal === 'TERM' ? t('a close request') : t('End task')) : t('SIG{{signal}}', { signal });

  return (
    <section className={`monitor-procs-section${search !== null ? ' is-searching' : ''}`}>
      <header className="monitor-procs-head">
        <b>{t('Processes')}</b>
        <span className="monitor-procs-spacer" />
        <em
          title={`Shown\tthe first ${LIMIT} in the current order\n${query ? `Matching “${search?.trim()}”\t${matches}\n` : ''}Processes on the host\t${total}`}
        >
          {rows.length} / {query ? matches : total}
        </em>
        <button
          type="button"
          className={`monitor-procs-search${search !== null ? ' on' : ''}`}
          onClick={() => (search === null ? openSearch() : closeSearch())}
          title={search === null ? t('Search by name (Ctrl+F)') : t('Close search (Esc)')}
          aria-label={t('Search processes')}
        >
          <Icon name="search" />
        </button>
      </header>
      {search !== null && (
        <div className="pane-filter monitor-procs-searchbar">
          <input
            ref={searchRef}
            value={search}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
                event.preventDefault();
                listRef.current?.focus({ preventScroll: true });
                if (rows.length) setSelected(rows[0].pid);
              }
            }}
            placeholder={t('Search by name')}
            aria-label={t('Search processes by name')}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="button" onClick={closeSearch} title={t('Close search (Esc)')} aria-label={t('Close search')}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      <div className="monitor-procs" role="grid" aria-label={t('Processes')} tabIndex={0} ref={listRef} onKeyDown={onKeyDown}>
        <div className="monitor-procs-row monitor-procs-th" role="row">
          {COLUMNS.map(([key, label]) => (
            <span
              key={key}
              role="columnheader"
              className={`col-${key}${sort.key === key ? ' is-sorted' : ''}`}
              aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none'}
              title={t('Sort by {{column}}', { column: t(label) })}
              onClick={() => sortBy(key)}
            >
              <b>{t(label)}</b>
              {sort.key === key ? (
                <i className={`monitor-sort${sort.descending ? ' is-descending' : ''}`} aria-hidden="true">
                  <Icon name="chevronDown" size={8} />
                </i>
              ) : null}
            </span>
          ))}
        </div>
        {rows.map(process => (
          <div
            key={process.pid}
            data-pid={process.pid}
            role="row"
            aria-selected={process.pid === selected}
            className={`monitor-procs-row${process.pid === selected ? ' is-selected' : ''}${process.pid === busy ? ' is-busy' : ''}`}
            title={tip(process)}
            onMouseDown={() => setSelected(process.pid)}
            onContextMenu={event => openMenu(event, process)}
          >
            <span className="col-pid">{process.pid}</span>
            <span className="col-name">{highlightMatch(process.name, query)}</span>
            <span className="col-user">{process.user || '—'}</span>
            <span className={`col-cpu${process.cpu >= 50 ? ' hot' : ''}`}>{process.cpu.toFixed(1)}</span>
            <span className="col-memory">{formatBytes(process.memory)}</span>
          </div>
        ))}
        {!rows.length ? (
          <div className="monitor-procs-empty">{query ? t('No process named “{{v}}”', { v: search?.trim() }) : t('No processes')}</div>
        ) : null}
      </div>
      {menu ? <ContextMenu items={menuItems(menu.process)} x={menu.x} y={menu.y} onClose={() => setMenu(null)} /> : null}
      {confirm ? (
        <TreeDialog
          section={t('MONITOR')}
          title={confirm.signal === 'TERM' ? t('STOP PROCESS') : t('KILL PROCESS')}
          confirm={confirm.signal === 'TERM' ? t('STOP') : t('KILL')}
          danger
          message={
            <>
              {tc(
                confirm.signal === 'TERM'
                  ? confirm.process.user
                    ? 'Stop <c>{{name}}</c> (PID {{pid}}, user {{user}}) on {{where}}? MetroTerm sends {{signal}}'
                    : 'Stop <c>{{name}}</c> (PID {{pid}}) on {{where}}? MetroTerm sends {{signal}}'
                  : confirm.process.user
                    ? 'Kill <c>{{name}}</c> (PID {{pid}}, user {{user}}) on {{where}}? MetroTerm sends {{signal}}'
                    : 'Kill <c>{{name}}</c> (PID {{pid}}) on {{where}}? MetroTerm sends {{signal}}',
                {
                  name: confirm.process.name,
                  pid: confirm.process.pid,
                  user: confirm.process.user,
                  where,
                  signal: signalName(confirm.signal),
                },
              )}
              {confirm.signal === 'TERM'
                ? t(' — the process can save its work and exit.')
                : t(' — the process ends at once; unsaved data in it is lost.')}
            </>
          }
          onCancel={() => {
            setConfirm(null);
            listRef.current?.focus();
          }}
          onSubmit={() => {
            const { process, signal } = confirm;
            setConfirm(null);
            setBusy(process.pid);
            void onSignal(process, signal).finally(() => {
              setBusy(null);
              listRef.current?.focus();
            });
          }}
        />
      ) : null}
    </section>
  );
}
