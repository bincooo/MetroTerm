import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { childFolders, type SessionFolder } from '../lib/sessionTree';
import { t } from '../i18n';
import { pressTarget } from '../lib/customScrollbars';

type FolderTreeSelectProps = {
  /** Selected folder id; '' = top level. */
  value: string;
  folders: SessionFolder[];
  onChange: (value: string) => void;
  /** Sessions directly inside each folder ('' = top level), shown on the right like the Explorer. */
  counts?: Record<string, number>;
  ariaLabel?: string;
};

type Row = {
  id: string; // '' = top level
  name: string;
  depth: number;
  parent: string | null; // null for the top-level row
  hasChildren: boolean;
  /** One entry per ancestor level 1..depth-1: does that ancestor have siblings further down? */
  guides: boolean[];
  last: boolean;
};

const ROW = 26;

/**
 * Explorer-folder picker drawn as a tree (used for "FOLDER" in the session dialogs).
 * The top level is the root node; folders hang below it with indent guides (├ └ │), a chevron
 * to fold a branch inside the menu, a folder icon and the session count. Clicking a row picks it.
 * Keys: ↑ ↓ Home End move, → unfolds / steps into, ← folds / steps out, Enter picks, Esc closes.
 */
export function FolderTreeSelect({ value, folders, onChange, counts = {}, ariaLabel }: FolderTreeSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [highlight, setHighlight] = useState(value);
  const [placement, setPlacement] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>({
    left: 0,
    width: 0,
    maxHeight: 300,
  });

  const known = useMemo(() => new Set(folders.map(folder => folder.id)), [folders]);
  const selectedId = known.has(value) ? value : '';

  // Visible rows in tree order (folded branches skipped).
  const rows = useMemo(() => {
    const out: Row[] = [
      {
        id: '',
        name: t('Top level'),
        depth: 0,
        parent: null,
        hasChildren: folders.some(folder => folder.parentId === null),
        guides: [],
        last: true,
      },
    ];
    if (collapsed.has('')) return out;
    const walk = (parentId: string | null, depth: number, guides: boolean[]) => {
      const children = childFolders(folders, parentId);
      children.forEach((folder, index) => {
        const last = index === children.length - 1;
        const hasChildren = folders.some(item => item.parentId === folder.id);
        out.push({ id: folder.id, name: folder.name, depth, parent: parentId ?? '', hasChildren, guides, last });
        if (hasChildren && !collapsed.has(folder.id)) walk(folder.id, depth + 1, [...guides, !last]);
      });
    };
    walk(null, 1, []);
    return out;
  }, [folders, collapsed]);

  const path = useMemo(() => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = folders.find(folder => folder.id === selectedId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = folders.find(folder => folder.id === current!.parentId);
    }
    return names;
  }, [folders, selectedId]);

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const wanted = Math.min(rows.length * ROW + 10, 320);
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    if (below < wanted && above > below)
      setPlacement({ left: rect.left, bottom: window.innerHeight - rect.top + 2, width: rect.width, maxHeight: Math.min(320, above) });
    else setPlacement({ left: rect.left, top: rect.bottom + 2, width: rect.width, maxHeight: Math.min(320, below) });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open, rows.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!rootRef.current?.contains(pressTarget(event))) setOpen(false);
    };
    const reflow = (event: Event) => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      place();
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [open]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(highlight)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight]);

  const openMenu = () => {
    // Unfold the branch holding the current choice so it is visible.
    setCollapsed(current => {
      const next = new Set(current);
      next.delete('');
      let folder = folders.find(item => item.id === selectedId);
      while (folder?.parentId) {
        next.delete(folder.parentId);
        folder = folders.find(item => item.id === folder!.parentId);
      }
      return next;
    });
    setHighlight(selectedId);
    setOpen(true);
  };
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const toggle = (id: string, fold?: boolean) =>
    setCollapsed(current => {
      const next = new Set(current);
      const shouldFold = fold ?? !next.has(id);
      if (shouldFold) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    const index = Math.max(
      0,
      rows.findIndex(row => row.id === highlight),
    );
    const row = rows[index];
    const go = (next: number) => {
      event.preventDefault();
      setHighlight(rows[Math.max(0, Math.min(rows.length - 1, next))].id);
    };
    if (event.key === 'ArrowDown') go(index + 1);
    else if (event.key === 'ArrowUp') go(index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(rows.length - 1);
    else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (row.hasChildren && collapsed.has(row.id)) toggle(row.id, false);
      else if (row.hasChildren) go(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.hasChildren && !collapsed.has(row.id)) toggle(row.id, true);
      else if (row.parent !== null) setHighlight(row.parent);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(row.id);
    } else if (event.key === 'Escape' || event.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={rootRef} className={`ui-select folder-tree-select ${open ? 'is-open' : ''}`} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-select-trigger"
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <i className="folder-tree-icon">
          <Icon name={selectedId ? 'folder' : 'home'} size={14} />
        </i>
        <span className="folder-tree-path" title={selectedId ? path.join(' / ') : t('Top level')}>
          {selectedId ? (
            path.map((name, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <b>
                    <Icon name="chevronRight" size={11} />
                  </b>
                )}
                <em>{name}</em>
              </Fragment>
            ))
          ) : (
            <em className="is-root">{t('Top level')}</em>
          )}
        </span>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" />
        </svg>
      </button>
      {open && (
        // preventDefault on click: inside a <label> the browser would forward the click to the trigger.
        <ul
          ref={listRef}
          className={`ui-select-menu folder-tree-menu ${placement.bottom !== undefined ? 'opens-up' : ''}`}
          role="tree"
          style={{
            left: placement.left,
            top: placement.top,
            bottom: placement.bottom,
            minWidth: placement.width,
            maxHeight: placement.maxHeight,
          }}
          onClick={event => event.preventDefault()}
        >
          {rows.map(row => {
            const folded = collapsed.has(row.id);
            const count = counts[row.id] ?? 0;
            return (
              <li
                key={row.id || '(root)'}
                data-id={row.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.hasChildren ? !folded : undefined}
                aria-selected={row.id === selectedId}
                className={`${row.id === highlight ? 'is-active' : ''} ${row.id === selectedId ? 'is-selected' : ''} ${row.depth === 0 ? 'is-root' : ''}`}
                onPointerEnter={() => setHighlight(row.id)}
                onPointerDown={event => event.preventDefault()}
                onClick={() => choose(row.id)}
              >
                {row.guides.map((more, level) => (
                  <span key={level} className={`ft-guide ${more ? 'line' : ''}`} />
                ))}
                {row.depth > 0 && <span className={`ft-guide ${row.last ? 'end' : 'tee'}`} />}
                {row.hasChildren ? (
                  <span
                    className="ft-twisty"
                    onClick={event => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggle(row.id);
                    }}
                    title={folded ? t('Expand') : t('Collapse')}
                  >
                    <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={12} />
                  </span>
                ) : (
                  <span className="ft-twisty is-leaf" />
                )}
                <i className="ft-icon">
                  <Icon name={row.depth === 0 ? 'home' : row.hasChildren && !folded ? 'folderFilled' : 'folder'} size={14} />
                </i>
                <span className="ft-name">{row.name}</span>
                {count > 0 && <small>{count}</small>}
                {row.id === selectedId && (
                  <span className="ft-check">
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
