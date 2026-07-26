'use client';

import { useEffect, useRef, useState } from 'react';
import type { SpendSnapshot } from '@/lib/cost';

/**
 * Running cost, folded into the nav bar.
 *
 * It used to be a panel on the concepts page, which meant it was only visible in the
 * one place you are least likely to be wondering about it, and it took up room that
 * belongs to the concepts themselves. As a nav chip it is available from everywhere
 * and costs one line of chrome.
 *
 * Deliberately quiet: same size and weight as the nav links, no colour unless the
 * budget is actually spent. A cost readout that draws the eye during a session is a
 * distraction from the thing being trained.
 */
export function SpendChip({ snapshot }: { snapshot: SpendSnapshot }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes it, and focus goes back to the chip that opened it.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    // Deferred, so the click that opened the panel does not immediately close it.
    const id = setTimeout(() => document.addEventListener('mousedown', onClick), 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
      clearTimeout(id);
    };
  }, [open]);

  if (snapshot.empty) return null;

  const { budget } = snapshot;
  const over = budget.exceeded;

  return (
    <div className="spend">
      <button
        ref={buttonRef}
        type="button"
        className={`spend-chip${over ? ' over' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        // The visible text is "$1.52 / $4.00", which read aloud on its own says
        // nothing about what it measures. title= would not fix that: it is only used
        // as an accessible name when an element has no text content at all.
        aria-label={
          `Estimated spend this month: ${usd(snapshot.monthUsd)}` +
          (budget.limitUsd !== null ? ` of a ${usd(budget.limitUsd)} budget` : '') +
          (over ? ', budget reached' : '')
        }
        title="Estimated spend this month"
      >
        <span className="spend-chip-dot" aria-hidden />
        <span className="tabular">{usd(snapshot.monthUsd)}</span>
        {budget.limitUsd !== null && (
          <span className="spend-chip-limit tabular">/ {usd(budget.limitUsd)}</span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="spend-panel fade"
          role="dialog"
          aria-modal="false"
          aria-label="Estimated spend"
        >
          <div className="row wrap gap-14" style={{ marginBottom: 16 }}>
            <p className="section-label" style={{ margin: 0 }}>
              Estimated spend · {snapshot.month}
            </p>
            <button
              type="button"
              className="spend-close push"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              aria-label="Close"
            >
              ×
            </button>
          </div>

          <div className="row wrap gap-22" style={{ alignItems: 'baseline' }}>
            <Figure label="Today" value={usd(snapshot.todayUsd)} />
            <Figure label="This month" value={usd(snapshot.monthUsd)} />
            {budget.limitUsd !== null && (
              <Figure label="Budget" value={usd(budget.limitUsd)} warn={over} />
            )}
            <Figure
              label="Ahead of use"
              value={usd(snapshot.aheadOfUse.estimatedUsd)}
              hint={`${snapshot.aheadOfUse.unservedItems} generated, not yet served`}
            />
          </div>

          {budget.limitUsd !== null && budget.limitUsd > 0 && (
            <div className="spend-bar" aria-hidden>
              <div
                className={over ? 'over' : undefined}
                style={{
                  width: `${Math.min(100, (budget.spentThisMonthUsd / budget.limitUsd) * 100)}%`,
                }}
              />
            </div>
          )}

          {over && (
            <div className="warnbox" style={{ marginTop: 16 }}>
              The monthly budget estimate has been reached, so pre-generation is paused.
              Sessions still run — items are generated as you reach them, which is slower and
              only spends on questions you actually see.
            </div>
          )}

          {snapshot.byKind.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="mini" style={{ marginTop: 18, width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Call</th>
                    <th style={{ textAlign: 'right' }}>Calls</th>
                    <th style={{ textAlign: 'right' }}>Output tokens</th>
                    <th style={{ textAlign: 'right' }}>Estimated</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.byKind.map((row) => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td className="tabular" style={{ textAlign: 'right' }}>
                        {row.calls.toLocaleString()}
                      </td>
                      <td className="tabular" style={{ textAlign: 'right' }}>
                        {row.outputTokens.toLocaleString()}
                      </td>
                      <td className="tabular" style={{ textAlign: 'right' }}>
                        {usd(row.estimatedUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Whether the half-price pipeline is actually being used. A share near zero
              after real use means the speculative work is not being batched. */}
          <p className="note" style={{ marginTop: 16 }}>
            {Math.round(snapshot.billing.batchShare * 100)}% of {snapshot.monthCalls.toLocaleString()}{' '}
            calls went through the Batch API at half rate
            {snapshot.billing.batchCalls === 0 ? ' — none yet, so nothing is discounted' : ''}.
          </p>

          <p className="note" style={{ marginTop: 8 }}>
            Token counts are exact. Dollars are estimated from a built-in price table that
            may be out of date — set <code>GYM_PRICES</code> to correct it.
          </p>
        </div>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div>
      <p className="field-label" style={{ marginBottom: 4 }}>
        {label}
      </p>
      <p
        className="tabular"
        style={{
          font: '400 22px/1 var(--serif)',
          color: warn ? 'var(--terra)' : 'var(--ink)',
          margin: 0,
        }}
      >
        {value}
      </p>
      {hint && (
        <p className="note" style={{ marginTop: 4 }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
