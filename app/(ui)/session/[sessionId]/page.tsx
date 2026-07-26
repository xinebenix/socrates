import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getConcept, getSession } from '@/lib/db/queries';
import { Topbar } from '@/components/Chrome';
import { SessionRunner } from '@/components/SessionRunner';
import { EndSessionButton } from './EndSessionButton';

export const dynamic = 'force-dynamic';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId: raw } = await params;
  const sessionId = Number(raw);
  if (!Number.isFinite(sessionId)) notFound();

  const db = getDb();
  const session = getSession(db, sessionId);
  if (!session) notFound();

  const concept = getConcept(db, session.concept_id);
  if (!concept) notFound();

  return (
    <div className="shell">
      <Topbar
        subtitle={session.kind === 'benchmark' ? 'benchmark run' : concept.name}
        right={<EndSessionButton sessionId={sessionId} conceptId={concept.id} />}
      />
      <main className="page" style={{ paddingTop: 26 }}>
        <SessionRunner
          sessionId={sessionId}
          conceptId={concept.id}
          conceptName={concept.name}
        />
      </main>
    </div>
  );
}
