'use client';

import { createContext, useContext } from 'react';
import type { Dict } from '@/lib/i18n/dict';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/locale';
import { dictionaryFor } from '@/lib/i18n/dict';

interface I18nValue {
  locale: Locale;
  dict: Dict;
}

/**
 * Falls back to the default rather than throwing when a client component renders
 * outside the provider — a missing translation is a cosmetic problem, and a component
 * that crashes over one is a worse bug than the one it reports.
 */
const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  dict: dictionaryFor(DEFAULT_LOCALE),
});

export function I18nProvider({
  locale,
  dict,
  children,
}: I18nValue & { children: React.ReactNode }) {
  // The dictionary is plain serialisable data, so it crosses the server/client
  // boundary as a prop and no client component needs to fetch it.
  return <I18nContext.Provider value={{ locale, dict }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function useDict(): Dict {
  return useContext(I18nContext).dict;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
