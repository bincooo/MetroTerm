import { t } from '../../i18n';
import { invoke } from '@tauri-apps/api/core';
import { log } from './log';
import { isDesktop } from './tauri';
import { backend } from './backend';

/**
 * App configuration persisted to `~/.metroterm/` (desktop, via Rust commands in
 * src-rust/src/common/config.rs). In the browser preview, which can't touch the file system,
 * the same documents are kept in localStorage under `metroterm:<file>`.
 *
 * Two files:
 * - settings.json — preferences;
 * - sessions.json — Explorer folders + sessions, plus the open terminal tabs (`tabs`) and the
 *   panel layout (`layout`); the desktop app adds the window size (`window`) itself.
 * `layout` and `tabs` are read / written like documents of their own but live inside
 * sessions.json (they used to be layout.json / tabs.json, which are read once for migration).
 * Since the Window menu, `windows` holds every window's layout + tabs; `layout` / `tabs` are
 * read once to build window 1 and then dropped (dropConfig).
 *
 * Everything is loaded once before the UI renders (`loadConfig`), so components can read it
 * synchronously; writes are debounced per file.
 */
const CONFIG_DIR = '~/.metroterm';
type ConfigName = 'settings' | 'sessions' | 'layout' | 'tabs' | 'windows' | 'filer' | 'explorer' | 'monitor' | 'tunnels';
type FileName = 'settings' | 'sessions';
/** Sections stored inside sessions.json. */
const SECTIONS = ['windows', 'tabs', 'layout', 'filer', 'explorer', 'monitor', 'tunnels'] as const;
const fileOf = (name: ConfigName): FileName => (name === 'settings' ? 'settings' : 'sessions');
/** Keys of sessions.json that belong to the desktop app, never written from here. */
const FOREIGN_KEYS = ['window'];

/** Keys used by earlier builds (browser storage) — read once as a fallback / migration. */
const LEGACY_KEYS: Partial<Record<ConfigName, string>> = { layout: 'monoterm-layout-tree-v4' };
/** Sections that never existed as separate files (nothing to migrate from). */
const NO_LEGACY_FILE: readonly ConfigName[] = ['windows', 'filer', 'explorer', 'monitor', 'tunnels'];

const cache = new Map<ConfigName, unknown>();
const timers = new Map<FileName, number>();
let configDir = CONFIG_DIR;

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
const parse = (text: string | null | undefined) => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Desktop app and browser + `metroterm web` both persist to ~/.metroterm; the static preview uses localStorage. */
const onDisk = () => isDesktop() || backend.mode === 'server';

async function loadFile(name: string): Promise<unknown> {
  if (isDesktop()) return parse(await invoke<string | null>('load_config', { name }).catch(() => null));
  if (onDisk())
    return (
      parse(await backend.call<string | null>('config.load', { name }).catch(() => null)) ?? parse(storage()?.getItem(`metroterm:${name}`))
    );
  return parse(storage()?.getItem(`metroterm:${name}`));
}

export async function loadConfig(): Promise<void> {
  if (isDesktop()) configDir = await invoke<string>('config_dir_path').catch(() => CONFIG_DIR);
  else if (onDisk()) configDir = await backend.call<string>('config.dir').catch(() => CONFIG_DIR);
  const [settings, sessions, ...legacy] = await Promise.all(
    ['settings', 'sessions', ...SECTIONS].map(name =>
      NO_LEGACY_FILE.includes(name as ConfigName) ? Promise.resolve(undefined) : loadFile(name),
    ),
  );
  if (settings !== undefined) cache.set('settings', settings);
  if (isObject(sessions)) {
    const main = { ...sessions };
    for (const key of [...SECTIONS, ...FOREIGN_KEYS]) delete main[key];
    cache.set('sessions', main);
  }
  SECTIONS.forEach((section, index) => {
    let value = isObject(sessions) ? sessions[section] : undefined;
    if (value === undefined) value = legacy[index]; // layout.json / tabs.json from before the merge
    const legacyKey = LEGACY_KEYS[section];
    if (value === undefined && legacyKey) value = parse(storage()?.getItem(legacyKey));
    if (value !== undefined) cache.set(section, value);
  });
}

export function readConfig<T>(name: ConfigName): T | undefined {
  return cache.get(name) as T | undefined;
}

export function writeConfig(name: ConfigName, value: unknown, delay = 300): void {
  cache.set(name, value);
  const file = fileOf(name);
  window.clearTimeout(timers.get(file));
  timers.set(
    file,
    window.setTimeout(() => flush(file), delay),
  );
}

/** Remove a section of sessions.json (superseded data, e.g. `layout` / `tabs` → `windows`). */
export function dropConfig(name: ConfigName): void {
  if (!cache.has(name)) return;
  cache.delete(name);
  const file = fileOf(name);
  window.clearTimeout(timers.get(file));
  timers.set(
    file,
    window.setTimeout(() => flush(file), 300),
  );
}

/** File content: settings as is; sessions = the sessions document + its sections. */
function compose(file: FileName): unknown {
  if (file === 'settings') return cache.get('settings');
  const doc: Record<string, unknown> = {
    ...(isObject(cache.get('sessions')) ? (cache.get('sessions') as Record<string, unknown>) : { version: 3, folders: [], sessions: [] }),
  };
  for (const section of SECTIONS) if (cache.has(section)) doc[section] = cache.get(section);
  return doc;
}

function flush(file: FileName) {
  timers.delete(file);
  const value = compose(file);
  if (value === undefined) return;
  const content = JSON.stringify(value, null, 2);
  if (isDesktop())
    void invoke('save_config', { name: file, content }).catch(error =>
      log.warn(t('Cannot save {{file}}.json', { file }), error, { quiet: true }),
    );
  else if (onDisk())
    void backend
      .call('config.save', { name: file, content })
      .catch(error => log.warn(t('Cannot save {{file}}.json', { file }), error, { quiet: true }));
  else {
    try {
      storage()?.setItem(`metroterm:${file}`, content);
      SECTIONS.forEach(section => storage()?.removeItem(`metroterm:${section}`));
    } catch {
      /* storage unavailable (sandboxed preview) */
    }
  }
}

/** Write pending changes immediately (e.g. before the window closes). */
export function flushConfig() {
  [...timers.keys()].forEach(file => {
    window.clearTimeout(timers.get(file));
    flush(file);
  });
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushConfig);

/** Where config lives, for display: absolute path on desktop, `browser storage` in the preview. */
export const configLocation = () => (onDisk() ? configDir : t('browser localStorage (preview)'));
