import { t } from '../../i18n';
import { readConfig, writeConfig } from '../platform/config';

/**
 * SSH tunnels (port forwarding), configured in the Tunnels dialog and run by the backend
 * (src-rust/src/remote/tunnel.rs):
 * - local    `ssh -L [bind:]port:dest:destPort` — a port here reaches dest through the server;
 * - remote   `ssh -R [bind:]port:dest:destPort` — a port on the server reaches dest from here;
 * - dynamic  `ssh -D [bind:]port` — a SOCKS 4/5 proxy here, connecting through the server.
 * Definitions are saved in sessions.json (`tunnels`); running tunnels live in the backend.
 */
export type TunnelKind = 'local' | 'remote' | 'dynamic';

export type TunnelConfig = {
  id: string;
  name: string;
  /** Explorer session (SSH) the tunnel goes through. */
  sessionId: string;
  kind: TunnelKind;
  /** Empty = loopback (127.0.0.1 here, localhost on the server for remote tunnels). */
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
  /** Start when MetroTerm starts. */
  autoStart: boolean;
};

/** `tunnel.list` / `tunnel.start` answer for a running tunnel. */
export type TunnelStatus = {
  id: string;
  connectionId: string;
  kind: TunnelKind;
  state: 'running' | 'error';
  message: string | null;
  boundHost: string;
  boundPort: number;
  active: number;
  total: number;
  rx: number;
  tx: number;
  started: number;
};

/** What the UI shows for one tunnel. */
export type TunnelView =
  { state: 'stopped'; message: string | null } | { state: 'starting'; message: null } | ({ state: 'running' | 'error' } & TunnelStatus);

type TunnelsDoc = { tunnels?: unknown[] };

export const TUNNEL_KINDS: { value: TunnelKind; label: string; flag: string; hint: string }[] = [
  { value: 'local', label: 'LOCAL', flag: '-L', hint: 'A port on this computer reaches a host through the SSH server.' },
  { value: 'remote', label: 'REMOTE', flag: '-R', hint: 'A port on the SSH server reaches a host through this computer.' },
  {
    value: 'dynamic',
    label: 'DYNAMIC',
    flag: '-D',
    hint: 'A SOCKS 4 / 5 proxy on this computer; connections go out through the SSH server.',
  },
];

const KINDS = new Set<TunnelKind>(['local', 'remote', 'dynamic']);
const port = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 0);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export const newTunnelId = () => `tunnel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** A config read from disk, with every field checked (hand-edited files must not break the UI). */
function sanitizeTunnel(value: unknown): TunnelConfig | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const kind = item.kind as TunnelKind;
  if (!text(item.id) || !KINDS.has(kind)) return null;
  return {
    id: text(item.id),
    name: text(item.name),
    sessionId: text(item.sessionId),
    kind,
    bindHost: text(item.bindHost),
    bindPort: port(item.bindPort),
    destHost: text(item.destHost),
    destPort: port(item.destPort),
    autoStart: item.autoStart === true,
  };
}

export function readTunnels(): TunnelConfig[] {
  const doc = readConfig<TunnelsDoc>('tunnels');
  if (!Array.isArray(doc?.tunnels)) return [];
  return doc.tunnels.flatMap(item => {
    const tunnel = sanitizeTunnel(item);
    return tunnel ? [tunnel] : [];
  });
}

export function saveTunnels(tunnels: TunnelConfig[]) {
  writeConfig('tunnels', { tunnels });
}

/** Default listen host as shown in placeholders. */
export const defaultBindHost = (kind: TunnelKind) => (kind === 'remote' ? 'localhost' : '127.0.0.1');

/** `127.0.0.1:8080 → db:5432` style summary. */
export function describeTunnel(tunnel: Pick<TunnelConfig, 'kind' | 'bindHost' | 'bindPort' | 'destHost' | 'destPort'>, boundPort?: number) {
  const listen = `${tunnel.bindHost.trim() || defaultBindHost(tunnel.kind)}:${boundPort || tunnel.bindPort || 'auto'}`;
  if (tunnel.kind === 'dynamic') return `${listen} → SOCKS`;
  return `${listen} → ${tunnel.destHost.trim() || '?'}:${tunnel.destPort || '?'}`;
}

/** OpenSSH equivalent of a tunnel (shown in the edit form). */
export function sshFlag(tunnel: Pick<TunnelConfig, 'kind' | 'bindHost' | 'bindPort' | 'destHost' | 'destPort'>) {
  const flag = TUNNEL_KINDS.find(item => item.value === tunnel.kind)!.flag;
  const bind = tunnel.bindHost.trim() ? `${tunnel.bindHost.trim()}:` : '';
  const listen = `${bind}${tunnel.bindPort || 0}`;
  return tunnel.kind === 'dynamic'
    ? t('ssh {{flag}} {{listen}}', { flag, listen })
    : `ssh ${flag} ${listen}:${tunnel.destHost.trim() || 'host'}:${tunnel.destPort || 'port'}`;
}

/** Problem with a tunnel form, or null when it can be saved. */
export function validateTunnel(tunnel: TunnelConfig, hasSession: boolean): string | null {
  if (!hasSession) return t('Choose the SSH session the tunnel goes through.');
  if (tunnel.kind === 'remote' && !tunnel.bindPort) return t('Enter the port the SSH server listens on.');
  if (tunnel.kind !== 'dynamic' && (!tunnel.destHost.trim() || !tunnel.destPort)) return t('Enter the destination host and port.');
  return null;
}
