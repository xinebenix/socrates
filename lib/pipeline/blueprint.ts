/**
 * Blueprint generation and merge.
 *
 * Invariant 11: the blueprint is editable by the user and revisable by evidence. It
 * is a knowledge artifact that can be wrong, and every item inherits its errors — so
 * regeneration merges rather than replaces, and a node that survives keeps its
 * cells, its mastery, and its response history.
 */

import type { Db } from '../db';
import { structured } from '../llm/client';
import { buildBlueprintCall, type BlueprintOut } from '../prompts/blueprint';
import { looksContested } from '../source';
import { logEvent } from '../ops';
import {
  ensureCells,
  createNode,
  findNodeByTitle,
  getConcept,
  listNodes,
  updateNode,
  upsertMisconception,
} from '../db/queries';

export interface BlueprintReport {
  created: string[];
  updated: string[];
  /** Nodes already present that the regeneration did not produce. Kept, never dropped. */
  unmatched: string[];
  newMisconceptions: { node: string; label: string }[];
  gaps: string[];
}

export async function generateBlueprint(
  db: Db,
  conceptId: number,
  hints?: string | null
): Promise<BlueprintReport> {
  const concept = getConcept(db, conceptId);
  if (!concept) throw new Error(`concept ${conceptId} not found`);

  const call = buildBlueprintCall({
    conceptName: concept.name,
    sourceText: concept.source_text ?? '',
    hints: hints ?? null,
    contested: looksContested(concept.name, concept.source_note),
  });

  const started = Date.now();
  const { data, attempts } = await structured<BlueprintOut>(call);
  const report = mergeBlueprint(db, conceptId, data);

  // "It felt slow" is not something anyone can act on. This is.
  logEvent(db, 'info', 'blueprint.generated', {
    conceptId,
    ms: Date.now() - started,
    attempts,
    nodes: data.nodes.length,
    hasSource: Boolean(concept.source_text?.trim()),
  });

  return report;
}

/** Split out from the network call so the merge semantics can be tested directly. */
export function mergeBlueprint(db: Db, conceptId: number, data: BlueprintOut): BlueprintReport {
  const report: BlueprintReport = {
    created: [],
    updated: [],
    unmatched: [],
    newMisconceptions: [],
    gaps: data.gaps ?? [],
  };

  const before = listNodes(db, conceptId);
  const matchedIds = new Set<number>();
  let nextOrder = before.length;

  const tx = db.transaction(() => {
    for (const incoming of data.nodes) {
      const depths = normalizeDepths(incoming.applicable_depths);
      const existing = findNodeByTitle(db, conceptId, incoming.title);

      let nodeId: number;
      if (existing) {
        matchedIds.add(existing.id);
        updateNode(db, existing.id, { description: incoming.description });
        ensureCells(db, existing.id, depths);
        nodeId = existing.id;
        report.updated.push(incoming.title);
      } else {
        const node = createNode(db, {
          conceptId,
          title: incoming.title,
          description: incoming.description,
          orderIndex: nextOrder++,
          origin: 'generated',
          applicableDepths: depths,
        });
        nodeId = node.id;
        report.created.push(incoming.title);
      }

      for (const m of incoming.misconceptions ?? []) {
        const existingM = db
          .prepare(
            `SELECT id FROM misconceptions WHERE node_id = ? AND lower(trim(label)) = lower(trim(?))`
          )
          .get(nodeId, m.label) as { id: number } | undefined;
        if (!existingM) report.newMisconceptions.push({ node: incoming.title, label: m.label });
        upsertMisconception(db, {
          nodeId,
          label: m.label,
          description: m.description,
          origin: 'generated',
        });
      }
    }

    // Survivors the regeneration did not mention are kept. Truncating here would
    // silently destroy mastery and response history.
    for (const n of before) {
      if (!matchedIds.has(n.id)) report.unmatched.push(n.title);
    }
  });

  tx();
  return report;
}

function normalizeDepths(depths: number[] | undefined): number[] {
  const set = new Set(
    (depths ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 6)
  );
  // A node with no declared depths would be unservable. D1 and D2 always apply.
  if (set.size === 0) return [1, 2];
  return [...set].sort((a, b) => a - b);
}
