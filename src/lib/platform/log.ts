/// <reference types="vite/client" />
import { useSyncExternalStore } from 'react';
import { backend } from './backend';

/**
 * The one logging tool of the UI. Every message goes to the application log (Session → Log,
 * backend `log.write`, target "ui") at its level, and to the browser console in development.
 * `info` / `warn` / `error` are also shown in the status bar (the "activity" text); `debug`
 * and `trace` are only written to the log.
 *
 *   log('Session tab closed');                // = log.info: status bar + log (info)
 *   log.error('Cannot save', error);          // status bar "Cannot save: …" + log (error)
 *   log.debug('resize 120×40', { quiet });    // log only
 *   log.info('Copied', { quiet: true });      // log only, the status bar keeps its text
 *
 * Components import `log` directly (no onStatus / onLog props); the status bar reads the text
 * with `useActivity()`.
 */
type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
type LogOptions = {
  /** Don't show the message in the status bar (it is still written to the log). */
  quiet?: boolean;
};

const DEV = import.meta.env.DEV;
let activity = 'Ready';
const listeners = new Set<() => void>();

/** Text of an error-like value (Error, string, anything else). */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function setActivity(message: string) {
  if (message === activity) return;
  activity = message;
  listeners.forEach(listener => listener());
}

function write(level: LogLevel, message: string, options?: LogOptions) {
  if (!options?.quiet && level !== 'debug' && level !== 'trace') setActivity(message);
  if (DEV) {
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'info' ? console.info : console.debug;
    out(`[${level}] ${message}`);
  }
  if (backend.live) void backend.call('log.write', { level, message }).catch(() => undefined);
}

/** `message` + the error's text when there is one ("Cannot save: permission denied"). */
const withError = (message: string, error?: unknown) => (error === undefined ? message : `${message}: ${errorText(error)}`);

/** `log(message)` is `log.info(message)`. */
export const log = Object.assign((message: string, options?: LogOptions) => write('info', message, options), {
  info: (message: string, options?: LogOptions) => write('info', message, options),
  warn: (message: string, error?: unknown, options?: LogOptions) => write('warn', withError(message, error), options),
  error: (message: string, error?: unknown, options?: LogOptions) => write('error', withError(message, error), options),
  debug: (message: string) => write('debug', message),
  trace: (message: string) => write('trace', message),
});

/** Status bar text: the last info / warn / error message. */
export function useActivity(): string {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => activity,
  );
}
