import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getConcept, listMisconceptions, listNodes } from '@/lib/db/queries';
import { buildGrid } from '@/lib/stats';
import { blueprintAlarm } from '@/lib/analysis/itemStats';
import { Topbar } from '@/components/Chrome';
import { getDict } from '@/lib/i18n/server';
import { BlueprintEditor } from './BlueprintEditor';

export const dynamic = 'force-dynamic';

export default async function BlueprintPage({
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
            {t.blueprint.eyebrow}
          </p>
          <h1 className="display">{concept.name}</h1>
          <p className="lede">{t.blueprint.lede}</p>

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
