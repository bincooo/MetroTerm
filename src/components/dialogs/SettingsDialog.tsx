import { useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeMode } from '../../types';
import { configLocation } from '../../lib/platform/config';
import { hasLockPassword, IDLE_RANGE, type LockSettings } from '../../lib/settings/lockScreen';
import {
  FONT_SIZE_RANGE,
  OPACITY_PERCENT_RANGE,
  SCROLLBACK_RANGE,
  TERMINAL_FONT_STACK,
  UI_FONT_STACK,
  defaultUiFamily,
  sanitizeAppearance,
  sanitizeTerminalPrefs,
  withFallback,
  MCP_PORT_RANGE,
  newMcpToken,
  type AppearancePrefs,
  type CursorShape,
  type McpPrefs,
  type McpStatus,
  type TerminalPrefs,
} from '../../lib/settings/preferences';
import { backend } from '../../lib/platform/backend';
import { copyText } from '../../lib/platform/clipboard';
import { installedFonts } from '../../lib/settings/fonts';
import { ComboBox, type ComboOption } from '../common/ComboBox';
import { escapeCloses, backdropMouseDown } from '../common/dialog';
import { Select } from '../common/Select';
import { Icon } from '../common/Icon';
import { NumberInput } from '../common/NumberInput';
import { listColorSchemes } from '../../lib/terminal/palettes';
import { DEFAULT_COLOR_SCHEMES } from '../../lib/settings/preferences';
import { log } from '../../lib/platform/log';
import { LANGUAGES, t, type Language } from '../../i18n';

const CURSOR_SHAPES: { value: CursorShape; label: string }[] = [
  { value: 'block', label: 'BLOCK' },
  { value: 'bar', label: 'BAR' },
  { value: 'underline', label: 'UNDERLINE' },
];

/** `titleBar`: the app's own frameless title bar (default) or the system's native one — never both. */
export type TitleBarMode = 'frameless' | 'native';

/** MCP SERVER → how to add it to an agent CLI. */
type McpClient = 'claude' | 'codex' | 'gemini' | 'json';
const MCP_CLIENTS: { value: McpClient; label: string }[] = [
  { value: 'claude', label: 'CLAUDE CODE' },
  { value: 'codex', label: 'CODEX' },
  { value: 'gemini', label: 'GEMINI CLI' },
  { value: 'json', label: 'JSON' },
];
/** Claude Code / Gemini CLI / most clients: SSE. Codex speaks Streamable HTTP only: /mcp. */
const mcpSnippet = (client: McpClient, port: number, token: string) => {
  const base = `http://127.0.0.1:${port}`;
  const auth = `Bearer ${token || '<token>'}`;
  switch (client) {
    case 'claude':
      return `claude mcp add --transport sse metroterm ${base}/sse --header "Authorization: ${auth}"`;
    case 'codex':
      return `# ~/.codex/config.toml\n[mcp_servers.metroterm]\nurl = "${base}/mcp"\nhttp_headers = { Authorization = "${auth}" }`;
    case 'gemini':
      return JSON.stringify({ mcpServers: { metroterm: { url: `${base}/sse`, headers: { Authorization: auth } } } }, null, 2);
    default:
      return JSON.stringify({ mcpServers: { metroterm: { type: 'sse', url: `${base}/sse`, headers: { Authorization: auth } } } }, null, 2);
  }
};

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
  mcp,
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
  /** MCP SERVER (applied by the app on Save with `mcp.configure`). */
  mcp: McpPrefs;
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
    mcp: McpPrefs,
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
  const [boldText, setBoldText] = useState(prefs.boldText);
  const [uiFamily, setUiFamily] = useState(appearance.uiFontFamily);
  const fonts = useMemo(() => installedFonts(), []);
  const [schemes, setSchemes] = useState(prefs.colorSchemes);
  const [schemeNames, setSchemeNames] = useState<Record<ThemeMode, string[]>>({ dark: [], gold: [], light: [] });
  const [schemesLoaded, setSchemesLoaded] = useState(false);
  useEffect(() => {
    void listColorSchemes().then(
      names => {
        setSchemeNames(names);
        setSchemesLoaded(true);
      },
      error => log.warn(t('Cannot read the themes folder'), error),
    );
  }, []);
  /**
   * TERMINAL COLORS choices for the theme picked above (a list only, nothing typed): Default (its own
   * scheme), then its folder's other schemes; a saved scheme whose file is gone stays listed as such.
   */
  const schemeOptions = (theme: ThemeMode) => {
    const names = schemeNames[theme].filter(name => name !== DEFAULT_COLOR_SCHEMES[theme]);
    const current = schemes[theme];
    return [
      { value: '', label: t('Default'), hint: DEFAULT_COLOR_SCHEMES[theme] },
      ...(current && !names.includes(current) && schemesLoaded ? [{ value: current, label: current, hint: t('file not found') }] : []),
      ...names.map(name => ({ value: name, label: name })),
    ];
  };
  const [idleMinutes, setIdleMinutes] = useState(lock.idleMinutes);
  const [askPassword, setAskPassword] = useState(!lock.skipPrompt);
  const [mcpOn, setMcpOn] = useState(mcp.enabled);
  const [mcpPort, setMcpPort] = useState(mcp.port);
  const [mcpToken, setMcpToken] = useState(mcp.token);
  const [mcpInput, setMcpInput] = useState(mcp.allowInput);
  const [mcpClient, setMcpClient] = useState<McpClient>('claude');
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [copied, setCopied] = useState<'token' | 'snippet' | null>(null);
  useEffect(() => {
    if (!backend.live) return;
    void backend.call<McpStatus>('mcp.status').then(setMcpStatus, error => log.warn(t('MCP server'), error));
  }, []);
  const turnMcp = (on: boolean) => {
    setMcpOn(on);
    if (on && !mcpToken) setMcpToken(newMcpToken());
  };
  const copy = (what: 'token' | 'snippet', text: string) =>
    void copyText(text).then(ok => {
      setCopied(ok ? what : null);
      if (ok) window.setTimeout(() => setCopied(current => (current === what ? null : current)), 1500);
    });
  const mcpDraft: McpPrefs = { enabled: mcpOn, port: mcpPort, token: mcpToken, allowInput: mcpInput };
  const mcpChanged = JSON.stringify(mcpDraft) !== JSON.stringify(mcp);
  const mcpNote = (): { text: string; error?: boolean } => {
    if (!backend.live) return { text: t('The MCP server runs in the MetroTerm backend (desktop app or metroterm web).') };
    if (mcpChanged) return { text: t('Applied when you save.') };
    if (mcpStatus?.error) return { text: mcpStatus.error, error: true };
    if (mcpStatus?.running)
      return { text: t('Running at {{url}} · {{n}} SSE client(s) connected.', { url: mcpStatus.url ?? '', n: mcpStatus.clients }) };
    return {
      text: t('Off. Agent CLIs (Claude Code, Codex, Gemini CLI …) can list, read and drive these terminals over MCP when it is on.'),
    };
  };
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={backdropMouseDown}>
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
            sanitizeTerminalPrefs({
              ...prefs,
              fontSize,
              scrollback,
              cursorBlink,
              cursorStyle,
              fontFamily: terminalFamily,
              boldText,
              colorSchemes: schemes,
            }),
            { idleMinutes, skipPrompt: !askPassword },
            sanitizeAppearance({ windowOpacity: opacity, uiFontFamily: uiFamily }),
            lang,
            mcpDraft,
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
          </button>
        </div>
        <label className="settings-scheme">
          {t('TERMINAL COLORS')}
          <Select
            ariaLabel="Terminal colors"
            className={schemes[mode] ? '' : 'is-default'}
            value={schemes[mode]}
            options={schemeOptions(mode)}
            onChange={value => setSchemes(current => ({ ...current, [mode]: value }))}
          />
        </label>
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
              options={fontOptions(fonts.mono, 'DejaVu Sans Mono')}
              onChange={setTerminalFamily}
              placeholder={t('Default')}
            />
          </label>
          <label>
            {t('INTERFACE FONT')}
            <ComboBox
              ariaLabel="Interface font"
              value={uiFamily}
              options={fontOptions(fonts.ui, defaultUiFamily() || 'RobotoMono Nerd Font')}
              onChange={setUiFamily}
              placeholder={t('Default')}
            />
          </label>
        </div>
        <div className="font-preview" aria-label={t('Font preview')}>
          <span style={{ fontFamily: withFallback(terminalFamily.trim(), TERMINAL_FONT_STACK), fontSize }} title={t('Terminal font')}>
            {FONT_SAMPLE}
          </span>
          <span style={{ fontFamily: withFallback(uiFamily.trim() || defaultUiFamily(), UI_FONT_STACK) }} title={t('Interface font')}>
            {t('Session · Preferences · Settings…')}
          </span>
        </div>
        <div className="field-label">{t('BOLD TEXT')}</div>
        <div className="segmented bold-text" role="radiogroup" aria-label={t('Bold text')}>
          <button
            type="button"
            role="radio"
            aria-checked={!boldText}
            className={!boldText ? 'is-active' : ''}
            onClick={() => setBoldText(false)}
          >
            {t('REGULAR')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={boldText}
            className={boldText ? 'is-active' : ''}
            onClick={() => setBoldText(true)}
          >
            {t('BOLD')}
          </button>
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
        <div className="field-label">{t('MCP SERVER')}</div>
        <div className="segmented mcp-switch" role="radiogroup" aria-label={t('MCP server')}>
          <button type="button" role="radio" aria-checked={!mcpOn} className={!mcpOn ? 'is-active' : ''} onClick={() => turnMcp(false)}>
            {t('OFF')}
          </button>
          <button type="button" role="radio" aria-checked={mcpOn} className={mcpOn ? 'is-active' : ''} onClick={() => turnMcp(true)}>
            {t('ON')}
          </button>
        </div>
        {mcpOn && (
          <>
            <div className="form-grid mcp-prefs">
              <label>
                {t('ACCESS TOKEN')}
                <div className="lock-password-row mcp-token">
                  <span title={mcpToken}>{mcpToken}</span>
                  <button type="button" onClick={() => copy('token', mcpToken)}>
                    {copied === 'token' ? t('COPIED') : t('COPY')}
                  </button>
                  <button
                    type="button"
                    title={t('New token: agent CLIs set up with the old one must be updated')}
                    onClick={() => setMcpToken(newMcpToken())}
                  >
                    {t('NEW')}
                  </button>
                </div>
              </label>
              <label>
                {t('PORT')}
                <NumberInput
                  ariaLabel="MCP port"
                  value={mcpPort}
                  onChange={setMcpPort}
                  min={MCP_PORT_RANGE.min}
                  max={MCP_PORT_RANGE.max}
                  step={1}
                />
              </label>
            </div>
            <label className="dialog-check mcp-input">
              <input type="checkbox" checked={mcpInput} onChange={event => setMcpInput(event.target.checked)} />
              <span>{t('Allow agents to type, open and arrange tabs')}</span>
            </label>
            <div className="segmented mcp-clients" role="radiogroup" aria-label={t('Agent CLI')}>
              {MCP_CLIENTS.map(item => (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={mcpClient === item.value}
                  className={mcpClient === item.value ? 'is-active' : ''}
                  onClick={() => setMcpClient(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="mcp-snippet">
              <pre>{mcpSnippet(mcpClient, mcpPort, mcpToken)}</pre>
              <button type="button" title={t('Copy')} onClick={() => copy('snippet', mcpSnippet(mcpClient, mcpPort, mcpToken))}>
                {copied === 'snippet' ? t('COPIED') : t('COPY')}
              </button>
            </div>
          </>
        )}
        <p className={`dialog-note${mcpNote().error ? ' is-error' : ''}`}>{mcpNote().text}</p>
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
