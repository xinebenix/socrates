/**
 * @vitest-environment jsdom
 *
 * The spend readout in the nav bar.
 *
 * It replaced a panel on the concepts page, so it now sits on every authenticated
 * screen including a session in progress. That makes two properties worth pinning:
 * it stays collapsed until asked for, and it renders nothing at all before any
 * spending has happened — a "$0.00" chip on a fresh install is noise.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SpendChip } from '../../components/SpendChip';
import type { SpendSnapshot } from '../../lib/cost';

function snapshot(over: Partial<SpendSnapshot> = {}): SpendSnapshot {
  return {
    empty: false,
    month: '2026-07',
    todayUsd: 0.42,
    monthUsd: 1.52,
    monthCalls: 13,
    budget: {
      limitUsd: 4,
      spentThisMonthUsd: 1.52,
      remainingUsd: 2.48,
      exceeded: false,
      month: '2026-07',
    },
    aheadOfUse: { unservedItems: 7, estimatedUsd: 0.19 },
    byKind: [
      { key: 'blueprint', calls: 1, inputTokens: 10000, outputTokens: 12000, estimatedUsd: 1.05 },
      { key: 'item', calls: 6, inputTokens: 15000, outputTokens: 18000, estimatedUsd: 0.19 },
    ],
    billing: { batchCalls: 8, syncCalls: 5, batchUsd: 0.3, syncUsd: 1.22, batchShare: 0.62 },
    ...over,
  };
}

beforeEach(cleanup);

describe('the chip', () => {
  it('renders nothing at all when nothing has been spent', () => {
    const { container } = render(<SpendChip snapshot={snapshot({ empty: true })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the month figure and the budget ceiling', () => {
    render(<SpendChip snapshot={snapshot()} />);
    const chip = screen.getByRole('button', { name: /estimated spend/i });
    expect(chip.textContent).toContain('$1.52');
    expect(chip.textContent).toContain('$4.00');
  });

  it('starts collapsed', () => {
    render(<SpendChip snapshot={snapshot()} />);
    expect(screen.getByRole('button', { name: /estimated spend/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('marks itself over budget rather than only saying so inside', () => {
    render(
      <SpendChip
        snapshot={snapshot({
          budget: {
            limitUsd: 1,
            spentThisMonthUsd: 1.52,
            remainingUsd: 0,
            exceeded: true,
            month: '2026-07',
          },
        })}
      />
    );
    expect(screen.getByRole('button', { name: /estimated spend/i }).className).toContain('over');
  });
});

describe('the overlay', () => {
  it('opens on click and carries the breakdown', async () => {
    const user = userEvent.setup();
    render(<SpendChip snapshot={snapshot()} />);

    await user.click(screen.getByRole('button', { name: /estimated spend/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.textContent).toContain('Today');
    expect(dialog.textContent).toContain('Ahead of use');
    expect(dialog.textContent).toContain('7 generated, not yet served');
    expect(dialog.textContent).toContain('blueprint');
    // The estimate is always labelled as one.
    expect(dialog.textContent).toMatch(/Dollars are estimated/);
  });

  it('reports the batch share, and says plainly when it is zero', async () => {
    const user = userEvent.setup();
    render(<SpendChip snapshot={snapshot()} />);
    await user.click(screen.getByRole('button', { name: /estimated spend/i }));
    expect(screen.getByRole('dialog').textContent).toContain('62% of 13');

    cleanup();
    render(
      <SpendChip
        snapshot={snapshot({
          billing: { batchCalls: 0, syncCalls: 13, batchUsd: 0, syncUsd: 1.52, batchShare: 0 },
        })}
      />
    );
    await user.click(screen.getByRole('button', { name: /estimated spend/i }));
    expect(screen.getByRole('dialog').textContent).toMatch(/none yet, so nothing is discounted/);
  });

  it('closes on Escape, on the close button, and by toggling the chip', async () => {
    const user = userEvent.setup();
    render(<SpendChip snapshot={snapshot()} />);
    const chip = screen.getByRole('button', { name: /estimated spend/i });

    await user.click(chip);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(chip).toHaveFocus();

    await user.click(chip);
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(chip);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(chip);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('explains the pause when the budget is spent', async () => {
    const user = userEvent.setup();
    render(
      <SpendChip
        snapshot={snapshot({
          budget: {
            limitUsd: 1,
            spentThisMonthUsd: 1.52,
            remainingUsd: 0,
            exceeded: true,
            month: '2026-07',
          },
        })}
      />
    );
    await user.click(screen.getByRole('button', { name: /estimated spend/i }));
    // The reassurance matters as much as the warning: training still works.
    expect(screen.getByRole('dialog').textContent).toMatch(/Sessions still run/);
  });
});
