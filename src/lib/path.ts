/**
 * Normalize a typed path: expand a leading `~` to `home`, collapse repeated slashes,
 * resolve `.` / `..` (never above the root). Windows drive paths (`C:/…`, `C:\…`) keep their drive.
 * `trailingSlash` keeps a trailing `/` on directories.
 */
export function normalizePath(raw: string, home: string, trailingSlash = true): string {
  const input = raw.trim().replace(/^~(?=[\\/]|$)/, home.replace(/[\\/]$/, '')) || '/';
  const drive = /^[A-Za-z]:(?=[\\/]|$)/.exec(input)?.[0];
  const rest = drive ? input.slice(drive.length) : input;
  const parts: string[] = [];
  for (const part of rest.split(/[\\/]/)) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${drive ?? ''}/${parts.join('/')}${parts.length && trailingSlash ? '/' : ''}`;
}

/** Parent directory (`/` and `C:/` are their own parent). */
export function parentPath(path: string): string {
  const normalized = normalizePath(path, '/', false);
  const index = normalized.lastIndexOf('/');
  const parent = normalized.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent || '/';
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
