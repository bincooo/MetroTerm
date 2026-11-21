import { useEffect, useId, useRef, useState } from 'react';
import { log } from '../lib/log';
import { terminalRegistry } from '../lib/backend';
import { isWindowsHost } from '../lib/hostOs';
import type { TerminalTab } from '../types';
import { Icon } from './Icon';
import { NumberInput } from './NumberInput';
import { Select } from './Select';
import type { TreeSession } from './SessionTree';
import { t } from '../i18n';
import { FILE_DROP_EVENT, shellQuote, type FileDrop } from '../lib/fileDrop';

/**
 * Sender panels that accept text from outside ("Send Selection to Sender"): the first one opened
 * in the window that is shown gets it (panels of the other windows stay mounted, detached).
 */
type SenderSink = { append: (text: string) => void; shown: () => boolean };
const senderInbox: SenderSink[] = [];
const shownSender = () => senderInbox.find(sink => sink.shown());
export const canSendToSender = () => Boolean(shownSender());
export const sendToSender = (text: string) => shownSender()?.append(text);

/** Char mode: the interval is the gap between two typed characters (ms). */
const CHAR_INTERVAL_MIN = 20;

/**
 * Sender panel body. Each Sender panel keeps its own text / target / count / interval.
 * Targets: the current session, all open sessions, or the sessions ticked in the list that
 * appears right of the editor with "Select Session".
 */
export function SenderBody({
  active,
  activeTabId,
  terminalTabs,
  connections,
  tabTitle,
}: {
  active: TreeSession;
  activeTabId: string | null;
  terminalTabs: TerminalTab[];
  connections: TreeSession[];
  /** Name of an open terminal tab (as on its tab). */
  tabTitle: (tab: TerminalTab) => string;
}) {
  const [senderText, setSenderText] = useState('');
  const controlsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sink: SenderSink = {
      append: text => setSenderText(current => (current && !current.endsWith('\n') ? `${current}\n` : current) + text),
      shown: () => Boolean(controlsRef.current?.isConnected),
    };
    senderInbox.push(sink);
    return () => {
      const index = senderInbox.indexOf(sink);
      if (index >= 0) senderInbox.splice(index, 1);
    };
  }, []);
  const [senderTarget, setSenderTarget] = useState<'current' | 'select' | 'all'>('current');
  /** "Select Session": the ticked terminal tabs (ids; closed tabs are ignored when sending). */
  const [picked, setPicked] = useState<string[]>([]);
  const [senderCount, setSenderCount] = useState(1);
  /** Line mode: seconds between repeats. Char mode: milliseconds between characters. */
  const [lineInterval, setLineInterval] = useState(1);
  const [charInterval, setCharInterval] = useState(50);
  const [granularity, setGranularity] = useState<'line' | 'char'>('line');
  const byChar = granularity === 'char';
  const openIds = new Set(terminalTabs.map(tab => tab.id));
  const pickedOpen = picked.filter(id => openIds.has(id));
  const connectionById = new Map(connections.map(item => [item.id, item]));
  const senderGutterRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const windowsTarget = active.transport === 'local' && isWindowsHost();
  const windowsTargetRef = useRef(windowsTarget);
  windowsTargetRef.current = windowsTarget;
  // Files dropped from the file manager (lib/fileDrop): their paths go in at the caret (replacing the
  // selection), shell-quoted and separated by spaces, as in the terminal. The browser gives only names.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const onDrop = (event: Event) => {
      const drop = (event as CustomEvent<FileDrop>).detail;
      const words = (drop.paths.length ? drop.paths : drop.files.map(file => file.name)).map(item =>
        shellQuote(item, windowsTargetRef.current),
      );
      const field = textRef.current;
      if (!words.length || !field) return;
      const inserted = words.join(' ');
      const start = field.selectionStart;
      const end = field.selectionEnd;
      setSenderText(current => current.slice(0, start) + inserted + current.slice(end));
      field.focus();
      requestAnimationFrame(() => field.setSelectionRange(start + inserted.length, start + inserted.length));
    };
    editor.addEventListener(FILE_DROP_EVENT, onDrop);
    return () => editor.removeEventListener(FILE_DROP_EVENT, onDrop);
  }, []);
  const timers = useRef<number[]>([]);
  /** A send with several lines / repeats is still being typed (Stop is enabled). */
  const [running, setRunning] = useState(false);
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), []);
  /** Stop: cancel everything not typed yet (the remaining lines and repeats). */
  const stopSending = () => {
    if (!timers.current.length) return;
    timers.current.forEach(timer => window.clearTimeout(timer));
    timers.current = [];
    setRunning(false);
    log.info(t('Sender · stopped, remaining input cancelled'));
  };
  const radioGroup = useId(); // unique radio names per Sender panel instance
  /** Text → chunks to type. Line: every line + Enter. Char: one character per chunk (a newline is Enter). */
  const payloads = (): string[] => {
    const text = senderText.replace(/\r?\n/g, '\r');
    if (byChar) return Array.from(text);
    const lines = text.split('\r');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map(line => `${line}\r`);
  };
  const sendPreset = () => {
    if (!senderText.length) return;
    const chunks = payloads();
    const targets =
      senderTarget === 'current'
        ? activeTabId
          ? [activeTabId]
          : []
        : senderTarget === 'select'
          ? pickedOpen
          : terminalTabs.map(tab => tab.id);
    if (!targets.length) {
      log.warn(senderTarget === 'select' ? t('Sender · tick the sessions to send to') : t('Sender · no open terminal to send to'));
      return;
    }
    timers.current.forEach(timer => window.clearTimeout(timer));
    timers.current = [];
    const count = Math.max(1, Math.round(senderCount));
    const charGap = Math.max(CHAR_INTERVAL_MIN, charInterval);
    let last = 0;
    for (let round = 0; round < count; round++) {
      chunks.forEach((chunk, index) => {
        // Char: every character one interval after the previous one, repeats follow on.
        // Line: lines are typed with a short gap so interactive programs see them one by one.
        const at = byChar ? (round * chunks.length + index) * charGap : round * lineInterval * 1000 + index * 20;
        last = Math.max(last, at);
        timers.current.push(
          window.setTimeout(() => {
            targets.forEach(tab => terminalRegistry.write(tab, chunk));
          }, at),
        );
      });
    }
    setRunning(true);
    timers.current.push(
      window.setTimeout(() => {
        timers.current = [];
        setRunning(false);
      }, last + 1),
    );
    const bytesTotal = chunks.reduce((sum, chunk) => sum + new TextEncoder().encode(chunk).length, 0);
    const pace = byChar ? t(' · {{charGap}} ms/char', { charGap }) : count > 1 ? t(' @ {{v}}s', { v: lineInterval.toFixed(2) }) : '';
    log.info(
      t('Sent {{bytesTotal}} byte(s) ×{{count}}{{pace}} to {{length}} terminal(s)', { bytesTotal, count, pace, length: targets.length }),
    );
  };
  return (
    <>
      <div className="sender-controls" ref={controlsRef}>
        <button className={`play${running ? ' is-running' : ''}`} title={t('Send (Ctrl+Enter)')} onClick={sendPreset}>
          <Icon name="play" />
        </button>
        <button className="stop" title={t('Stop (Esc)')} disabled={!running} onClick={stopSending}>
          <Icon name="stop" />
        </button>
        <i />
        <span>{t('By:')}</span>
        <label>
          <input type="radio" checked={granularity === 'line'} onChange={() => setGranularity('line')} name={`${radioGroup}-granularity`} />{' '}
          {t('Line')}
        </label>
        <label>
          <input type="radio" checked={granularity === 'char'} onChange={() => setGranularity('char')} name={`${radioGroup}-granularity`} />{' '}
          {t('Char')}
        </label>
        <span>{t('Count:')}</span>
        <NumberInput
          className="sender-count"
          ariaLabel="Repeat count"
          value={senderCount}
          onChange={setSenderCount}
          min={1}
          max={9999}
          step={1}
        />
        <span className="sender-interval-label">{t('Interval:')}</span>
        {byChar ? (
          <NumberInput
            key="char"
            className="sender-interval"
            ariaLabel="Interval between characters in milliseconds"
            value={charInterval}
            onChange={setCharInterval}
            min={CHAR_INTERVAL_MIN}
            max={60000}
            step={10}
            suffix="ms"
          />
        ) : (
          <NumberInput
            key="line"
            className="sender-interval"
            ariaLabel="Interval in seconds"
            value={lineInterval}
            onChange={setLineInterval}
            min={0}
            max={3600}
            step={0.1}
            precision={2}
            suffix="s"
          />
        )}
        <span>{t('Targets:')}</span>
        <Select
          className="sender-target"
          ariaLabel="Send targets"
          value={senderTarget}
          onChange={value => setSenderTarget(value as typeof senderTarget)}
          options={[
            { value: 'current', label: t('Current Session'), hint: active.name },
            { value: 'select', label: t('Select Session'), hint: t('{{count}} selected', { count: pickedOpen.length }) },
            { value: 'all', label: t('All Sessions'), hint: t('{{count}} open', { count: terminalTabs.length }) },
          ]}
        />
      </div>
      <div
        className={`sender-editor${senderTarget === 'select' ? ' has-targets' : ''}`}
        ref={editorRef}
        data-file-drop="sender"
        data-file-drop-label={t('Drop to insert the path')}
      >
        <div className="sender-gutter" ref={senderGutterRef} aria-hidden="true">
          {senderText.split('\n').map((_, index) => (
            <span key={index}>{index + 1}</span>
          ))}
        </div>
        <textarea
          ref={textRef}
          onScroll={event => {
            if (senderGutterRef.current) senderGutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }}
          wrap="off"
          value={senderText}
          onChange={event => setSenderText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendPreset();
            else if (event.key === 'Escape' && running) {
              event.preventDefault();
              stopSending();
            }
          }}
        />
        {senderTarget === 'select' && (
          <div className="sender-targets" role="group" aria-label={t('Sessions to send to')}>
            <label className="sender-targets-head">
              <input
                type="checkbox"
                checked={terminalTabs.length > 0 && pickedOpen.length === terminalTabs.length}
                ref={box => {
                  if (box) box.indeterminate = pickedOpen.length > 0 && pickedOpen.length < terminalTabs.length;
                }}
                disabled={!terminalTabs.length}
                onChange={event => setPicked(event.target.checked ? terminalTabs.map(tab => tab.id) : [])}
              />
              <span>{t('Open sessions')}</span>
              <em>
                {pickedOpen.length}/{terminalTabs.length}
              </em>
            </label>
            <div className="sender-targets-list">
              {terminalTabs.length ? (
                terminalTabs.map(tab => {
                  const status = connectionById.get(tab.connectionId)?.status;
                  return (
                    <label key={tab.id} className={tab.id === activeTabId ? 'is-current' : undefined}>
                      <input
                        type="checkbox"
                        checked={pickedOpen.includes(tab.id)}
                        onChange={event =>
                          setPicked(current =>
                            event.target.checked ? [...current.filter(id => openIds.has(id)), tab.id] : current.filter(id => id !== tab.id),
                          )
                        }
                      />
                      <em className={`open-tab-status ${status ?? ''}`} />
                      <span>{tabTitle(tab)}</span>
                    </label>
                  );
                })
              ) : (
                <p>{t('No open sessions')}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
