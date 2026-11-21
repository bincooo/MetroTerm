import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeMode } from '../types';
import { configLocation } from '../lib/config';
import { hasLockPassword, IDLE_RANGE, type LockSettings } from '../lib/lockScreen';
import {
  FONT_SIZE_RANGE,
  OPACITY_PERCENT_RANGE,
  SCROLLBACK_RANGE,
  TERMINAL_FONT_STACK,
  UI_FONT_STACK,
  sanitizeAppearance,
  sanitizeTerminalPrefs,
  withFallback,
  type AppearancePrefs,
  type CursorShape,
  type TerminalPrefs,
} from '../lib/preferences';
import { installedFonts } from '../lib/fonts';
import { ComboBox, type ComboOption } from './ComboBox';
import { escapeCloses } from './dialog';
import { Icon } from './Icon';
import { NumberInput } from './NumberInput';
import { LANGUAGES, t, type Language } from '../i18n';

const CURSOR_SHAPES: { value: CursorShape; label: string }[] = [
  { value: 'block', label: 'BLOCK' },
  { value: 'bar', label: 'BAR' },
  { value: 'underline', label: 'UNDERLINE' },
];

/** `titleBar`: the app's own frameless title bar (default) or the system's native one — never both. */
export type TitleBarMode = 'frameless' | 'native';

/** FONTS suggestions: the built-in stack first, then the families found on this computer. */
const fontOptions = (families: string[], builtIn: string): ComboOption[] => [
  { value: '', label: t('Default'), hint: builtIn },
  ...families.map(family => ({ value: family, label: family })),
];
const FONT_SAMPLE = 'AaBbCc 0O 1lI {}[] => 中文 ✓';

/** Session → Preferences → Settings…: app-wide settings (theme, window, fonts, terminal, lock). */
export function SettingsDialog({
  theme,
  language,
  titleBar,
  desktop,
  prefs,
  appearance,
  lock,
  onLockPassword,
  onPreviewOpacity,
  onClose,
  onSave,
}: {
  theme: ThemeMode;
  /** LANGUAGE: English (default) or Chinese, applied on Save. */
  language: Language;
  titleBar: TitleBarMode;
  /** Desktop app: the TITLE BAR and WINDOW OPACITY choices apply (a browser has no window to change). */
  desktop: boolean;
  prefs: TerminalPrefs;
  appearance: AppearancePrefs;
  lock: LockSettings;
  onLockPassword: () => void;
  /** Opacity slider moved: shown on the window right away (put back on Cancel). */
  onPreviewOpacity: (percent: number) => void;
  onClose: () => void;
  onSave: (
    theme: ThemeMode,
    titleBar: TitleBarMode,
    prefs: TerminalPrefs,
    lock: Pick<LockSettings, 'idleMinutes' | 'skipPrompt'>,
    appearance: AppearancePrefs,
    language: Language,
  ) => void;
}) {
  const [mode, setMode] = useState(theme);
  const [lang, setLang] = useState(language);
  const [frame, setFrame] = useState(titleBar);
  const [fontSize, setFontSize] = useState(prefs.fontSize);
  const [scrollback, setScrollback] = useState(prefs.scrollback);
  const [cursorBlink, setCursorBlink] = useState(prefs.cursorBlink);
  const [cursorStyle, setCursorStyle] = useState<CursorShape>(prefs.cursorStyle);
  const [opacity, setOpacity] = useState(appearance.windowOpacity);
  const [terminalFamily, setTerminalFamily] = useState(prefs.fontFamily);
  const [uiFamily, setUiFamily] = useState(appearance.uiFontFamily);
  const fonts = useMemo(() => installedFonts(), []);
  const [idleMinutes, setIdleMinutes] = useState(lock.idleMinutes);
  const [askPassword, setAskPassword] = useState(!lock.skipPrompt);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="connection-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={formRef}
        onMouseDown={event => event.stopPropagation()}
        onKeyDown={escapeCloses(onClose)}
        onSubmit={event => {
          event.preventDefault();
          onSave(
            mode,
            frame,
            sanitizeTerminalPrefs({ ...prefs, fontSize, scrollback, cursorBlink, cursorStyle, fontFamily: terminalFamily }),
            { idleMinutes, skipPrompt: !askPassword },
            sanitizeAppearance({ windowOpacity: opacity, uiFontFamily: uiFamily }),
            lang,
          );
        }}
      >
        <div className="dialog-title">
          <span>{t('PREFERENCES')}</span>
          <b>{t('SETTINGS')}</b>
          <button type="button" className="icon-button" title={t('Close')} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="field-label">{t('LANGUAGE')}</div>
        <div className="segmented" role="radiogroup" aria-label={t('Language')}>
          {LANGUAGES.map(item => (
            <button
              key={item.value}
              type="button"
              role="radio"
              aria-checked={lang === item.value}
              className={lang === item.value ? 'is-active' : ''}
              onClick={() => setLang(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="field-label">{t('THEME')}</div>
        <div className="segmented" role="radiogroup" aria-label={t('Theme')}>
          <button type="button" className={mode === 'dark' ? 'is-active' : ''} onClick={() => setMode('dark')}>
            {t('DARK')}
          </button>
          <button type="button" className={mode === 'light' ? 'is-active' : ''} onClick={() => setMode('light')}>
            {t('LIGHT')}
          </button>
          <button type="button" className={`theme-gold-option${mode === 'gold' ? ' is-active' : ''}`} onClick={() => setMode('gold')}>
            <Icon name="crown" />
            {t('GOLD')}
            <em>{t('PRO MAX')}</em>
          </button>
        </div>
        {desktop && (
          <>
            <div className="field-label">{t('TITLE BAR')}</div>
            <div className="segmented" role="radiogroup" aria-label={t('Title bar')}>
              <button type="button" className={frame === 'frameless' ? 'is-active' : ''} onClick={() => setFrame('frameless')}>
                {t('FRAMELESS')}
              </button>
              <button type="button" className={frame === 'native' ? 'is-active' : ''} onClick={() => setFrame('native')}>
                {t('NATIVE')}
              </button>
            </div>
          </>
        )}
        <div className="field-label">{t('WINDOW OPACITY')}</div>
        <div className="opacity-slider settings-opacity">
          <input
            type="range"
            aria-label={t('Window opacity')}
            min={OPACITY_PERCENT_RANGE.min}
            max={OPACITY_PERCENT_RANGE.max}
            step={5}
            value={opacity}
            disabled={!desktop}
            onChange={event => {
              const value = Number(event.target.value);
              setOpacity(value);
              onPreviewOpacity(value);
            }}
          />
          <span>{opacity >= 100 ? t('Opaque') : `${opacity}%`}</span>
        </div>
        {!desktop && <p className="dialog-note settings-hint">{t('Window opacity applies in the desktop app.')}</p>}
        <div className="field-label">{t('FONTS')}</div>
        <div className="form-grid even settings-fonts">
          <label>
            {t('TERMINAL FONT')}
            <ComboBox
              ariaLabel="Terminal font"
              value={terminalFamily}
              options={fontOptions(fonts.mono, 'RobotoMono Nerd Font')}
              onChange={setTerminalFamily}
              placeholder={t('Default')}
            />
          </label>
          <label>
            {t('INTERFACE FONT')}
            <ComboBox
              ariaLabel="Interface font"
              value={uiFamily}
              options={fontOptions(fonts.ui, 'RobotoMono Nerd Font')}
              onChange={setUiFamily}
              placeholder={t('Default')}
            />
          </label>
        </div>
        <div className="font-preview" aria-label={t('Font preview')}>
          <span style={{ fontFamily: withFallback(terminalFamily.trim(), TERMINAL_FONT_STACK), fontSize }} title={t('Terminal font')}>
            {FONT_SAMPLE}
          </span>
          <span style={{ fontFamily: withFallback(uiFamily.trim(), UI_FONT_STACK) }} title={t('Interface font')}>
            {t('Session · Preferences · Settings…')}
          </span>
        </div>
        <div className="form-grid even">
          <label>
            {t('TERMINAL FONT SIZE')}
            <NumberInput
              ariaLabel="Terminal font size"
              value={fontSize}
              onChange={setFontSize}
              min={FONT_SIZE_RANGE.min}
              max={FONT_SIZE_RANGE.max}
              step={1}
              suffix="px"
            />
          </label>
          <label>
            {t('SCROLLBACK LINES')}
            <NumberInput
              ariaLabel="Scrollback lines"
              value={scrollback}
              onChange={setScrollback}
              min={SCROLLBACK_RANGE.min}
              max={SCROLLBACK_RANGE.max}
              step={1000}
            />
          </label>
        </div>
        <div className="field-label">{t('CURSOR')}</div>
        <div className="segmented cursor-shapes" role="radiogroup" aria-label={t('Cursor style')}>
          {CURSOR_SHAPES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={cursorStyle === value}
              className={cursorStyle === value ? 'is-active' : ''}
              onClick={() => setCursorStyle(value)}
            >
              <i className={`cursor-sample is-${value}`} aria-hidden="true" />
              {t(label)}
            </button>
          ))}
        </div>
        <div className="segmented cursor-blink" role="radiogroup" aria-label={t('Cursor blinking')}>
          <button type="button" className={cursorBlink ? 'is-active' : ''} onClick={() => setCursorBlink(true)}>
            {t('BLINKING')}
          </button>
          <button type="button" className={!cursorBlink ? 'is-active' : ''} onClick={() => setCursorBlink(false)}>
            {t('STEADY')}
          </button>
        </div>
        <div className="field-label">{t('LOCK SCREEN')}</div>
        <div className="form-grid even lock-prefs">
          <label>
            {t('LOCK PASSWORD')}
            <div className="lock-password-row">
              <span className={hasLockPassword(lock) ? 'is-set' : ''}>{hasLockPassword(lock) ? 'Set' : t('Not set')}</span>
              <button type="button" onClick={onLockPassword}>
                {hasLockPassword(lock) ? t('CHANGE…') : t('SET…')}
              </button>
            </div>
          </label>
          <label>
            {t('AUTO LOCK AFTER IDLE')}
            <NumberInput
              ariaLabel="Auto lock after idle (minutes, 0 = off)"
              value={idleMinutes}
              onChange={setIdleMinutes}
              min={IDLE_RANGE.min}
              max={IDLE_RANGE.max}
              step={1}
              suffix="min"
            />
          </label>
        </div>
        {!hasLockPassword(lock) && (
          <label className="dialog-check">
            <input type="checkbox" checked={askPassword} onChange={event => setAskPassword(event.target.checked)} />
            <span>{t('Offer to set a password when locking without one')}</span>
          </label>
        )}
        <p className="dialog-note">{t('Auto lock: 0 = off. Keyboard and mouse input count as activity, terminal output does not.')}</p>
        <p className="dialog-note">
          {t('Applies to all terminals, including open ones. Saved in {{dir}}/settings.json.', { dir: configLocation() })}
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t('CANCEL')}
          </button>
          <button className="primary-button" type="submit">
            {t('SAVE')} <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    </div>
  );
}
