/**
 * @vitest-environment jsdom
 *
 * Acceptance tests 1, 2 and 5 — the three invariants that live in the answer surface.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemCard, type ItemCardProps, type McFeedbackView } from '../../components/ItemCard';
import { canSubmit } from '../../lib/ui/submitGuard';

/** The full countdown: an item that has just been put on screen. */
const COUNTDOWN_SECONDS = 10;

const OPTIONS = [
  { id: 11, position: 1, text: 'Society as a whole holds title to the means of production.' },
  { id: 12, position: 2, text: 'A government agency holds title on behalf of the public.' },
  { id: 13, position: 3, text: 'Income is transferred from higher to lower earners.' },
  { id: 14, position: 4, text: 'Prices are set by a central planning board.' },
];

const FEEDBACK: McFeedbackView = {
  kind: 'mc',
  correct: false,
  explanation: 'Ownership, not administration, is the distinguishing feature.',
  chosenOptionId: 12,
  misconceptionLabel: 'state ownership = social ownership',
  options: [
    {
      id: 11,
      position: 1,
      text: OPTIONS[0].text,
      isCorrect: true,
      rationale: 'This is the definition the source gives.',
      misconceptionLabel: null,
    },
    {
      id: 12,
      position: 2,
      text: OPTIONS[1].text,
      isCorrect: false,
      rationale: 'Conflates a state holding title with society holding it.',
      misconceptionLabel: 'state ownership = social ownership',
    },
    {
      id: 13,
      position: 3,
      text: OPTIONS[2].text,
      isCorrect: false,
      rationale: 'Mistakes a transfer of income for a change in ownership.',
      misconceptionLabel: 'socialism = redistribution',
    },
    {
      id: 14,
      position: 4,
      text: OPTIONS[3].text,
      isCorrect: false,
      rationale: 'Treats one allocation mechanism as definitional.',
      misconceptionLabel: 'socialism requires central planning',
    },
  ],
};

function makeProps(overrides: Partial<ItemCardProps> = {}): ItemCardProps {
  return {
    kind: 'mc',
    stem: 'Which statement best captures what social ownership requires?',
    nodeTitle: 'Ownership structures',
    depthLevel: 5,
    position: 3,
    total: 20,
    options: OPTIONS,
    phase: 'answering',
    selectedOptionId: null,
    freeText: '',
    confidence: null,
    submitting: false,
    feedback: null,
    secondsLeft: COUNTDOWN_SECONDS,
    onSelectOption: vi.fn(),
    onFreeText: vi.fn(),
    onConfidence: vi.fn(),
    onSubmit: vi.fn(),
    onDontKnow: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  };
}

beforeEach(cleanup);

/* ------------------------------------------------------------------- test 1 */

describe('AT1 — submit is disabled until a confidence value is selected (invariant 1)', () => {
  it('is disabled with an option chosen but no confidence', () => {
    render(<ItemCard {...makeProps({ selectedOptionId: 11, confidence: null })} />);
    expect(screen.getByTestId('submit')).toBeDisabled();
  });

  it('is disabled with confidence chosen but no option', () => {
    render(<ItemCard {...makeProps({ selectedOptionId: null, confidence: 'confident' })} />);
    expect(screen.getByTestId('submit')).toBeDisabled();
  });

  it('is enabled only once both are present', () => {
    render(<ItemCard {...makeProps({ selectedOptionId: 11, confidence: 'unsure' })} />);
    expect(screen.getByTestId('submit')).toBeEnabled();
  });

  it('clicking a disabled submit does not fire onSubmit', async () => {
    const onSubmit = vi.fn();
    render(<ItemCard {...makeProps({ selectedOptionId: 11, confidence: null, onSubmit })} />);
    await userEvent.click(screen.getByTestId('submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('offers exactly the three confidence states and no default', () => {
    render(<ItemCard {...makeProps()} />);
    for (const v of ['guessing', 'unsure', 'confident']) {
      expect(screen.getByTestId(`confidence-${v}`)).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('the guard itself refuses free-response submission without confidence', () => {
    expect(
      canSubmit({
        kind: 'free',
        phase: 'answering',
        selectedOptionId: null,
        freeText: 'a real answer',
        confidence: null,
        submitting: false,
      })
    ).toBe(false);

    expect(
      canSubmit({
        kind: 'free',
        phase: 'answering',
        selectedOptionId: null,
        freeText: 'a real answer',
        confidence: 'guessing',
        submitting: false,
      })
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------- test 2 */

describe('AT2 — no control mutates the stored response after feedback (invariant 2)', () => {
  const answered = makeProps({
    phase: 'feedback',
    selectedOptionId: 12,
    confidence: 'confident',
    feedback: FEEDBACK,
  });

  it('the submit control no longer exists', () => {
    render(<ItemCard {...answered} />);
    expect(screen.queryByTestId('submit')).toBeNull();
  });

  it('the confidence control no longer exists', () => {
    render(<ItemCard {...answered} />);
    for (const v of ['guessing', 'unsure', 'confident']) {
      expect(screen.queryByTestId(`confidence-${v}`)).toBeNull();
    }
  });

  it('every option is disabled and cannot be re-chosen', async () => {
    const onSelectOption = vi.fn();
    render(<ItemCard {...{ ...answered, onSelectOption }} />);

    for (const o of OPTIONS) {
      const btn = screen.getByTestId(`option-${o.id}`);
      expect(btn).toBeDisabled();
      await userEvent.click(btn);
    }
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it('the only remaining control advances to the next item', async () => {
    const onNext = vi.fn();
    render(<ItemCard {...{ ...answered, onNext }} />);

    const card = screen.getByTestId('item-card');
    const enabled = within(card)
      .getAllByRole('button')
      .filter((b) => !(b as HTMLButtonElement).disabled);

    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toHaveAttribute('data-testid', 'next');

    await userEvent.click(enabled[0]);
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('a free-response textarea is read-only after feedback', () => {
    render(
      <ItemCard
        {...makeProps({
        kind: 'free',
        phase: 'feedback',
        freeText: 'my answer',
        confidence: 'unsure',
        options: [],
        feedback: {
          kind: 'free',
          correct: false,
          score: 0.5,
          threshold: 0.8,
          criteria: [
            { id: 'c1', criterion: 'States the distinction.', met: false, evidenceQuote: null, comment: 'Not stated.' },
          ],
          missing: ['the ownership distinction'],
          misconceptionsDetected: [],
          verdictSummary: 'Half the rubric is unmet.',
        },
      })}
      />
    );
    expect(screen.getByTestId('free-answer')).toBeDisabled();
  });

  it('the guard refuses a submit attempt from the feedback phase', () => {
    expect(
      canSubmit({
        kind: 'mc',
        phase: 'feedback',
        selectedOptionId: 12,
        confidence: 'confident',
        freeText: '',
        submitting: false,
      })
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------- test 5 */

describe('AT5 — feedback explains every option (invariant 5)', () => {
  const answered = makeProps({
    phase: 'feedback',
    selectedOptionId: 12,
    confidence: 'confident',
    feedback: FEEDBACK,
  });

  it('renders a rationale for all four options, not only the correct or chosen one', () => {
    render(<ItemCard {...answered} />);
    for (const o of FEEDBACK.options) {
      const node = screen.getByTestId(`rationale-${o.id}`);
      expect(node).toHaveTextContent(o.rationale!);
    }
    expect(screen.getAllByTestId(/^rationale-/)).toHaveLength(4);
  });

  it('names the misconception behind each distractor, including the unchosen ones', () => {
    render(<ItemCard {...answered} />);
    const tags = screen.getAllByTestId(/^misconception-/);
    expect(tags).toHaveLength(3);
    expect(screen.getByTestId('misconception-13')).toHaveTextContent('socialism = redistribution');
    expect(screen.getByTestId('misconception-14')).toHaveTextContent(
      'socialism requires central planning'
    );
  });

  it('names the misconception the user actually picked, and shows the explanation', () => {
    render(<ItemCard {...answered} />);
    const feedback = screen.getByTestId('feedback');
    expect(feedback).toHaveTextContent('state ownership = social ownership');
    expect(screen.getByTestId('explanation')).toHaveTextContent(
      'Ownership, not administration, is the distinguishing feature.'
    );
  });

  it('marks the correct option and the user’s choice distinctly', () => {
    render(<ItemCard {...answered} />);
    expect(screen.getByTestId('option-11')).toHaveAttribute('data-state', 'correct');
    expect(screen.getByTestId('option-12')).toHaveAttribute('data-state', 'wrong-chosen');
    expect(screen.getByTestId('option-13')).toHaveAttribute('data-state', 'wrong');
  });

  it('still explains all four when the answer was right', () => {
    render(
      <ItemCard
        {...answered}
        selectedOptionId={11}
        feedback={{ ...FEEDBACK, correct: true, chosenOptionId: 11, misconceptionLabel: null }}
      />
    );
    expect(screen.getAllByTestId(/^rationale-/)).toHaveLength(4);
  });
});

/* --------------------------------------------- no gamification on the path */

describe('the answer path carries no reward signal', () => {
  it('shows no streak, score, or celebration', () => {
    const { container } = render(<ItemCard {...makeProps({ phase: 'feedback', selectedOptionId: 11, confidence: 'confident', feedback: { ...FEEDBACK, correct: true } })} />);
    const text = container.textContent ?? '';
    for (const word of ['streak', 'in a row', 'Level', 'points', 'Nice work', 'Well done']) {
      expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});
