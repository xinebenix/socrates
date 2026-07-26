/**
 * The running cost, on the page you land on.
 *
 * Buried in a diagnostics endpoint it is a number nobody looks at until the invoice
 * arrives. The point of putting it here is that the two decisions it should inform —
 * how wide to buffer, and which model writes items — are made in the same place.
 *
 * Estimated, and says so. Tokens are exact; the price table is not.
 */

import { budgetStatus, dayKey, spendBy, totalSpend, unservedItemSpend } from '@/lib/cost';
import { getDb } from '@/lib/db';

function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function SpendStrip() {
  const db = getDb();

  const month = totalSpend(db, `${budgetStatus(db).month}-01`);
  if (month.calls === 0) return null;

  const budget = budgetStatus(db);
  const today = totalSpend(db, dayKey());
  const ahead = unservedItemSpend(db);
  const byKind = spendBy(db, 'kind', `${budget.month}-01`);

  const pct =
    budget.limitUsd !== null && budget.limitUsd > 0
      ? Math.min(100, (budget.spentThisMonthUsd / budget.limitUsd) * 100)
      : null;

  return (
    <div className="panel" style={{ marginTop: 34 }}>
      <div className="row wrap gap-14" style={{ marginBottom: 14 }}>
        <p className="section-label" style={{ margin: 0 }}>
          Estimated spend
        </p>
        <span className="note push">
          {month.calls.toLocaleString()} calls this month · tokens exact, dollars estimated
        </span>
      </div>

      <div className="row wrap gap-22" style={{ alignItems: 'baseline' }}>
        <Figure label="Today" value={usd(today.estimatedUsd)} />
        <Figure label="This month" value={usd(month.estimatedUsd)} />
        {budget.limitUsd !== null && (
          <Figure
            label="Budget"
            value={`${usd(budget.spentThisMonthUsd)} / ${usd(budget.limitUsd)}`}
            warn={budget.exceeded}
          />
        )}
        <Figure
          label="Ahead of use"
          value={usd(ahead.estimatedUsd)}
          hint={`${ahead.unservedItems} generated, not yet served`}
        />
      </div>

      {pct !== null && (
        <div
          aria-hidden
          style={{
            marginTop: 16,
            height: 3,
            background: 'rgba(var(--ink-rgb), 0.1)',
            borderRadius: 2,
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: 2,
              background: budget.exceeded ? 'var(--terra)' : 'var(--verd)',
            }}
          />
        </div>
      )}

      {budget.exceeded && (
        <div className="warnbox" style={{ marginTop: 16 }}>
          The monthly budget estimate has been reached, so pre-generation is paused. Sessions
          still run — items are generated one at a time as you reach them, which is slower and
          only spends on questions you actually see.
        </div>
      )}

      {byKind.length > 0 && (
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
            {byKind.map((row) => (
              <tr key={row.key}>
                <td>{row.key}</td>
                <td style={{ textAlign: 'right' }}>{row.calls.toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{row.outputTokens.toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{usd(row.estimatedUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
