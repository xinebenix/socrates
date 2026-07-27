'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDict } from '@/components/I18nProvider';
import { fill } from '@/lib/i18n/dict';

export interface ConceptSummary {
  id: number;
  name: string;
  hasSource: boolean;
  sourceNote: string | null;
  shared: boolean;
  nodeCount: number;
  coverage: number;
  dueCount: number;
}

export interface LibraryEntry {
  id: number;
  name: string;
  bankSize: number;
}

export function NewConceptForm() {
  const t = useDict();
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
    setStatus(t.concepts.statusCreating);
    try {
      const res = await fetch('/api/concepts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), sourceText, sourceNote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.concepts.errorCreateFailed);

      const conceptId = data.concept.id as number;

      // Somebody has already decomposed this topic, so there is nothing to generate —
      // the blueprint and the item bank come with it and only the progress starts at
      // zero. Straight to the dashboard, and say what happened rather than letting a
      // stranger's map appear as though it were yours.
      if (data.joined) {
        router.push(`/dashboard/${conceptId}`);
        return;
      }

      setStatus(t.concepts.statusDecomposing);

      const bp = await fetch('/api/blueprint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conceptId, hints }),
      });
      const bpData = await bp.json();
      if (!bp.ok) throw new Error(bpData.error ?? t.concepts.errorBlueprintFailed);

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
          placeholder={t.concepts.nameInputPlaceholder}
          disabled={busy}
          aria-label={t.concepts.nameInputAriaLabel}
        />
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? t.concepts.beginButtonBusy : t.concepts.beginButton}
        </button>
      </div>

      <div className="row wrap gap-14" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn small"
          onClick={() => setExpanded((v) => !v)}
          disabled={busy}
        >
          {expanded ? t.concepts.hideSourceButton : t.concepts.addSourceButton}
        </button>
        {!expanded && !sourceText.trim() && (
          <span className="note">{t.concepts.noSourceWarning}</span>
        )}
      </div>

      {expanded && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="source-text">
              {t.concepts.sourceTextLabel}
            </label>
            <textarea
              id="source-text"
              className="field"
              rows={12}
              value={sourceText}
              disabled={busy}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder={t.concepts.sourceTextPlaceholder}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="source-note">
              {t.concepts.sourceNoteLabel}
            </label>
            <input
              id="source-note"
              className="field"
              value={sourceNote}
              disabled={busy}
              onChange={(e) => setSourceNote(e.target.value)}
              placeholder={t.concepts.sourceNotePlaceholder}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="hints">
              {t.concepts.hintsLabel}
            </label>
            <input
              id="hints"
              className="field"
              value={hints}
              disabled={busy}
              onChange={(e) => setHints(e.target.value)}
              placeholder={t.concepts.hintsPlaceholder}
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
  const t = useDict();

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
              <span className="eyebrow-accent push tabular">
                {fill(t.concepts.dueBadge, { count: c.dueCount })}
              </span>
            )}
          </div>

          <div className="row gap-14">
            <span className="eyebrow tabular">
              {fill(t.concepts.coveredStat, { percent: Math.round(c.coverage * 100) })}
            </span>
            <span className="eyebrow tabular">
              {fill(t.concepts.nodesStat, { count: c.nodeCount })}
            </span>
          </div>

          <div className="progress">
            <span style={{ width: `${Math.round(c.coverage * 100)}%` }} />
          </div>

          {!c.hasSource && (
            <span className="note" style={{ color: 'var(--terra)' }}>
              {c.shared ? t.concepts.sharedConceptNote : t.concepts.degradedModeNote}
            </span>
          )}

          <div className="row wrap gap-6" style={{ marginTop: 4 }}>
            <StartButton conceptId={c.id} disabled={c.nodeCount === 0} />
            <Link className="btn small" href={`/blueprint/${c.id}`}>
              {t.concepts.blueprintLink}
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
  label,
}: {
  conceptId: number;
  disabled?: boolean;
  length?: number;
  label?: string;
}) {
  const t = useDict();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defaulted here rather than in the parameter list: the dictionary comes from a hook,
  // which cannot be called while the default expression is evaluated.
  const buttonLabel = label ?? t.concepts.trainButton;

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
      if (!res.ok) throw new Error(data.error ?? t.concepts.errorSessionStartFailed);
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
        {busy ? t.concepts.trainButtonBusy : buttonLabel}
      </button>
      {error && (
        <span className="note" style={{ color: 'var(--terra)' }}>
          {error}
        </span>
      )}
    </>
  );
}

/**
 * Concepts somebody else has already built.
 *
 * Joining one is the cheapest thing in the app: the blueprint is one large Opus call and
 * a stocked concept is dozens more, and this is a row. Only sourceless concepts appear
 * here — a concept grounded in somebody's own material is theirs and never listed.
 */
export function SharedLibrary({ concepts }: { concepts: LibraryEntry[] }) {
  const t = useDict();
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function join(entry: LibraryEntry) {
    setBusy(entry.id);
    setError(null);
    try {
      // Creating by the same name is the join: the API matches the normalised name and
      // hands back the existing concept rather than building a second one.
      const res = await fetch('/api/concepts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: entry.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.concepts.errorCreateFailed);
      router.push(`/dashboard/${data.concept.id as number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <>
      <div
        className="grid-tiles"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}
      >
        {concepts.map((c) => (
          <div className="tile" key={c.id} style={{ gap: 12 }}>
            <span style={{ font: "400 22px/1.15 var(--serif)", color: 'var(--ink)' }}>{c.name}</span>
            <span className="eyebrow tabular">
              {fill(t.concepts.libraryBankSize, { count: c.bankSize })}
            </span>
            <div className="row wrap gap-6" style={{ marginTop: 4 }}>
              <button
                type="button"
                className="btn small primary"
                disabled={busy !== null}
                onClick={() => void join(c)}
              >
                {busy === c.id ? t.concepts.libraryJoinButtonBusy : t.concepts.libraryJoinButton}
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p className="note" style={{ color: 'var(--terra)', marginTop: 10 }}>
          {error}
        </p>
      )}
    </>
  );
}
