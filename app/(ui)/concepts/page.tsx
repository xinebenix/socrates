import { getDb } from '@/lib/db';
import { listConcepts, listSharedLibrary } from '@/lib/db/queries';
import { requireUser } from '@/lib/session';
import { loadCellSnapshots } from '@/lib/policy/snapshot';
import { coverage } from '@/lib/policy/frontier';
import { isDue } from '@/lib/schedule/decay';
import { now } from '@/lib/clock';
import { Topbar } from '@/components/Chrome';
import { getDict } from '@/lib/i18n/server';
import { ConceptList, NewConceptForm, SharedLibrary } from './ConceptsClient';

export const dynamic = 'force-dynamic';

export default async function ConceptsPage() {
  const t = await getDict();
  const db = getDb();
  const user = await requireUser();
  const at = now();

  // The heading carries an emphasised span, so the template is split around its
  // placeholder rather than filled — the two halves bracket the <em>.
  const [headingBefore, headingAfter] = t.concepts.heading.split('{emphasis}');

  const concepts = listConcepts(db, user.id).map((c) => {
    const cells = loadCellSnapshots(db, user.id, c.id).filter((x) => x.applicable);
    return {
      id: c.id,
      name: c.name,
      hasSource: Boolean(c.source_text && c.source_text.trim()),
      sourceNote: c.source_note,
      shared: c.visibility === 'shared',
      nodeCount: new Set(cells.map((x) => x.nodeId)).size,
      coverage: coverage(cells),
      dueCount: cells.filter((x) => isDue(x.nextDueAt, at)).length,
    };
  });

  // Concepts other people have already built and paid for. Starting one of these costs
  // a row rather than a blueprint generation and a stocked item bank.
  const library = listSharedLibrary(db, user.id).map((c) => ({
    id: c.id,
    name: c.name,
    bankSize: c.bank_size,
  }));

  return (
    <div className="shell">
      <Topbar subtitle={t.concepts.topbarSubtitle} />
      <main className="page">
        <div className="column rise">
          <div className="row gap-14" style={{ marginBottom: 24 }}>
            <span
              style={{ width: 9, height: 9, background: 'var(--terra)', borderRadius: '50%' }}
              aria-hidden
            />
            <span className="eyebrow">{t.concepts.eyebrow}</span>
          </div>

          <h1 className="display">
            {headingBefore}
            <em className="accent">{t.concepts.headingEmphasis}</em>
            {headingAfter}
          </h1>
          <p className="lede">{t.concepts.lede}</p>

          <NewConceptForm />

          {concepts.length > 0 && (
            <div className="mt-34">
              <p className="section-label">{t.concepts.listSectionLabel}</p>
              <ConceptList concepts={concepts} />
            </div>
          )}

          {library.length > 0 && (
            <div className="mt-34">
              <p className="section-label">{t.concepts.librarySectionLabel}</p>
              <p className="note" style={{ marginBottom: 14 }}>
                {t.concepts.libraryNote}
              </p>
              <SharedLibrary concepts={library} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
