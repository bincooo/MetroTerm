import { useEffect, useRef, useState } from 'react';
import { DialogFrame, DialogActions } from '../common/DialogFrame';
import { PANEL_VIEWS, type PanelView } from '../../lib/workspace/layout';
import { FOCUS_BARS, type FocusConfig, type TriState, type Visibility } from '../../lib/workspace/focusMode';
import { keyHint } from '../../lib/settings/keybindings';
import { t } from '../../i18n';

type Option<T extends string> = { value: T; label: string };
const TRI: Option<TriState>[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'preserve', label: 'Preserve' },
];
const VIS: Option<Visibility>[] = [
  { value: 'show', label: 'Show' },
  { value: 'hide', label: 'Hide' },
  { value: 'preserve', label: 'Preserve' },
];

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  swatch,
  note,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  swatch?: string;
  note?: string;
}) {
  return (
    <div className={`focus-row${disabled ? ' is-disabled' : ''}`} data-tip={note}>
      <span className="focus-label">
        {swatch !== undefined && <i className="pane-swatch" aria-hidden="true" style={{ background: swatch }} />}
        {label}
      </span>
      <div className="focus-choice" role="radiogroup" aria-label={label}>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            disabled={disabled}
            className={value === option.value ? 'is-active' : ''}
            onClick={() => onChange(option.value)}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Focus Mode settings (shown when the mode starts, unless turned off; also View → Focus Mode Settings…).
 * OK starts Focus Mode with these settings (or applies them when it is already on).
 */
export function FocusModeDialog({
  value,
  swatches,
  desktop,
  onCancel,
  onConfirm,
}: {
  value: FocusConfig;
  swatches: Partial<Record<PanelView, string>>;
  /** Always on top needs the desktop app. */
  desktop: boolean;
  onCancel: () => void;
  onConfirm: (config: FocusConfig) => void;
}) {
  const [config, setConfig] = useState(value);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLButtonElement>('.primary-button')?.focus({ preventScroll: true });
  }, []);
  const desktopOnly = desktop ? undefined : t('Desktop app only');
  return (
    <DialogFrame
      kicker={t('VIEW')}
      title={t('FOCUS MODE')}
      className="focus-dialog"
      label={t('Focus Mode')}
      closeTitle={t('Cancel (Esc)')}
      focusForm={false}
      formRef={formRef}
      onClose={onCancel}
      onSubmit={() => onConfirm(config)}
    >
      <div className="focus-section">{t('MODES')}</div>
      <div className="focus-group">
        <Choice
          label={t('Full screen')}
          value={config.fullScreen}
          options={TRI}
          onChange={fullScreen => setConfig(current => ({ ...current, fullScreen }))}
        />
        <Choice
          label={t('Always on top')}
          value={config.alwaysOnTop}
          options={TRI}
          disabled={!desktop}
          note={desktopOnly}
          onChange={alwaysOnTop => setConfig(current => ({ ...current, alwaysOnTop }))}
        />
      </div>

      <div className="focus-section">{t('BARS')}</div>
      <div className="focus-group">
        {FOCUS_BARS.map(bar => (
          <Choice
            key={bar.id}
            label={t(bar.label)}
            value={config.bars[bar.id]}
            options={VIS}
            onChange={next => setConfig(current => ({ ...current, bars: { ...current.bars, [bar.id]: next } }))}
          />
        ))}
      </div>

      <div className="focus-section">{t('PANES')}</div>
      <div className="focus-group">
        {PANEL_VIEWS.map(pane => (
          <Choice
            key={pane.view}
            label={t(pane.label)}
            swatch={swatches[pane.view] ?? ''}
            value={config.panes[pane.view]}
            options={VIS}
            onChange={next => setConfig(current => ({ ...current, panes: { ...current.panes, [pane.view]: next } }))}
          />
        ))}
      </div>

      <p className="dialog-note">
        {t(
          'Focus Mode maximizes the window without its title bar and window buttons. Leave it with {{keys}} or the Focus Mode button (with the menu bar hidden: move the mouse to the top edge).',
          { keys: keyHint('focusMode') ?? '—' },
        )}
      </p>
      <div className="focus-foot">
        <label className="dialog-check">
          <input
            type="checkbox"
            checked={config.showDialog}
            onChange={event => setConfig(current => ({ ...current, showDialog: event.target.checked }))}
          />
          <span>{t('Show this dialog when focus mode starts')}</span>
        </label>
        <DialogActions onCancel={onCancel} label={t('OK')} />
      </div>
    </DialogFrame>
  );
}
