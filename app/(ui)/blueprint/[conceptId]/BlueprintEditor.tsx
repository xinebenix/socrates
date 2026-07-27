'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Heatmap, HeatmapLegend } from '@/components/Heatmap';
import { StartButton } from '../../concepts/ConceptsClient';
import type { GridCell, GridRow } from '@/lib/stats';
import type { MisconceptionWithState, NodeRow } from '@/lib/db/types';
import { DEPTHS } from '@/lib/prompts/depth';
import { useDict } from '@/components/I18nProvider';
import { fill, type Dict } from '@/lib/i18n/dict';

// The selection count is the reader's own, not the concept's — on a shared blueprint a
// global tally would be somebody else's confusion reported as yours.
type NodeWithMisconceptions = NodeRow & { misconceptions: MisconceptionWithState[] };

/**
 * `origin` is a stored enum, not prose, so it is looked up rather than translated in
 * place. The table is deliberately partial — a value the dictionary has no word for
 * falls through to the stored token instead of rendering blank.
 */
function originLabel(t: Dict, origin: string): string {
  if (origin === 'generated') return t.blueprint.nodeOriginGenerated;
  if (origin === 'user') return t.blueprint.nodeOriginUser;
  return origin;
}

/**
 * The degraded-mode warning used to end with "add source text on the concept and
 * regenerate", which was advice the interface did not let you take — source text was
 * settable at creation and nowhere else. Since a source-less blueprint is the single
 * biggest quality problem the system can have, the instruction and the control to
 * follow it belong in the same box.
 */
function SourceTextPanel({
  conceptId,
  hasSource,
  initialSource,
  initialNote,
  onSaved,
}: {
  conceptId: number;
  hasSource: boolean;
  initialSource: string;
  initialNote: string;
  onSaved: () => void;
}) {
  const t = useDict();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(initialSource);
  const [note, setNote] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(thenRegenerate: boolean) {
    if (!text.trim()) {
      setError(t.blueprint.nothingToSaveError);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/concepts/${conceptId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceText: text, sourceNote: note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.blueprint.saveFailedError);
      setOpen(false);
      // Saving alone changes nothing about the existing blueprint — it was drawn
      // without this text. Regeneration is what actually makes the source count.
      if (thenRegenerate) onSaved();
      else window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack gap-14">
      {!hasSource && (
        <div className="warnbox">
          {t.blueprint.noSourceWarning}
          {!open && (
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn small" onClick={() => setOpen(true)}>
                {t.blueprint.addSourceTextButton}
              </button>
            </div>
          )}
        </div>
      )}

      {hasSource && !open && (
        <div className="row wrap gap-9">
          <button type="button" className="btn small" onClick={() => setOpen(true)}>
            {t.blueprint.editSourceTextButton}
          </button>
          <span className="note">{t.blueprint.sourceChangeNote}</span>
        </div>
      )}

      {open && (
        <div className="panel">
          <p className="section-label" style={{ marginTop: 0, marginBottom: 16 }}>
            {t.blueprint.sourceMaterialLabel}
          </p>
          <div style={{ marginBottom: 16 }}>
            <textarea
              id="blueprint-source-text"
              className="field"
              rows={14}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.blueprint.sourceTextPlaceholder}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label className="field-label" htmlFor="blueprint-source-note">
              {t.blueprint.sourceNoteLabel}
            </label>
            <input
              id="blueprint-source-note"
              className="field"
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t.blueprint.sourceNotePlaceholder}
            />
          </div>

          {error && <div className="warnbox" style={{ marginBottom: 16 }}>{error}</div>}

          <div className="row wrap gap-9">
            <button
              type="button"
              className="btn small primary"
              disabled={busy}
              onClick={() => void save(true)}
            >
              {busy ? t.blueprint.savingBusy : t.blueprint.saveAndRedrawButton}
            </button>
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() => void save(false)}
            >
              {t.blueprint.saveOnlyButton}
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => setOpen(false)}>
              {t.blueprint.cancelButton}
            </button>
          </div>
          <p className="note" style={{ marginTop: 12 }}>
            {t.blueprint.redrawMergeNote}
          </p>
        </div>
      )}
    </div>
  );
}

export function BlueprintEditor({
  conceptId,
  initialNodes,
  initialGrid,
  alarm,
  hasSource,
  initialSource,
  initialNote,
  canEdit,
  visibility,
}: {
  conceptId: number;
  initialNodes: NodeWithMisconceptions[];
  initialGrid: GridRow[];
  alarm: string | null;
  hasSource: boolean;
  initialSource: string;
  initialNote: string;
  /** False on a shared concept somebody else owns: read it, or fork it. */
  canEdit: boolean;
  visibility: 'shared' | 'private';
}) {
  const t = useDict();
  const router = useRouter();
  const [nodes, setNodes] = useState(initialNodes);
  const [grid, setGrid] = useState(initialGrid);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ cell: GridCell; row: GridRow } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function patch(ops: unknown[]) {
    setBusy(t.blueprint.savingBusy);
    setError(null);
    try {
      const res = await fetch('/api/blueprint', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.blueprint.saveFailedError);
      if (data.nodes) setNodes(data.nodes);
      if (data.grid) setGrid(data.grid);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    setBusy(t.blueprint.regeneratingBusy);
    setError(null);
    try {
      const res = await fetch('/api/blueprint', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conceptId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.blueprint.regenerationFailedError);
      router.refresh();
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <div className="stack gap-22">
      <SourceTextPanel
        conceptId={conceptId}
        hasSource={hasSource}
        initialSource={initialSource}
        initialNote={initialNote}
        onSaved={() => void regenerate()}
      />


      {alarm && <div className="warnbox">{alarm}</div>}
      {error && <div className="warnbox">{error}</div>}

      <div className="panel">
        <div className="row wrap gap-14" style={{ marginBottom: 16 }}>
          <p className="section-label" style={{ margin: 0 }}>
            {t.blueprint.masteryGridLabel}
          </p>
          <div className="push row wrap gap-9">
            <StartButton
              conceptId={conceptId}
              disabled={nodes.length === 0}
              label={t.blueprint.trainButton}
            />
            <button type="button" className="btn small" disabled={!!busy} onClick={() => void regenerate()}>
              {t.blueprint.regenerateAndMergeButton}
            </button>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <Heatmap
            grid={grid}
            selectedCellId={selected?.cell.cellId ?? null}
            onCellClick={(cell, row) =>
              setSelected((s) => (s?.cell.cellId === cell.cellId ? null : { cell, row }))
            }
          />
        </div>

        <div style={{ marginTop: 14 }}>
          <HeatmapLegend />
        </div>

        {busy && (
          <p className="note breathe" style={{ marginTop: 12 }}>
            {busy}
          </p>
        )}
      </div>

      {selected && (
        <CellInspector
          cell={selected.cell}
          row={selected.row}
          onToggleApplicable={() =>
            void patch([
              {
                op: 'set-applicable',
                nodeId: selected.row.nodeId,
                depth: selected.cell.depth,
                applicable: !selected.cell.applicable,
              },
            ])
          }
          onClose={() => setSelected(null)}
        />
      )}

      <div>
        <p className="section-label">{t.blueprint.nodesLabel}</p>
        <div className="stack gap-14">
          {nodes.map((n, i) => (
            <NodeEditor
              key={n.id}
              node={n}
              index={i}
              total={nodes.length}
              grid={grid.find((g) => g.nodeId === n.id) ?? null}
              onPatch={patch}
            />
          ))}
        </div>
      </div>

      <AddNode conceptId={conceptId} onPatch={patch} />
    </div>
  );
}

function CellInspector({
  cell,
  row,
  onToggleApplicable,
  onClose,
}: {
  cell: GridCell;
  row: GridRow;
  onToggleApplicable: () => void;
  onClose: () => void;
}) {
  const t = useDict();
  const d = DEPTHS[cell.depth - 1];
  return (
    <div className="panel">
      <div className="row wrap gap-14" style={{ marginBottom: 12 }}>
        <span className="eyebrow-accent">
          {fill(t.blueprint.cellInspectorHeading, {
            title: row.title,
            depthShort: d.short,
            depthName: d.name,
          })}
        </span>
        <button type="button" className="btn small push" onClick={onClose}>
          {t.blueprint.closeButton}
        </button>
      </div>
      <p className="note" style={{ marginBottom: 14 }}>
        {d.definition}
      </p>
      <div
        className="grid-tiles"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))' }}
      >
        <Stat label={t.blueprint.statEstimate} value={`${Math.round(cell.pMastery * 100)}%`} />
        <Stat label={t.blueprint.statEffective} value={`${Math.round(cell.effectiveMastery * 100)}%`} />
        <Stat
          label={t.blueprint.statRetrievability}
          value={`${Math.round(cell.retrievability * 100)}%`}
        />
        <Stat label={t.blueprint.statResponses} value={String(cell.responseCount)} />
        <Stat
          label={t.blueprint.statInterval}
          value={fill(t.blueprint.intervalDaysValue, { days: cell.intervalDays.toFixed(1) })}
        />
        <Stat
          label={t.blueprint.statNextDue}
          value={cell.nextDueAt ? cell.nextDueAt.slice(0, 10) : '—'}
        />
      </div>
      <button type="button" className="btn small" style={{ marginTop: 14 }} onClick={onToggleApplicable}>
        {cell.applicable ? t.blueprint.markNotApplicableButton : t.blueprint.markApplicableButton}
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile" style={{ padding: 14 }}>
      <span className="eyebrow" style={{ letterSpacing: '0.18em' }}>
        {label}
      </span>
      <span className="value tabular" style={{ fontSize: 24 }}>
        {value}
      </span>
    </div>
  );
}

function NodeEditor({
  node,
  index,
  total,
  grid,
  onPatch,
}: {
  node: NodeWithMisconceptions;
  index: number;
  total: number;
  grid: GridRow | null;
  onPatch: (ops: unknown[]) => Promise<void>;
}) {
  const t = useDict();
  const [title, setTitle] = useState(node.title);
  const [description, setDescription] = useState(node.description);
  const [open, setOpen] = useState(false);
  const dirty = title !== node.title || description !== node.description;

  return (
    <div className="panel">
      <div className="row wrap gap-9" style={{ alignItems: 'flex-start' }}>
        <input
          className="field"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label={fill(t.blueprint.nodeTitleAriaLabel, { index: index + 1 })}
          style={{ flex: 1, minWidth: 220, fontSize: 18 }}
        />
        <span className="eyebrow" style={{ paddingTop: 14 }}>
          {originLabel(t, node.origin)}
        </span>
        <button type="button" className="btn small" onClick={() => setOpen((v) => !v)}>
          {open
            ? t.blueprint.collapseButton
            : fill(t.blueprint.misconceptionsToggle, { count: node.misconceptions.length })}
        </button>
      </div>

      <textarea
        className="field"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label={fill(t.blueprint.nodeDescriptionAriaLabel, { title: node.title })}
        style={{ marginTop: 10 }}
      />

      <div className="row wrap gap-6" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn small primary"
          disabled={!dirty}
          onClick={() => void onPatch([{ op: 'update-node', nodeId: node.id, title, description }])}
        >
          {t.blueprint.saveNodeButton}
        </button>
        <button
          type="button"
          className="btn small"
          disabled={index === 0}
          onClick={() => void onPatch([{ op: 'update-node', nodeId: node.id, orderIndex: index - 1 }])}
        >
          {t.blueprint.moveUpButton}
        </button>
        <button
          type="button"
          className="btn small"
          disabled={index === total - 1}
          onClick={() => void onPatch([{ op: 'update-node', nodeId: node.id, orderIndex: index + 1 }])}
        >
          {t.blueprint.moveDownButton}
        </button>
        <button
          type="button"
          className="btn small danger push"
          onClick={() => {
            if (confirm(fill(t.blueprint.deleteNodeConfirm, { title: node.title }))) {
              void onPatch([{ op: 'delete-node', nodeId: node.id }]);
            }
          }}
        >
          {t.blueprint.deleteNodeButton}
        </button>
      </div>

      {grid && (
        <p className="note" style={{ marginTop: 10 }}>
          {fill(t.blueprint.applicableDepths, {
            depths:
              grid.cells
                .filter((c) => c.applicable)
                .map((c) => `D${c.depth}`)
                .join(' · ') || t.blueprint.applicableDepthsNone,
          })}
        </p>
      )}

      {open && <MisconceptionPanel node={node} onPatch={onPatch} />}
    </div>
  );
}

function MisconceptionPanel({
  node,
  onPatch,
}: {
  node: NodeWithMisconceptions;
  onPatch: (ops: unknown[]) => Promise<void>;
}) {
  const t = useDict();
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid var(--rule-soft)', paddingTop: 16 }}>
      <p className="section-label">{t.blueprint.misconceptionsPanelLabel}</p>

      <div className="stack gap-9">
        {node.misconceptions.map((m) => (
          <div
            key={m.id}
            className="row wrap gap-9"
            style={{ alignItems: 'flex-start', paddingBottom: 9, borderBottom: '1px solid var(--rule-soft)' }}
          >
            <div className="stack gap-6" style={{ flex: 1, minWidth: 240 }}>
              <span className="serif-body" style={{ fontSize: 16 }}>
                {m.label}
              </span>
              <span className="note">{m.description}</span>
            </div>
            <span className="eyebrow tabular" style={{ paddingTop: 4 }}>
              {fill(t.blueprint.misconceptionMeta, {
                origin: m.origin,
                count: m.times_selected,
              })}
            </span>
            <button
              type="button"
              className="btn small danger"
              onClick={() => void onPatch([{ op: 'delete-misconception', id: m.id }])}
            >
              {t.blueprint.removeMisconceptionButton}
            </button>
          </div>
        ))}
      </div>

      <div className="stack gap-9" style={{ marginTop: 14 }}>
        <input
          className="field"
          placeholder={t.blueprint.misconceptionLabelPlaceholder}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label={t.blueprint.newMisconceptionLabelAriaLabel}
        />
        <textarea
          className="field"
          rows={2}
          placeholder={t.blueprint.misconceptionDescriptionPlaceholder}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label={t.blueprint.newMisconceptionDescriptionAriaLabel}
        />
        <button
          type="button"
          className="btn small primary"
          style={{ alignSelf: 'flex-start' }}
          disabled={!label.trim() || !description.trim()}
          onClick={() => {
            void onPatch([
              { op: 'add-misconception', nodeId: node.id, label: label.trim(), description: description.trim() },
            ]);
            setLabel('');
            setDescription('');
          }}
        >
          {t.blueprint.addMisconceptionButton}
        </button>
      </div>
    </div>
  );
}

function AddNode({
  conceptId,
  onPatch,
}: {
  conceptId: number;
  onPatch: (ops: unknown[]) => Promise<void>;
}) {
  const t = useDict();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="panel">
      <p className="section-label">{t.blueprint.addNodeByHandLabel}</p>
      <div className="stack gap-9">
        <input
          className="field"
          placeholder={t.blueprint.nodeTitlePlaceholder}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label={t.blueprint.newNodeTitleAriaLabel}
        />
        <textarea
          className="field"
          rows={3}
          placeholder={t.blueprint.nodeDescriptionPlaceholder}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label={t.blueprint.newNodeDescriptionAriaLabel}
        />
        <button
          type="button"
          className="btn small primary"
          style={{ alignSelf: 'flex-start' }}
          disabled={!title.trim() || !description.trim()}
          onClick={() => {
            void onPatch([
              { op: 'add-node', conceptId, title: title.trim(), description: description.trim() },
            ]);
            setTitle('');
            setDescription('');
          }}
        >
          {t.blueprint.addNodeButton}
        </button>
      </div>
    </div>
  );
}
