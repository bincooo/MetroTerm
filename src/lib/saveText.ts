import { t } from '../i18n';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { backend, type ConnectionSpec } from './backend';

/**
 * "Save … As": write text (terminal selection / output) to a local file the user picks.
 *
 * - Desktop: the native Save dialog (starts in the folder used last time, else the home folder, with
 *   the suggested name filled in); the backend writes the file (`file.saveText`).
 * - Browser: the browser's save picker (`showSaveFilePicker`, Chromium) — the file is written where
 *   the user chooses; elsewhere (Firefox, sandboxed frames) a normal download with the suggested name.
 *
 * Result: the saved path / name, or null when the user cancelled.
 */
const LOCAL: ConnectionSpec = { id: '__local__', name: 'local', transport: 'local', host: 'localhost', port: 0, username: '' };
let lastFolder = '';

type PickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    name: string;
    createWritable: () => Promise<{ write: (data: Blob | string) => Promise<void>; close: () => Promise<void> }>;
  }>;
};

const parentOf = (path: string) => {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at > 0 ? path.slice(0, at) : '';
};
const separator = (folder: string) => (folder.includes('\\') && !folder.includes('/') ? '\\' : '/');

export async function saveTextAs(text: string, suggestedName: string, title: string): Promise<string | null> {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  const extension = suggestedName.split('.').pop() || 'txt';

  if (backend.mode === 'desktop') {
    if (!lastFolder) lastFolder = await backend.call<string>('fs.home', { connection: LOCAL }).catch(() => '');
    const defaultPath = lastFolder ? `${lastFolder}${separator(lastFolder)}${suggestedName}` : suggestedName;
    const path = await saveDialog({
      title,
      defaultPath,
      filters: [
        { name: extension === 'log' ? t('Log file') : t('Text file'), extensions: [extension] },
        { name: t('All files'), extensions: ['*'] },
      ],
    });
    if (!path) return null;
    await backend.call('file.saveText', { path, text: body });
    lastFolder = parentOf(path) || lastFolder;
    return path;
  }

  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName,
        types: [{ description: extension === 'log' ? t('Log file') : t('Text file'), accept: { 'text/plain': [`.${extension}`] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([body], { type: 'text/plain;charset=utf-8' }));
      await writable.close();
      return handle.name;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null; // cancelled
      // Not allowed here (e.g. a sandboxed preview frame): fall back to a download.
    }
  }
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return suggestedName;
}
