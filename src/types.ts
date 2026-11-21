/** App themes: black, white, and Gold (the black theme with gold accents — meant for the Pro Max tier, open to everyone for now). */
export type ThemeMode = 'dark' | 'light' | 'gold';
export type Transport = 'local' | 'ssh' | 'telnet' | 'tcp' | 'serial';

/** Serial line settings (Serial sessions). */
export type SerialSettings = {
  /** /dev/ttyUSB0, COM3 … */
  device: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: 'none' | 'odd' | 'even';
  stopBits: 1 | 2;
  flowControl: 'none' | 'software' | 'hardware';
};

export type Connection = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  transport: Transport;
  status: 'online' | 'offline' | 'connecting';
  fingerprint?: string;
  /** SSH authentication: auto = agent → keys → password (OpenSSH order). */
  auth?: 'auto' | 'password' | 'key' | 'agent';
  /** Private key file (SSH, `auth: 'key'` or as first key in `auto`). */
  identityFile?: string;
  /** Local sessions: shell executable (default $SHELL / PowerShell). */
  shell?: string;
  /** "Remember password" (password login): encrypted by the backend (`secret.seal`), never plain text. */
  savedPassword?: string;
  /** SSH / Telnet / TCP: connect directly even when Session → Proxy… is set. */
  noProxy?: boolean;
  /** Telnet / TCP / Serial: show typed characters locally (for peers that don't echo). */
  localEcho?: boolean;
  /** Serial sessions. */
  serial?: SerialSettings;
};

/** tmux panes of a window's terminal area (lib/tmux.ts): row = left | right, column = top / bottom; leaves are pane ids. */
export type TmuxNode =
  { kind: 'pane'; id: string } | { kind: 'split'; dir: 'row' | 'column'; ratio: number; first: TmuxNode; second: TmuxNode };

/**
 * An open terminal tab (many tabs may use the same saved session; `title`: custom name). `windowId` = the Window-menu window it belongs to (set by App);
 * `tmuxPane` = the tmux pane (tab group) of that window it is shown in (absent / unknown = the first pane).
 */
export type TerminalTab = {
  id: string;
  connectionId: string;
  title?: string;
  windowId?: string;
  tmuxPane?: string;
};

export type RemoteFile = {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'link';
  /** Directory or symlink to a directory. */
  isDir: boolean;
  size: number;
  /** Unix seconds. */
  modified: number | null;
  /** `drwxr-xr-x` style. */
  permissions?: string | null;
  /** Owner user / group names (numeric ids when unknown); null on Windows. */
  owner?: string | null;
  group?: string | null;
};
