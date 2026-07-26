'use client';

import { DEPTHS } from '@/lib/prompts/depth';
import type { GridCell, GridRow } from '@/lib/stats';
import { useDict } from '@/components/I18nProvider';
import { fill, type Dict } from '@/lib/i18n/dict';

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
  const t = useDict();

  return (
    <table className="heatmap">
      <thead>
        <tr>
          <th className="node-col">{t.dashboard.nodeColumnHeader}</th>
          {DEPTHS.map((d) => (
            <th
              key={d.level}
              title={fill(t.dashboard.depthColumnTitle, {
                name: d.name,
                definition: d.definition,
              })}
            >
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
                  aria-label={label(t, row, cell)}
                  title={label(t, row, cell)}
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
  const t = useDict();

  return (
    <div className="legend">
      <span className="swatch-row">
        <span className="swatch" style={{ background: 'var(--surface-raised)' }} />
        <span className="eyebrow" style={{ letterSpacing: '0.1em' }}>
          {t.dashboard.legendNeverTested}
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
          {t.dashboard.legendDue}
        </span>
      </span>
      <span className="swatch-row">
        <span className="swatch" style={{ borderStyle: 'dashed', background: 'transparent' }} />
        <span className="eyebrow" style={{ letterSpacing: '0.1em' }}>
          {t.dashboard.legendNotApplicable}
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

function label(t: Dict, row: GridRow, cell: GridCell): string {
  if (!cell.applicable) {
    return fill(t.dashboard.cellLabelNotApplicable, { node: row.title, depth: cell.depth });
  }
  if (cell.responseCount === 0) {
    return fill(t.dashboard.cellLabelNeverTested, {
      node: row.title,
      depth: cell.depth,
      prior: Math.round(cell.pMastery * 100),
    });
  }
  return (
    fill(t.dashboard.cellLabelTested, {
      node: row.title,
      depth: cell.depth,
      effective: Math.round(cell.effectiveMastery * 100),
      estimate: Math.round(cell.pMastery * 100),
      retrievability: Math.round(cell.retrievability * 100),
      count: cell.responseCount,
    }) +
    (cell.mastered ? t.dashboard.cellLabelMasteredSuffix : '') +
    (cell.due ? t.dashboard.cellLabelDueSuffix : '')
  );
}
