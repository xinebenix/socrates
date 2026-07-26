'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useI18n } from './I18nProvider';
import {
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_LABELS,
  type Locale,
} from '@/lib/i18n/locale';

/**
 * Language switch in the nav bar.
 *
 * A two-state segmented control rather than a dropdown: with exactly two locales, a
 * menu is one more click and one more thing to discover for no gain, and both options
 * being visible means the reader can see that Chinese exists without opening anything.
 *
 * The cookie is set here and the tree re-rendered on the server, so every string —
 * including the ones in server components that never reach the client — comes back in
 * the new language. No page reload, no URL change: a locale in the path would break
 * links the reader has already saved.
 */
export function LocaleToggle() {
  const { locale } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(next: Locale) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className="locale" role="group" aria-label={LOCALE_LABELS[locale].full}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          className={`locale-opt${l === locale ? ' on' : ''}`}
          // aria-pressed rather than aria-current: this is a toggle, not navigation.
          aria-pressed={l === locale}
          aria-label={LOCALE_LABELS[l].full}
          disabled={pending}
          onClick={() => choose(l)}
        >
          {LOCALE_LABELS[l].short}
        </button>
      ))}
    </div>
  );
}
