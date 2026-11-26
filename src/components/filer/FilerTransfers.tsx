import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../common/Icon';
import { t } from '../../i18n';
import { errorText } from '../../lib/platform/log';

/**
 * Filer transfers (upload, download, copy, move) as batches: every file of a multi-file upload is
 * listed with its own progress, the batch has an overall bar, and when it ends the panel stays as
 * the result notice — a success notice closes by itself after a few seconds, failures stay with the
 * reason of each failed file and a Retry button. Files run one after another; Cancel skips the files
 * still waiting (the running one finishes).
 */
type TransferDirection = 'upload' | 'download' | 'copy' | 'move';
type TransferJob = {
  name: string;
  size: number | null;
  /** Does the work; `transferId` goes to the backend so its progress events reach this item. */
  run: (transferId: string) => Promise<void>;
};
type ItemState = 'queued' | 'running' | 'done' | 'error' | 'skipped';
type TransferItem = TransferJob & { id: string; done: number; total: number | null; state: ItemState; message?: string };
type TransferBatch = {
  id: string;
  direction: TransferDirection;
  /** Where the files go (shown under the title). */
  folder: string;
  items: TransferItem[];
  state: 'running' | 'done';
  open: boolean;
};
type BatchResult = { done: number; failed: number; skipped: number };

const SUCCESS_TTL = 4000;
let sequence = 0;
const nextId = (kind: string) => `${kind}-${Date.now().toString(36)}-${++sequence}`;

export function useTransfers() {
  const [batches, setBatches] = useState<TransferBatch[]>([]);
  const latest = useRef(batches);
  useEffect(() => {
    latest.current = batches;
  }, [batches]);
  const cancelled = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(timer => window.clearTimeout(timer));
  }, []);

  const patchItem = useCallback((batchId: string, itemId: string, patch: Partial<TransferItem>) => {
    setBatches(current =>
      current.map(batch =>
        batch.id === batchId ? { ...batch, items: batch.items.map(item => (item.id === itemId ? { ...item, ...patch } : item)) } : batch,
      ),
    );
  }, []);

  const dismiss = useCallback((batchId: string) => {
    window.clearTimeout(timers.current.get(batchId));
    timers.current.delete(batchId);
    setBatches(current => current.filter(batch => batch.id !== batchId));
  }, []);

  /** Runs the items of a batch that are queued, in order. */
  const drain = useCallback(
    async (batchId: string, items: TransferItem[], stopOnError: boolean): Promise<BatchResult> => {
      const result: BatchResult = { done: 0, failed: 0, skipped: 0 };
      let stop = false;
      for (const item of items) {
        if (stop || cancelled.current.has(batchId)) {
          patchItem(batchId, item.id, { state: 'skipped' });
          result.skipped++;
          continue;
        }
        patchItem(batchId, item.id, { state: 'running', done: 0, message: undefined });
        try {
          await item.run(item.id);
          setBatches(current =>
            current.map(batch =>
              batch.id === batchId
                ? {
                    ...batch,
                    items: batch.items.map(entry =>
                      entry.id === item.id ? { ...entry, state: 'done', done: entry.total ?? entry.size ?? entry.done } : entry,
                    ),
                  }
                : batch,
            ),
          );
          result.done++;
        } catch (reason) {
          patchItem(batchId, item.id, { state: 'error', message: errorText(reason) });
          result.failed++;
          if (stopOnError) stop = true;
        }
      }
      cancelled.current.delete(batchId);
      setBatches(current => current.map(batch => (batch.id === batchId ? { ...batch, state: 'done' } : batch)));
      if (!result.failed && !result.skipped)
        timers.current.set(
          batchId,
          window.setTimeout(() => dismiss(batchId), SUCCESS_TTL),
        );
      return result;
    },
    [dismiss, patchItem],
  );

  /** Start a batch; resolves when every file has been tried (or skipped). */
  const run = useCallback(
    (direction: TransferDirection, folder: string, jobs: TransferJob[], options: { stopOnError?: boolean } = {}) => {
      const id = nextId('batch');
      const items: TransferItem[] = jobs.map(job => ({ ...job, id: nextId('transfer'), done: 0, total: job.size, state: 'queued' }));
      setBatches(current => [
        ...current.filter(batch => batch.state === 'running' || batch.items.some(item => item.state === 'error')).slice(-3),
        { id, direction, folder, items, state: 'running', open: items.length > 1 },
      ]);
      return drain(id, items, options.stopOnError ?? false);
    },
    [drain],
  );

  /** A `transfer.progress` event from the backend. */
  const progress = useCallback((transferId: string, done: number, total: number | null | undefined) => {
    setBatches(current => {
      let hit = false;
      const next = current.map(batch => {
        if (batch.state !== 'running' || !batch.items.some(item => item.id === transferId)) return batch;
        hit = true;
        return {
          ...batch,
          items: batch.items.map(item => (item.id === transferId ? { ...item, done, total: total ?? item.total } : item)),
        };
      });
      return hit ? next : current;
    });
  }, []);

  const cancel = useCallback((batchId: string) => {
    cancelled.current.add(batchId);
    setBatches(current => [...current]); // repaint: the Cancel button turns into "Cancelling…"
  }, []);

  /** Run the failed and skipped files of a finished batch again (same batch, same notice). */
  const retry = useCallback(
    (batchId: string) => {
      const batch = latest.current.find(entry => entry.id === batchId);
      if (!batch || batch.state === 'running') return Promise.resolve<BatchResult>({ done: 0, failed: 0, skipped: 0 });
      const again = batch.items.filter(item => item.state === 'error' || item.state === 'skipped');
      const ids = new Set(again.map(item => item.id));
      window.clearTimeout(timers.current.get(batchId));
      setBatches(current =>
        current.map(entry =>
          entry.id === batchId
            ? {
                ...entry,
                state: 'running',
                items: entry.items.map(item => (ids.has(item.id) ? { ...item, state: 'queued', done: 0, message: undefined } : item)),
              }
            : entry,
        ),
      );
      return drain(batchId, again, batch.direction === 'move' || batch.direction === 'copy');
    },
    [drain],
  );

  const toggle = useCallback((batchId: string) => {
    setBatches(current => current.map(batch => (batch.id === batchId ? { ...batch, open: !batch.open } : batch)));
  }, []);

  return { batches, run, progress, cancel, retry, dismiss, toggle, isCancelling: (id: string) => cancelled.current.has(id) };
}

const RUNNING: Record<TransferDirection, string> = {
  upload: 'Uploading {{current}} of {{count}}',
  download: 'Downloading {{current}} of {{count}}',
  copy: 'Copying {{current}} of {{count}}',
  move: 'Moving {{current}} of {{count}}',
};
const DONE_ONE: Record<TransferDirection, string> = {
  upload: '{{name}} uploaded',
  download: '{{name}} downloaded',
  copy: '{{name}} copied',
  move: '{{name}} moved',
};
const DONE_MANY: Record<TransferDirection, string> = {
  upload: '{{count}} files uploaded',
  download: '{{count}} files downloaded',
  copy: '{{count}} items copied',
  move: '{{count}} items moved',
};
const FAILED: Record<TransferDirection, string> = {
  upload: 'Upload failed',
  download: 'Download failed',
  copy: 'Copy failed',
  move: 'Move failed',
};

function title(batch: TransferBatch, counts: Record<ItemState, number>) {
  const count = batch.items.length;
  const finished = counts.done + counts.error + counts.skipped;
  if (batch.state === 'running') return t(RUNNING[batch.direction], { current: Math.min(count, finished + 1), count });
  if (counts.error || counts.skipped) {
    const head = count === 1 ? `${t(FAILED[batch.direction])} · ${batch.items[0].name}` : t(FAILED[batch.direction]);
    if (count === 1) return head;
    const parts = [t('{{count}} done', { count: counts.done })];
    if (counts.error) parts.push(t('{{count}} failed', { count: counts.error }));
    if (counts.skipped) parts.push(t('{{count}} cancelled', { count: counts.skipped }));
    return `${head} · ${parts.join(' · ')}`;
  }
  return count === 1 ? t(DONE_ONE[batch.direction], { name: batch.items[0].name }) : t(DONE_MANY[batch.direction], { count });
}

export function TransferPanel({
  batches,
  bytes,
  onCancel,
  onRetry,
  onDismiss,
  onToggle,
  isCancelling,
}: {
  batches: TransferBatch[];
  bytes: (value: number) => string;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDismiss: (id: string) => void;
  onToggle: (id: string) => void;
  isCancelling: (id: string) => boolean;
}) {
  // Always mounted (hidden while empty) so a dismissed notice can play its leave animation in place.
  return (
    <div className="filer-transfers">
      {batches.map(batch => {
        const counts: Record<ItemState, number> = { queued: 0, running: 0, done: 0, error: 0, skipped: 0 };
        let doneBytes = 0;
        let totalBytes = 0;
        let sized = true;
        for (const item of batch.items) {
          counts[item.state]++;
          if (item.total === null) sized = false;
          else {
            totalBytes += item.total;
            doneBytes += item.state === 'done' ? item.total : Math.min(item.done, item.total);
          }
        }
        const count = batch.items.length;
        const finished = counts.done + counts.error + counts.skipped;
        const running = batch.state === 'running';
        // Bytes when every size is known, otherwise files (plus the running file's share when known).
        const share = (() => {
          if (sized && totalBytes > 0) return doneBytes / totalBytes;
          const current = batch.items.find(item => item.state === 'running');
          const part = current?.total ? Math.min(1, current.done / current.total) : 0;
          return count ? (finished + part) / count : 1;
        })();
        const tone = running ? '' : counts.error ? ' is-error' : counts.skipped ? ' is-warning' : ' is-done';
        const icon =
          batch.direction === 'download'
            ? 'download'
            : batch.direction === 'upload'
              ? 'upload'
              : batch.direction === 'move'
                ? 'moveTo'
                : 'copyTo';
        return (
          <section key={batch.id} className={`filer-transfer${tone}`} role={running ? 'status' : counts.error ? 'alert' : 'status'}>
            <header>
              <button
                type="button"
                className="filer-transfer-title"
                aria-expanded={batch.open}
                disabled={count < 2}
                onClick={() => onToggle(batch.id)}
                title={batch.folder}
              >
                <i className="filer-transfer-icon" aria-hidden="true">
                  {running ? <Icon name={icon} size={12} /> : counts.error || counts.skipped ? '✕' : '✓'}
                </i>
                <span>{title(batch, counts)}</span>
                {count > 1 ? <Icon name={batch.open ? 'chevronDown' : 'chevronRight'} size={10} /> : null}
              </button>
              <small>
                {sized && totalBytes ? `${bytes(doneBytes)} / ${bytes(totalBytes)}` : running ? `${Math.round(share * 100)}%` : ''}
              </small>
              {running ? (
                <button
                  type="button"
                  className="filer-transfer-action"
                  disabled={isCancelling(batch.id) || counts.queued === 0}
                  onClick={() => onCancel(batch.id)}
                >
                  {isCancelling(batch.id) ? t('Cancelling…') : t('Cancel')}
                </button>
              ) : counts.error || counts.skipped ? (
                <button type="button" className="filer-transfer-action" onClick={() => onRetry(batch.id)}>
                  {t('Retry')}
                </button>
              ) : null}
              {running ? null : (
                <button
                  type="button"
                  className="filer-transfer-close"
                  aria-label={t('Dismiss')}
                  title={t('Dismiss')}
                  onClick={() => onDismiss(batch.id)}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </header>
            <div className="filer-transfer-bar" aria-hidden="true">
              <i style={{ width: `${Math.round(Math.min(1, share) * 1000) / 10}%` }} />
            </div>
            {batch.open && count > 1 ? (
              <ul className="filer-transfer-list">
                {batch.items.map(item => (
                  <li key={item.id} className={`is-${item.state}`} title={item.message ? `${item.name} · ${item.message}` : item.name}>
                    <i aria-hidden="true">{{ queued: '·', running: '', done: '✓', error: '✕', skipped: '–' }[item.state]}</i>
                    <span>{item.name}</span>
                    <small>
                      {item.state === 'running'
                        ? item.total
                          ? `${Math.min(100, Math.round((item.done / item.total) * 100))}%`
                          : bytes(item.done)
                        : item.state === 'error'
                          ? item.message
                          : item.state === 'queued'
                            ? t('Waiting')
                            : item.state === 'skipped'
                              ? t('Cancelled')
                              : item.total !== null
                                ? bytes(item.total)
                                : ''}
                    </small>
                    {item.state === 'running' && item.total ? (
                      <b className="filer-transfer-item-bar" style={{ width: `${Math.min(100, (item.done / item.total) * 100)}%` }} />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : count === 1 && batch.items[0].state === 'error' ? (
              <p className="filer-transfer-reason">{batch.items[0].message}</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
