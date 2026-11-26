/** Small formatting / parsing helpers shared by panels and dialogs. */

/** Two digits: 7 → "07" (dates, times). */
export const pad2 = (value: number) => String(value).padStart(2, '0');

/** Natural, case-insensitive text order: "file2" before "File10". */
export const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** A byte count in B / KB / MB / GB / TB (1024-based): whole bytes, else `digits` decimals below 100. */
export function formatBytes(bytes: number, digits = 1) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(value >= 100 ? 0 : digits) : Math.round(value)} ${units[unit]}`;
}

/** A port typed in a field: digits only, at most 65535 (0 = none). */
export const parsePort = (text: string) => Math.min(65535, Number(text.replace(/\D/g, '').slice(0, 5)) || 0);
