import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getConcept } from '@/lib/db/queries';
import { conceptStats } from '@/lib/stats';
import { blueprintAlarm } from '@/lib/analysis/itemStats';
import { Heatmap, HeatmapLegend } from '@/components/Heatmap';
import { Topbar } from '@/components/Chrome';
import { StartButton } from '../../concepts/ConceptsClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
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

  const s = conceptStats(db, conceptId);
  const alarm = blueprintAlarm(db, conceptId);
  const maxForecast = Math.max(1, ...s.dueForecast.map((d) => d.count));
  const active = s.misconceptionProfile.filter((m) => m.active);

  return (
    <div className="shell">
      <Topbar subtitle={concept.name} conceptId={conceptId} />
      <main className="page">
        <div className="column wide rise stack gap-22">
          <div>
            <p className="eyebrow" style={{ marginBottom: 14 }}>
              Where you actually are
            </p>
            <h1 className="display" style={{ marginBottom: 18 }}>
              {concept.name}
            </h1>
            <div className="row wrap gap-9">
              <StartButton conceptId={conceptId} disabled={s.grid.length === 0} label="Train now" />
              <Link className="btn small" href={`/blueprint/${conceptId}`}>
                Edit the blueprint
              </Link>
            </div>
          </div>

          {!s.hasSource && (
            <div className="warnbox">
              No source material on this concept. Items test the canonical version of the topic and
              will miss whatever is specific to what you are actually reading.
            </div>
          )}
          {alarm && <div className="warnbox">{alarm}</div>}

          <div
            className="grid-tiles"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}
          >
            <Tile label="Coverage" value={`${Math.round(s.coverage * 100)}%`} />
            <Tile label="Mastered cells" value={`${s.masteredCells}/${s.applicableCells}`} />
            <Tile label="Due now" value={String(s.dueCount)} />
            <Tile label="Depth frontier" value={`D${s.frontier}`} />
            <Tile label="Responses" value={String(s.totalResponses)} />
          </div>

          <div className="panel">
            <p className="section-label">Mastery grid — decayed, not raw</p>
            <div style={{ overflowX: 'auto' }}>
              <Heatmap grid={s.grid} />
            </div>
            <div style={{ marginTop: 14 }}>
              <HeatmapLegend />
            </div>
          </div>

          <div className="panel">
            <p className="section-label">
              Misconception profile — ranked by recent selection
            </p>
            {s.misconceptionProfile.length === 0 ? (
              <p className="note">Nothing recorded yet.</p>
            ) : (
              <>
                {active.length > 0 && (
                  <p className="note" style={{ marginBottom: 12, color: 'var(--terra)' }}>
                    {active.length} belief{active.length === 1 ? '' : 's'} selected twice or more in
                    the last 20 responses. Those nodes now get a remediation slice at the top of
                    every session, with the same belief put back in the option set.
                  </p>
                )}
                <div className="ledger">
                  {s.misconceptionProfile.slice(0, 14).map((m) => (
                    <div className="ledger-row" key={m.id} style={{ alignItems: 'flex-start' }}>
                      <span className={`dot ${m.active ? 'miss' : 'ok'}`} aria-hidden />
                      <span className="stack gap-6" style={{ flex: 1, minWidth: 0 }}>
                        <span className="serif-body" style={{ fontSize: 16 }}>
                          {m.label}
                        </span>
                        <span className="note">{m.description}</span>
                        <span className="eyebrow" style={{ letterSpacing: '0.14em' }}>
                          {m.nodeTitle}
                        </span>
                      </span>
                      <span className="eyebrow tabular" style={{ flex: 'none' }}>
                        {m.timesSelected}× total · {m.recentSelections} recent
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="row wrap gap-22" style={{ alignItems: 'stretch' }}>
            <div className="panel" style={{ flex: 1, minWidth: 320 }}>
              <p className="section-label">Due forecast — next 14 days</p>
              <div className="spark">
                {s.dueForecast.map((d, i) => (
                  <span
                    key={d.date}
                    className={`bar ${i === 0 && d.count > 0 ? 'accent' : ''}`}
                    style={{ height: `${Math.max(2, (d.count / maxForecast) * 100)}%` }}
                    title={`${d.date}: ${d.count} cell(s)`}
                  />
                ))}
              </div>
              <p className="note" style={{ marginTop: 8 }}>
                {s.dueForecast.reduce((a, b) => a + b.count, 0)} cells fall due in the next
                fortnight. The leftmost bar includes everything already overdue.
              </p>
            </div>

            <div className="panel" style={{ flex: 1, minWidth: 320 }}>
              <p className="section-label">Retention — mean mastery after each day&apos;s work</p>
              {s.retention.length === 0 ? (
                <p className="note">No responses yet.</p>
              ) : (
                <>
                  <div className="spark">
                    {s.retention.slice(-30).map((p) => (
                      <span
                        key={p.date}
                        className="bar"
                        style={{ height: `${Math.max(2, p.meanEffectiveMastery * 100)}%` }}
                        title={`${p.date}: ${Math.round(p.meanEffectiveMastery * 100)}% over ${p.responses} response(s)`}
                      />
                    ))}
                  </div>
                  <p className="note" style={{ marginTop: 8 }}>
                    Generated items drift in difficulty, so this line is not a measurement of
                    progress. The{' '}
                    <Link href={`/benchmark/${conceptId}`}>frozen benchmark</Link> is.
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="panel">
            <p className="section-label">Benchmark history</p>
            {s.benchmarkHistory.length === 0 ? (
              <p className="note">
                No benchmark runs yet. Practice on generated items; measure on frozen ones —{' '}
                <Link href={`/items/${conceptId}`}>promote some validated items</Link> to the
                benchmark set, then run it.
              </p>
            ) : (
              <div className="ledger">
                {s.benchmarkHistory.map((b) => (
                  <div className="ledger-row" key={b.runAt}>
                    <span className="eyebrow tabular" style={{ width: 100, flex: 'none' }}>
                      {b.runAt.slice(0, 10)}
                    </span>
                    <span className="serif-body" style={{ flex: 1 }}>
                      {Object.entries(b.byDepth)
                        .map(([d, v]) => `${d} ${Math.round(v * 100)}%`)
                        .join('  ·  ') || '—'}
                    </span>
                    <span
                      className="value tabular"
                      style={{ fontSize: 22, flex: 'none' }}
                    >
                      {Math.round(b.overall * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <span className="eyebrow" style={{ letterSpacing: '0.22em' }}>
        {label}
      </span>
      <span className="value tabular">{value}</span>
    </div>
  );
}
