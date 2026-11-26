/**
 * The Filer's listing: columns (widths and sort order saved in sessions.json → `filer`), sizes,
 * dates and type names.
 */
import type { RemoteFile } from '../../types';
import { readConfig } from '../../lib/platform/config';
import { naturalCompare, pad2 } from '../../lib/format';
import { t } from '../../i18n';

export const bytes = (value: number) =>
  value < 1024
    ? t('{{value}} B', { value })
    : value < 1024 ** 2
      ? t('{{v}} KB', { v: (value / 1024).toFixed(value < 10240 ? 1 : 0) })
      : value < 1024 ** 3
        ? t('{{v}} MB', { v: (value / 1024 ** 2).toFixed(1) })
        : t('{{v}} GB', { v: (value / 1024 ** 3).toFixed(2) });
export const formatTime = (seconds: number | null) => {
  if (!seconds) return '—';
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};
/** Explorer-style type name: folder, link, or the extension ("Markdown file", "PNG image"). */
const TYPE_NAMES: Record<string, string> = {
  md: 'Markdown file',
  txt: 'Text file',
  log: 'Log file',
  json: 'JSON file',
  yaml: 'YAML file',
  yml: 'YAML file',
  toml: 'TOML file',
  xml: 'XML file',
  csv: 'CSV file',
  ini: 'Settings file',
  conf: 'Config file',
  cfg: 'Config file',
  env: 'Env file',
  sh: 'Shell script',
  bash: 'Shell script',
  zsh: 'Shell script',
  ps1: 'PowerShell script',
  bat: 'Batch file',
  cmd: 'Batch file',
  py: 'Python file',
  js: 'JavaScript file',
  mjs: 'JavaScript file',
  ts: 'TypeScript file',
  tsx: 'TypeScript file',
  jsx: 'JavaScript file',
  rs: 'Rust file',
  go: 'Go file',
  java: 'Java file',
  c: 'C file',
  h: 'C header',
  cpp: 'C++ file',
  rb: 'Ruby file',
  php: 'PHP file',
  html: 'HTML file',
  css: 'CSS file',
  sql: 'SQL file',
  pdf: 'PDF document',
  doc: 'Word document',
  docx: 'Word document',
  xls: 'Excel sheet',
  xlsx: 'Excel sheet',
  ppt: 'PowerPoint deck',
  pptx: 'PowerPoint deck',
  png: 'PNG image',
  jpg: 'JPEG image',
  jpeg: 'JPEG image',
  gif: 'GIF image',
  svg: 'SVG image',
  webp: 'WebP image',
  ico: 'Icon',
  zip: 'ZIP archive',
  gz: 'GZ archive',
  tgz: 'TGZ archive',
  tar: 'TAR archive',
  xz: 'XZ archive',
  '7z': '7Z archive',
  rar: 'RAR archive',
  mp3: 'MP3 audio',
  wav: 'WAV audio',
  mp4: 'MP4 video',
  mkv: 'MKV video',
  iso: 'Disc image',
  exe: 'Application',
  deb: 'Debian package',
  rpm: 'RPM package',
  pem: 'Certificate',
  crt: 'Certificate',
  key: 'Key file',
  pub: 'Public key',
};
export const fileType = (file: RemoteFile) => {
  if (file.kind === 'link') return file.isDir ? t('Folder link') : t('Link');
  if (file.isDir) return t('Folder');
  const dot = file.name.lastIndexOf('.');
  if (dot <= 0 || dot === file.name.length - 1) return t('File');
  const ext = file.name.slice(dot + 1).toLowerCase();
  return TYPE_NAMES[ext] ? t(TYPE_NAMES[ext]) : t('{{ext}} file', { ext: ext.toUpperCase() });
};
export const COLUMNS = [
  ['name', 'Name'],
  ['modified', 'Date Modified'],
  ['type', 'Type'],
  ['size', 'Size'],
  ['permissions', 'Permissions'],
  ['owner', 'Owner'],
  ['group', 'Group'],
] as const;
export type SortKey = (typeof COLUMNS)[number][0];
export type Sort = { key: SortKey; descending: boolean };
export type ColumnWidths = Record<SortKey, number>;

/** Column widths (px) until the user drags a header edge; stored in sessions.json → `filer`. */
export const DEFAULT_WIDTHS: ColumnWidths = { name: 220, modified: 124, type: 104, size: 64, permissions: 88, owner: 68, group: 68 };
export const MIN_WIDTH = 40;
export const MIN_NAME_WIDTH = 80;
export const COLUMN_GAP = 12; // matches `column-gap` of .filer-head / rows (styles/filer.css)
export type FilerDoc = { columns?: Partial<ColumnWidths>; sort?: Partial<Sort>; follow?: boolean };
const isColumn = (key: unknown): key is SortKey => COLUMNS.some(([column]) => column === key);
export const savedFiler = (): { widths: ColumnWidths; sort: Sort; follow: boolean } => {
  const doc = readConfig<FilerDoc>('filer') ?? {};
  const widths = { ...DEFAULT_WIDTHS };
  for (const [key] of COLUMNS) {
    const value = doc.columns?.[key];
    if (typeof value === 'number' && Number.isFinite(value))
      widths[key] = Math.max(key === 'name' ? MIN_NAME_WIDTH : MIN_WIDTH, Math.round(value));
  }
  const sort: Sort = { key: isColumn(doc.sort?.key) ? doc.sort.key : 'name', descending: doc.sort?.descending === true };
  return { widths, sort, follow: doc.follow === true };
};

const byName = (a: RemoteFile, b: RemoteFile) => naturalCompare(a.name, b.name);
const byText = (value: (file: RemoteFile) => string | null | undefined) => (a: RemoteFile, b: RemoteFile) =>
  naturalCompare(value(a) ?? '', value(b) ?? '') || byName(a, b);
const ORDER: Record<SortKey, (a: RemoteFile, b: RemoteFile) => number> = {
  name: byName,
  modified: (a, b) => (a.modified ?? 0) - (b.modified ?? 0) || byName(a, b),
  type: byText(fileType),
  size: (a, b) => a.size - b.size || byName(a, b),
  permissions: byText(file => file.permissions),
  owner: byText(file => file.owner),
  group: byText(file => file.group),
};
/** A path as one shell word: unchanged when it only has safe characters, else in single quotes. */
export const shellQuote = (value: string) => (/^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);
export const compare = (sort: Sort) => (a: RemoteFile, b: RemoteFile) => {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders first, in either direction
  const order = ORDER[sort.key](a, b);
  return sort.descending ? -order : order;
};
