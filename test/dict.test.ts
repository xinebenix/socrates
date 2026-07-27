/**
 * Properties of the string tables that `tsc` cannot see.
 *
 * The type system already guarantees shape: `Dict` is derived from `en`, so a key added
 * in English and forgotten in Chinese fails the build. What it cannot see is a *value*
 * that is wrong — and one class of wrong value is expensive here, because the spend panel
 * renders money out of two separate keys.
 *
 * That is not hypothetical. `zh.chrome.currencySymbol` shipped as ¥ while
 * `zh.chrome.amountBelowCent` stayed `<$0.01`, so the Chinese panel read `¥1.52` on one
 * line and `<$0.01` on the next — two currencies for the same quantity, and the ¥ stating
 * a number nobody had converted. Both keys typecheck perfectly.
 */

import { describe, expect, it } from 'vitest';
import { en, zh, dictionaryFor } from '../lib/i18n/dict';
import { LOCALES } from '../lib/i18n/locale';

const tables = { en, zh } as const;

describe('the string tables', () => {
  it('cover every locale the app offers', () => {
    for (const locale of LOCALES) {
      expect(dictionaryFor(locale), `no table for ${locale}`).toBeTruthy();
    }
  });

  it('quote one currency per locale, in both places money is formatted', () => {
    // The panel builds an amount as `${currencySymbol}${n}` but has a separate literal for
    // the sub-cent case. If those disagree the same figure changes currency as it shrinks.
    for (const [locale, table] of Object.entries(tables)) {
      const symbol = table.chrome.currencySymbol;
      expect(
        table.chrome.amountBelowCent,
        `${locale}: amountBelowCent does not use ${symbol}, the symbol the other figures carry`
      ).toContain(symbol);
    }
  });

  it('price in dollars everywhere, because the figures are US billing', () => {
    // Deliberate departure from the design comp, which drew ¥. These numbers come from
    // Anthropic API billing unconverted; a ¥ in front of one states an amount that is
    // false. Redenominating needs a rate and a rounding rule — a product decision.
    for (const [locale, table] of Object.entries(tables)) {
      expect(table.chrome.currencySymbol, `${locale} prices in a non-dollar currency`).toBe('$');
    }
  });

  it('keep every placeholder the English uses, in every translation', () => {
    // A dropped {count} renders a sentence with a hole in it; an invented one renders the
    // literal braces, since fill() leaves unknown placeholders visible on purpose.
    const placeholders = (s: string) => new Set(s.match(/\{[a-zA-Z]+\}/g) ?? []);

    for (const [locale, table] of Object.entries(tables)) {
      if (locale === 'en') continue;
      for (const [ns, group] of Object.entries(en)) {
        for (const [key, source] of Object.entries(group as Record<string, string>)) {
          const translated = (table as unknown as Record<string, Record<string, string>>)[ns][key];
          expect(
            [...placeholders(translated)].sort(),
            `${locale}: ${ns}.${key} does not carry the same placeholders as the English`
          ).toEqual([...placeholders(source)].sort());
        }
      }
    }
  });

  it('leave no string blank in any locale', () => {
    for (const [locale, table] of Object.entries(tables)) {
      for (const [ns, group] of Object.entries(table)) {
        for (const [key, value] of Object.entries(group as Record<string, string>)) {
          expect(value.trim(), `${locale}: ${ns}.${key} is empty`).not.toBe('');
        }
      }
    }
  });
});
