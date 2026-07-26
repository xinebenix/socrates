/**
 * @vitest-environment jsdom
 *
 * Switching language must not consume the question on screen.
 *
 * The i18n wiring put the dictionary into the `load` callback's dependency array. That
 * looks harmless — it is only used for an error fallback — but it puts the dictionary's
 * *identity* in the deps, and the identity changes on every locale switch: the toggle
 * calls router.refresh() and the dict arrives freshly deserialized across the RSC
 * boundary. `useEffect(..., [load])` then re-runs load() mid-session.
 *
 * The damage is not cosmetic. The slot was stamped served when it was handed out, so
 * fetching next-item again returns the FOLLOWING slot: the question the learner was
 * part-way through is gone, their answer is cleared, and no response was recorded. In a
 * benchmark run that silently drops an item from the measured set.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { SessionRunner } from '../../components/SessionRunner';
import { I18nProvider } from '../../components/I18nProvider';
import { dictionaryFor } from '../../lib/i18n/dict';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const item = {
  kind: 'mc' as const,
  itemId: 1,
  cellId: 1,
  stem: 'Which reading is the one the source gives?',
  options: [
    { id: 1, position: 1, text: 'alpha' },
    { id: 2, position: 2, text: 'beta' },
    { id: 3, position: 3, text: 'gamma' },
    { id: 4, position: 4, text: 'delta' },
  ],
  nodeTitle: 'Ownership structures',
  depth: 1,
  position: 1,
  total: 20,
};

let nextItemCalls = 0;

beforeEach(() => {
  nextItemCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('next-item')) {
        nextItemCalls++;
        return {
          ok: true,
          json: async () => ({
            item,
            done: false,
            kind: 'practice',
            progress: { total: 20, served: 1, answered: 0 },
            warning: null,
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(locale: 'en' | 'zh') {
  return (
    <I18nProvider locale={locale} dict={dictionaryFor(locale)}>
      <SessionRunner sessionId={7} conceptId={1} conceptName="Socialism" />
    </I18nProvider>
  );
}

describe('changing language during a session', () => {
  it('does not re-fetch the next item', async () => {
    const { rerender } = render(renderAt('en'));
    await waitFor(() => expect(screen.getByText(item.stem)).toBeInTheDocument());
    expect(nextItemCalls).toBe(1);

    // A locale switch delivers a different dictionary object. Re-render with it.
    rerender(renderAt('zh'));
    await waitFor(() => expect(screen.getByText(item.stem)).toBeInTheDocument());

    // Still one. A second call here means the learner's current question was consumed.
    expect(
      nextItemCalls,
      'switching language re-fetched next-item, consuming the question on screen'
    ).toBe(1);
  });

  it('re-renders the chrome in the new language without losing the question', async () => {
    const { rerender } = render(renderAt('en'));
    await waitFor(() => expect(screen.getByText(item.stem)).toBeInTheDocument());
    expect(screen.getByText(/Confident/)).toBeInTheDocument();

    rerender(renderAt('zh'));

    // The interface follows the switch...
    await waitFor(() => expect(screen.getByText('确定')).toBeInTheDocument());
    // ...and the item, which is user data, is still the same one on screen.
    expect(screen.getByText(item.stem)).toBeInTheDocument();
  });
});
