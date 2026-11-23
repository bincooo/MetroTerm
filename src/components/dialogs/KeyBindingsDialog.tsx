import { useState, type KeyboardEvent } from 'react';
import {
  DEFAULT_KEY_BINDINGS,
  FIXED_BINDINGS,
  KEY_ACTIONS,
  bindingOf,
  conflictOf,
  formatKeys,
  isBindable,
  takesShellKey,
  type KeyAction,
  type KeyBindings,
} from '../../lib/settings/keybindings';
import { DialogFrame } from '../common/DialogFrame';
import { Icon } from '../common/Icon';
import { t } from '../../i18n';

type Status = { text: string; error?: boolean; reassign?: { action: KeyAction; from: KeyAction; keys: string } };

const GROUPS = [
  { group: 'app', title: 'APPLICATION' },
  { group: 'terminal', title: 'TERMINAL (IN A FOCUSED TERMINAL)' },
] as const;

/**
 * Session → Preferences → Keyboard Shortcuts…: click a shortcut, press the new keys. A combination
 * that another action (or a fixed shortcut) already uses is refused — with REASSIGN to move it here.
 * Saved in settings.json → `keys` (only what differs from the defaults).
 */
export function KeyBindingsDialog({
  value,
  onClose,
  onSave,
}: {
  value: KeyBindings;
  onClose: () => void;
  onSave: (value: KeyBindings) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const labelOf = (action: KeyAction) => t(KEY_ACTIONS.find(item => item.id === action)?.label ?? action);

  const record = (action: KeyAction, event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation(); // Esc cancels the recording, not the dialog
    if (event.key === 'Escape') {
      setRecording(null);
      setStatus(null);
      return;
    }
    const binding = bindingOf(event.nativeEvent);
    if (!binding) return; // a modifier on its own: wait for the key
    const keys = formatKeys(binding);
    if (!isBindable(binding)) {
      setStatus({ text: t('{{keys}} cannot be a shortcut — hold Ctrl or Alt with it, or use a function key.', { keys }), error: true });
      return;
    }
    setRecording(null);
    const conflict = conflictOf(draft, action, binding);
    if (conflict?.action === null) {
      setStatus({
        text: t('{{keys}} is already used by “{{label}}”, which cannot be changed.', { keys, label: t(conflict.label) }),
        error: true,
      });
      return;
    }
    if (conflict) {
      setStatus({
        text: t('{{keys}} is already used by “{{label}}”.', { keys, label: t(conflict.label) }),
        error: true,
        reassign: { action, from: conflict.action, keys: binding },
      });
      return;
    }
    setDraft(current => ({ ...current, [action]: binding }));
    setStatus(
      takesShellKey(binding) ? { text: t('{{keys}} no longer reaches the shell in a terminal (e.g. a readline key).', { keys }) } : null,
    );
  };

  const changed = KEY_ACTIONS.some(item => draft[item.id] !== DEFAULT_KEY_BINDINGS[item.id]);

  return (
    <DialogFrame
      kicker={t('PREFERENCES')}
      title={t('KEYBOARD SHORTCUTS')}
      className="focus-dialog keys-dialog"
      onClose={onClose}
      onSubmit={() => onSave(draft)}
    >
      {GROUPS.map(({ group, title }) => (
        <div key={group}>
          <div className="focus-section">{t(title)}</div>
          <div className="focus-group">
            {KEY_ACTIONS.filter(item => item.group === group).map(item => {
              const keys = draft[item.id];
              const isRecording = recording === item.id;
              return (
                <div key={item.id} className="focus-row keys-row" data-action={item.id}>
                  <span className="focus-label">{t(item.label)}</span>
                  <button
                    type="button"
                    className={`key-capture${isRecording ? ' is-recording' : ''}${keys ? '' : ' is-empty'}`}
                    aria-label={t('Shortcut for {{label}}', { label: t(item.label) })}
                    onClick={event => {
                      event.currentTarget.focus(); // WebKit doesn't focus a clicked button: the keys must reach it
                      setRecording(item.id);
                      setStatus({ text: t('Press the new shortcut for “{{label}}” (Esc cancels).', { label: t(item.label) }) });
                    }}
                    onKeyDown={isRecording ? event => record(item.id, event) : undefined}
                    onBlur={() => isRecording && setRecording(null)}
                  >
                    {isRecording ? t('Press keys…') : keys ? formatKeys(keys) : t('None')}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title={t('Reset to {{keys}}', { keys: formatKeys(item.keys) })}
                    aria-label={t('Reset to {{keys}}', { keys: formatKeys(item.keys) })}
                    disabled={keys === item.keys}
                    onClick={() => {
                      const conflict = conflictOf(draft, item.id, item.keys);
                      if (conflict?.action) {
                        setStatus({
                          text: t('{{keys}} is already used by “{{label}}”.', { keys: formatKeys(item.keys), label: t(conflict.label) }),
                          error: true,
                          reassign: { action: item.id, from: conflict.action, keys: item.keys },
                        });
                        return;
                      }
                      setDraft(current => ({ ...current, [item.id]: item.keys }));
                      setStatus(null);
                    }}
                  >
                    <Icon name="refresh" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title={t('Remove shortcut')}
                    aria-label={t('Remove shortcut')}
                    disabled={!keys}
                    onClick={() => {
                      setDraft(current => ({ ...current, [item.id]: '' }));
                      setStatus(null);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="focus-section">{t('FIXED')}</div>
      <div className="focus-group">
        {FIXED_BINDINGS.map(item => (
          <div key={item.keys} className="focus-row keys-row is-fixed">
            <span className="focus-label">{t(item.label)}</span>
            <kbd className="key-fixed">{item.keys}</kbd>
          </div>
        ))}
        <div className="focus-row keys-row is-fixed">
          <span className="focus-label">{t('tmux commands (after the prefix)')}</span>
          <kbd className="key-fixed">% &quot; ! z x o ; {'{ }'} c n p & , 0–9 ←↑→↓</kbd>
        </div>
      </div>
      {/* Message and buttons stay in view while the list scrolls: a refused shortcut is always seen. */}
      <div className="keys-foot">
        <p className={`dialog-note${status?.error ? ' is-error' : ''}`}>
          {status?.text ?? t('Click a shortcut and press the new keys. A shortcut that is already in use is refused.')}
          {status?.reassign && (
            <button
              type="button"
              className="secondary-button keys-reassign"
              onClick={() => {
                const { action, from, keys } = status.reassign!;
                setDraft(current => ({ ...current, [from]: '', [action]: keys }));
                setStatus({
                  text: t('{{keys}} moved from “{{from}}” to “{{to}}”.', {
                    keys: formatKeys(keys),
                    from: labelOf(from),
                    to: labelOf(action),
                  }),
                });
              }}
            >
              {t('REASSIGN')}
            </button>
          )}
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="keys-reset-all"
            disabled={!changed}
            onClick={() => {
              setDraft({ ...DEFAULT_KEY_BINDINGS });
              setStatus(null);
            }}
          >
            {t('RESET ALL')}
          </button>
          <button type="button" onClick={onClose}>
            {t('CANCEL')}
          </button>
          <button className="primary-button" type="submit">
            {t('SAVE')} <Icon name="arrowRight" />
          </button>
        </div>
      </div>
    </DialogFrame>
  );
}
