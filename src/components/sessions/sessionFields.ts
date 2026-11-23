/** Shared fields and options of the session dialogs (New Session / Properties and Default Session Settings). */
import { useEffect, useState } from 'react';
import { backend } from '../../lib/platform/backend';
import { BAUD_RATES } from '../../lib/sessions/transports';
import { type SessionProxy, type Transport } from '../../types';
import { type ComboOption } from '../common/ComboBox';
import type { TreeSession } from './SessionTree';
import { t } from '../../i18n';

export type ShellInfo = { name: string; path: string };

/** SHELL field suggestions: the default shell, then every shell found on this computer (name · path). */
export const shellOptions = (shells: ShellInfo[]): ComboOption[] => [
  { value: '', label: t('Default shell'), hint: '$SHELL' },
  ...shells.map(item => ({ value: item.name, label: item.name, hint: item.path })),
];

/** SHELL field placeholder: the shells found on this computer, or a generic hint. */
export const shellPlaceholder = (shells: ShellInfo[]) =>
  shells.length
    ? t('{{v}} · empty = $SHELL', { v: shells.map(item => item.name).join(' · ') })
    : t('bash, zsh … · empty = $SHELL / PowerShell');

/** PORT field: digits only, at most 65535 (a text input — number inputs expose no caret position). */
export const AUTH_OPTIONS = [
  { value: 'auto', label: 'Auto', hint: 'agent → key → password' },
  { value: 'password', label: 'Password', hint: 'asked on connect' },
  { value: 'key', label: 'Public key', hint: 'key file' },
  { value: 'agent', label: 'SSH agent', hint: 'ssh-agent / Pageant' },
];

export const DATA_BITS = [5, 6, 7, 8].map(value => ({ value: String(value), label: String(value) }));
export const PARITY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'odd', label: 'Odd' },
  { value: 'even', label: 'Even' },
];
export const STOP_BITS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
];
export const FLOW_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'hardware', label: 'Hardware', hint: 'RTS/CTS' },
  { value: 'software', label: 'Software', hint: 'XON/XOFF' },
];
export const BAUD_OPTIONS: ComboOption[] = BAUD_RATES.map(rate => ({ value: String(rate), label: String(rate) }));

/**
 * PROXY of SSH / Telnet / TCP sessions: Session → Proxy… (the app-wide proxy), none, a proxy of the
 * session's own, or a jump host (another SSH session).
 */
export type ProxyMode = 'global' | 'none' | SessionProxy['type'];
export const proxyModeOf = (session?: TreeSession): ProxyMode => (session?.noProxy ? 'none' : (session?.proxy?.type ?? 'global'));
export const OWN_PROXY_PORT = { socks5: 1080, http: 8080 } as const;

/** Name a new session gets for each type (replaced when the type changes and the name was not edited). */
export const DEFAULT_NAMES: Record<Transport, string> = {
  ssh: 'server',
  telnet: 'telnet',
  tcp: 'tcp',
  serial: 'serial',
  local: 'local shell',
};
export const isDefaultName = (name: string) => !name.trim() || Object.values(DEFAULT_NAMES).includes(name);

type SerialPortInfo = { path: string; description: string };

/** Serial ports present on this computer (backend `system.serialPorts`); [] in the browser preview. */
export function useSerialPorts(enabled: boolean) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!enabled || !backend.live) return;
    let cancelled = false;
    void backend.call<SerialPortInfo[]>('system.serialPorts').then(
      list => !cancelled && setPorts(list),
      () => !cancelled && setPorts([]),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, token]);
  return { ports, refresh: () => setToken(value => value + 1) };
}
