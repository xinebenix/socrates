'use client';

import type { Confidence } from '@/lib/mastery/bkt';
import { canSubmit, submitHintKey, type SubmitState } from '@/lib/ui/submitGuard';
import { depth } from '@/lib/prompts/depth';
import { useDict, useLocale } from '@/components/I18nProvider';
import { fill, type Dict } from '@/lib/i18n/dict';
import type { Locale } from '@/lib/i18n/locale';

/**
 * How the options are labelled, per locale.
 *
 * English keeps the Greek series — it is of a piece with Τέλος and Γνῶθι σεαυτόν
 * elsewhere in the interface. Chinese does not: ABCD is what a multiple-choice option
 * is called there, in every exam a reader has ever sat, and Α/Β/Γ/Δ reads as an
 * unfamiliar alphabet rather than as a flourish. A reader saying "选 B" should be able
 * to see a B.
 */
const OPTION_MARKS: Record<Locale, readonly string[]> = {
  en: ['Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ'],
  zh: ['A', 'B', 'C', 'D', 'E', 'F'],
};

const CONFIDENCE_CHOICES: {
  value: Confidence;
  key: string;
  labelKey: keyof Dict['session'];
}[] = [
  { value: 'guessing', key: 'G', labelKey: 'confidenceGuessing' },
  { value: 'unsure', key: 'U', labelKey: 'confidenceUnsure' },
  { value: 'confident', key: 'C', labelKey: 'confidenceConfident' },
];

/**
 * Render a template whose single `{placeholder}` is markup rather than text — the
 * emphasised misconception label, the key cap in the advance hint. Splitting on the
 * placeholder keeps the words either side of the hole translatable while the hole
 * itself stays a React node.
 */
function withNode(template: string, name: string, node: React.ReactNode) {
  const [before, ...rest] = template.split(`{${name}}`);
  return (
    <>
      {before}
      {node}
      {rest.join(`{${name}}`)}
    </>
  );
}

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
  /** Null when the learner declined the item rather than answering it. */
  chosenOptionId: number | null;
  misconceptionLabel: string | null;
  options: OptionView[];
  /** The answer was revealed on request, not earned. */
  declined?: boolean;
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
  /** The rubric was revealed on request; nothing was written, so nothing was graded. */
  declined?: boolean;
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
  /**
   * Seconds left before the item can be given up on, or null for no countdown at all.
   * At zero the "I don't know" control appears; it never appears before then.
   */
  secondsLeft: number | null;
  onSelectOption: (id: number) => void;
  onFreeText: (v: string) => void;
  onConfidence: (c: Confidence) => void;
  onSubmit: () => void;
  onDontKnow: () => void;
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
    selectedOptionId, freeText, confidence, submitting, feedback, secondsLeft,
  } = props;

  const t = useDict();
  const locale = useLocale();
  const marks = OPTION_MARKS[locale] ?? OPTION_MARKS.en;
  const state: SubmitState = {
    kind, phase, selectedOptionId, freeText, confidence, submitting,
  };
  const ready = canSubmit(state);
  const answered = phase === 'feedback';
  const d = depth(depthLevel);

  // The escape hatch opens only once the countdown has run out. Ten seconds of
  // trying to retrieve the answer is the part that does the work; a button that
  // was there from the first render would be pressed instead of thought about.
  const canGiveUp = !answered && secondsLeft === 0;
  const declined = Boolean(feedback?.declined);

  return (
    <article className="slab" data-testid="item-card">
      <div className="slab-head">
        <span className="eyebrow">
          {fill(t.session.questionCounter, { position, total })}
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

      <div className="card-stem">
        <h2 className="slab-stem">{stem}</h2>
      </div>

      {kind === 'mc' ? (
        <div className="stack gap-9 card-body">
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
                  {marks[i] ?? String(i + 1)}
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
                    {fb?.isCorrect
                      ? t.session.verdictCorrect
                      : chosen
                        ? t.session.verdictYourChoice
                        : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="card-body">
          <label className="field-label" htmlFor="free-answer">
            {t.session.yourAnswerLabel}
          </label>
          <textarea
            id="free-answer"
            className="field"
            data-testid="free-answer"
            rows={10}
            value={freeText}
            disabled={answered || submitting}
            placeholder={t.session.freeAnswerPlaceholder}
            onChange={(e) => props.onFreeText(e.target.value)}
          />
        </div>
      )}

      {/* Invariant 1: mandatory, and captured before submission. */}
      {!answered && (
        <div className="confidence">
          <span className="eyebrow">{t.session.confidencePrompt}</span>
          <div
            className="confidence-options"
            role="group"
            aria-label={t.session.confidenceGroupLabel}
          >
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
                <span className="label">{t.session[c.labelKey]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!answered && (
        <div className="card-actions">
          <div className="row wrap gap-14">
            <button
              type="button"
              className="btn primary"
              data-testid="submit"
              disabled={!ready}
              onClick={props.onSubmit}
            >
              {submitting ? t.session.submitting : t.session.submit}
            </button>

            {secondsLeft !== null && secondsLeft > 0 && (
              // Ticking text, hidden from screen readers: a per-second announcement
              // would drown out the question it is counting against.
              <span className="countdown tabular" data-testid="countdown" aria-hidden>
                {fill(t.session.countdownRemaining, { seconds: secondsLeft })}
              </span>
            )}

            {/* The live region exists from the first render, empty, so that the
                button's arrival is what gets announced. */}
            <span aria-live="polite">
              {canGiveUp && (
                <button
                  type="button"
                  className="btn"
                  data-testid="dont-know"
                  disabled={submitting}
                  onClick={props.onDontKnow}
                >
                  {t.session.dontKnow}
                </button>
              )}
            </span>

            <span className="note">
              {submitting ? t.session.recording : t.session[submitHintKey(state)]}
            </span>
          </div>

          {canGiveUp && (
            <p className="note" style={{ margin: '12px 0 0' }}>
              {t.session.dontKnowHint}
            </p>
          )}
        </div>
      )}

      {answered && feedback && (
        <div className="feedback" data-correct={String(feedback.correct)} data-testid="feedback">
          <div className="row wrap gap-14" style={{ alignItems: 'baseline', marginBottom: 12 }}>
            <span className="feedback-head">
              {declined
                ? t.session.feedbackHeadDontKnow
                : feedback.correct
                  ? t.session.feedbackHeadCorrect
                  : t.session.feedbackHeadWrong}
            </span>
            <span className="eyebrow">
              {declined
                ? t.session.feedbackEyebrowDontKnow
                : feedback.kind === 'free'
                  ? fill(t.session.criteriaMetSummary, {
                      met: feedback.criteria.filter((c) => c.met).length,
                      criteria: feedback.criteria.length,
                      score: Math.round(feedback.score * 100),
                      threshold: Math.round(feedback.threshold * 100),
                    })
                  : feedback.correct
                    ? t.session.feedbackEyebrowCorrect
                    : t.session.feedbackEyebrowWrong}
            </span>
          </div>

          {feedback.kind === 'mc' ? (
            <>
              {feedback.misconceptionLabel && (
                <p className="serif-body" style={{ margin: '0 0 14px' }}>
                  {withNode(
                    t.session.misconceptionAttribution,
                    'misconception',
                    <em style={{ color: 'var(--terra)' }}>{feedback.misconceptionLabel}</em>
                  )}
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
              {t.session.nextQuestion}
            </button>
            <span className="note">
              {withNode(
                t.session.orPressKey,
                'key',
                <strong style={{ color: 'var(--muted-soft)' }}>Enter</strong>
              )}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

function FreeFeedbackBody({ feedback }: { feedback: FreeFeedbackView }) {
  const t = useDict();
  const declined = Boolean(feedback.declined);
  return (
    <div className="stack gap-14" style={{ marginBottom: 22 }}>
      <p className="serif-body" style={{ margin: 0, maxWidth: '62ch' }}>
        {declined ? t.session.dontKnowFreeSummary : feedback.verdictSummary}
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
                  {c.comment ||
                    (declined
                      ? t.session.dontKnowCriterionNote
                      : t.session.criterionUnmetFallback)}
                </span>
              )}
            </span>
            <span
              className="verdict"
              style={{ color: c.met ? 'var(--verd)' : 'var(--terra)', paddingTop: 2 }}
            >
              {c.met ? t.session.criterionMet : t.session.criterionNotMet}
            </span>
          </div>
        ))}
      </div>

      {feedback.missing.length > 0 && (
        <div>
          <p className="section-label">{t.session.whatWasAbsent}</p>
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
            {t.session.beliefsRevealed}
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
