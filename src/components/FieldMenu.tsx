import { useEffect, useState } from 'react';
import { log } from '../lib/log';
import { ContextMenu, type MenuItem } from './MenuButton';
import { t } from '../i18n';

/**
 * Right-click menu for every editable text field (inputs, textareas) — replaces the browser's
 * own menu, in the same style as the app's other context menus.
 */
type TextField = HTMLInputElement | HTMLTextAreaElement;
type Open = { field: TextField; x: number; y: number; start: number | null; end: number | null };

const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', '']);

/** The text field under a right-click, or null (buttons, radios, xterm's hidden helper textarea …). */
function editableField(target: EventTarget | null): TextField | null {
  const field = (target as Element | null)?.closest?.('input, textarea');
  if (!field || field.classList.contains('xterm-helper-textarea')) return null;
  if (field instanceof HTMLTextAreaElement) return field;
  if (field instanceof HTMLInputElement && TEXT_TYPES.has(field.type)) return field;
  return null;
}

const selectionOf = (field: TextField) => {
  try {
    return { start: field.selectionStart, end: field.selectionEnd };
  } catch {
    return { start: null, end: null };
  }
};

/** Copy with a fallback for pages where the async clipboard is unavailable. */
async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fallback below */
  }
  return document.execCommand('copy');
}

export function FieldContextMenu() {
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const field = editableField(event.target);
      if (!field) return; // everything else: the app-wide blocker / the component's own menu
      event.preventDefault();
      event.stopPropagation(); // a row's own menu (e.g. Explorer rename field inside a tree row) must not open too
      if (field.disabled) return;
      if (document.activeElement !== field) field.focus({ preventScroll: true });
      const { start, end } = selectionOf(field);
      setOpen({ field, x: event.clientX, y: event.clientY, start, end });
    };
    window.addEventListener('contextmenu', onContextMenu, true);
    return () => window.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  if (!open) return null;
  const { field } = open;
  const readOnly = field.readOnly || field.disabled;
  const secret = field instanceof HTMLInputElement && field.type === 'password';
  const hasRange = open.start !== null && open.end !== null;
  // type=number has no selection API: treat everything as selected when the text is highlighted.
  const selected = hasRange ? field.value.slice(open.start!, open.end!) : (window.getSelection()?.toString() ?? '');
  const enabled = (command: string) => {
    try {
      return document.queryCommandEnabled(command);
    } catch {
      return true;
    }
  };

  /** Back to the field with the selection it had when the menu opened, then run `action`. */
  const restore = (action: () => void) => () => {
    field.focus({ preventScroll: true });
    if (hasRange) {
      try {
        field.setSelectionRange(open.start, open.end);
      } catch {
        /* number inputs */
      }
    }
    action();
  };
  const paste = async () => {
    // Desktop (WebKitGTK, clipboard access enabled by the app): a native paste — instant, keeps undo.
    // Browsers refuse execCommand('paste'), so read the clipboard asynchronously there.
    field.focus({ preventScroll: true });
    if (document.execCommand('paste')) return;
    let text: string | undefined;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = undefined;
    }
    field.focus({ preventScroll: true });
    if (text === undefined) {
      log.warn(t('Clipboard is not available — use Ctrl+V'));
      return;
    }
    if (text) document.execCommand('insertText', false, field instanceof HTMLInputElement ? text.replace(/\r?\n/g, ' ') : text);
  };
  const items: MenuItem[] = [
    {
      type: 'item',
      id: 'undo',
      label: t('Undo'),
      hint: 'Ctrl+Z',
      disabled: readOnly || !enabled('undo'),
      onSelect: restore(() => document.execCommand('undo')),
    },
    {
      type: 'item',
      id: 'redo',
      label: t('Redo'),
      hint: 'Ctrl+Shift+Z',
      disabled: readOnly || !enabled('redo'),
      onSelect: restore(() => document.execCommand('redo')),
    },
    { type: 'separator', id: 's1' },
    {
      type: 'item',
      id: 'cut',
      label: t('Cut'),
      hint: 'Ctrl+X',
      disabled: readOnly || secret || !selected,
      onSelect: restore(() => {
        void writeClipboard(selected).then(ok => {
          if (ok) document.execCommand('delete');
          else log.warn(t('Clipboard is not available'));
        });
      }),
    },
    {
      type: 'item',
      id: 'copy',
      label: t('Copy'),
      icon: 'copy',
      hint: 'Ctrl+C',
      disabled: secret || !selected,
      onSelect: restore(() => {
        void writeClipboard(selected).then(ok => {
          if (!ok) log.warn(t('Clipboard is not available'));
        });
      }),
    },
    {
      type: 'item',
      id: 'paste',
      label: t('Paste'),
      hint: 'Ctrl+V',
      disabled: readOnly,
      onSelect: restore(() => {
        void paste();
      }),
    },
    {
      type: 'item',
      id: 'delete',
      label: 'Delete',
      icon: 'trash',
      hint: 'Del',
      disabled: readOnly || !selected,
      onSelect: restore(() => document.execCommand('delete')),
    },
    { type: 'separator', id: 's2' },
    {
      type: 'item',
      id: 'select-all',
      label: t('Select All'),
      hint: 'Ctrl+A',
      disabled: !field.value,
      onSelect: restore(() => field.select()),
    },
  ];
  return (
    <ContextMenu
      items={items}
      x={open.x}
      y={open.y}
      onClose={() => {
        setOpen(null);
        // Closed with Esc / after a command: typing continues in the field. Closed by clicking elsewhere: leave focus there.
        requestAnimationFrame(() => {
          const now = document.activeElement;
          if (!now || now === document.body || now.closest('.ui-context-menu')) field.focus({ preventScroll: true });
        });
      }}
    />
  );
}
