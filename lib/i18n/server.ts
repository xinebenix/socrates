import { cookies } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale, type Locale } from './locale';
import { dictionaryFor, type Dict } from './dict';

/**
 * The reader's locale, server-side.
 *
 * Every page is already `dynamic = 'force-dynamic'`, so reading a cookie here costs
 * nothing that was not already being paid.
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
}

export async function getDict(): Promise<Dict> {
  return dictionaryFor(await getLocale());
}

/** Both at once, for the layout, which needs the locale for `lang` and the dict for the tree. */
export async function getI18n(): Promise<{ locale: Locale; dict: Dict }> {
  const locale = await getLocale();
  return { locale, dict: dictionaryFor(locale) };
}
