import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getConcept, listMisconceptions, listNodes } from '@/lib/db/queries';
import { buildGrid } from '@/lib/stats';
import { blueprintAlarm } from '@/lib/analysis/itemStats';
import { Topbar } from '@/components/Chrome';
import { BlueprintEditor } from './BlueprintEditor';

export const dynamic = 'force-dynamic';

export default async function BlueprintPage({
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

  const nodes = listNodes(db, conceptId).map((n) => ({
    ...n,
    misconceptions: listMisconceptions(db, n.id),
  }));

  return (
    <div className="shell">
      <Topbar subtitle={concept.name} conceptId={conceptId} />
      <main className="page">
        <div className="column wide rise">
          <p className="eyebrow" style={{ marginBottom: 14 }}>
            The blueprint — nodes across, depth down
          </p>
          <h1 className="display">{concept.name}</h1>
          <p className="lede">
            This map is a knowledge artifact and it can be wrong. Every item inherits its errors, so
            a wrong blueprint produces well-formed items testing the wrong things — with scores that
            look fine. Edit it by hand. That is not a fallback, it is the intended workflow.
          </p>

          <BlueprintEditor
            conceptId={conceptId}
            initialNodes={nodes}
            initialGrid={buildGrid(db, conceptId)}
            alarm={blueprintAlarm(db, conceptId)}
            hasSource={Boolean(concept.source_text && concept.source_text.trim())}
            initialSource={concept.source_text ?? ''}
            initialNote={concept.source_note ?? ''}
          />
        </div>
      </main>
    </div>
  );
}
