/**
 * Lock Screen: the optional lock password and the lock settings (settings.json → `lock`).
 *
 * The password itself is never stored: only a salted PBKDF2-SHA256 hash (WebCrypto), so the file
 * does not reveal it. Without a password the lock screen is a privacy cover (unlock with a click).
 */

export type LockSettings = {
  /** PBKDF2 hash and salt (base64); absent = no lock password. */
  hash?: string;
  salt?: string;
  iterations?: number;
  /** Lock after this many minutes without keyboard / mouse input; 0 = never. */
  idleMinutes: number;
  /** "Don't ask again" in the set-a-password prompt shown when locking without a password. */
  skipPrompt?: boolean;
  /** Locked when the app was closed (only kept with a password): starts locked again. */
  locked?: boolean;
};

export const IDLE_RANGE = { min: 0, max: 720 } as const;
const ITERATIONS = 150_000;

export function sanitizeLockSettings(value: unknown): LockSettings {
  const doc = (value && typeof value === 'object' ? value : {}) as Partial<LockSettings>;
  const idle = Number(doc.idleMinutes);
  const hasPassword = typeof doc.hash === 'string' && typeof doc.salt === 'string' && doc.hash.length > 0;
  return {
    ...(hasPassword
      ? { hash: doc.hash, salt: doc.salt, iterations: Number(doc.iterations) > 0 ? Number(doc.iterations) : ITERATIONS }
      : {}),
    idleMinutes: Number.isFinite(idle) ? Math.min(IDLE_RANGE.max, Math.max(IDLE_RANGE.min, Math.round(idle))) : 0,
    ...(doc.skipPrompt ? { skipPrompt: true } : {}),
    ...(hasPassword && doc.locked ? { locked: true } : {}),
  };
}

export const hasLockPassword = (settings: LockSettings) => Boolean(settings.hash && settings.salt);

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), char => char.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This browser offers no Web Crypto (needs a secure context: https or localhost)');
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toBase64(new Uint8Array(bits));
}

/** Hash a new lock password (fresh random salt). */
export async function hashLockPassword(password: string): Promise<Pick<LockSettings, 'hash' | 'salt' | 'iterations'>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derive(password, salt, ITERATIONS), salt: toBase64(salt), iterations: ITERATIONS };
}

/** True when `password` is the lock password (always true without one). */
export async function verifyLockPassword(settings: LockSettings, password: string): Promise<boolean> {
  if (!hasLockPassword(settings)) return true;
  const expected = settings.hash!;
  const actual = await derive(password, fromBase64(settings.salt!), settings.iterations ?? ITERATIONS);
  // Constant-time comparison of the two hashes.
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) diff |= (expected.charCodeAt(i) || 0) ^ (actual.charCodeAt(i) || 0);
  return diff === 0;
}
