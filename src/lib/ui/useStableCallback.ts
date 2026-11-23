import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback with a stable identity that always runs the latest `fn` (Vercel React best
 * practices: advanced-event-handler-refs / advanced-use-latest). Lets memoized children and
 * effects take event handlers without re-rendering / re-subscribing on every parent render.
 * Not for use during render — only in events and effects.
 */
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}
