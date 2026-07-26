import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getConcept, listBenchmarkRuns, listFrozenItems } from '@/lib/db/queries';
import { benchmarkCoverage } from '@/lib/pipeline/benchmark';
import { Topbar } from '@/components/Chrome';
import { getDict } from '@/lib/i18n/server';
import { fill } from '@/lib/i18n/dict';
import { RunBenchmarkButton } from './RunBenchmarkButton';

export const dynamic = 'force-dynamic';

interface StoredResults {
  overall?: number;
  n?: number;
  byDepth?: Record<string, { n: number; correct: number; score: number }>;
  byNode?: Record<string, { title: string; n: number; correct: number; score: number }>;
}

export default async function BenchmarkPage({
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

  const frozen = listFrozenItems(db, conceptId);
  const coverage = benchmarkCoverage(db, conceptId);
  const runs = listBenchmarkRuns(db, conceptId).map((r) => ({
    id: r.id,
    runAt: r.run_at,
    results: JSON.parse(r.results_json) as StoredResults,
  }));

  const uncovered = coverage.filter((c) => c.itemCount === 0);

  return (
    <div className="shell">
      <Topbar subtitle={concept.name} conceptId={conceptId} />
      <main className="page">
        <div className="column wide rise stack gap-22">
          <div>
            <p className="eyebrow" style={{ marginBottom: 14 }}>
              {t.benchmark.eyebrow}
            </p>
            <h1 className="display">{concept.name}</h1>
            <p className="lede">{t.benchmark.lede}</p>
            <div className="row wrap gap-9">
              <RunBenchmarkButton conceptId={conceptId} disabled={frozen.length === 0} />
              <Link className="btn small" href={`/items/${conceptId}`}>
                {t.benchmark.promoteItemsLink}
              </Link>
            </div>
          </div>

          {frozen.length === 0 && (
            <div className="warnbox">{t.benchmark.emptySetWarning}</div>
          )}

          {uncovered.length > 0 && frozen.length > 0 && (
            <div className="warnbox">
              {fill(
                uncovered.length === 1
                  ? t.benchmark.uncoveredWarningOne
                  : t.benchmark.uncoveredWarningOther,
                {
                  count: uncovered.length,
                  nodes: uncovered.map((u) => u.title).join(', '),
                }
              )}
            </div>
          )}

          <div className="panel">
            <p className="section-label">{t.benchmark.coverageSectionLabel}</p>
            <div className="ledger">
              {coverage.map((c) => (
                <div className="ledger-row" key={c.nodeId}>
                  <span className={`dot ${c.itemCount > 0 ? 'ok' : 'miss'}`} aria-hidden />
                  <span className="serif-body" style={{ flex: 1, fontSize: 16 }}>
                    {c.title}
                  </span>
                  <span className="eyebrow tabular" style={{ flex: 'none' }}>
                    {fill(
                      c.itemCount === 1
                        ? t.benchmark.coverageItemCountOne
                        : t.benchmark.coverageItemCountOther,
                      { count: c.itemCount }
                    )}
                    {c.depths.length > 0 && ` · ${c.depths.map((d) => `D${d}`).join(' ')}`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <p className="section-label">{t.benchmark.runHistorySectionLabel}</p>
            {runs.length === 0 ? (
              <p className="note">{t.benchmark.noRunsYet}</p>
            ) : (
              <>
                <div className="spark" style={{ marginBottom: 18 }}>
                  {runs.map((r) => (
                    <span
                      key={r.id}
                      className="bar accent"
                      style={{ height: `${Math.max(2, (r.results.overall ?? 0) * 100)}%` }}
                      title={fill(t.benchmark.runBarTitle, {
                        date: r.runAt.slice(0, 10),
                        percent: Math.round((r.results.overall ?? 0) * 100),
                      })}
                    />
                  ))}
                </div>
                <div className="ledger">
                  {runs
                    .slice()
                    .reverse()
                    .map((r) => (
                      <div className="ledger-row" key={r.id} style={{ alignItems: 'flex-start' }}>
                        <span className="eyebrow tabular" style={{ width: 100, flex: 'none' }}>
                          {r.runAt.slice(0, 10)}
                        </span>
                        <span className="stack gap-6" style={{ flex: 1 }}>
                          <span className="note">
                            {Object.entries(r.results.byDepth ?? {})
                              .sort(([a], [b]) => a.localeCompare(b))
                              .map(([d, v]) => `${d} ${v.correct}/${v.n}`)
                              .join('  ·  ') || '—'}
                          </span>
                          <span className="note" style={{ color: 'var(--muted)' }}>
                            {Object.values(r.results.byNode ?? {})
                              .map((v) => `${v.title} ${Math.round(v.score * 100)}%`)
                              .join('  ·  ')}
                          </span>
                        </span>
                        <span className="value tabular" style={{ fontSize: 22, flex: 'none' }}>
                          {Math.round((r.results.overall ?? 0) * 100)}%
                        </span>
                      </div>
                    ))}
                </div>
              </>
            )}
          </div>

          <div className="panel">
            <p className="section-label">
              {fill(t.benchmark.frozenItemsSectionLabel, { count: frozen.length })}
            </p>
            {frozen.length === 0 ? (
              <p className="note">{t.benchmark.frozenItemsEmpty}</p>
            ) : (
              <div className="ledger">
                {frozen.map((i) => (
                  <div className="ledger-row" key={i.id} style={{ alignItems: 'flex-start' }}>
                    <span className="eyebrow" style={{ width: 170, flex: 'none' }}>
                      {i.node_title} · D{i.depth}
                    </span>
                    <span className="serif-body" style={{ flex: 1, fontSize: 16 }}>
                      {i.stem}
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
