import Link from 'next/link';
import { SpendSlot } from './SpendSlot';
import { LocaleToggle } from './LocaleToggle';
import { SignOutButton } from './SignOutButton';
import { getDict } from '@/lib/i18n/server';
import { currentUser } from '@/lib/session';

export interface ChromeProps {
  /** Already localized by the caller, or a concept name, which is user data. */
  subtitle: string;
  conceptId?: number;
  right?: React.ReactNode;
  /**
   * Set false on public pages. The spend readout opens the database, which the login
   * page has no business doing.
   */
  spend?: boolean;
}

/** Sticky header: wordmark, a one-line subtitle, per-concept navigation, spend, language. */
export async function Topbar({ subtitle, conceptId, right, spend = true }: ChromeProps) {
  const t = await getDict();
  // `spend` marks the public pages, and those are the ones with nobody signed in.
  const user = spend ? await currentUser() : null;

  return (
    <header className="topbar">
      <Link href="/concepts" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="wordmark">Socrates</span>
        <span
          style={{
            font: "400 10px/1.3 var(--sans)",
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
          }}
        >
          {subtitle}
        </span>
      </Link>

      {conceptId != null && (
        <nav>
          <Link href={`/blueprint/${conceptId}`}>{t.chrome.navBlueprint}</Link>
          <Link href={`/dashboard/${conceptId}`}>{t.chrome.navDashboard}</Link>
          <Link href={`/items/${conceptId}`}>{t.chrome.navItemHealth}</Link>
          <Link href={`/benchmark/${conceptId}`}>{t.chrome.navBenchmark}</Link>
        </nav>
      )}

      <div className={conceptId != null ? 'topbar-end' : 'topbar-end push'}>
        {spend && <SpendSlot />}
        {/* Present on the login page too: someone who cannot read the login form is
            exactly the person who needs the switch most. */}
        <LocaleToggle />
        {user && <SignOutButton email={user.display_name || user.email} />}
        {right}
      </div>
    </header>
  );
}
