import Link from 'next/link';
import { SpendSlot } from './SpendSlot';

export interface ChromeProps {
  subtitle: string;
  conceptId?: number;
  right?: React.ReactNode;
  /**
   * Set false on public pages. The spend readout opens the database, which the login
   * page has no business doing.
   */
  spend?: boolean;
}

/** Sticky header: wordmark, a one-line subtitle, per-concept navigation, spend. */
export function Topbar({ subtitle, conceptId, right, spend = true }: ChromeProps) {
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
          <Link href={`/blueprint/${conceptId}`}>Blueprint</Link>
          <Link href={`/dashboard/${conceptId}`}>Dashboard</Link>
          <Link href={`/items/${conceptId}`}>Item health</Link>
          <Link href={`/benchmark/${conceptId}`}>Benchmark</Link>
        </nav>
      )}

      <div className={conceptId != null ? 'topbar-end' : 'topbar-end push'}>
        {spend && <SpendSlot />}
        {right}
      </div>
    </header>
  );
}
