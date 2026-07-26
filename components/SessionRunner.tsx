'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Confidence } from '@/lib/mastery/bkt';
import { canSubmit } from '@/lib/ui/submitGuard';
import { useDict } from '@/components/I18nProvider';
import { fill } from '@/lib/i18n/dict';
import { ItemCard, type FeedbackView, type OptionView } from './ItemCard';

const LOADING_LABEL_KEYS = [
  'loadingConsidering',
  'loadingFraming',
  'loadingSharpening',
  'loadingHarderCase',
] as const;

interface ServedItem {
  kind: 'mc' | 'free';
  itemId: number;
  cellId: number;
  stem: string;
  nodeTitle: string;
  depth: number;
  position: number;
  total: number;
  options?: { id: number; position: number; text: string }[];
}

export function SessionRunner({
  sessionId,
  conceptId,
  conceptName,
}: {
  sessionId: number;
  conceptId: number;
  conceptName: string;
}) {
  const t = useDict();
  const [item, setItem] = useState<ServedItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadIdx, setLoadIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [kindOfSession, setKindOfSession] = useState<'practice' | 'benchmark'>('practice');

  const [selectedOptionId, setSelectedOptionId] = useState<number | null>(null);
  const [freeText, setFreeText] = useState('');
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackView | null>(null);
  const [progress, setProgress] = useState({ total: 0, served: 0, answered: 0 });

  const shownAt = useRef<number>(Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFeedback(null);
    setSelectedOptionId(null);
    setFreeText('');
    setConfidence(null);

    try {
      const res = await fetch(`/api/session/${sessionId}/next-item`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.session.errorFetchNextItem);

      setKindOfSession(data.kind);
      setProgress(data.progress);
      if (data.warning) setError(data.warning as string);
      if (data.done || !data.item) {
        setDone(true);
        setItem(null);
      } else {
        setItem(data.item as ServedItem);
        shownAt.current = Date.now();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!loading) return;
    const timer = setInterval(
      () => setLoadIdx((i) => (i + 1) % LOADING_LABEL_KEYS.length),
      2200
    );
    return () => clearInterval(timer);
  }, [loading]);

  const submit = useCallback(async () => {
    if (!item || confidence === null || submitting) return;
    if (
      !canSubmit({
        kind: item.kind,
        phase: feedback ? 'feedback' : 'answering',
        selectedOptionId,
        freeText,
        confidence,
        submitting,
      })
    ) {
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/session/${sessionId}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId: item.itemId,
          chosenOptionId: item.kind === 'mc' ? selectedOptionId : undefined,
          freeText: item.kind === 'free' ? freeText : undefined,
          confidence,
          latencyMs: Date.now() - shownAt.current,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.session.errorRecordAnswer);

      setProgress(data.progress);

      // A benchmark run shows no feedback until the whole run is complete.
      if (data.deferred) {
        if (data.complete) setDone(true);
        else await load();
        return;
      }

      setFeedback(toFeedbackView(item, data.feedback));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [item, confidence, submitting, feedback, selectedOptionId, freeText, sessionId, load, t]);

  // Keyboard: 1-4 pick, G/U/C set confidence, Enter submits then advances.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'TEXTAREA' ||
        (target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text');

      if (e.key === 'Enter' && (!typing || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (feedback) void load();
        else void submit();
        return;
      }
      if (!item || feedback || typing) return;

      if (item.kind === 'mc' && item.options) {
        const i = ['1', '2', '3', '4', '5', '6'].indexOf(e.key);
        if (i >= 0 && i < item.options.length) {
          setSelectedOptionId(item.options[i].id);
          return;
        }
      }
      const k = e.key.toLowerCase();
      if (k === 'g') setConfidence('guessing');
      else if (k === 'u') setConfidence('unsure');
      else if (k === 'c') setConfidence('confident');
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, feedback, submit, load]);

  const pct = progress.total > 0 ? Math.round((progress.answered / progress.total) * 100) : 0;

  if (done) {
    return (
      <div className="column narrow rise">
        <p className="eyebrow" style={{ marginBottom: 16 }}>
          {t.session.endEyebrow}
        </p>
        <h1 className="display">{conceptName}</h1>
        <p className="lede">
          {fill(t.session.endItemsAnswered, {
            answered: progress.answered,
            total: progress.total,
          })}{' '}
          {kindOfSession === 'benchmark'
            ? t.session.endBenchmarkNote
            : t.session.endMasteryNote}
        </p>
        <div className="row wrap gap-9">
          <Link className="btn primary" href={`/dashboard/${conceptId}`}>
            {t.session.seeDashboard}
          </Link>
          <Link className="btn" href={`/concepts`}>
            {t.session.backToConcepts}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="column narrow">
      {/* A thin progress bar and nothing resembling a streak counter. */}
      <div className="row gap-14" style={{ marginBottom: 18 }}>
        <span className="eyebrow" style={{ flex: 'none' }}>
          {conceptName}
        </span>
        <span className="progress" style={{ flex: 1 }}>
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="eyebrow tabular" style={{ flex: 'none' }}>
          {fill(t.session.progressCount, {
            answered: progress.answered,
            total: progress.total,
          })}
        </span>
      </div>

      {error && (
        <div className="warnbox" style={{ marginBottom: 16 }}>
          <p style={{ margin: '0 0 12px' }}>{error}</p>
          <button type="button" className="btn danger small" onClick={() => void load()}>
            {t.session.askAgain}
          </button>
        </div>
      )}

      {loading && <LoadingSlab label={t.session[LOADING_LABEL_KEYS[loadIdx]]} />}

      {!loading && item && (
        <ItemCard
          kind={item.kind}
          stem={item.stem}
          nodeTitle={item.nodeTitle}
          depthLevel={item.depth}
          position={item.position}
          total={item.total}
          options={(item.options ?? []).map((o) => ({
            id: o.id,
            position: o.position,
            text: o.text,
          }))}
          phase={feedback ? 'feedback' : 'answering'}
          selectedOptionId={selectedOptionId}
          freeText={freeText}
          confidence={confidence}
          submitting={submitting}
          feedback={feedback}
          onSelectOption={setSelectedOptionId}
          onFreeText={setFreeText}
          onConfidence={setConfidence}
          onSubmit={() => void submit()}
          onNext={() => void load()}
        />
      )}
    </div>
  );
}

function LoadingSlab({ label }: { label: string }) {
  return (
    <div className="slab fade" style={{ padding: '44px 38px' }}>
      <div className="eyebrow breathe" style={{ marginBottom: 24 }}>
        {label}
      </div>
      <div className="shimmer" style={{ height: 16, width: '92%', marginBottom: 11 }} />
      <div className="shimmer" style={{ height: 16, width: '64%', marginBottom: 30 }} />
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            height: 46,
            marginBottom: 9,
            borderRadius: 2,
            background: 'rgba(var(--ink-rgb),.05)',
          }}
        />
      ))}
    </div>
  );
}

interface RawMcFeedback {
  correct: boolean;
  explanation: string;
  chosenOptionId: number;
  misconceptionLabel: string | null;
  options: {
    id: number;
    position: number;
    text: string;
    is_correct: number;
    rationale: string;
    misconception_label: string | null;
  }[];
}

interface RawFreeFeedback {
  correct: boolean;
  score: number;
  verdict: {
    criteria: { id: string; met: boolean; evidence_quote: string | null; comment: string }[];
    missing: string[];
    misconceptions_detected: string[];
    verdict_summary: string;
  };
  rubric: { id: string; criterion: string }[];
}

function toFeedbackView(item: ServedItem, raw: RawMcFeedback | RawFreeFeedback): FeedbackView {
  if (item.kind === 'mc') {
    const mc = raw as RawMcFeedback;
    const options: OptionView[] = mc.options.map((o) => ({
      id: o.id,
      position: o.position,
      text: o.text,
      isCorrect: o.is_correct === 1,
      rationale: o.rationale,
      misconceptionLabel: o.misconception_label,
    }));
    return {
      kind: 'mc',
      correct: mc.correct,
      explanation: mc.explanation,
      chosenOptionId: mc.chosenOptionId,
      misconceptionLabel: mc.misconceptionLabel,
      options,
    };
  }

  const free = raw as RawFreeFeedback;
  const labels = new Map(free.rubric.map((r) => [r.id, r.criterion]));
  return {
    kind: 'free',
    correct: free.correct,
    score: free.score,
    threshold: 0.8,
    criteria: free.verdict.criteria.map((c) => ({
      id: c.id,
      criterion: labels.get(c.id) ?? c.id,
      met: c.met,
      evidenceQuote: c.evidence_quote,
      comment: c.comment,
    })),
    missing: free.verdict.missing,
    misconceptionsDetected: free.verdict.misconceptions_detected,
    verdictSummary: free.verdict.verdict_summary,
  };
}
