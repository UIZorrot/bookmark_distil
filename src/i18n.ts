export type Language = 'zh-CN' | 'en';
export type LanguagePreference = Language | 'auto';

export function resolveLanguage(preference: LanguagePreference | undefined): Language {
  if (preference === 'zh-CN' || preference === 'en') return preference;

  const raw =
    typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage
      ? chrome.i18n.getUILanguage()
      : typeof navigator !== 'undefined'
        ? navigator.language
        : 'en';

  const normalized = raw.toLowerCase();
  if (normalized.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export function tr(lang: Language, zh: string, en: string) {
  return lang === 'zh-CN' ? zh : en;
}
