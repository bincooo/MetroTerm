import { useEffect, useRef, useState } from 'react';
import { log } from '../../lib/platform/log';
import type { Connection } from '../../types';
import { backend, toSpec } from '../../lib/platform/backend';
import { isWindowsHost } from '../../lib/platform/hostOs';
import { transportName } from '../../lib/sessions/transports';
import { Icon } from '../common/Icon';
import { Select } from '../common/Select';
import { MonitorProcesses, readMonitorDoc, saveMonitorDoc, type MonitorProcess, type StopSignal } from './MonitorProcesses';
import { t } from '../../i18n';
import { formatBytes } from '../../lib/format';

/** One `monitor.sample` answer (src-rust/src/monitor.rs). Rates are null on the first sample of a host. */
type MonitorSnapshot = {
  host: string;
  os: string;
  kernel: string;
  uptime: number;
  load: [number, number, number] | null;
  cpu: number | null;
  cores: number[];
  coreCount: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  rxRate: number | null;
  txRate: number | null;
  rxTotal: number;
  txTotal: number;
  readRate: number | null;
  writeRate: number | null;
  disks: { mount: string; fs: string; total: number; used: number }[];
  /** Every process of the host, busiest first. */
  processes: MonitorProcess[];
  processCount: number;
};

/** Points kept for the history graphs (2 minutes at the default interval). */
const HISTORY = 60;
const INTERVALS = [1, 2, 5, 10];
/**
 * The first sample of a host has no rates (CPU %, network, disk I/O, process CPU): it is not shown, the
 * second one follows after this long. The panel then opens complete instead of filling in and moving its
 * rows down (the Disk I/O line, the core bars) a sample later.
 */
const PRIME_DELAY = 400;

type History = { cpu: number[]; mem: number[]; rx: number[]; tx: number[] };
const emptyHistory = (): History => ({ cpu: [], mem: [], rx: [], tx: [] });
const push = (list: number[], value: number) => [...list, value].slice(-HISTORY);

const rate = (value: number | null) => (value === null ? '—' : `${formatBytes(value)}/s`);
const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(value >= 99.95 ? 0 : 1)}%`);
function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days
    ? t('{{days}}d {{hours}}h {{minutes}}m', { days, hours, minutes })
    : hours
      ? t('{{hours}}h {{minutes}}m', { hours, minutes })
      : `${minutes}m`;
}

function Meter({ value, warn = 85 }: { value: number | null; warn?: number }) {
  const width = Math.max(0, Math.min(100, value ?? 0));
  return (
    <span className={`monitor-meter${value !== null && value >= warn ? ' hot' : ''}`}>
      <i style={{ width: `${width}%` }} />
    </span>
  );
}

/** History graph; `max` fixes the scale (percent graphs), else it follows the largest point. */
function Spark({ series, max, className }: { series: number[][]; max?: number; className?: string }) {
  const top = max ?? Math.max(1, ...series.flat());
  const line = (values: number[]) =>
    values.map((value, index) => `${((HISTORY - values.length + index) / (HISTORY - 1)) * 100},${30 - (value / top) * 28}`).join(' ');
  return (
    <svg className={`monitor-spark ${className ?? ''}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      {series.map((values, index) =>
        values.length > 1 ? <polyline key={index} className={`s${index}`} points={line(values)} vectorEffect="non-scaling-stroke" /> : null,
      )}
    </svg>
  );
}

type MonitorPanelProps = {
  /** Session of the active terminal tab: the Monitor follows it like the Filer does. */
  connection: Connection;
  /** Status bar message. */
};

export function MonitorPanel({ connection }: MonitorPanelProps) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(emptyHistory);
  const [interval, setIntervalSeconds] = useState(() => {
    const saved = readMonitorDoc().interval;
    return typeof saved === 'number' && INTERVALS.includes(saved) ? saved : 2;
  });
  /** Ctrl+F in the panel: the process list opens its search box. */
  const [searchRequest, setSearchRequest] = useState(0);
  /** Bumped to sample at once (after stopping a process). */
  const [refresh, setRefresh] = useState(0);
  const [paused, setPaused] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  /** Result of a failed Stop / Kill, shown for a while (samples don't clear it). */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const root = useRef<HTMLDivElement>(null);
  const supported = connection.transport === 'local' || connection.transport === 'ssh';
  // SSH: the Monitor uses the session's live connection and never connects (or asks for a password) itself.
  const live = connection.transport === 'local' || connection.status === 'online';
  const spec = JSON.stringify(toSpec(connection));

  // Another session: start over (rates and graphs belong to one host). Adjusted while rendering, not
  // in an effect, so the new session never shows a frame with the old host's numbers
  // (rerender-derived-state-no-effect).
  const [shownId, setShownId] = useState(connection.id);
  if (shownId !== connection.id) {
    setShownId(connection.id);
    setSnapshot(null);
    setError(null);
    setHistory(emptyHistory());
    setUpdated(null);
  }

  useEffect(() => {
    if (!supported || !live || paused) return;
    let stopped = false;
    let timer: number | undefined;
    let primed = false;
    const tick = async () => {
      // Hidden tab, hidden panel or minimised window: no sampling (nothing runs on the host meanwhile).
      const visible = !document.hidden && root.current?.offsetParent !== null;
      if (visible) {
        try {
          const next = await backend.call<MonitorSnapshot>('monitor.sample', { connection: JSON.parse(spec) });
          if (stopped) return;
          if (next.cpu === null && !primed) {
            primed = true;
            timer = window.setTimeout(tick, PRIME_DELAY);
            return;
          }
          primed = true;
          setSnapshot(next);
          setError(null);
          setUpdated(new Date());
          setHistory(current => ({
            cpu: next.cpu === null ? current.cpu : push(current.cpu, next.cpu),
            mem: next.memTotal ? push(current.mem, (next.memUsed / next.memTotal) * 100) : current.mem,
            rx: next.rxRate === null ? current.rx : push(current.rx, next.rxRate),
            tx: next.txRate === null ? current.tx : push(current.tx, next.txRate),
          }));
        } catch (reason) {
          if (stopped) return;
          setError(String(reason));
        }
      }
      if (!stopped) timer = window.setTimeout(tick, visible ? interval * 1000 : 500);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [spec, supported, live, paused, interval, refresh]);

  const where =
    connection.transport === 'local' ? t('this computer') : `${connection.username ? `${connection.username}@` : ''}${connection.host}`;
  const windows = connection.transport === 'local' && isWindowsHost();
  /** Stop / Kill from the process list (already confirmed there). */
  const signal = async (process: MonitorProcess, kind: StopSignal) => {
    const verb = kind === 'TERM' ? t('Stopped') : t('Killed');
    try {
      await backend.call('monitor.signal', { connection: JSON.parse(spec), pid: process.pid, signal: kind });
      log.info(t('{{verb}} {{name}} (PID {{pid}}) on {{name2}}', { verb, name: process.name, pid: process.pid, name2: connection.name }));
      setNotice(null);
    } catch (reason) {
      const message = String(reason).replace(/^Error: /, '');
      log.error(message);
      setNotice(message);
    }
    // Sample again so the list shows the result (an exiting process may take a moment).
    window.setTimeout(() => setRefresh(value => value + 1), 300);
  };

  const toolbar = (
    <div className="monitor-toolbar">
      <span className="monitor-target" title={`Monitoring the session of the active terminal tab\t${connection.name}`}>
        {connection.name}
        {snapshot?.host ? <em>{snapshot.host}</em> : null}
      </span>
      <Select
        className="monitor-interval"
        ariaLabel="Refresh interval"
        value={String(interval)}
        onChange={value => {
          setIntervalSeconds(Number(value));
          saveMonitorDoc({ interval: Number(value) });
        }}
        options={INTERVALS.map(value => ({ value: String(value), label: t('{{value}} s', { value }) }))}
      />
      <button
        onClick={() => setPaused(value => !value)}
        title={paused ? t('Resume') : t('Pause')}
        disabled={!supported || !live}
        className={paused ? 'on' : ''}
      >
        <Icon name={paused ? 'play' : 'pause'} />
      </button>
    </div>
  );

  if (!supported || !live)
    return (
      <div className="monitor" ref={root}>
        {toolbar}
        {/* Not connected yet: often only for a moment at start, so the text fades in a little later (.is-pending). */}
        <div className={supported ? 'panel-empty is-pending' : 'panel-empty'}>
          <span>
            {!supported
              ? t('{{name}} is a {{v}} session — nothing to monitor. The Monitor works with local and SSH sessions.', {
                  name: connection.name,
                  v: transportName(connection.transport),
                })
              : t('{{name}} is not connected. Open or reconnect a terminal of this session to monitor its host.', {
                  name: connection.name,
                })}
          </span>
        </div>
      </div>
    );

  if (!snapshot)
    return (
      <div className="monitor" ref={root}>
        {toolbar}
        <div className={error || paused ? 'panel-empty' : 'panel-empty is-pending'}>
          <span>
            {error ? t('Monitor: {{error}}', { error }) : paused ? t('Paused') : t('Reading {{name}}…', { name: connection.name })}
          </span>
        </div>
      </div>
    );

  const s = snapshot;
  const memPercent = s.memTotal ? (s.memUsed / s.memTotal) * 100 : null;
  const swapPercent = s.swapTotal ? (s.swapUsed / s.swapTotal) * 100 : null;
  const info = [
    ['Host', s.host],
    ['System', s.os],
    ['Kernel', s.kernel],
    ['Uptime', formatUptime(s.uptime)],
    ['Updated', updated ? updated.toLocaleTimeString() : '—'],
  ]
    .map(([label, value]) => `${label}\t${value || '—'}`)
    .join('\n');

  return (
    <div
      className="monitor"
      ref={root}
      // Focusable, so Ctrl+F reaches the panel after a click anywhere in it (not only in the list).
      tabIndex={-1}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          event.stopPropagation();
          setSearchRequest(value => value + 1);
        }
      }}
    >
      {toolbar}
      {error || notice ? (
        <div className="monitor-error" onClick={() => setNotice(null)} title={notice ? t('Click to dismiss') : undefined}>
          {notice ?? error}
        </div>
      ) : null}
      <div className="monitor-body" data-scrollbar>
        <div className="monitor-info" title={info}>
          <span>{s.os || s.kernel}</span>
          <span>{t('up {{time}}', { time: formatUptime(s.uptime) })}</span>
          {s.load ? <span>{t('load {{load}}', { load: s.load.map(value => value.toFixed(2)).join(' ') })}</span> : null}
          <span>{t('{{count}} proc', { count: s.processCount })}</span>
        </div>

        <section>
          <header>
            <b>{t('CPU')}</b>
            <span>{t('{{count}} cores', { count: s.coreCount })}</span>
            <strong>{percent(s.cpu)}</strong>
          </header>
          <Meter value={s.cpu} />
          <Spark series={[history.cpu]} max={100} className="cpu" />
          {s.cores.length > 1 ? (
            <div className="monitor-cores">
              {s.cores.map((value, index) => (
                <span key={index} title={`Core ${index}\t${percent(value)}`}>
                  <i style={{ height: `${Math.max(2, Math.min(100, value))}%` }} className={value >= 85 ? 'hot' : ''} />
                </span>
              ))}
            </div>
          ) : null}
        </section>

        <section className="mem">
          <header>
            <b>{t('Memory')}</b>
            <span>
              {formatBytes(s.memUsed)} / {formatBytes(s.memTotal)}
            </span>
            <strong>{percent(memPercent)}</strong>
          </header>
          <Meter value={memPercent} warn={90} />
          <Spark series={[history.mem]} max={100} className="mem" />
          <header className="sub">
            <b>{t('Swap')}</b>
            <span>{s.swapTotal ? `${formatBytes(s.swapUsed)} / ${formatBytes(s.swapTotal)}` : 'none'}</span>
            <strong>{percent(swapPercent)}</strong>
          </header>
          {s.swapTotal ? <Meter value={swapPercent} warn={50} /> : null}
        </section>

        <section>
          <header>
            <b>{t('Network')}</b>
            <span title={`Received since boot\t${formatBytes(s.rxTotal)}\nSent since boot\t${formatBytes(s.txTotal)}`}>
              <i className="rx">↓ {rate(s.rxRate)}</i> <i className="tx">↑ {rate(s.txRate)}</i>
            </span>
          </header>
          <Spark series={[history.rx, history.tx]} className="net" />
          {s.readRate !== null || s.writeRate !== null ? (
            <header className="sub">
              <b>{t('Disk I/O')}</b>
              <span>
                <i className="rx">R {rate(s.readRate)}</i> <i className="tx">W {rate(s.writeRate)}</i>
              </span>
            </header>
          ) : null}
        </section>

        {s.disks.length ? (
          <section>
            <header>
              <b>{t('Disks')}</b>
            </header>
            {s.disks.map(disk => {
              const used = disk.total ? (disk.used / disk.total) * 100 : 0;
              return (
                <div
                  className="monitor-disk"
                  key={disk.mount}
                  title={`Mount\t${disk.mount}\nDevice\t${disk.fs}\nUsed\t${formatBytes(disk.used)}\nFree\t${formatBytes(Math.max(0, disk.total - disk.used))}\nSize\t${formatBytes(disk.total)}`}
                >
                  <span>{disk.mount}</span>
                  <Meter value={used} warn={90} />
                  <em>
                    {formatBytes(disk.used, 0)} / {formatBytes(disk.total, 0)}
                  </em>
                </div>
              );
            })}
          </section>
        ) : null}

        <MonitorProcesses
          processes={s.processes}
          total={Math.max(s.processCount, s.processes.length)}
          where={where}
          windows={windows}
          onSignal={signal}
          searchRequest={searchRequest}
        />
      </div>
    </div>
  );
}
