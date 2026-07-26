import { getDb } from '@/lib/db';
import { spendSnapshot } from '@/lib/cost';
import { SpendChip } from './SpendChip';

/**
 * Reads the spend figures server-side and hands them to the client chip as plain
 * data. Kept separate from Chrome so the login page — which is public and has no
 * business opening the database — can leave it out entirely.
 */
export function SpendSlot() {
  try {
    const snapshot = spendSnapshot(getDb());
    return <SpendChip snapshot={snapshot} />;
  } catch {
    // Chrome must render even if the database is unavailable. A missing cost readout
    // is a far better failure than an unusable app.
    return null;
  }
}
