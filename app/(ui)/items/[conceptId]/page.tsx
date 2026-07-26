import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getConcept } from '@/lib/db/queries';
import {
  cellStats,
  deadDistractors,
  MIN_N_FOR_STATISTIC,
  nodeHealth,
} from '@/lib/analysis/itemStats';
import { Topbar } from '@/components/Chrome';
import { ItemHealthTable } from './ItemHealthClient';

export const dynamic = 'force-dynamic';

export default async function ItemsPage({
  params,
}: {
  params: Promise<{ conceptId: string }>;
}) {
  const { conceptId: raw } = await params;
  const conceptId = Number(raw);
  if (!Number.isFinite(conceptId)) notFound();

  const db = getDb();
  const concept = getConcept(db, conceptId);
  if (!concept) notFound();

  const cells = cellStats(db, conceptId);
  const dead = deadDistractors(db, conceptId);
  const health = nodeHealth(db, conceptId);

  return (
    <div className="shell">
      <Topbar subtitle={concept.name} conceptId={conceptId} />
      <main className="page">
        <div className="column wide rise stack gap-22">
          <div>
            <p className="eyebrow" style={{ marginBottom: 14 }}>
              Item health — the harness evaluating itself
            </p>
            <h1 className="display">{concept.name}</h1>
            <p className="advisory">
              Single-user statistics are thin. Classical item analysis assumes many test-takers;
              with one person and a handful of administrations per item, difficulty and
              discrimination estimates are noisy. These are aggregated at the cell level, hidden
              below n&nbsp;=&nbsp;{MIN_N_FOR_STATISTIC}, and <strong>advisory only</strong> — do not
              read them as measurements.
            </p>
          </div>

          <div className="panel">
            <p className="section-label">Per cell</p>
            <ItemHealthTable conceptId={conceptId} cells={cells} />
          </div>

          <div className="panel">
            <p className="section-label">
              Dead distractors — never chosen across five or more administrations
            </p>
            {dead.length === 0 ? (
              <p className="note">
                None yet. A distractor nobody picks silently converts a 4-option item into a
                3-option item and inflates the guess rate, so this list is worth clearing.
              </p>
            ) : (
              <div className="ledger">
                {dead.map((d) => (
                  <div className="ledger-row" key={d.optionId} style={{ alignItems: 'flex-start' }}>
                    <span className="dot miss" aria-hidden />
                    <span className="eyebrow" style={{ width: 150, flex: 'none' }}>
                      {d.nodeTitle} · D{d.depth}
                    </span>
                    <span className="serif-body" style={{ flex: 1, fontSize: 16 }}>
                      {d.text}
                    </span>
                    <span className="eyebrow tabular" style={{ flex: 'none' }}>
                      {d.administrations} served
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <p className="section-label">Validator rejection rate by node</p>
            <p className="advisory" style={{ marginBottom: 14 }}>
              A node above 30% is usually badly drawn rather than hard. The likeliest explanation
              for scattered failure is not several separate gaps but one node that was never
              properly cut.
            </p>
            <div className="ledger">
              {health.map((h) => (
                <div className="ledger-row" key={h.nodeId}>
                  <span className={`dot ${h.alarm ? 'miss' : 'ok'}`} aria-hidden />
                  <span className="serif-body" style={{ flex: 1, fontSize: 16 }}>
                    {h.nodeTitle}
                  </span>
                  <span className="eyebrow tabular" style={{ flex: 'none' }}>
                    {h.rejected}/{h.generated} rejected ·{' '}
                    {h.generated > 0 ? `${Math.round(h.rejectionRate * 100)}%` : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
