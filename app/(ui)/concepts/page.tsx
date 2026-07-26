import { getDb } from '@/lib/db';
import { listConcepts } from '@/lib/db/queries';
import { loadCellSnapshots } from '@/lib/policy/snapshot';
import { coverage } from '@/lib/policy/frontier';
import { isDue } from '@/lib/schedule/decay';
import { now } from '@/lib/clock';
import { Topbar } from '@/components/Chrome';
import { ConceptList, NewConceptForm } from './ConceptsClient';
import { SpendStrip } from '@/components/SpendStrip';

export const dynamic = 'force-dynamic';

export default async function ConceptsPage() {
  const db = getDb();
  const at = now();

  const concepts = listConcepts(db).map((c) => {
    const cells = loadCellSnapshots(db, c.id).filter((x) => x.applicable);
    return {
      id: c.id,
      name: c.name,
      hasSource: Boolean(c.source_text && c.source_text.trim()),
      sourceNote: c.source_note,
      nodeCount: new Set(cells.map((x) => x.nodeId)).size,
      coverage: coverage(cells),
      dueCount: cells.filter((x) => isDue(x.nextDueAt, at)).length,
    };
  });

  return (
    <div className="shell">
      <Topbar subtitle="the endless knowledge gym" />
      <main className="page">
        <div className="column rise">
          <div className="row gap-14" style={{ marginBottom: 24 }}>
            <span
              style={{ width: 9, height: 9, background: 'var(--terra)', borderRadius: '50%' }}
              aria-hidden
            />
            <span className="eyebrow">The examination begins with a subject</span>
          </div>

          <h1 className="display">
            What shall we <em style={{ fontStyle: 'italic', color: 'var(--terra)' }}>examine</em>?
          </h1>
          <p className="lede">
            Name a concept and paste what you are learning it from. I will not lecture you — I will
            decompose the material, question you against the map, and keep coming back to the parts
            you cannot yet hold.
          </p>

          <NewConceptForm />

          {concepts.length > 0 && (
            <div className="mt-34">
              <p className="section-label">Under examination</p>
              <ConceptList concepts={concepts} />
            </div>
          )}

          <SpendStrip />
        </div>
      </main>
    </div>
  );
}
