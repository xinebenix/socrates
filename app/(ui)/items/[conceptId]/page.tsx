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
import { getDict } from '@/lib/i18n/server';
import { fill } from '@/lib/i18n/dict';
import { ItemHealthTable } from './ItemHealthClient';

export const dynamic = 'force-dynamic';

export default async function ItemsPage({
  params,
}: {
  params: Promise<{ conceptId: string }>;
}) {
  const t = await getDict();
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
              {t.items.eyebrow}
            </p>
            <h1 className="display">{concept.name}</h1>
            <p
              className="advisory"
              // The entry carries its own `&nbsp;` and `<strong>` markup, which is why it
              // goes in as HTML rather than as a text child. The source is the static
              // dictionary, never a database row.
              dangerouslySetInnerHTML={{
                __html: fill(t.items.statsAdvisory, { minN: MIN_N_FOR_STATISTIC }),
              }}
            />
          </div>

          <div className="panel">
            <p className="section-label">{t.items.perCellLabel}</p>
            <ItemHealthTable conceptId={conceptId} cells={cells} />
          </div>

          <div className="panel">
            <p className="section-label">{t.items.deadDistractorsLabel}</p>
            {dead.length === 0 ? (
              <p className="note">
                {t.items.deadDistractorsNoneYet} {t.items.deadDistractorsRationale}
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
                      {fill(t.items.distractorServedCount, { count: d.administrations })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <p className="section-label">{t.items.validatorRejectionLabel}</p>
            <p className="advisory" style={{ marginBottom: 14 }}>
              {t.items.validatorRejectionAdvisory}
            </p>
            <div className="ledger">
              {health.map((h) => (
                <div className="ledger-row" key={h.nodeId}>
                  <span className={`dot ${h.alarm ? 'miss' : 'ok'}`} aria-hidden />
                  <span className="serif-body" style={{ flex: 1, fontSize: 16 }}>
                    {h.nodeTitle}
                  </span>
                  <span className="eyebrow tabular" style={{ flex: 'none' }}>
                    {fill(t.items.nodeRejectionSummary, {
                      rejected: h.rejected,
                      generated: h.generated,
                      rate: h.generated > 0 ? `${Math.round(h.rejectionRate * 100)}%` : '—',
                    })}
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
