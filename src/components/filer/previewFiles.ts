import type { RemoteFile } from '../../types';

/** Demo listing for the static preview (no backend). */
export const PREVIEW_HOME = '/home/demo';
const day = (text: string) => Math.round(new Date(text).getTime() / 1000);
export const previewFiles: RemoteFile[] = [
  ...[
    ['.config', '2026-11-15 22:02'],
    ['Desktop', '2026-10-28 08:35'],
    ['Documents', '2026-10-11 10:35'],
    ['Downloads', '2026-11-16 00:00'],
    ['go', '2026-08-30 09:41'],
    ['IdeaProjects', '2026-11-14 07:39'],
    ['Music', '2026-06-27 07:49'],
    ['Pictures', '2026-11-08 19:11'],
    ['projects', '2026-11-16 18:30'],
    ['tools', '2026-11-15 00:16'],
  ].map(([name, date]) => ({
    name,
    path: `${PREVIEW_HOME}/${name}`,
    kind: 'dir' as const,
    isDir: true,
    size: 0,
    modified: day(date),
    permissions: 'drwxr-xr-x',
    owner: 'demo',
    group: 'demo',
  })),
  {
    name: '.bashrc',
    path: `${PREVIEW_HOME}/.bashrc`,
    kind: 'file',
    isDir: false,
    size: 3526,
    modified: day('2026-07-12 16:58'),
    permissions: '-rw-r--r--',
    owner: 'demo',
    group: 'demo',
  },
  {
    name: 'README.md',
    path: `${PREVIEW_HOME}/README.md`,
    kind: 'file',
    isDir: false,
    size: 4821,
    modified: day('2026-11-16 18:30'),
    permissions: '-rw-r--r--',
    owner: 'demo',
    group: 'demo',
  },
  {
    name: 'system.log',
    path: `${PREVIEW_HOME}/system.log`,
    kind: 'file',
    isDir: false,
    size: 210972,
    modified: day('2026-11-16 18:44'),
    permissions: '-rw-r-----',
    owner: 'demo',
    group: 'adm',
  },
];
