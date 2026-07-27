import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import {
  canEditConcept,
  canReadConcept,
  getConcept,
  listMisconceptions,
  listMisconceptionsWithState,
  listNodes,
} from '@/lib/db/queries';
import { requireUser } from '@/lib/session';
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
  const user = await requireUser();
  const concept = getConcept(db, conceptId);
  if (!concept || !canReadConcept(concept, user.id)) notFound();

  const selections = new Map(
    listMisconceptionsWithState(db, user.id, conceptId).map((m) => [m.id, m.times_selected])
  );
  const nodes = listNodes(db, conceptId).map((n) => ({
    ...n,
    misconceptions: listMisconceptions(db, n.id).map((m) => ({
      ...m,
      // "Selected 4×" is a claim about the reader, not about the concept. On a shared
      // blueprint the global count would be somebody else's confusion.
      times_selected: selections.get(m.id) ?? 0,
    })),
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
            // A shared blueprint is other people's map too. Non-owners read it and fork.
            canEdit={canEditConcept(concept, user.id)}
            visibility={concept.visibility}
            initialNodes={nodes}
            initialGrid={buildGrid(db, user.id, conceptId)}
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
