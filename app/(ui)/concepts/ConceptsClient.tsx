'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export interface ConceptSummary {
  id: number;
  name: string;
  hasSource: boolean;
  sourceNote: string | null;
  nodeCount: number;
  coverage: number;
  dueCount: number;
}

export function NewConceptForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [hints, setHints] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;

    setBusy(true);
    setStatus('Creating the concept…');
    try {
      const res = await fetch('/api/concepts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), sourceText, sourceNote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'could not create the concept');

      const conceptId = data.concept.id as number;
      setStatus(
        'Decomposing the source into a blueprint. This takes a minute — it is one large ' +
          'call, and the map it produces is what every item is generated against.'
      );

      const bp = await fetch('/api/blueprint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conceptId, hints }),
      });
      const bpData = await bp.json();
      if (!bp.ok) throw new Error(bpData.error ?? 'blueprint generation failed');

      router.push(`/blueprint/${conceptId}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create}>
      <div className="inline-form">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Socialism, Bayes' theorem, CSS specificity…"
          disabled={busy}
          aria-label="Concept name"
        />
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Working…' : 'Begin'}
        </button>
      </div>

      <div className="row wrap gap-14" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn small"
          onClick={() => setExpanded((v) => !v)}
          disabled={busy}
        >
          {expanded ? 'Hide source' : 'Add source material'}
        </button>
        {!expanded && !sourceText.trim() && (
          <span className="note">
            Without source text, generation falls back to the textbook version of the concept and
            systematically misses whatever is idiosyncratic about your understanding.
          </span>
        )}
      </div>

      {expanded && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="source-text">
              Source material
            </label>
            <textarea
              id="source-text"
              className="field"
              rows={12}
              value={sourceText}
              disabled={busy}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="Paste the chapter, paper, lecture notes, or documentation you are learning this from. Every node and every item is grounded in this."
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="source-note">
              Where it came from
            </label>
            <input
              id="source-note"
              className="field"
              value={sourceNote}
              disabled={busy}
              onChange={(e) => setSourceNote(e.target.value)}
              placeholder="Ch. 4 of …  (add [contested] to force the politically-neutral prompt variant)"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="hints">
              Hints for the decomposition (optional)
            </label>
            <input
              id="hints"
              className="field"
              value={hints}
              disabled={busy}
              onChange={(e) => setHints(e.target.value)}
              placeholder="e.g. keep the historical material separate from the theoretical claims"
            />
          </div>
        </div>
      )}

      {status && (
        <p className="note" style={{ marginTop: 14 }}>
          {status}
        </p>
      )}
    </form>
  );
}

export function ConceptList({ concepts }: { concepts: ConceptSummary[] }) {
  return (
    <div className="grid-tiles" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}>
      {concepts.map((c) => (
        <div className="tile" key={c.id} style={{ gap: 12 }}>
          <div className="row gap-9" style={{ alignItems: 'baseline' }}>
            <Link
              href={`/dashboard/${c.id}`}
              style={{ font: "400 22px/1.15 var(--serif)", color: 'var(--ink)' }}
            >
              {c.name}
            </Link>
            {c.dueCount > 0 && (
              <span className="eyebrow-accent push tabular">{c.dueCount} due</span>
            )}
          </div>

          <div className="row gap-14">
            <span className="eyebrow tabular">{Math.round(c.coverage * 100)}% covered</span>
            <span className="eyebrow tabular">{c.nodeCount} nodes</span>
          </div>

          <div className="progress">
            <span style={{ width: `${Math.round(c.coverage * 100)}%` }} />
          </div>

          {!c.hasSource && (
            <span className="note" style={{ color: 'var(--terra)' }}>
              No source material — degraded mode.
            </span>
          )}

          <div className="row wrap gap-6" style={{ marginTop: 4 }}>
            <StartButton conceptId={c.id} disabled={c.nodeCount === 0} />
            <Link className="btn small" href={`/blueprint/${c.id}`}>
              Blueprint
            </Link>
          </div>
        </div>
      ))}
    </div>
  );
}

export function StartButton({
  conceptId,
  disabled,
  length,
  label = 'Train',
}: {
  conceptId: number;
  disabled?: boolean;
  length?: number;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conceptId, length }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'could not start a session');
      router.push(`/session/${data.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn small primary"
        disabled={busy || disabled}
        onClick={() => void start()}
      >
        {busy ? 'Assembling…' : label}
      </button>
      {error && (
        <span className="note" style={{ color: 'var(--terra)' }}>
          {error}
        </span>
      )}
    </>
  );
}
