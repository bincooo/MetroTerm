import type { Connection } from '../../types';
import { errorText } from '../platform/log';
import { backend } from '../platform/backend';
import { readTunnels, type TunnelConfig, type TunnelStatus, type TunnelView } from './tunnels';

/**
 * Live state of the tunnels, outside React: the backend runs them, this store polls `tunnel.list`
 * and remembers what is starting or failed to start. Components read it with
 * `useSyncExternalStore` — the menu bar only subscribes to the number of running tunnels, so the
 * polling never re-renders the whole app.
 *
 * Polling: every second while the Tunnels dialog is open, every 5 s while any tunnel runs (to see
 * tunnels stopped by a dropped SSH connection), not at all otherwise.
 */
type Listener = () => void;

const statuses = new Map<string, TunnelStatus>();
const starting = new Set<string>();
const failures = new Map<string, string>();
const listeners = new Set<Listener>();
let views: ReadonlyMap<string, TunnelView> = new Map();
let runningCount = 0;
let watchers = 0;
let timer: number | undefined;
let polling = false;

function publish() {
  const next = new Map<string, TunnelView>();
  failures.forEach((message, id) => next.set(id, { state: 'stopped', message }));
  statuses.forEach((status, id) => next.set(id, status));
  starting.forEach(id => next.set(id, { state: 'starting', message: null }));
  views = next;
  let count = 0;
  for (const status of statuses.values()) if (status.state === 'running') count++;
  runningCount = count;
  listeners.forEach(listener => listener());
}

function schedule() {
  window.clearTimeout(timer);
  timer = undefined;
  if (!backend.live) return;
  const delay = watchers > 0 ? 1000 : statuses.size > 0 ? 5000 : 0;
  if (delay) timer = window.setTimeout(() => void refresh(), delay);
}

/** Read `tunnel.list`; publishes only when something changed. */
async function refresh() {
  if (polling || !backend.live) return;
  polling = true;
  try {
    const list = await backend.call<TunnelStatus[]>('tunnel.list');
    const before = JSON.stringify([...statuses.values()]);
    statuses.clear();
    for (const status of list) statuses.set(status.id, status);
    if (JSON.stringify(list) !== before) publish();
  } catch {
    // Backend gone: keep the last state; the app shows its own "backend lost" message.
  } finally {
    polling = false;
    schedule();
  }
}

/** Spec sent to `tunnel.start` (the backend does not need the name or session id). */
const specOf = (tunnel: TunnelConfig) => ({
  id: tunnel.id,
  kind: tunnel.kind,
  bindHost: tunnel.bindHost.trim(),
  bindPort: tunnel.bindPort,
  destHost: tunnel.destHost.trim(),
  destPort: tunnel.destPort,
});

export const tunnelRuntime = {
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getViews: () => views,
  getRunningCount: () => runningCount,

  /** Fast polling while the returned function has not been called (Tunnels dialog open). */
  watch() {
    watchers++;
    void refresh();
    return () => {
      watchers = Math.max(0, watchers - 1);
      schedule();
    };
  },

  /** Start (or restart) a tunnel; resolves to an error text, or null when it runs. */
  async start(tunnel: TunnelConfig, connection: Connection): Promise<string | null> {
    if (!backend.live) return 'Tunnels need the MetroTerm app or server (not the static preview).';
    starting.add(tunnel.id);
    failures.delete(tunnel.id);
    publish();
    try {
      const status = await backend.call<TunnelStatus>('tunnel.start', { tunnel: specOf(tunnel), connection });
      statuses.set(tunnel.id, status);
      return null;
    } catch (error) {
      statuses.delete(tunnel.id);
      failures.set(tunnel.id, errorText(error));
      return errorText(error);
    } finally {
      starting.delete(tunnel.id);
      publish();
      schedule();
    }
  },

  async stop(id: string) {
    failures.delete(id);
    if (statuses.has(id) && backend.live) {
      try {
        await backend.call('tunnel.stop', { id });
      } catch {
        // Already gone with the backend.
      }
    }
    statuses.delete(id);
    publish();
    schedule();
  },

  /** Forget a deleted tunnel (stopping it first). */
  async remove(id: string) {
    await tunnelRuntime.stop(id);
    failures.delete(id);
    publish();
  },
};

let autoStarted = false;

/**
 * Start the tunnels marked "Start when MetroTerm starts" — once per app load (React StrictMode
 * runs effects twice in development).
 */
export function autoStartTunnels(sessions: readonly Connection[], onStatus: (message: string) => void) {
  if (autoStarted || !backend.live) return;
  autoStarted = true;
  const byId = new Map(sessions.map(session => [session.id, session]));
  for (const tunnel of readTunnels()) {
    if (!tunnel.autoStart) continue;
    const session = byId.get(tunnel.sessionId);
    if (!session || session.transport !== 'ssh') continue;
    void tunnelRuntime.start(tunnel, session).then(error => {
      if (error) onStatus(`Tunnel ${tunnel.name || tunnel.id}: ${error}`);
    });
  }
}
