/**
 * Session types (Session Settings dialog, Explorer, tabs): label, icon, default port and the
 * one-line description shown next to a session ("user@host:port", "/dev/ttyUSB0 · 115200 8N1" …).
 */
import { t } from '../../i18n';
import type { IconName } from '../../components/common/Icon';
import type { Connection, SerialSettings, Transport } from '../../types';
import { fieldsOf } from '../settings/fields';

export const TRANSPORTS: { value: Transport; label: string; title: string }[] = [
  { value: 'ssh', label: 'SSH', title: 'SSH CONNECTION' },
  { value: 'telnet', label: 'TELNET', title: 'TELNET CONNECTION' },
  { value: 'tcp', label: 'TCP', title: 'RAW TCP CONNECTION' },
  { value: 'serial', label: 'SERIAL', title: 'SERIAL PORT' },
  { value: 'local', label: 'LOCAL', title: 'LOCAL SHELL' },
];

export const isTransport = (value: unknown): value is Transport =>
  value === 'local' || value === 'ssh' || value === 'telnet' || value === 'tcp' || value === 'serial';

/** Sessions that connect to host:port (and may go through the proxy). */
export const isNetwork = (transport: Transport) => transport === 'ssh' || transport === 'telnet' || transport === 'tcp';
/** Sessions with a file system the Filer can browse (local disk / SFTP). */
export const hasFiles = (transport: Transport) => transport === 'local' || transport === 'ssh';

export const transportIcon = (transport: Transport): IconName =>
  transport === 'ssh'
    ? 'server'
    : transport === 'telnet'
      ? 'telnet'
      : transport === 'tcp'
        ? 'tcp'
        : transport === 'serial'
          ? 'serial'
          : 'terminal';

/** Short type name: status bar, tab tooltips, Session panel. */
export const transportName = (transport: Transport) =>
  transport === 'ssh'
    ? t('SSH')
    : transport === 'telnet'
      ? t('Telnet')
      : transport === 'tcp'
        ? t('TCP')
        : transport === 'serial'
          ? t('Serial')
          : t('Local shell');

export const defaultPort = (transport: Transport) => (transport === 'ssh' ? 22 : transport === 'telnet' ? 23 : 0);

const DEFAULT_SERIAL: SerialSettings = {
  device: '',
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
};
export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000];

export function sanitizeSerial(value: unknown): SerialSettings {
  const raw = fieldsOf<SerialSettings>(value);
  const d = DEFAULT_SERIAL;
  const baud = typeof raw.baudRate === 'number' && raw.baudRate > 0 ? Math.round(raw.baudRate) : d.baudRate;
  return {
    device: typeof raw.device === 'string' ? raw.device : d.device,
    baudRate: Math.min(10_000_000, baud),
    dataBits: raw.dataBits === 5 || raw.dataBits === 6 || raw.dataBits === 7 ? raw.dataBits : 8,
    parity: raw.parity === 'odd' || raw.parity === 'even' ? raw.parity : 'none',
    stopBits: raw.stopBits === 2 ? 2 : 1,
    flowControl: raw.flowControl === 'software' || raw.flowControl === 'hardware' ? raw.flowControl : 'none',
  };
}

/** "115200 8N1" (+ flow control). */
const serialFrame = (serial: SerialSettings) =>
  `${serial.baudRate} ${serial.dataBits}${serial.parity === 'none' ? 'N' : serial.parity === 'odd' ? 'O' : 'E'}${serial.stopBits}${
    serial.flowControl === 'hardware' ? ' RTS/CTS' : serial.flowControl === 'software' ? ' XON/XOFF' : ''
  }`;

/** Where a session goes: shown under its name (Explorer hints, Open Recent, Session panel). */
export function describeConnection(connection: Pick<Connection, 'transport' | 'host' | 'port' | 'username' | 'shell' | 'serial'>) {
  switch (connection.transport) {
    case 'ssh':
      return `${connection.username ? `${connection.username}@` : ''}${connection.host}${connection.port && connection.port !== 22 ? `:${connection.port}` : ''}`;
    case 'telnet':
      return `telnet://${connection.host}${connection.port && connection.port !== 23 ? `:${connection.port}` : ''}`;
    case 'tcp':
      return `tcp://${connection.host}:${connection.port}`;
    case 'serial': {
      const serial = sanitizeSerial(connection.serial);
      return `${serial.device || 'serial'} · ${serialFrame(serial)}`;
    }
    default:
      return connection.shell || 'local';
  }
}
