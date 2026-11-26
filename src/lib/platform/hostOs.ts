import { backend } from './backend';

/**
 * Operating system of the computer the backend runs on — where local shells start and local files
 * are. Not the browser's: in web mode (`metroterm web`) a Windows browser can drive a Linux
 * backend. Asked once before the first render (`system.os`: Rust's `std::env::consts::OS`); the
 * static preview and backends without that call fall back to the browser's own system.
 */
type HostOs = 'windows' | 'macos' | 'linux';

const guess = (): HostOs => {
  const agent = navigator.userAgent;
  if (/Windows/i.test(agent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(agent)) return 'macos';
  return 'linux';
};

let os: HostOs | null = null;

/** Called once in main.tsx, after the backend has been detected. */
export async function loadHostOs(): Promise<HostOs> {
  const answer = backend.live ? await backend.call<string>('system.os').catch(() => null) : null;
  os = answer === 'windows' || answer === 'macos' ? answer : answer ? 'linux' : guess();
  return os;
}

const hostOs = (): HostOs => os ?? guess();
export const isWindowsHost = () => hostOs() === 'windows';
export const isMacHost = () => hostOs() === 'macos';
