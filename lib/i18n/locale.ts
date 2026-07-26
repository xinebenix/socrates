/**
 * Locale selection.
 *
 * Two locales, chosen by the reader and remembered in a cookie. There is no path
 * prefix and no `Accept-Language` sniffing: this is a single-user tool, the choice is
 * deliberate rather than inferred, and a URL that changes when you switch language
 * would break every link the reader has already saved.
 */

export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_COOKIE = 'socrates_locale';

/** A year: the choice is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: string | undefined | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** The `lang` attribute for `<html>`. Screen readers and hyphenation depend on it. */
export function htmlLang(locale: Locale): string {
  return locale === 'zh' ? 'zh-Hans' : 'en';
}

export const LOCALE_LABELS: Record<Locale, { short: string; full: string }> = {
  en: { short: 'EN', full: 'English' },
  zh: { short: '中', full: '简体中文' },
};
