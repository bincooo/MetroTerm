import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorText, log } from '../../lib/platform/log';
import { createPortal } from 'react-dom';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { Connection, RemoteFile } from '../../types';
import { backend, LOCAL_SPEC, terminalRegistry, toSpec, type BackendEvent } from '../../lib/platform/backend';
import { Icon } from '../common/Icon';
import { FILE_DROP_EVENT, type FileDrop } from '../../lib/ui/fileDrop';
import { FilerDestinationDialog, type DestinationMode } from './FilerDestinationDialog';
import { TransferPanel, useTransfers } from './FilerTransfers';
import { ContextMenu, MenuButton, type MenuItem } from '../common/MenuButton';
import { baseName, joinPath, normalizePath, parentPath } from '../../lib/files/path';
import { writeConfig } from '../../lib/platform/config';
import { knownCwd, onCwdChange, queryCwd } from '../../lib/terminal/cwd';
import { t } from '../../i18n';
import { highlightMatch } from '../common/MatchHighlight';
import { describeConnection } from '../../lib/sessions/transports';
import { FileOpDialog, type Dialog } from './FileOpDialog';
import {
  bytes,
  COLUMN_GAP,
  COLUMNS,
  compare,
  DEFAULT_WIDTHS,
  fileType,
  formatTime,
  MIN_NAME_WIDTH,
  MIN_WIDTH,
  savedFiler,
  shellQuote,
  type ColumnWidths,
  type FilerDoc,
  type Sort,
  type SortKey,
} from './listing';
import { PREVIEW_HOME, previewFiles } from './previewFiles';

/**
 * Filer: the one file browser. It follows the active session. A local session browses this
 * computer; an SSH session browses the remote host over SFTP, sharing the terminal's SSH
 * connection, so no second login is needed.
 * Supports: browse (path box, parent, back, home), hidden files, sort, new folder, rename (F2),
 * delete (Del), move to / copy to another folder (context menu), upload (context menu / drag-drop), download (double-click a file), copy path, context menu,
 * "Terminal folder" (open the active terminal's current folder) and "Follow terminal" (stay in it).
 */

const ERROR_TTL = 25_000;

export default function Filer({
  connection,
  terminalTabId = null,
}: {
  connection: Connection;
  /** Active terminal tab (its connection is `connection`): source of "Terminal folder" / "Follow terminal". */
  terminalTabId?: string | null;
}) {
  const live = backend.live;
  const spec = useMemo(
    () => toSpec(connection),
    [
      connection.id,
      connection.transport,
      connection.host,
      connection.port,
      connection.username,
      connection.auth,
      connection.identityFile,
      connection.shell,
      connection.noProxy,
      JSON.stringify(connection.proxy),
    ],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const local = connection.transport === 'local';
  const [home, setHome] = useState(live ? '' : PREVIEW_HOME);
  const [path, setPath] = useState(live ? '' : PREVIEW_HOME);
  const [draft, setDraft] = useState(path);
  const [files, setFiles] = useState<RemoteFile[]>(live ? [] : previewFiles);
  const [history, setHistory] = useState<string[]>([]);
  /** The lead item: keyboard focus, Enter / F2, where Shift+↑↓ moves. */
  const [selected, setSelected] = useState<string | null>(null);
  /** Multi-selection (Ctrl+click toggles, Shift+click / Shift+↑↓ select a range, Ctrl+A all): the picked paths. */
  const [pickedPaths, setPickedPaths] = useState<string[]>([]);
  /** Where a Shift range starts: the last item clicked or toggled without Shift. */
  const anchorRef = useRef<string | null>(null);
  /** Select one item only (null: nothing) — a plain click or arrow key, a new folder. */
  const selectOnly = useCallback((target: string | null) => {
    setSelected(target);
    setPickedPaths(target ? [target] : []);
    anchorRef.current = target;
  }, []);
  const [showHidden, setShowHidden] = useState(false);
  /** Name search in the current folder (Ctrl+F / ⋮ → Search…); null = closed. */
  const [search, setSearch] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState<Sort>(() => savedFiler().sort);
  const [widths, setWidths] = useState<ColumnWidths>(() => savedFiler().widths);
  const widthsRef = useRef(widths);
  widthsRef.current = widths;
  /** Column being resized: the header edge follows the pointer (pointer capture on the handle). */
  const resizeRef = useRef<{ key: SortKey; startX: number; startWidth: number; pointerId: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  /** "Follow terminal": the Filer enters the active terminal's current folder whenever it changes. */
  const [follow, setFollow] = useState(() => savedFiler().follow);
  const followRef = useRef(follow);
  followRef.current = follow;
  const tabRef = useRef(terminalTabId);
  tabRef.current = terminalTabId;
  const filerDoc = useRef<FilerDoc>({ columns: widths, sort, follow });
  /** sessions.json → `filer`: widths when a resize ends (not on every pointer move), the sort, follow. */
  const saveFiler = (next: FilerDoc) => {
    filerDoc.current = { ...filerDoc.current, ...next };
    writeConfig('filer', filerDoc.current, 0);
  };
  /** Click a column header: sort by it; clicking the sorted column again reverses the order. */
  const sortBy = (key: SortKey) => {
    const next = { key, descending: sort.key === key && !sort.descending };
    setSort(next);
    saveFiler({ sort: next });
  };
  const startResize = (key: SortKey, event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { key, startX: event.clientX, startWidth: widths[key], pointerId: event.pointerId };
    setResizing(true);
  };
  const dragWidth = (drag: { key: SortKey; startX: number; startWidth: number }, clientX: number) =>
    Math.max(drag.key === 'name' ? MIN_NAME_WIDTH : MIN_WIDTH, Math.round(drag.startWidth + clientX - drag.startX));
  const moveResize = (event: React.PointerEvent<HTMLElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const width = dragWidth(drag, event.clientX);
    setWidths(current => (current[drag.key] === width ? current : { ...current, [drag.key]: width }));
  };
  const endResize = (event: React.PointerEvent<HTMLElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setResizing(false);
    // A cancelled pointer (e.g. the window lost it) keeps the width reached so far.
    saveWidths(event.type === 'pointercancel' ? widthsRef.current : { ...widthsRef.current, [drag.key]: dragWidth(drag, event.clientX) });
  };
  const saveWidths = (next: ColumnWidths) => {
    setWidths(next);
    saveFiler({ columns: next });
  };
  const columnTemplate = `${COLUMNS.map(([key]) => `${widths[key]}px`).join(' ')} minmax(0, 1fr)`;
  const columnsWidth = COLUMNS.reduce((sum, [key]) => sum + widths[key], 0) + COLUMN_GAP * COLUMNS.length;
  // A live Filer starts loading at once (the effect below): "0 items" never shows before the first listing.
  const [loading, setLoading] = useState(live);
  /** Error banner at the top of the list; removes itself after ERROR_TTL. */
  const [error, setErrorState] = useState<{ text: string; id: number } | null>(null);
  const errorSeq = useRef(0);
  const setError = useCallback((text: string | null) => setErrorState(text ? { text, id: ++errorSeq.current } : null), []);
  const transfers = useTransfers();
  const { progress: transferProgress } = transfers;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** Move to… / Copy to…: the items and the operation while their destination folder is picked. */
  const [destination, setDestination] = useState<{ mode: DestinationMode; files: RemoteFile[] } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; file: RemoteFile | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPaths = useRef(new Map<string, string>());
  const loadSeq = useRef(0);
  const pathRef = useRef(path);
  pathRef.current = path;
  const status = (message: string) => log.info(t('Filer · {{message}}', { message }));
  const fail = (message: string) => log.error(t('Filer · {{message}}', { message }));
  const focusList = () => listRef.current?.focus();
  /** A transfer-panel job: `run`, then `done` in the log; a failure is logged (`failed`) and rethrown for the batch. */
  const job = (
    name: string,
    size: number | null,
    run: (transferId: string) => Promise<unknown>,
    failed: (error: string) => string,
    done?: string,
  ) => ({
    name,
    size,
    run: async (transferId: string) => {
      try {
        await run(transferId);
        if (done) status(done);
      } catch (reason) {
        fail(failed(errorText(reason)));
        throw reason;
      }
    },
  });

  /**
   * A new folder: the path box shows it and an open search box starts empty. Done where the path
   * changes instead of in effects watching `path` (rerender-move-effect-to-event). Reloading the
   * same folder keeps both.
   */
  const showPath = (next: string) => {
    if (next === pathRef.current) return;
    pathRef.current = next;
    setPath(next);
    setDraft(next);
    setSearch(current => (current === null ? null : ''));
  };

  /** List `target` (empty = home); the path becomes the canonical one returned by the backend. */
  const load = useCallback(
    async (target: string, options: { keepSelection?: boolean; record?: boolean } = {}) => {
      const previous = pathRef.current;
      const remember = (next: string) => {
        if (options.record !== false && previous && next !== previous)
          setHistory(items => [previous, ...items.filter(item => item !== previous)].slice(0, 30));
      };
      if (!live) {
        const next = target || PREVIEW_HOME;
        remember(next);
        setFiles(next === PREVIEW_HOME ? previewFiles : []);
        showPath(next);
        setError(null);
        return true;
      }
      const seq = ++loadSeq.current;
      setLoading(true);
      try {
        const result = await backend.call<{ path: string; entries: RemoteFile[] }>('fs.list', { connection: spec, path: target });
        if (seq !== loadSeq.current) return true;
        remember(result.path);
        setFiles(result.entries);
        showPath(result.path);
        setError(null);
        lastPaths.current.set(spec.id, result.path);
        if (!options.keepSelection) selectOnly(null);
        return true;
      } catch (reason) {
        if (seq !== loadSeq.current) return true;
        setError(errorText(reason));
        fail(errorText(reason));
        return false;
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [live, spec],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = (keepSelection = true) => load(pathRef.current, { keepSelection, record: false });

  // Follow the active session: resolve its home and show its last folder.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    setFiles([]);
    selectOnly(null);
    setError(null);
    setHistory([]);
    showPath('');
    setLoading(true);
    void backend
      .call<string>('fs.home', { connection: spec })
      .then(async resolved => {
        if (cancelled) return;
        setHome(resolved);
        // Following the terminal: open its current folder instead of the last one shown.
        const cwd = followRef.current && tabRef.current ? await queryCwd(tabRef.current) : null;
        if (cancelled) return;
        void load(cwd ?? lastPaths.current.get(spec.id) ?? resolved, { record: false });
      })
      .catch(reason => {
        if (!cancelled) {
          setLoading(false);
          setError(errorText(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [live, spec, load]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setErrorState(current => (current?.id === error.id ? null : current)), ERROR_TTL);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(
    () =>
      backend.on((event: BackendEvent) => {
        if (event.type === 'transfer.progress') transferProgress(event.transferId, event.done, event.total);
      }),
    [transferProgress],
  );

  const query = (search ?? '').trim().toLowerCase();
  // While searching, a query starting with "." also finds hidden files.
  // One pass, one toLowerCase per file (js-combine-iterations).
  const visible = useMemo(
    () =>
      files
        .filter(file => {
          const hidden = file.name.startsWith('.');
          if (!query) return showHidden || !hidden;
          return file.name.toLowerCase().includes(query) && (showHidden || !hidden || query.startsWith('.'));
        })
        .sort(compare(sort)),
    [files, showHidden, sort, query],
  );
  const hiddenCount = useMemo(() => files.reduce((count, file) => (file.name.startsWith('.') ? count + 1 : count), 0), [files]);
  const shownCount = showHidden ? files.length : files.length - hiddenCount;
  const selectedFile = files.find(file => file.path === selected) ?? null;
  const pickedSet = useMemo(() => new Set(pickedPaths), [pickedPaths]);
  /** What the file commands work on: the picked items (list order), else the lead item. */
  const chosen = useMemo(() => {
    const list = visible.filter(file => pickedSet.has(file.path));
    return list.length ? list : selectedFile ? [selectedFile] : [];
  }, [visible, pickedSet, selectedFile]);
  const many = chosen.length > 1;
  /** Paths of the visible items from `from` to `to` (both included), in list order. */
  const rangeOf = (from: string | null, to: string) => {
    const a = visible.findIndex(file => file.path === from);
    const b = visible.findIndex(file => file.path === to);
    if (a < 0 || b < 0) return [to];
    return visible.slice(Math.min(a, b), Math.max(a, b) + 1).map(file => file.path);
  };
  /** Click on an item: plain = only it; Ctrl / ⌘ = add or remove it; Shift = the range from the anchor (Ctrl+Shift adds it). */
  const clickItem = (event: React.MouseEvent, file: RemoteFile) => {
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      const range = rangeOf(anchorRef.current ?? selected, file.path);
      setPickedPaths(current => (toggle ? [...new Set([...current, ...range])] : range));
      setSelected(file.path);
      anchorRef.current ??= file.path;
    } else if (toggle) {
      setPickedPaths(current => (current.includes(file.path) ? current.filter(item => item !== file.path) : [...current, file.path]));
      setSelected(file.path);
      anchorRef.current = file.path;
    } else selectOnly(file.path);
  };

  // ---------- search ----------
  const openSearch = () => {
    setSearch(current => current ?? '');
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  };
  const closeSearch = () => {
    setSearch(null);
    listRef.current?.focus();
  };
  /** Leave the search box for the list, on the first match (Enter / ↓). */
  const toFirstMatch = () => {
    const first = visible[0];
    if (first) selectOnly(first.path);
    listRef.current?.focus();
  };
  // A new query: the selection only stays when it still matches; the list starts at the top-left.
  useEffect(() => {
    if (!query) return;
    setSelected(current => (current && visible.some(file => file.path === current) ? current : null));
    setPickedPaths(current => current.filter(item => visible.some(file => file.path === item)));
    if (listRef.current) {
      listRef.current.scrollTop = 0;
      listRef.current.scrollLeft = 0;
    }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  const onFilerKey = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      openSearch();
    }
  };

  const go = (raw: string) => {
    const target = normalizePath(raw, home || '/', false);
    setDraft(target);
    // On failure the list still shows `path`; put the box back in sync (the banner names the failed folder).
    void load(target).then(ok => {
      if (!ok) setDraft(pathRef.current);
    });
  };
  const up = () => {
    if (path && path !== '/' && !/^[A-Za-z]:\/?$/.test(path)) void load(parentPath(path));
  };
  const back = () => {
    const [previous, ...rest] = history;
    if (!previous) return;
    setHistory(rest);
    void load(previous, { record: false });
  };
  // ---------- terminal folder ----------
  const terminalReady = live && Boolean(terminalTabId);
  /** Enter the active terminal's current folder (asked fresh from the backend / OSC 7). */
  const goTerminalFolder = async (quiet = false) => {
    const tab = tabRef.current;
    if (!tab) {
      if (!quiet) status(t('no terminal open'));
      return;
    }
    const cwd = await queryCwd(tab);
    if (tabRef.current !== tab) return;
    if (!cwd) {
      if (!quiet) status(t("the terminal's folder is not known yet"));
      return;
    }
    if (cwd !== pathRef.current) void load(cwd);
  };
  /** Type the selected item's path (else the current folder's) at the terminal prompt — quoted for
   * the shell when needed, without Enter — and focus the terminal. */
  const pathToTerminal = () => {
    const tab = tabRef.current;
    const targets = chosen.length ? chosen.map(file => file.path) : [pathRef.current];
    const target = targets.join(' ');
    const handle = terminalRegistry.get(tab);
    if (!handle || !target) {
      status(t('no terminal open'));
      return;
    }
    handle.write(targets.map(item => shellQuote(item)).join(' '));
    handle.focus();
    status(t('path sent to the terminal: {{target}}', { target }));
  };
  const toggleFollow = () => {
    const next = !follow;
    setFollow(next);
    saveFiler({ follow: next });
    status(next ? t('following the terminal folder') : t('stopped following the terminal'));
    if (next) void goTerminalFolder(true);
  };
  // Follow: every reported change of the active terminal's folder opens it here.
  useEffect(() => {
    if (!follow || !live || !terminalTabId) return;
    const off = onCwdChange((tab, cwd) => {
      if (tab === tabRef.current && cwd !== pathRef.current) void load(cwd);
    });
    const known = knownCwd(terminalTabId);
    if (known && known !== pathRef.current) void load(known);
    void goTerminalFolder(true); // switched tab / turned on: the current folder now
    return off;
  }, [follow, live, terminalTabId, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEntry = (file: RemoteFile) => {
    if (file.isDir) void load(file.path);
    else void download(file);
  };

  // ---------- transfers (FilerTransfers: one batch per action, listed above the footer) ----------
  async function download(file: RemoteFile | null) {
    if (!file || file.isDir) {
      status(t('select a file to download'));
      return;
    }
    if (!live) {
      status(t('static preview · start the backend to download files'));
      return;
    }
    if (backend.mode === 'server') {
      // Browser: stream through the HTTP endpoint; the browser's download manager shows progress.
      const anchor = document.createElement('a');
      anchor.href = backend.url('fs/download', { connection: spec.id, path: file.path });
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      status(t('downloading {{name}}', { name: file.name }));
      return;
    }
    const target = await saveDialog({ defaultPath: file.name, title: t('Save downloaded file') }).catch(() => null);
    if (!target) return;
    const result = await transfers.run('download', String(target), [downloadJob(file, String(target), false)]);
    if (result.done) status(t('{{name}} downloaded', { name: file.name }));
  }

  /** A transfer job copying `file` to the local `path`; `named`: its name goes into the error message. */
  const downloadJob = (file: RemoteFile, path: string, named: boolean) =>
    job(
      file.name,
      file.size,
      transferId =>
        backend.call('fs.transfer', { transferId, from: { connection: spec, path: file.path }, to: { connection: LOCAL_SPEC, path } }),
      error => t('download failed: {{v}}', { v: named ? `${file.name} · ${error}` : error }),
    );

  /** Download several files (folders are skipped): into one folder picked once (desktop), or one browser download each. */
  async function downloadMany(targets: RemoteFile[]) {
    const list = targets.filter(file => !file.isDir);
    if (list.length <= 1) return download(list[0] ?? null);
    if (!live) {
      status(t('static preview · start the backend to download files'));
      return;
    }
    if (backend.mode === 'server') {
      for (const file of list) await download(file);
      return;
    }
    const folder = await openDialog({ directory: true, title: t('Download {{count}} files to…', { count: list.length }) }).catch(
      () => null,
    );
    if (!folder || Array.isArray(folder)) return;
    const separator = String(folder).includes('\\') && !String(folder).includes('/') ? '\\' : '/';
    const base = String(folder).replace(/[\\/]+$/, '');
    const result = await transfers.run(
      'download',
      String(folder),
      list.map(file => downloadJob(file, `${base}${separator}${file.name}`, true)),
    );
    if (result.done) status(t('{{count}} files downloaded', { count: result.done }));
  }

  const uploadBrowserFiles = async (list: FileList | File[]) => {
    const dir = path;
    await transfers.run(
      'upload',
      dir || '/',
      Array.from(list).map(file =>
        job(
          file.name,
          file.size,
          async transferId => {
            const url = backend.url('fs/upload', { connection: spec.id, path: joinPath(dir, file.name), transfer: transferId });
            const response = await fetch(url, { method: 'PUT', body: file });
            if (!response.ok)
              throw new Error((await response.json().catch(() => null))?.error ?? t('HTTP {{status}}', { status: response.status }));
          },
          error => t('upload failed: {{v}}', { v: `${file.name} · ${error}` }),
          t('{{name}} uploaded', { name: file.name }),
        ),
      ),
    );
    void load(dir, { keepSelection: true, record: false });
  };

  const upload = async () => {
    if (!live) {
      status(t('static preview · start the backend to upload files'));
      return;
    }
    if (backend.mode === 'server') {
      fileInputRef.current?.click();
      return;
    }
    const picked = await openDialog({ multiple: true, title: t('Upload files') }).catch(() => null);
    await uploadLocalPaths((Array.isArray(picked) ? picked : picked ? [picked] : []).map(String));
  };
  /**
   * Desktop: upload files of this computer (Upload here… / dropped from the file manager) into the shown
   * folder. Folders are walked first (links to folders are skipped): their folders are created, and every
   * file in them is one item of the batch, named by its path below the dropped item.
   */
  const uploadLocalPaths = async (sources: string[]) => {
    const dir = path;
    if (!sources.length) return;
    const folders: string[] = [];
    const files: { source: string; target: string; name: string; size: number | null }[] = [];
    const walk = async (source: string, target: string, name: string, size: number | null) => {
      const listing = await backend.call<{ entries: RemoteFile[] }>('fs.list', { connection: LOCAL_SPEC, path: source }).catch(() => null);
      if (!listing) {
        files.push({ source, target, name, size });
        return;
      }
      folders.push(target);
      for (const entry of listing.entries)
        if (!(entry.kind === 'link' && entry.isDir))
          await walk(entry.path, joinPath(target, entry.name), `${name}/${entry.name}`, entry.isDir ? null : entry.size);
    };
    for (const source of sources) await walk(source, joinPath(dir, baseName(source)), baseName(source), null);
    for (const folder of folders) await backend.call('fs.mkdir', { connection: spec, path: folder }).catch(() => undefined);
    const result = await transfers.run(
      'upload',
      dir || '/',
      files.map(file =>
        job(
          file.name,
          file.size,
          transferId =>
            backend.call('fs.transfer', {
              transferId,
              from: { connection: LOCAL_SPEC, path: file.source },
              to: { connection: spec, path: file.target },
            }),
          error => t('upload failed: {{v}}', { v: `${file.name} · ${error}` }),
        ),
      ),
    );
    if (result.done) status(t('{{count}} files uploaded', { count: result.done }));
    void load(dir, { keepSelection: true, record: false });
  };

  // Files dropped on the list from the system's file manager (lib/ui/fileDrop): uploaded into the shown folder.
  const dropRef = useRef<(drop: FileDrop) => void>(() => undefined);
  dropRef.current = drop => {
    if (!live) status(t('static preview · start the backend to upload files'));
    else if (drop.paths.length && backend.mode !== 'server') void uploadLocalPaths(drop.paths);
    else if (drop.files.length) void uploadBrowserFiles(drop.files);
  };
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onDrop = (event: Event) => dropRef.current((event as CustomEvent<FileDrop>).detail);
    list.addEventListener(FILE_DROP_EVENT, onDrop);
    return () => list.removeEventListener(FILE_DROP_EVENT, onDrop);
  }, []);

  // ---------- file operations ----------
  const runDialog = async () => {
    if (!dialog) return;
    const current = dialog;
    try {
      if (current.kind === 'mkdir') {
        const name = current.value.trim();
        if (!name) return;
        await backend.call('fs.mkdir', { connection: spec, path: joinPath(path, name) });
        status(t('folder {{name}} created', { name }));
      } else if (current.kind === 'rename' && current.file) {
        const name = current.value.trim();
        if (!name || name === current.file.name) {
          setDialog(null);
          return;
        }
        await backend.call('fs.rename', { connection: spec, from: current.file.path, to: joinPath(parentPath(current.file.path), name) });
        status(t('renamed to {{name}}', { name }));
      } else if (current.kind === 'delete' && current.file) {
        const targets = current.files?.length ? current.files : [current.file];
        for (const file of targets) await backend.call('fs.remove', { connection: spec, path: file.path });
        status(
          targets.length > 1 ? t('{{count}} items deleted', { count: targets.length }) : t('{{name}} deleted', { name: targets[0].name }),
        );
        selectOnly(null);
      }
      setDialog(null);
      void load(path, { record: false });
      listRef.current?.focus();
    } catch (reason) {
      setDialog(null);
      setError(errorText(reason));
      fail(errorText(reason));
    }
  };
  const isLive = () => live || void status(t('static preview · start the backend for file operations'));
  const newFolder = () => isLive() && setDialog({ kind: 'mkdir', value: 'new-folder' });
  const rename = (file = selectedFile) => isLive() && file && setDialog({ kind: 'rename', file, value: file.name });
  const remove = (targets = chosen) =>
    isLive() && targets.length && setDialog({ kind: 'delete', file: targets[0], files: targets, value: '' });
  const moveOrCopy = (mode: DestinationMode, targets = chosen) => isLive() && targets.length && setDestination({ mode, files: targets });
  /** Runs Move to… / Copy to… into `folder` (same connection), item by item; shown in the footer like a transfer. */
  const runDestination = async (folder: string) => {
    if (!destination) return;
    const { mode, files: targets } = destination;
    setDestination(null);
    listRef.current?.focus();
    // Stops at the first failure; Retry in the notice runs the rest.
    await transfers.run(
      mode,
      folder,
      targets.map(file =>
        job(
          file.name,
          null,
          () =>
            backend.call(mode === 'move' ? 'fs.move' : 'fs.copy', { connection: spec, from: file.path, to: joinPath(folder, file.name) }),
          error => (mode === 'move' ? t('move failed: {{error}}', { error }) : t('copy failed: {{error}}', { error })),
          mode === 'move'
            ? t('{{name}} moved to {{folder}}', { name: file.name, folder })
            : t('{{name}} copied to {{folder}}', { name: file.name, folder }),
        ),
      ),
      { stopOnError: true },
    );
    void reload(mode === 'copy');
  };
  const copyPath = (value: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => status(t('copied {{value}}', { value })),
      () => fail(t('clipboard not available')),
    );
  };

  const onListKey = (event: React.KeyboardEvent) => {
    if (dialog || destination || menu) return;
    const index = visible.findIndex(file => file.path === selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        if (event.shiftKey) {
          // Shift+↑↓: the lead moves, the selection is the range from the anchor to it.
          const anchor = anchorRef.current ?? selected ?? next.path;
          anchorRef.current = anchor;
          setSelected(next.path);
          setPickedPaths(rangeOf(anchor, next.path));
        } else selectOnly(next.path);
        listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      event.stopPropagation();
      setPickedPaths(visible.map(file => file.path));
      if (!selected && visible[0]) setSelected(visible[0].path);
    } else if (event.key === 'Enter' && selectedFile) {
      event.preventDefault();
      openEntry(selectedFile);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      up();
    } else if (event.key === 'Delete' && chosen.length) {
      event.preventDefault();
      remove();
    } else if (event.key === 'F2' && selectedFile && !many) {
      event.preventDefault();
      rename();
    } else if (event.key === 'F5') {
      event.preventDefault();
      void reload();
    } else if (event.key === 'Escape' && search !== null) {
      event.preventDefault();
      closeSearch();
    }
  };

  /** Rename (`target`, only when `group` is one item), Delete, Move to…, Copy to… (`group`). */
  const editItems = (group: RemoteFile[], target: RemoteFile | null): MenuItem[] => [
    {
      type: 'item',
      id: 'rename',
      label: t('Rename'),
      icon: 'rename',
      hint: 'F2',
      disabled: !target || group.length > 1,
      onSelect: () => rename(target),
    },
    {
      type: 'item',
      id: 'delete',
      label: group.length > 1 ? t('Delete {{count}} items', { count: group.length }) : 'Delete',
      icon: 'trash',
      hint: 'Del',
      disabled: !group.length,
      onSelect: () => remove(group),
    },
    {
      type: 'item',
      id: 'move-to',
      label: t('Move to…'),
      icon: 'moveTo',
      disabled: !group.length,
      onSelect: () => moveOrCopy('move', group),
    },
    {
      type: 'item',
      id: 'copy-to',
      label: t('Copy to…'),
      icon: 'copyTo',
      disabled: !group.length,
      onSelect: () => moveOrCopy('copy', group),
    },
  ];
  const folderItems: MenuItem[] = [
    { type: 'item', id: 'home', label: t('Home folder'), icon: 'home', onSelect: () => home && void load(home) },
    { type: 'item', id: 'copy-dir', label: t('Copy folder path'), icon: 'copy', onSelect: () => copyPath(path) },
  ];
  const newFolderItem: MenuItem = { type: 'item', id: 'mkdir', label: t('New folder'), icon: 'folderPlus', onSelect: newFolder };
  /** Commands for the items: one item, or the whole selection when it has several. */
  const itemCommands = (group: RemoteFile[]): MenuItem[] => {
    const file = group[0];
    if (!file) return [];
    const several = group.length > 1;
    const fileCount = group.filter(item => !item.isDir).length;
    return [
      several
        ? {
            type: 'item',
            id: 'open',
            label: t('Download {{count}} files', { count: fileCount }),
            icon: 'download',
            disabled: !fileCount,
            onSelect: () => void downloadMany(group),
          }
        : {
            type: 'item',
            id: 'open',
            label: file.isDir ? t('Open') : t('Download'),
            icon: file.isDir ? 'folderFilled' : 'download',
            hint: 'Enter',
            onSelect: () => openEntry(file),
          },
      ...editItems(group, file),
      {
        type: 'item',
        id: 'copy',
        label: several ? t('Copy paths') : t('Copy path'),
        icon: 'copy',
        onSelect: () => copyPath(group.map(item => item.path).join('\n')),
      },
    ];
  };
  const fileItems = (file: RemoteFile | null): MenuItem[] => [
    ...(file
      ? ([
          ...itemCommands(chosen.some(item => item.path === file.path) ? chosen : [file]),
          { type: 'separator', id: 'sep-file' },
        ] as MenuItem[])
      : []),
    newFolderItem,
    { type: 'item', id: 'upload', label: t('Upload here…'), icon: 'upload', onSelect: () => void upload() },
    { type: 'separator', id: 'sep-dir' },
    ...folderItems,
    { type: 'item', id: 'refresh', label: t('Refresh'), icon: 'refresh', hint: 'F5', onSelect: () => void reload() },
  ];
  const moreItems: MenuItem[] = [
    { type: 'item', id: 'search', label: t('Search…'), icon: 'search', hint: 'Ctrl+F', onSelect: openSearch },
    { type: 'separator', id: 'sep-search' },
    newFolderItem,
    ...editItems(chosen, selectedFile),
    { type: 'separator', id: 'sep' },
    ...folderItems,
    { type: 'separator', id: 'sep-view' },
    {
      type: 'item',
      id: 'hidden',
      label: t('Show hidden files'),
      icon: 'eye',
      checked: showHidden,
      onSelect: () => setShowHidden(value => !value),
    },
  ];

  const totalSize = visible.reduce((sum, file) => sum + (file.isDir ? 0 : file.size), 0);
  const footerText = (() => {
    if (loading && !files.length) return t('Loading…');
    if (many) {
      const size = chosen.reduce((sum, file) => sum + (file.isDir ? 0 : file.size), 0);
      return t('{{count}} selected · {{size}}', { count: chosen.length, size: bytes(size) });
    }
    if (query) return `${visible.length} of ${shownCount} match “${search?.trim()}”${selectedFile ? ` · ${selectedFile.name}` : ''}`;
    if (selectedFile) return `${selectedFile.name} · ${selectedFile.isDir ? 'folder' : bytes(selectedFile.size)}`;
    return `${t('{{count}} items', { count: visible.length })}${totalSize ? `\u00a0\u00a0${bytes(totalSize)}` : ''}${!showHidden && hiddenCount ? ` · ${t('{{count}} hidden', { count: hiddenCount })}` : ''}`;
  })();
  const where = `${connection.name} · ${local ? 'this computer' : `${describeConnection(connection)} (SFTP)`}`;

  return (
    <div
      className="filer-browser"
      onKeyDownCapture={onFilerKey}
      style={{ '--filer-cols': columnTemplate, '--filer-min': `calc(${columnsWidth}px + 2 * var(--pad-x, 8px))` } as React.CSSProperties}
    >
      <div className="filer-path">
        <input
          className="filer-path-input"
          value={draft}
          spellCheck={false}
          aria-label={t('Path')}
          title={`${where} — type a path and press Enter`}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              go(draft);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(path);
              event.currentTarget.blur();
            }
          }}
          onBlur={() => setDraft(path)}
          onFocus={event => {
            const input = event.currentTarget;
            requestAnimationFrame(() => input.select());
          }}
        />
        <button title={t('Parent folder (Backspace)')} onClick={up}>
          <Icon name="arrowUp" />
        </button>
        <button title={t('Back')} disabled={!history.length} onClick={back}>
          <Icon name="history" />
        </button>
        <button title={t('Refresh (F5)')} onClick={() => void reload()}>
          <Icon name="refresh" />
        </button>
        <MenuButton title={t('More')} items={moreItems}>
          <Icon name="kebab" size={16} />
        </MenuButton>
      </div>
      {search !== null && (
        <div className="pane-filter filer-search">
          <input
            ref={searchRef}
            value={search}
            spellCheck={false}
            aria-label={t('Search in this folder')}
            placeholder={t('Search in this folder')}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              } else if (event.key === 'Enter' || event.key === 'ArrowDown') {
                event.preventDefault();
                toFirstMatch();
              }
            }}
          />
          <button title={t('Close search (Esc)')} aria-label={t('Close search')} onClick={closeSearch}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {error && (
        <div className="file-message is-error" role="alert" key={error.id}>
          <b>✗</b>
          <span className="file-message-text">{error.text}</span>
          <button className="file-message-close" onClick={() => setError(null)} aria-label={t('Dismiss')} title={t('Dismiss')}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      <div
        ref={listRef}
        className="filer-list"
        aria-busy={loading}
        tabIndex={0}
        onKeyDown={onListKey}
        onContextMenu={event => {
          if (!(event.target as Element).closest('button')) {
            event.preventDefault();
            selectOnly(null);
            setMenu({ x: event.clientX, y: event.clientY, file: null });
          }
        }}
        data-file-drop="filer"
        data-file-drop-label={t('Drop to upload to {{path}}', { path: path || '/' })}
      >
        <div className={`filer-head${resizing ? ' is-resizing' : ''}`} role="row">
          {COLUMNS.map(([key, label]) => (
            <div
              key={key}
              role="columnheader"
              aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none'}
              className={`filer-th filer-col-${key}${sort.key === key ? ' is-sorted' : ''}`}
              title={t('Sort by {{column}}', { column: t(label) })}
              onClick={() => sortBy(key)}
            >
              <b>{t(label)}</b>
              {sort.key === key && (
                <i className={`filer-sort${sort.descending ? ' is-descending' : ''}`} aria-hidden="true">
                  <Icon name="chevronDown" size={8} />
                </i>
              )}
              <i
                className="filer-col-resizer"
                aria-hidden="true"
                onPointerDown={event => startResize(key, event)}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
                onClick={event => event.stopPropagation()}
                onDoubleClick={event => {
                  event.stopPropagation();
                  saveWidths({ ...widthsRef.current, [key]: DEFAULT_WIDTHS[key] }); // back to the default width
                }}
              />
            </div>
          ))}
        </div>
        {visible.map(file => (
          <button
            key={file.path}
            data-path={file.path}
            className={`${pickedSet.has(file.path) || (file.path === selected && !pickedPaths.length) ? 'selected' : ''}`}
            aria-selected={pickedSet.has(file.path)}
            data-tip={[
              ['Name', file.name],
              ['Date Modified', formatTime(file.modified)],
              ['Type', fileType(file)],
              ['Size', file.isDir ? '—' : bytes(file.size)],
              ['Permissions', file.permissions ?? '—'],
            ]
              .map(row => row.join('\t'))
              .join('\n')}
            onMouseDown={event => {
              if (event.shiftKey) event.preventDefault(); // no text selection on Shift+click
            }}
            onClick={event => clickItem(event, file)}
            onDoubleClick={() => openEntry(file)}
            onContextMenu={event => {
              event.preventDefault();
              // Right-click inside the selection keeps it (the menu then works on all of it).
              if (!pickedSet.has(file.path)) selectOnly(file.path);
              else setSelected(file.path);
              setMenu({ x: event.clientX, y: event.clientY, file });
            }}
          >
            <span className={`filer-name filer-col-name ${file.kind}${file.name.startsWith('.') ? ' is-hidden-file' : ''}`}>
              <i>
                <Icon name={file.isDir ? 'folderFilled' : file.kind === 'link' ? 'link' : 'file'} />
              </i>
              {highlightMatch(file.name, query)}
            </span>
            <time className="filer-col-modified">{formatTime(file.modified)}</time>
            <span className="filer-col-type">{fileType(file)}</span>
            <span className="filer-col-size">{file.isDir ? '' : bytes(file.size)}</span>
            <span className="filer-col-permissions">{file.permissions ?? ''}</span>
            <span className="filer-col-owner">{file.owner ?? ''}</span>
            <span className="filer-col-group">{file.group ?? ''}</span>
          </button>
        ))}
        {!error && !loading && path && !visible.length && (
          <div className="file-message">{query ? t('No matches') : files.length ? t('Only hidden files') : t('Empty folder')}</div>
        )}
        {loading && !files.length && !error && <div className="file-message is-pending">{t('Connecting…')}</div>}
      </div>
      <TransferPanel
        batches={transfers.batches}
        bytes={bytes}
        onCancel={transfers.cancel}
        onRetry={id => void transfers.retry(id).then(() => reload())}
        onDismiss={transfers.dismiss}
        onToggle={transfers.toggle}
        isCancelling={transfers.isCancelling}
      />
      <div className="filer-foot">
        {/* "Loading…" fades in a little later (.is-pending): a quick listing never shows it. */}
        <span className={loading && !files.length ? 'filer-foot-text is-pending' : 'filer-foot-text'} title={footerText}>
          {error ? <i className="status-dot error" /> : null}
          {footerText}
        </span>
        <span className="filer-foot-actions">
          <button
            title={`Copy path to terminal — types ${many ? `the paths of ${chosen.length} items` : selectedFile ? `the path of ${selectedFile.name}` : 'the current folder'} at the prompt (no Enter)`}
            disabled={!terminalTabId || !path}
            onClick={pathToTerminal}
          >
            <Icon name="pathToTerminal" />
          </button>
          <button
            title={t("Terminal folder — open the terminal's current folder")}
            disabled={!terminalReady}
            onClick={() => void goTerminalFolder()}
          >
            <Icon name="terminalFolder" />
          </button>
          <button
            className={follow ? 'is-on' : ''}
            aria-pressed={follow}
            title={
              follow
                ? t("Follow terminal: on — the Filer enters the terminal's folder after every cd")
                : t("Follow terminal: off — click to enter the terminal's folder automatically")
            }
            onClick={toggleFollow}
          >
            <Icon name="follow" />
          </button>
        </span>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={event => {
          if (event.target.files?.length) void uploadBrowserFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={fileItems(menu.file)} onClose={() => setMenu(null)} />}
      {destination &&
        createPortal(
          <FilerDestinationDialog
            mode={destination.mode}
            files={destination.files}
            connection={connection}
            spec={spec}
            startPath={path}
            home={home}
            showHidden={showHidden}
            onCancel={() => {
              setDestination(null);
              focusList();
            }}
            onSubmit={folder => void runDestination(folder)}
          />,
          document.querySelector('.metroterm-shell') ?? document.body,
        )}
      {dialog &&
        createPortal(
          <FileOpDialog
            dialog={dialog}
            connection={connection}
            folder={path}
            onChange={value => setDialog(current => (current ? { ...current, value } : current))}
            onCancel={() => {
              setDialog(null);
              focusList();
            }}
            onSubmit={() => void runDialog()}
          />,
          document.querySelector('.metroterm-shell') ?? document.body,
        )}
    </div>
  );
}
