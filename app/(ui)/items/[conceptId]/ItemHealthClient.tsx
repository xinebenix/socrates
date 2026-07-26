'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CellStats } from '@/lib/analysis/itemStats';

interface ItemDetail {
  id: number;
  stem: string;
  validated: number;
  frozen: number;
  retired: number;
  served_count: number;
  validator: { flags?: string[]; notes?: string; rejected?: boolean } | null;
  options: { id: number; text: string; is_correct: number; selected_count: number }[];
}

export function ItemHealthTable({
  conceptId,
  cells,
}: {
  conceptId: number;
  cells: CellStats[];
}) {
  const [openCell, setOpenCell] = useState<number | null>(null);
  const [items, setItems] = useState<ItemDetail[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function open(cellId: number) {
    if (openCell === cellId) {
      setOpenCell(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/items?cellId=${cellId}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'could not load items');
      setItems(data.items as ItemDetail[]);
      setOpenCell(cellId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(body: Record<string, unknown>, cellId: number) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'action failed');
      setOpenCell(null);
      await open(cellId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const withActivity = cells.filter((c) => c.n > 0 || c.itemCount > 0);

  return (
    <>
      {error && <div className="warnbox" style={{ marginBottom: 14 }}>{error}</div>}

      {withActivity.length === 0 ? (
        <p className="note">No items generated yet for this concept.</p>
      ) : (
        <div className="ledger">
          {withActivity.map((c) => (
            <div key={c.cellId}>
              <div className="ledger-row">
                <span className="eyebrow" style={{ width: 170, flex: 'none' }}>
                  {c.nodeTitle}
                </span>
                <span className="eyebrow-accent" style={{ width: 34, flex: 'none' }}>
                  D{c.depth}
                </span>
                <span className="note tabular" style={{ flex: 1 }}>
                  {c.itemCount} item{c.itemCount === 1 ? '' : 's'} · n = {c.n}
                  {c.belowThreshold ? (
                    <> · statistics withheld below n = 5</>
                  ) : (
                    <>
                      {' '}
                      · difficulty {fmt(c.difficulty)} · discrimination {fmt(c.discrimination)}{' '}
                      <em style={{ color: 'var(--muted)' }}>(advisory)</em>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  onClick={() => void open(c.cellId)}
                >
                  {openCell === c.cellId ? 'Hide' : 'Items'}
                </button>
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  onClick={() => void act({ action: 'regenerate', cellId: c.cellId }, c.cellId)}
                >
                  Generate
                </button>
              </div>

              {openCell === c.cellId && (
                <div style={{ padding: '4px 18px 18px', background: 'var(--surface-sunken)' }}>
                  {items.length === 0 && <p className="note">No items stored for this cell.</p>}
                  {items.map((it) => (
                    <div
                      key={it.id}
                      className="panel"
                      style={{ marginTop: 12, background: 'var(--surface)' }}
                    >
                      <div className="row wrap gap-9" style={{ marginBottom: 8 }}>
                        <span className="eyebrow tabular">#{it.id}</span>
                        {it.frozen === 1 && <span className="eyebrow-accent">benchmark</span>}
                        {it.retired === 1 && <span className="eyebrow">retired</span>}
                        {it.validated === 0 && <span className="eyebrow">rejected by validator</span>}
                        <span className="eyebrow tabular push">served {it.served_count}×</span>
                      </div>

                      <p className="serif-body" style={{ margin: '0 0 10px' }}>
                        {it.stem}
                      </p>

                      {it.options.length > 0 && (
                        <ul className="note" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                          {it.options.map((o) => (
                            <li key={o.id} style={{ marginBottom: 2 }}>
                              {o.is_correct === 1 ? '✓ ' : '· '}
                              {o.text}{' '}
                              <span style={{ color: 'var(--muted)' }}>
                                (chosen {o.selected_count}×)
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {it.validator?.flags && it.validator.flags.length > 0 && (
                        <p className="note" style={{ color: 'var(--terra)' }}>
                          validator flags: {it.validator.flags.join(', ')}
                          {it.validator.notes ? ` — ${it.validator.notes}` : ''}
                        </p>
                      )}

                      <div className="row wrap gap-6" style={{ marginTop: 10 }}>
                        {it.frozen === 0 ? (
                          <button
                            type="button"
                            className="btn small"
                            disabled={busy || it.validated !== 1}
                            title={
                              it.validated === 1
                                ? 'Freeze this item into the benchmark set. It leaves practice permanently.'
                                : 'Only validated items can join the benchmark set.'
                            }
                            onClick={() => void act({ action: 'promote', itemId: it.id }, c.cellId)}
                          >
                            Promote to benchmark
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn small"
                            disabled={busy}
                            onClick={() => void act({ action: 'demote', itemId: it.id }, c.cellId)}
                          >
                            Return to practice
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn small danger"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              { action: it.retired === 1 ? 'unretire' : 'retire', itemId: it.id },
                              c.cellId
                            )
                          }
                        >
                          {it.retired === 1 ? 'Un-retire' : 'Retire'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="note" style={{ marginTop: 12 }}>
        Concept #{conceptId}
      </p>
    </>
  );
}

function fmt(v: number | null): string {
  return v === null ? '—' : v.toFixed(2);
}
