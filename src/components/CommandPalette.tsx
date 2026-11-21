import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { overlayHost, type MenuItem } from './MenuButton';
import type { BarMenu, BarMenuItem } from './MenuBar';
import i18n, { t } from '../i18n';
import { pressTarget } from '../lib/customScrollbars';

type Command = {
  key: string;
  /** Shown: translated titles, e.g. ['Session', 'New Session']. */
  path: string[];
  hint?: string;
  checked?: boolean;
  /** Lower-case text a query is matched against: the shown path, the English one and the shortcut. */
  haystack: string;
  /** Lower-case shown title of the command itself (matches there rank first). */
  leaf: string;
  run: () => void;
};

/**
 * English text of a menu label. App builds most labels already translated (`t('New Session…')`), so the
 * English is found through the reverse of the current language's resource table (built once per opening).
 */
function englishOf(): (label: string) => string {
  const table = (i18n.getResourceBundle(i18n.language, 'translation') ?? {}) as Record<string, string>;
  const back = new Map<string, string>();
  for (const [english, shown] of Object.entries(table)) if (!back.has(shown)) back.set(shown, english);
  return label => back.get(label) ?? label;
}

/** Every enabled command of the menu bar, submenus flattened into `Menu / Submenu / Item` paths. */
function collectCommands(menus: BarMenu[]): Command[] {
  const out: Command[] = [];
  const english = englishOf();
  const walk = (items: BarMenuItem[], shown: string[], source: string[], keys: string[]) => {
    for (const item of items) {
      if (item.type === 'separator' || item.disabled) continue;
      const label = t(item.label);
      if (item.type === 'submenu') {
        walk(item.items, [...shown, label], [...source, english(item.label)], [...keys, item.id]);
        continue;
      }
      const command = item as Extract<MenuItem, { type: 'item' }>;
      const path = [...shown, label];
      const hint = command.hint ? t(command.hint) : undefined;
      out.push({
        key: [...keys, command.id].join('/'),
        path,
        hint,
        checked: command.checked,
        haystack: `${path.join(' / ')}\n${[...source, english(command.label)].join(' / ')}\n${hint ?? ''}`.toLowerCase(),
        leaf: label.toLowerCase(),
        run: command.onSelect,
      });
    }
  };
  for (const menu of menus) if (menu.items?.length) walk(menu.items, [t(menu.label)], [english(menu.label)], [menu.id]);
  return out;
}

/** Words in any order, each somewhere in the path / shortcut; titles starting with the query first, then menu order. */
function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  const first: Command[] = [];
  const rest: Command[] = [];
  const whole = words.join(' ');
  for (const command of commands) {
    if (!words.every(word => command.haystack.includes(word))) continue;
    (command.leaf.startsWith(whole) ? first : rest).push(command);
  }
  return first.concat(rest);
}

/**
 * Menu-bar search (the 🔍 left of Tunnels, Ctrl+Shift+P): a search box over every menu command, listed as
 * `Session / New Session`. ↑ ↓ (PgUp / PgDn) choose, Enter runs, Esc closes and gives focus back (usually to
 * the terminal). The commands are taken from the menus when it opens. Loaded on first use (React.lazy).
 */
export default function CommandPalette({ menus, onClose }: { menus: BarMenu[]; onClose: () => void }) {
  // Snapshot of the menus at open (rerender-lazy-state-init): App re-renders while the palette is open, the
  // list should not change under the pointer.
  const [commands] = useState(() => collectCommands(menus));
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [help, setHelp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const shown = useMemo(() => filterCommands(commands, query), [commands, query]);
  const current = Math.min(highlight, shown.length - 1);

  useLayoutEffect(() => {
    const focused = document.activeElement;
    returnFocus.current = focused instanceof HTMLElement ? focused : null;
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const outside = (event: Event) => {
      const target = pressTarget(event) as Element;
      // The 🔍 button toggles by itself (closing here would reopen it right away).
      if (!rootRef.current?.contains(target) && !target.closest?.('[data-palette-toggle]')) closeRef.current();
    };
    const closeNow = () => closeRef.current();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', closeNow);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', closeNow);
    };
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [current, shown]);

  const dismiss = () => {
    onClose();
    returnFocus.current?.focus({ preventScroll: true });
  };
  const run = (command: Command | undefined) => {
    if (!command) return;
    dismiss();
    command.run();
  };
  const move = (step: number) => {
    if (!shown.length) return;
    setHighlight(Math.max(0, Math.min(shown.length - 1, current + step)));
  };

  return createPortal(
    <div
      ref={rootRef}
      className="command-palette"
      role="dialog"
      aria-label={t('Search menus')}
      onKeyDown={event => {
        // Nothing typed here is a shortcut of the app or the terminal.
        event.stopPropagation();
        if (event.key === 'ArrowDown') move(1);
        else if (event.key === 'ArrowUp') move(-1);
        else if (event.key === 'PageDown') move(8);
        else if (event.key === 'PageUp') move(-8);
        else if (event.key === 'Enter') run(shown[current]);
        else if (event.key === 'Escape') dismiss();
        else return;
        event.preventDefault();
      }}
    >
      <div className="command-palette-field">
        <input
          ref={inputRef}
          value={query}
          placeholder={t('Search menus')}
          aria-label={t('Search menus')}
          aria-controls="command-palette-list"
          aria-activedescendant={current >= 0 ? `command-${current}` : undefined}
          spellCheck={false}
          onChange={event => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
        />
        <button
          type="button"
          className={help ? 'is-on' : undefined}
          aria-pressed={help}
          aria-label={t('Help')}
          title={t('Help')}
          onClick={() => {
            setHelp(value => !value);
            inputRef.current?.focus();
          }}
        >
          ?
        </button>
      </div>
      {help ? (
        <p className="command-palette-help">
          {t('Type words of a menu command in any order. ↑ ↓ choose · Enter runs · Esc closes. Opens with Ctrl+Shift+P.')}
        </p>
      ) : null}
      <ul id="command-palette-list" ref={listRef} role="listbox" className="command-palette-list">
        {shown.length ? (
          shown.map((command, index) => (
            <li
              key={command.key}
              id={`command-${index}`}
              role="option"
              aria-selected={index === current}
              className={index === current ? 'is-active' : undefined}
              onPointerMove={() => index !== current && setHighlight(index)}
              onPointerDown={event => event.preventDefault()}
              onClick={() => run(command)}
            >
              <i aria-hidden="true">
                <Icon name="chevronRight" size={12} />
              </i>
              <span>
                {command.path.map((part, at) => (
                  <span key={at} className={at === command.path.length - 1 ? 'is-leaf' : undefined}>
                    {at ? ' / ' : ''}
                    {part}
                  </span>
                ))}
                {command.checked ? <b className="command-palette-check" aria-label={t('On')} /> : null}
              </span>
              {command.hint ? <small>{command.hint}</small> : null}
            </li>
          ))
        ) : (
          <li className="command-palette-empty" role="presentation">
            {t('No matching menu commands')}
          </li>
        )}
      </ul>
    </div>,
    overlayHost(),
  );
}
