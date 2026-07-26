/**
 * @vitest-environment jsdom
 *
 * The countdown and the escape hatch it opens.
 *
 * Two things are worth holding in place. The "I don't know" control must not exist
 * before the countdown expires — the ten seconds of trying to retrieve the answer are
 * the part that does the work, and a button present from the first render would be
 * pressed instead of thought about. And taking the escape hatch must record a response
 * before it reveals anything, or the answer could be read and then submitted.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemCard, type ItemCardProps, type McFeedbackView } from '../../components/ItemCard';
import { SessionRunner } from '../../components/SessionRunner';
import { I18nProvider } from '../../components/I18nProvider';
import { dictionaryFor } from '../../lib/i18n/dict';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const OPTIONS = [
  { id: 11, position: 1, text: 'Society as a whole holds title.' },
  { id: 12, position: 2, text: 'A government agency holds title.' },
  { id: 13, position: 3, text: 'Income is transferred downward.' },
  { id: 14, position: 4, text: 'Prices are set centrally.' },
];

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
    secondsLeft: 10,
    onSelectOption: vi.fn(),
    onFreeText: vi.fn(),
    onConfidence: vi.fn(),
    onSubmit: vi.fn(),
    onDontKnow: vi.fn(),
    onNext: vi.fn(),
    ...overrides,
  };
}

function renderCard(props: ItemCardProps, locale: 'en' | 'zh' = 'en') {
  return render(
    <I18nProvider locale={locale} dict={dictionaryFor(locale)}>
      <ItemCard {...props} />
    </I18nProvider>
  );
}

beforeEach(cleanup);

/* ------------------------------------------------------------ the countdown */

describe('the countdown gates the escape hatch', () => {
  it('shows the remaining seconds and no way out while it is running', () => {
    renderCard(makeProps({ secondsLeft: 7 }));
    expect(screen.getByTestId('countdown')).toHaveTextContent('7');
    expect(screen.queryByTestId('dont-know')).toBeNull();
  });

  it('offers no way out on the last second either', () => {
    renderCard(makeProps({ secondsLeft: 1 }));
    expect(screen.queryByTestId('dont-know')).toBeNull();
  });

  it('replaces the counter with the control at zero', async () => {
    const onDontKnow = vi.fn();
    renderCard(makeProps({ secondsLeft: 0, onDontKnow }));

    expect(screen.queryByTestId('countdown')).toBeNull();
    const btn = screen.getByTestId('dont-know');
    await userEvent.click(btn);
    expect(onDontKnow).toHaveBeenCalledOnce();
  });

  it('says what pressing it costs, since the record will stand', () => {
    renderCard(makeProps({ secondsLeft: 0 }));
    expect(screen.getByTestId('item-card')).toHaveTextContent('records the item as not known');
  });

  it('is gone once the item has been answered', () => {
    renderCard(
      makeProps({
        phase: 'feedback',
        secondsLeft: null,
        selectedOptionId: 11,
        confidence: 'confident',
        feedback: declinedFeedback(),
      })
    );
    expect(screen.queryByTestId('dont-know')).toBeNull();
    expect(screen.queryByTestId('countdown')).toBeNull();
  });

  it('does not gate the ordinary submit path', () => {
    renderCard(makeProps({ secondsLeft: 10, selectedOptionId: 11, confidence: 'unsure' }));
    expect(screen.getByTestId('submit')).toBeEnabled();
  });
});

/* ------------------------------------------------------------- the reveal */

function declinedFeedback(): McFeedbackView {
  return {
    kind: 'mc',
    correct: false,
    declined: true,
    explanation: 'Ownership, not administration, is the distinguishing feature.',
    chosenOptionId: null,
    misconceptionLabel: null,
    options: OPTIONS.map((o, i) => ({
      ...o,
      isCorrect: i === 0,
      rationale: `Why option ${i + 1} is what it is.`,
      misconceptionLabel: i === 0 ? null : `belief ${i}`,
    })),
  };
}

describe('what a revealed answer shows', () => {
  it('names the correct option, the explanation, and every rationale', () => {
    renderCard(makeProps({ phase: 'feedback', secondsLeft: null, feedback: declinedFeedback() }));

    expect(screen.getByTestId('option-11')).toHaveAttribute('data-state', 'correct');
    expect(screen.getByTestId('explanation')).toHaveTextContent(
      'Ownership, not administration, is the distinguishing feature.'
    );
    expect(screen.getAllByTestId(/^rationale-/)).toHaveLength(4);
  });

  it('attributes no choice to a learner who made none', () => {
    renderCard(makeProps({ phase: 'feedback', secondsLeft: null, feedback: declinedFeedback() }));

    for (const o of OPTIONS.slice(1)) {
      expect(screen.getByTestId(`option-${o.id}`)).toHaveAttribute('data-state', 'wrong');
    }
    expect(screen.getByTestId('feedback')).not.toHaveTextContent('your choice');
    // Not "Not this time" — nothing was tried.
    expect(screen.getByTestId('feedback')).toHaveTextContent('You did not know it.');
  });

  it('carries no control that could still change the answer', () => {
    renderCard(makeProps({ phase: 'feedback', secondsLeft: null, feedback: declinedFeedback() }));

    const enabled = screen
      .getAllByRole('button')
      .filter((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toHaveAttribute('data-testid', 'next');
  });
});

/* -------------------------------------------------------------- the marks */

describe('option marks follow the locale', () => {
  it('is ABCD in Chinese, which is what a multiple-choice option is called there', () => {
    renderCard(makeProps(), 'zh');
    const marks = OPTIONS.map((o) =>
      screen.getByTestId(`option-${o.id}`).querySelector('.mark')?.textContent
    );
    expect(marks).toEqual(['A', 'B', 'C', 'D']);
  });

  it('keeps the Greek series in English', () => {
    renderCard(makeProps(), 'en');
    const marks = OPTIONS.map((o) =>
      screen.getByTestId(`option-${o.id}`).querySelector('.mark')?.textContent
    );
    expect(marks).toEqual(['Α', 'Β', 'Γ', 'Δ']);
  });
});

/* ------------------------------------------------- the timer, end to end */

const SERVED_ITEM = {
  kind: 'mc' as const,
  itemId: 1,
  cellId: 1,
  stem: 'Which reading is the one the source gives?',
  options: OPTIONS,
  nodeTitle: 'Ownership structures',
  depth: 1,
  position: 1,
  total: 20,
};

describe('the timer a learner actually sits through', () => {
  let posted: Record<string, unknown>[] = [];
  let served = 0;

  beforeEach(() => {
    posted = [];
    served = 0;
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (String(url).includes('next-item')) {
          served++;
          return {
            ok: true,
            json: async () => ({
              // A fresh object each time, as a real fetch would hand back.
              item: { ...SERVED_ITEM, itemId: served, position: served },
              done: false,
              kind: 'practice',
              progress: { total: 20, served: 1, answered: 0 },
              warning: null,
            }),
          };
        }
        posted.push(JSON.parse(init?.body ?? '{}'));
        return {
          ok: true,
          json: async () => ({
            deferred: false,
            declined: true,
            progress: { total: 20, served: 1, answered: 1 },
            feedback: {
              correct: false,
              explanation: 'Ownership, not administration, is what distinguishes it.',
              chosenOptionId: null,
              misconceptionLabel: null,
              options: OPTIONS.map((o, i) => ({
                id: o.id,
                position: o.position,
                text: o.text,
                is_correct: i === 0 ? 1 : 0,
                rationale: `Why option ${i + 1} is what it is.`,
                misconception_label: i === 0 ? null : `belief ${i}`,
              })),
            },
          }),
        };
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens the escape hatch after ten seconds, not before', async () => {
    render(
      <I18nProvider locale="en" dict={dictionaryFor('en')}>
        <SessionRunner sessionId={7} conceptId={1} conceptName="Socialism" />
      </I18nProvider>
    );
    await act(async () => {});

    expect(screen.getByText(SERVED_ITEM.stem)).toBeInTheDocument();
    expect(screen.queryByTestId('dont-know')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    expect(screen.queryByTestId('dont-know')).toBeNull();
    expect(screen.getByTestId('countdown')).toHaveTextContent('1');

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('dont-know')).toBeInTheDocument();
  });

  it('records the item as declined before showing the answer', async () => {
    render(
      <I18nProvider locale="en" dict={dictionaryFor('en')}>
        <SessionRunner sessionId={7} conceptId={1} conceptName="Socialism" />
      </I18nProvider>
    );
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('dont-know'));
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ itemId: 1, dontKnow: true });
    expect(posted[0].latencyMs).toBeGreaterThanOrEqual(10_000);

    // Only then is anything revealed.
    expect(screen.getByTestId('explanation')).toHaveTextContent(
      'Ownership, not administration, is what distinguishes it.'
    );
    expect(screen.getByTestId('option-11')).toHaveAttribute('data-state', 'correct');
  });

  it('starts the next question at a full countdown, not at the last one’s zero', async () => {
    render(
      <I18nProvider locale="en" dict={dictionaryFor('en')}>
        <SessionRunner sessionId={7} conceptId={1} conceptName="Socialism" />
      </I18nProvider>
    );
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dont-know'));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('next'));
    });

    // The escape hatch must be earned again on the item that just arrived.
    expect(screen.getByTestId('countdown')).toHaveTextContent('10');
    expect(screen.queryByTestId('dont-know')).toBeNull();
  });
});
