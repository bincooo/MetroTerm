import type { SVGProps } from 'react';

/**
 * Unified line-icon set: 16×16 grid, 1.3px stroke, square caps & joins (Metro / straight-edged).
 * Every icon is drawn on the same grid so they share the same optical size and baseline,
 * replacing the mixed Unicode glyphs that rendered at different sizes per font.
 */
const paths = {
  // window
  minimize: <path d="M3.5 8h9" />,
  maximize: <rect x="3.5" y="3.5" width="9" height="9" />,
  restore: <path d="M3.5 5.5h7v7h-7zM5.5 5.5v-2h7v7h-2" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  // navigation
  chevronDown: <path d="M4.5 6.5 8 10l3.5-3.5" />,
  chevronRight: <path d="M6.5 4.5 10 8l-3.5 3.5" />,
  arrowUp: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  arrowRight: <path d="M3 8h9.5M8.5 4l4 4-4 4" />,
  upload: <path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v3h11v-3" />,
  download: <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 10.5v3h11v-3" />,
  external: <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4" />,
  // actions
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  /** ≡ (a tmux pane's menu). */
  menu: <path d="M3 4.5h10M3 8h10M3 11.5h10" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" />
      <path d="M10.5 5.5v-3h-8v8h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.3 10.3 3.2 3.2" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5M8 5.5v5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8h5" />
    </>
  ),
  filter: <path d="M2.5 3.5h11L9.5 8.5v4.5l-3-1.5v-3z" />,
  settings: (
    <>
      <path d="M2.5 4.5h3M9.5 4.5h4M2.5 11.5h6M12.5 11.5h1" />
      <rect x="5.5" y="3" width="4" height="3" />
      <rect x="8.5" y="10" width="4" height="3" />
    </>
  ),
  /** Bolder ⋮ for toolbars: 2×2 squares on whole pixels (render at size 16). */
  kebab: (
    <>
      <rect x="7" y="2" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="7" y="7" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="7" y="12" width="2" height="2" fill="currentColor" stroke="none" />
    </>
  ),
  more: (
    <>
      <rect x="7.25" y="2.75" width="1.5" height="1.5" fill="currentColor" stroke="none" />
      <rect x="7.25" y="7.25" width="1.5" height="1.5" fill="currentColor" stroke="none" />
      <rect x="7.25" y="11.75" width="1.5" height="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  play: <path d="M5 3.5v9l7-4.5z" fill="currentColor" />,
  pause: <path d="M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z" fill="currentColor" stroke="none" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" stroke="none" />,
  star: <path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z" />,
  starFilled: <path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z" fill="currentColor" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2V11.5M8 4.5v1" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  crown: <path d="M2.5 12.5h11M3 10.5 2 4.5l3.5 3L8 3l2.5 4.5 3.5-3-1 6z" />,
  // objects / panels
  logo: <path d="M8 2 14 8 8 14 2 8z" fill="currentColor" stroke="none" />,
  sessions: <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h11M5 3.5v9" />,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h1M2.5 8h1M2.5 12h1" />,
  folder: <path d="M2 4h4.5l1.5 1.5h6v7H2z" />,
  folderPlus: (
    <>
      <path d="M2.5 4.5h4l1.2 1.5h5.8v7h-11z" />
      <path d="M8 8v3.5M6.25 9.75h3.5" />
    </>
  ),
  // Filer → Move to… / Copy to…: a folder with an arrow / with two sheets going in
  moveTo: (
    <>
      <path d="M2.5 4.5h4l1.2 1.5h5.8v7h-11z" />
      <path d="M5 9.5h5M8 7.5l2 2-2 2" />
    </>
  ),
  copyTo: (
    <>
      <path d="M2.5 4.5h4l1.2 1.5h5.8v7h-11z" />
      <path d="M5.5 9h3v2.5h-3zM7 9V7.75h3v2.5H8.5" />
    </>
  ),
  rename: (
    <>
      <path d="M2.5 13.5h3l7-7-3-3-7 7z" />
      <path d="M8.5 4.5l3 3" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.5h11M6 4.5v-2h4v2M4 4.5l.7 9h6.6l.7-9" />
      <path d="M6.75 7v4.5M9.25 7v4.5" />
    </>
  ),
  home: <path d="M2.5 7.5 8 2.75l5.5 4.75M4 6.5v7h3v-4h2v4h3v-7" />,
  folderFilled: <path d="M2 4h4.5l1.5 1.5h6v7H2z" fill="currentColor" fillOpacity=".25" />,
  file: <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />,
  link: <path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />,
  send: <path d="M2.5 8 13.5 2.5 10.5 13.5 8 9zM8 9l5.5-6.5" />,
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" />
      <path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3.5" />
    </>
  ),
  server: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" />
      <rect x="2.5" y="9" width="11" height="4.5" />
      <path d="M5 4.75h1M5 11.25h1" />
    </>
  ),
  telnet: (
    <>
      <rect x="2" y="3" width="12" height="10" />
      <path d="M5 6.5h6M8 6.5V11" />
    </>
  ),
  tcp: (
    <>
      <rect x="6" y="2" width="4" height="3" />
      <rect x="2" y="11" width="4" height="3" />
      <rect x="10" y="11" width="4" height="3" />
      <path d="M8 5v3M4 11V8h8v3" />
    </>
  ),
  serial: (
    <>
      <path d="M1.5 5h13l-1.75 6h-9.5z" />
      <path d="M5 7.5h.5M7.75 7.5h.5M10.5 7.5h.5M6.25 9h.5M9.25 9h.5" />
    </>
  ),
  proxy: (
    <>
      <rect x="5.5" y="5.5" width="5" height="5" />
      <path d="M1.5 8h4M10.5 8h4M12.5 6l2 2-2 2" />
    </>
  ),
  log: <path d="M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3" />,
  sftp: (
    <>
      <path d="M2 4h4.5l1.5 1.5h6v7H2z" />
      <path d="M6 9.5h4M8.5 8l1.5 1.5L8.5 11" />
    </>
  ),
  layout: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M8 2.5v11M8 8h5.5" />
    </>
  ),
  /** tmux split-window -h / -v: a box split left | right, top / bottom. */
  splitRow: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M8 2.5v11" />
    </>
  ),
  splitColumn: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M2.5 8h11" />
    </>
  ),
  fullscreen: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  /** Corners pointing inwards: leave fullscreen. */
  fullscreenExit: <path d="M6 2.5V6H2.5M10 2.5V6h3.5M13.5 10H10v3.5M6 13.5V10H2.5" />,
  arrowDown: <path d="M8 3v9.5M4 8.5l4 4 4-4" />,
  tunnel: <path d="M2.5 13.5V7a5.5 5.5 0 0 1 11 0v6.5M5.5 13.5V7.5a2.5 2.5 0 0 1 5 0v6" />,
  focus: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3" />
    </>
  ),
  issue: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5v4.2M8 10.8v.8" />
    </>
  ),
  activity: <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />,
  sort: <path d="M4.5 2.5v11M2 11l2.5 2.5L7 11M11.5 13.5v-11M9 5l2.5-2.5L14 5" />,
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  save: (
    <>
      <path d="M2.5 2.5h9l2 2v9h-11z" />
      <path d="M5 2.5v3h5v-3M5 13.5v-4.5h6v4.5" />
    </>
  ),
  unplug: <path d="M2 14l2.5-2.5M14 2l-2.5 2.5M5.5 7.5 4 9a2.1 2.1 0 0 0 3 3l1.5-1.5M10.5 8.5 12 7a2.1 2.1 0 0 0-3-3L7.5 5.5" />,
  bookmark: <path d="M4 2.5h8v11L8 10.5 4 13.5z" />,
  /** Arrow into a terminal window: put a path at the terminal prompt ("Copy path to terminal"). */
  pathToTerminal: (
    <>
      <path d="M6 2h8.5v12H6" />
      <path d="M1 8h8.75M6.25 4.5 9.75 8l-3.5 3.5M11 11.25h1.75" />
    </>
  ),
  /** Map pin: the terminal's current folder ("Terminal folder"). */
  terminalFolder: (
    <>
      <path d="M8 14.5S3.5 9.9 3.5 6.5a4.5 4.5 0 0 1 9 0c0 3.4-4.5 8-4.5 8z" />
      <circle cx="8" cy="6.5" r="1.75" />
    </>
  ),
  /** Map pin over a base: stay on the terminal's folder ("Follow terminal"). */
  follow: (
    <>
      <path d="M8 13.75S4 9.85 4 5.75a4 4 0 0 1 8 0c0 4.1-4 8-4 8z" />
      <circle cx="8" cy="5.75" r="1.6" />
      <path d="M5.25 10.75H3.5a2 2 0 0 0 0 4H7M10.75 10.75h1.75a2 2 0 0 1 0 4H9" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;

type IconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & { name: IconName; size?: number };

export function Icon({ name, size = 14, className = '', ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      className={`icon icon-${name} ${className}`}
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
