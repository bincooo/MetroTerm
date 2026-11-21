import { createElement, type ReactNode } from 'react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './zh.json';

/**
 * Localization (react-i18next). The keys are the English texts themselves, so English needs no
 * resource file and a missing translation shows the English text. `zh.json` maps English → Chinese.
 * Language: settings.json `language` ('en' default | 'zh'), chosen in Settings → LANGUAGE.
 *
 * `t` can be used anywhere (also outside components); App re-renders on a language change
 * (useTranslation), and so does everything it renders. Memoized components call useTranslation.
 * Texts in module-level tables are translated where they are shown (`t(item.label)`).
 */
export type Language = 'en' | 'zh';
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];
export const sanitizeLanguage = (value: unknown): Language => (value === 'zh' ? 'zh' : 'en');

void i18n.use(initReactI18next).init({
  resources: { en: { translation: {} }, zh: { translation: zh } },
  lng: 'en',
  fallbackLng: 'en',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  react: { useSuspense: false },
});

export const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options) as string;
export const setLanguage = (language: Language) => {
  if (i18n.language !== language) void i18n.changeLanguage(language);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
};
export default i18n;

/**
 * Translate a text with inline code: `<c>…</c>` in the (translated) text becomes <code>…</code>.
 * tc('Delete <c>{{name}}</c>?', { name }) → ['Delete ', <code>name</code>, '?']
 */
export const tc = (key: string, options?: Record<string, unknown>): ReactNode[] =>
  t(key, options)
    .split(/<c>(.*?)<\/c>/)
    .map((part, index) => (index % 2 ? createElement('code', { key: index }, part) : part));
