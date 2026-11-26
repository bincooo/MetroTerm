import { useCallback, useEffect, useRef, useState } from 'react';
import { hashLockPassword, hasLockPassword, sanitizeLockSettings } from '../../lib/settings/lockScreen';
import { readSettings } from '../settingsDoc';

/** Lock Screen (status bar → Lock Screen; settings.json → lock): settings, locked state, idle lock. */
export function useLockScreen() {
  const [lockSettings, setLockSettings] = useState(() => sanitizeLockSettings(readSettings().lock));
  /** Locked when the app was closed while locked with a password: starts locked again. */
  const [locked, setLocked] = useState(() => hasLockPassword(lockSettings) && Boolean(lockSettings.locked));
  const [lockPrompt, setLockPrompt] = useState<'setup' | 'password' | null>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const lockNow = useCallback(
    (fromIdle = false) => {
      if (lockedRef.current) return;
      // No password yet: offer to set one (unless turned off) — not when locking because of idling.
      if (!fromIdle && !hasLockPassword(lockSettings) && !lockSettings.skipPrompt) {
        setLockPrompt('setup');
        return;
      }
      lockedRef.current = true;
      setLockPrompt(null);
      setLocked(true);
    },
    [lockSettings],
  );
  // The app was used: keyboard / mouse input (terminal output doesn't count). Auto lock after idling.
  useEffect(() => {
    if (locked || !lockSettings.idleMinutes) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const types = ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart'] as const;
    types.forEach(type => window.addEventListener(type, touch, { capture: true, passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - last >= lockSettings.idleMinutes * 60_000) lockNow(true);
    }, 5_000);
    return () => {
      types.forEach(type => window.removeEventListener(type, touch, { capture: true }));
      window.clearInterval(timer);
    };
  }, [locked, lockSettings.idleMinutes, lockNow]);
  const saveLockPassword = async (password: string | null) => {
    const secret = password === null ? {} : await hashLockPassword(password);
    setLockSettings(current => {
      const { hash: _h, salt: _s, iterations: _i, locked: _l, ...rest } = current;
      return { ...rest, ...secret };
    });
    return secret;
  };
  return { lockSettings, setLockSettings, locked, setLocked, lockedRef, lockPrompt, setLockPrompt, lockNow, saveLockPassword };
}
