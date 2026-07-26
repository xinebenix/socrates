'use client';

import type { Confidence } from '@/lib/mastery/bkt';
import { canSubmit, submitHint, type SubmitState } from '@/lib/ui/submitGuard';
import { depth } from '@/lib/prompts/depth';

const GREEK = ['Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ'];

const CONFIDENCE_CHOICES: { value: Confidence; key: string; label: string }[] = [
  { value: 'guessing', key: 'G', label: 'Guessing' },
  { value: 'unsure', key: 'U', label: 'Unsure' },
  { value: 'confident', key: 'C', label: 'Confident' },
];

export interface OptionView {
  id: number;
  position: number;
  text: string;
  /** Present only after submission. */
  isCorrect?: boolean;
  rationale?: string;
  misconceptionLabel?: string | null;
}

export interface McFeedbackView {
  kind: 'mc';
  correct: boolean;
  explanation: string;
  chosenOptionId: number;
  misconceptionLabel: string | null;
  options: OptionView[];
}

export interface FreeCriterionView {
  id: string;
  criterion: string;
  met: boolean;
  evidenceQuote: string | null;
  comment: string;
}

export interface FreeFeedbackView {
  kind: 'free';
  correct: boolean;
  score: number;
  threshold: number;
  criteria: FreeCriterionView[];
  missing: string[];
  misconceptionsDetected: string[];
  verdictSummary: string;
}

export type FeedbackView = McFeedbackView | FreeFeedbackView;

export interface ItemCardProps {
  kind: 'mc' | 'free';
  stem: string;
  nodeTitle: string;
  depthLevel: number;
  position: number;
  total: number;
  options: OptionView[];
  phase: 'answering' | 'feedback';
  selectedOptionId: number | null;
  freeText: string;
  confidence: Confidence | null;
  submitting: boolean;
  feedback: FeedbackView | null;
  onSelectOption: (id: number) => void;
  onFreeText: (v: string) => void;
  onConfidence: (c: Confidence) => void;
  onSubmit: () => void;
  onNext: () => void;
}

/**
 * One item, centered, nothing else on screen.
 *
 * Three invariants live in this component and are covered by acceptance tests 1, 2
 * and 5:
 *   1. Submit is disabled until a confidence value is selected.
 *   2. After feedback renders, no control exists that mutates the stored response.
 *   5. The feedback panel renders a rationale for all four options.
 */
export function ItemCard(props: ItemCardProps) {
  const {
    kind, stem, nodeTitle, depthLevel, position, total, options, phase,
    selectedOptionId, freeText, confidence, submitting, feedback,
  } = props;

  const state: SubmitState = {
    kind, phase, selectedOptionId, freeText, confidence, submitting,
  };
  const ready = canSubmit(state);
  const answered = phase === 'feedback';
  const d = depth(depthLevel);

  return (
    <article className="slab" data-testid="item-card">
      <div className="slab-head">
        <span className="eyebrow">
          Question {position} of {total}
        </span>
        <span
          style={{ width: 3, height: 3, background: 'var(--muted)', borderRadius: '50%' }}
          aria-hidden
        />
        <span className="eyebrow-accent">
          {d.short} · {d.name}
        </span>
        <span className="eyebrow push" style={{ letterSpacing: '0.14em' }}>
          {nodeTitle}
        </span>
      </div>

      <div style={{ padding: '30px 30px 8px' }}>
        <h2 className="slab-stem">{stem}</h2>
      </div>

      {kind === 'mc' ? (
        <div className="stack gap-9" style={{ padding: '18px 30px 4px' }}>
          {options.map((o, i) => {
            const chosen = selectedOptionId === o.id;
            const fb = answered ? optionRationale(feedback, o.id) : null;
            return (
              <button
                key={o.id}
                type="button"
                className="option"
                data-state={optionState(answered, chosen, fb?.isCorrect ?? false)}
                data-testid={`option-${o.id}`}
                disabled={answered || submitting}
                aria-pressed={chosen}
                onClick={() => props.onSelectOption(o.id)}
              >
                <span className="accent" aria-hidden />
                <span className="mark" aria-hidden>
                  {GREEK[i] ?? String(i + 1)}
                </span>
                <span className="body">
                  <span className="text">{o.text}</span>

                  {/* Invariant 5: a rationale for every option, not only the correct
                      one and not only the chosen one. */}
                  {answered && fb?.rationale && (
                    <span
                      className={`option-note ${fb.isCorrect ? 'correct' : chosen ? 'wrong' : ''}`}
                      data-testid={`rationale-${o.id}`}
                    >
                      {fb.rationale}
                    </span>
                  )}

                  {answered && !fb?.isCorrect && fb?.misconceptionLabel && (
                    <span className="misconception-tag" data-testid={`misconception-${o.id}`}>
                      {fb.misconceptionLabel}
                    </span>
                  )}
                </span>
                {answered && (
                  <span className="verdict">
                    {fb?.isCorrect ? 'correct' : chosen ? 'your choice' : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ padding: '18px 30px 4px' }}>
          <label className="field-label" htmlFor="free-answer">
            Your answer
          </label>
          <textarea
            id="free-answer"
            className="field"
            data-testid="free-answer"
            rows={10}
            value={freeText}
            disabled={answered || submitting}
            placeholder="Write it out. You will be graded on what is literally here, not on what you meant."
            onChange={(e) => props.onFreeText(e.target.value)}
          />
        </div>
      )}

      {/* Invariant 1: mandatory, and captured before submission. */}
      {!answered && (
        <div className="confidence">
          <span className="eyebrow">Before you submit — how sure are you?</span>
          <div className="confidence-options" role="group" aria-label="Confidence">
            {CONFIDENCE_CHOICES.map((c) => (
              <button
                key={c.value}
                type="button"
                className="confidence-btn"
                data-testid={`confidence-${c.value}`}
                aria-pressed={confidence === c.value}
                disabled={submitting}
                onClick={() => props.onConfidence(c.value)}
              >
                <span className="key" aria-hidden>
                  {c.key}
                </span>
                <span className="label">{c.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!answered && (
        <div className="row wrap gap-14" style={{ padding: '22px 30px 28px' }}>
          <button
            type="button"
            className="btn primary"
            data-testid="submit"
            disabled={!ready}
            onClick={props.onSubmit}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
          <span className="note">{submitting ? 'Recording…' : submitHint(state)}</span>
        </div>
      )}

      {answered && feedback && (
        <div className="feedback" data-correct={String(feedback.correct)} data-testid="feedback">
          <div className="row wrap gap-14" style={{ alignItems: 'baseline', marginBottom: 12 }}>
            <span className="feedback-head">
              {feedback.correct ? 'Just so.' : 'Not this time.'}
            </span>
            <span className="eyebrow">
              {feedback.kind === 'free'
                ? `${feedback.criteria.filter((c) => c.met).length} of ${feedback.criteria.length} criteria met · ${Math.round(feedback.score * 100)}% (pass at ${Math.round(feedback.threshold * 100)}%)`
                : feedback.correct
                  ? 'the principle beneath it'
                  : 'here is where it turns'}
            </span>
          </div>

          {feedback.kind === 'mc' ? (
            <>
              {feedback.misconceptionLabel && (
                <p className="serif-body" style={{ margin: '0 0 14px' }}>
                  You chose the answer someone believing{' '}
                  <em style={{ color: 'var(--terra)' }}>{feedback.misconceptionLabel}</em> would
                  choose.
                </p>
              )}
              <p
                className="serif-body"
                style={{ margin: '0 0 22px', maxWidth: '62ch', fontSize: 18, lineHeight: 1.62 }}
                data-testid="explanation"
              >
                {feedback.explanation}
              </p>
            </>
          ) : (
            <FreeFeedbackBody feedback={feedback} />
          )}

          <div className="row wrap gap-14">
            <button type="button" className="btn primary" data-testid="next" onClick={props.onNext}>
              Next question
            </button>
            <span className="note">
              or press <strong style={{ color: 'var(--muted-soft)' }}>Enter</strong>
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

function FreeFeedbackBody({ feedback }: { feedback: FreeFeedbackView }) {
  return (
    <div className="stack gap-14" style={{ marginBottom: 22 }}>
      <p className="serif-body" style={{ margin: 0, maxWidth: '62ch' }}>
        {feedback.verdictSummary}
      </p>

      <div className="ledger" data-testid="criteria">
        {feedback.criteria.map((c) => (
          <div className="ledger-row" key={c.id} style={{ alignItems: 'flex-start' }}>
            <span className={`dot ${c.met ? 'ok' : 'miss'}`} aria-hidden />
            <span className="stack gap-6" style={{ flex: 1, minWidth: 0 }}>
              <span className="serif-body" style={{ fontSize: 16 }}>
                {c.criterion}
              </span>
              {c.met && c.evidenceQuote ? (
                <span className="option-note correct">“{c.evidenceQuote}”</span>
              ) : (
                <span className="option-note wrong">
                  {c.comment || 'Nothing in the answer meets this.'}
                </span>
              )}
            </span>
            <span
              className="verdict"
              style={{ color: c.met ? 'var(--verd)' : 'var(--terra)', paddingTop: 2 }}
            >
              {c.met ? 'met' : 'not met'}
            </span>
          </div>
        ))}
      </div>

      {feedback.missing.length > 0 && (
        <div>
          <p className="section-label">What was absent</p>
          <ul className="serif-body" style={{ margin: 0, paddingLeft: 20 }}>
            {feedback.missing.map((m, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      {feedback.misconceptionsDetected.length > 0 && (
        <div>
          <p className="section-label" style={{ color: 'var(--terra)' }}>
            Beliefs the answer positively reveals
          </p>
          <ul className="serif-body" style={{ margin: 0, paddingLeft: 20 }}>
            {feedback.misconceptionsDetected.map((m, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function optionRationale(feedback: FeedbackView | null, optionId: number): OptionView | null {
  if (!feedback || feedback.kind !== 'mc') return null;
  return feedback.options.find((o) => o.id === optionId) ?? null;
}

function optionState(answered: boolean, chosen: boolean, isCorrect: boolean): string {
  if (!answered) return chosen ? 'chosen' : 'idle';
  if (isCorrect) return 'correct';
  return chosen ? 'wrong-chosen' : 'wrong';
}
