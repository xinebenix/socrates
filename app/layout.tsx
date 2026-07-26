import type { Metadata } from 'next';
import './globals.css';
import { I18nProvider } from '@/components/I18nProvider';
import { getI18n } from '@/lib/i18n/server';
import { htmlLang } from '@/lib/i18n/locale';

export const metadata: Metadata = {
  title: 'Socrates',
  description:
    'A mental gym. Retrieval practice against a structured map of a concept — the testing is the training, not the measurement.',
};

/**
 * Noto Serif SC and Noto Sans SC sit *under* EB Garamond and Jost rather than replacing
 * them, so Latin runs — the wordmark, the D1–D6 codes, numerals — keep their original
 * faces while CJK falls through to a face that has the glyphs. A font stack does that
 * per character for free; swapping the whole family per locale would not.
 */
const FONTS =
  'https://fonts.googleapis.com/css2' +
  '?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500' +
  '&family=Cinzel:wght@500;600' +
  '&family=Jost:wght@300;400;500;600' +
  '&family=Noto+Serif+SC:wght@400;500;600' +
  '&family=Noto+Sans+SC:wght@300;400;500' +
  '&display=swap';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dict } = await getI18n();

  return (
    // data-locale drives the CJK type adjustments in globals.css: no italics, and a
    // looser line-height. Both are things the comp calls for and neither belongs in a
    // component.
    <html lang={htmlLang(locale)} data-locale={locale}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={FONTS} rel="stylesheet" />
      </head>
      <body>
        <I18nProvider locale={locale} dict={dict}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
