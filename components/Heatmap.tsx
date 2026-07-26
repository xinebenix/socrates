'use client';

import { DEPTHS } from '@/lib/prompts/depth';
import type { GridCell, GridRow } from '@/lib/stats';

/**
 * The mastery grid: nodes as rows, D1-D6 as columns, each cell a heatmap square
 * colored by effective mastery, with a dot marking due and a rule marking mastered.
 */
export function Heatmap({
  grid,
  onCellClick,
  selectedCellId,
}: {
  grid: GridRow[];
  onCellClick?: (cell: GridCell, row: GridRow) => void;
  selectedCellId?: number | null;
}) {
  return (
    <table className="heatmap">
      <thead>
        <tr>
          <th className="node-col">Node</th>
          {DEPTHS.map((d) => (
            <th key={d.level} title={`${d.name} — ${d.definition}`}>
              {d.short}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.map((row) => (
          <tr key={row.nodeId}>
            <td className="node-col" title={row.description}>
              {row.title}
            </td>
            {row.cells.map((cell) => (
              <td key={cell.depth}>
                <button
                  type="button"
                  className="cell-swatch"
                  data-applicable={String(cell.applicable)}
                  aria-label={label(row, cell)}
                  title={label(row, cell)}
                  style={{
                    background: swatch(cell),
                    outline:
                      selectedCellId === cell.cellId ? '2px solid var(--terra)' : undefined,
                    outlineOffset: selectedCellId === cell.cellId ? 1 : undefined,
                  }}
                  onClick={() => onCellClick?.(cell, row)}
                >
                  {cell.applicable && cell.due && <span className="due-dot" aria-hidden />}
                  {cell.applicable && cell.mastered && (
                    <span className="mastered-rule" aria-hidden />
                  )}
                </button>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HeatmapLegend() {
  return (
    <div className="legend">
      <span className="swatch-row">
        <span className="swatch" style={{ background: 'var(--surface-raised)' }} />
        <span className="eyebrow" style={{ letterSpacing: '0.1em' }}>
          never tested
        </span>
      </span>
      {[0.25, 0.5, 0.75, 0.95].map((v) => (
        <span className="swatch-row" key={v}>
          <span
            className="swatch"
            style={{ background: `rgba(var(--verd-rgb), ${0.06 + v * 0.72})` }}
          />
          <span className="eyebrow" style={{ letterSpacing: '0.1em' }}>
            {Math.round(v * 100)}%
          </span>
        </span>
      ))}
      <span className="swatch-row">
        <span
          className="swatch"
          style={{ position: 'relative', background: 'rgba(var(--verd-rgb),.3)' }}
        >
          <span
            style={{
              position: 'absolute',
              top: 1,
              right: 1,
              width: 4,
              height: 4,
              borderRadius: '50%',
              background: 'var(--terra)',
            }}
          />
        </span>
        <span className="eyebrow" style={{ letterSpacing: '0.1em' }}>
          due
        </span>
      </span>
      <span className="swatch-row">
        <span className="swatch" style={{ borderStyle: 'dashed', background: 'transparent' }} />
        <span className="eyebrow" style={{ letterSpacing: '0.1em' }}>
          not applicable
        </span>
      </span>
    </div>
  );
}

/**
 * Effective mastery, not the raw estimate — what the user sees is decayed.
 *
 * A cell with no responses is left unfilled rather than shaded at the 0.15 prior.
 * The prior is an assumption, not evidence, and colouring it green would make an
 * untouched cell read as better known than one that has actually been failed.
 */
function swatch(cell: GridCell): string {
  if (!cell.applicable) return 'transparent';
  if (cell.responseCount === 0) return 'var(--surface-raised)';
  const v = Math.max(0, Math.min(1, cell.effectiveMastery));
  return `rgba(var(--verd-rgb), ${0.06 + v * 0.72})`;
}

function label(row: GridRow, cell: GridCell): string {
  if (!cell.applicable) return `${row.title} · D${cell.depth} — marked not applicable`;
  if (cell.responseCount === 0) {
    return `${row.title} · D${cell.depth} — never tested (prior ${Math.round(cell.pMastery * 100)}%)`;
  }
  return (
    `${row.title} · D${cell.depth} — effective ${Math.round(cell.effectiveMastery * 100)}% ` +
    `(estimate ${Math.round(cell.pMastery * 100)}%, retrievability ${Math.round(cell.retrievability * 100)}%), ` +
    `${cell.responseCount} response(s)${cell.mastered ? ', mastered' : ''}${cell.due ? ', due now' : ''}`
  );
}
