import { t } from '../../i18n';
import { jumpHostsOf, type SerialSettings, type SessionProxy, type Transport } from '../../types';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isDesktop } from './tauri';
// log.ts imports backend too; the cycle is safe (log is only used inside functions).
import { log } from './log';

/**
 * Backend access, same API in every environment:
 * - `desktop` — Tauri app: `invoke('rpc')` + `backend-event` window events (src-rust/src/desktop.rs)
 * - `server`  — browser + `metroterm web`: JSON-RPC over the `/api/ws` WebSocket (src-rust/src/server.rs)
 * - `preview` — no backend reachable (static preview): components fall back to demo data
 */
type BackendMode = 'desktop' | 'server' | 'preview';

export type PromptField = { label: string; secret: boolean };
export type BackendEvent =
  | { type: 'terminal.data'; sessionId: string; data: string }
  | { type: 'terminal.exit'; sessionId: string; code: number | null; reason: string | null }
  | { type: 'connection.state'; connectionId: string; state: 'connecting' | 'online' | 'offline' | 'error'; message: string | null }
  | {
      type: 'auth.prompt';
      requestId: string;
      connectionId: string;
      kind: 'password' | 'passphrase' | 'keyboard' | 'hostkey';
      title: string;
      message: string;
      fields: PromptField[];
    }
  | { type: 'auth.done'; requestId: string }
  | { type: 'transfer.progress'; transferId: string; done: number; total: number | null }
  /** Agent CLI in a terminal and its state (src-rust/src/agents); `agent: null` = none (any more). */
  | { type: 'agent.state'; sessionId: string; agent: string | null; name: string | null; state: string | null }
  /** MCP tools (src-rust/src/mcp/tools/ui.rs) about windows, panes and tabs (lib/workspace/mcpUi.ts); answered with `mcp.reply`. */
  | { type: 'mcp.ui'; requestId: string; action: string; params: Record<string, unknown> | null }
  | { type: 'backend.closed'; message: string }
  /** Desktop: the window is being closed from outside the UI while terminals are open (src-rust/src/desktop.rs). */
  | { type: 'window.closeRequested' }
  /** Desktop: MetroTerm was started again and this window was brought to the front (single instance). */
  | { type: 'window.activated' };

type Handler = (event: BackendEvent) => void;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

let mode: BackendMode = 'preview';
let socket: WebSocket | null = null;
let clientId = '';
let nextId = 1;
const pending = new Map<number, Pending>();
const handlers = new Set<Handler>();

const dispatchEvent = (event: BackendEvent) =>
  handlers.forEach(handler => {
    try {
      handler(event);
    } catch (error) {
      log.error('Backend event handler failed', error, { quiet: true });
    }
  });

function connectSocket(timeoutMs: number): Promise<boolean> {
  if (typeof window === 'undefined' || !/^https?:$/.test(window.location.protocol) || !window.location.host) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`);
    } catch {
      done(false);
      return;
    }
    const timer = window.setTimeout(() => {
      done(false);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    ws.onmessage = message => {
      let payload: { hello?: { clientId: string }; id?: number; result?: unknown; error?: string; event?: BackendEvent };
      try {
        payload = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (payload.hello) {
        clientId = payload.hello.clientId;
        socket = ws;
        window.clearTimeout(timer);
        done(true);
        return;
      }
      if (payload.event) {
        dispatchEvent(payload.event);
        return;
      }
      if (typeof payload.id === 'number') {
        const request = pending.get(payload.id);
        if (!request) return;
        pending.delete(payload.id);
        if (payload.error !== undefined) request.reject(new Error(payload.error));
        else request.resolve(payload.result);
      }
    };
    ws.onerror = () => {
      window.clearTimeout(timer);
      done(false);
    };
    ws.onclose = () => {
      window.clearTimeout(timer);
      done(false);
      if (socket !== ws) return;
      socket = null;
      pending.forEach(request => request.reject(new Error('Backend connection lost')));
      pending.clear();
      dispatchEvent({ type: 'backend.closed', message: t('Backend connection lost — reload the page to reconnect.') });
    };
  });
}

let ready: Promise<BackendMode> | null = null;

/** Detect the backend once (called before the first render). */
export function initBackend(): Promise<BackendMode> {
  if (!ready) {
    ready = (async () => {
      if (isDesktop()) {
        await listen<BackendEvent>('backend-event', event => dispatchEvent(event.payload));
        mode = 'desktop';
      } else if (await connectSocket(2500)) {
        mode = 'server';
      }
      return mode;
    })();
  }
  return ready;
}

export const backend = {
  get mode() {
    return mode;
  },
  get live() {
    return mode !== 'preview';
  },
  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (mode === 'desktop') return invoke<T>('rpc', { method, params });
    if (mode === 'server' && socket) {
      const id = nextId++;
      const ws = socket;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: value => resolve(value as T), reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    return Promise.reject(new Error('No backend (static preview)'));
  },
  on(handler: Handler): () => void {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },
  /** URL of an HTTP endpoint of the WebSocket server (server mode only). */
  url(path: string, query: Record<string, string>) {
    const search = new URLSearchParams({ client: clientId, ...query });
    return `/api/${path}?${search.toString()}`;
  },
};

/** Connection config as sent to the backend (a remembered password only in its encrypted form). */
export type ConnectionSpec = {
  id: string;
  name: string;
  transport: Transport;
  host: string;
  port: number;
  username: string;
  auth?: 'auto' | 'password' | 'key' | 'agent';
  identityFile?: string;
  shell?: string;
  savedPassword?: string;
  noProxy?: boolean;
  proxy?: SessionProxy;
  localEcho?: boolean;
  serial?: SerialSettings;
};
/** What the backend gets: a jump host is sent as that session's whole config (its own route included). */
export type WireSpec = Omit<ConnectionSpec, 'proxy'> & { proxy?: Omit<SessionProxy, 'jump' | 'jumps'> & { jump?: WireSpec | null } };

/** Saved sessions by id, for jump hosts (set by App). */
let findSession: (id: string) => ConnectionSpec | undefined = () => undefined;
export const setSessionLookup = (lookup: (id: string) => ConnectionSpec | undefined) => {
  findSession = lookup;
};
/** Jump hosts in a row at most (a chain longer than this, or a loop, gets no further jump host: the backend reports it). */
const MAX_JUMPS = 8;
const JUMP = { type: 'jump', host: '', port: 0, username: '' } as const;
const wireProxy = (connection: ConnectionSpec, via: string[]): WireSpec['proxy'] => {
  const proxy = connection.proxy;
  if (
    !proxy ||
    connection.noProxy ||
    (connection.transport !== 'ssh' && connection.transport !== 'telnet' && connection.transport !== 'tcp')
  )
    return undefined;
  if (proxy.type !== 'jump')
    return { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, savedPassword: proxy.savedPassword };
  // Jump hosts a → b → c: sent nested, as the last one reached through the one before it, the first
  // by its own route (its proxy / jump hosts / Session → Proxy…) — the backend opens them in turn.
  // A missing, non-SSH or repeated session, or a chain over MAX_JUMPS, is sent as null: the backend
  // refuses the connection with a message instead of skipping a hop.
  const chain = [...via, connection.id];
  let hop: WireSpec | null = null;
  const ids = jumpHostsOf(proxy);
  for (const [index, id] of ids.entries()) {
    const session = findSession(id);
    if (!session || session.transport !== 'ssh' || chain.includes(id) || chain.length > MAX_JUMPS) {
      hop = null;
      break;
    }
    hop =
      index === 0
        ? toSpec(session, chain)
        : { ...toSpec({ ...session, noProxy: undefined, proxy: undefined }, chain), proxy: { ...JUMP, jump: hop } };
    chain.push(id);
  }
  return { ...JUMP, jump: hop };
};

export const toSpec = (connection: ConnectionSpec, via: string[] = []): WireSpec => ({
  id: connection.id,
  name: connection.name,
  transport: connection.transport,
  host: connection.host,
  port: connection.port,
  username: connection.username,
  auth: connection.auth ?? 'auto',
  identityFile: connection.identityFile || undefined,
  shell: connection.shell || undefined,
  savedPassword: connection.transport === 'ssh' && connection.savedPassword ? connection.savedPassword : undefined,
  noProxy: connection.noProxy || undefined,
  proxy: wireProxy(connection, via),
  localEcho: connection.localEcho || undefined,
  serial: connection.transport === 'serial' ? connection.serial : undefined,
});

/**
 * Registry of live terminals by tab id, so other parts of the UI can reach them: the Sender types
 * into them, the Session menu disconnects them and saves their selection / output.
 */
type TerminalHandle = {
  write: (data: string) => void;
  /** Ends the shell / SSH channel of this terminal only; Enter reconnects. False when not connected. */
  disconnect: () => boolean;
  selection: () => string;
  /** Whole buffer (scrollback + screen) as plain text, soft-wrapped rows joined. */
  output: () => string;
  /** Normal-screen buffer with its colours / styles as ANSI escape sequences ('' when blank). */
  ansi: () => string;
  /** Keyboard focus to this terminal. */
  focus: () => void;
  /** Open the find bar (pane toolbar 🔍, Ctrl+F). */
  find: () => void;
};
const terminals = new Map<string, TerminalHandle>();
export const terminalRegistry = {
  register(tabId: string, handle: TerminalHandle) {
    terminals.set(tabId, handle);
    return () => {
      if (terminals.get(tabId) === handle) terminals.delete(tabId);
    };
  },
  get(tabId: string | null | undefined) {
    return tabId ? terminals.get(tabId) : undefined;
  },
  write(tabId: string, data: string) {
    const handle = terminals.get(tabId);
    if (!handle) return false;
    handle.write(data);
    return true;
  },
};

/** This computer's file system as an `fs.*` endpoint (desktop downloads / uploads, Save dialogs). */
export const LOCAL_SPEC: ConnectionSpec = { id: '__local__', name: 'local', transport: 'local', host: 'localhost', port: 0, username: '' };
