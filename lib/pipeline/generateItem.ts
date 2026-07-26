/**
 * Item generation: generate -> similarity guard -> blind validation -> persist.
 *
 * Two sequential LLM calls per item, which is why nothing calls this on the answer
 * path. The pre-generation worker keeps a buffer ahead of the session runner.
 */

import type { Db } from '../db';
import { iso, now } from '../clock';
import { structured } from '../llm/client';
import { buildMcItemCall, type McItemOut } from '../prompts/itemMc';
import { buildFreeItemCall, type FreeItemOut } from '../prompts/itemFree';
import { buildValidationCall, gate } from '../prompts/validate';
import { tooSimilar } from '../analysis/similarity';
import { selectExcerpt, looksContested } from '../source';
import type { ItemRow, ValidatorVerdict } from '../db/types';
import { logEvent } from '../ops';
import {
  activeMisconceptions,
  getCell,
  getConcept,
  getNode,
  listMisconceptions,
  recentStems,
  upsertMisconception,
} from '../db/queries';

export const MAX_GENERATION_ATTEMPTS = 3;
const RECENT_STEMS_MC = 5;
const RECENT_STEMS_FREE = 3;

export interface GenerationOutcome {
  item: ItemRow | null;
  attempts: number;
  /** Every validator verdict, including rejections — the rejection rate per node is
   *  the signal that a blueprint node is badly drawn (limitation 2). */
  rejections: { reasons: string[]; verdict: ValidatorVerdict }[];
  error: string | null;
}

export async function generateItemForCell(db: Db, cellId: number): Promise<GenerationOutcome> {
  const cell = getCell(db, cellId);
  if (!cell) return fail('cell not found');

  const started = Date.now();
  const outcome =
    cell.depth === 6 ? await generateFreeItem(db, cellId) : await generateMcItem(db, cellId);

  // Two model calls per attempt, so a slow cell is usually a cell that is being
  // regenerated — the attempt count is the part worth seeing next to the duration.
  logEvent(db, outcome.item ? 'info' : 'warn', 'generate.timing', {
    cellId,
    depth: cell.depth,
    ms: Date.now() - started,
    attempts: outcome.attempts,
    ok: Boolean(outcome.item),
  });

  return outcome;
}

/* --------------------------------------------------------------- MC (D1-D5) */

export async function generateMcItem(db: Db, cellId: number): Promise<GenerationOutcome> {
  const ctx = loadContext(db, cellId);
  if (!ctx) return fail('cell not found');

  const previous = recentStems(db, cellId, RECENT_STEMS_MC);
  const rejections: GenerationOutcome['rejections'] = [];
  let deadDistractorNote: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    attempts = attempt;

    const generated = await structured<McItemOut>(
      buildMcItemCall({
        nodeTitle: ctx.node.title,
        nodeDescription: ctx.node.description,
        depthLevel: ctx.cell.depth,
        sourceExcerpt: ctx.excerpt,
        misconceptions: ctx.misconceptions.map((m) => ({
          label: m.label,
          description: m.description,
        })),
        recentStems: previous,
        activeMisconceptionLabels: ctx.activeLabels,
        deadDistractorNote,
      })
    );
    const gen: McItemOut = generated.data;

    const shapeProblem = checkMcShape(gen);
    if (shapeProblem) {
      rejections.push({ reasons: [shapeProblem], verdict: emptyVerdict() });
      continue;
    }

    // Invariant 6, enforced rather than requested.
    if (tooSimilar(gen.stem, previous)) {
      rejections.push({ reasons: ['stem too similar to a recent item'], verdict: emptyVerdict() });
      continue;
    }

    // Invariant 3: a separate call that independently solves the item, with no
    // sight of the key. Options go over in randomized order.
    const order = shuffledIndices(gen.options.length);
    const shownTexts = order.map((i) => gen.options[i].text);
    const keyedIndex = gen.options.findIndex((o) => o.is_correct);
    const keyedPosition = order.indexOf(keyedIndex) + 1;

    const validated = await structured<ValidatorVerdict>(
      buildValidationCall({
        stem: gen.stem,
        optionTexts: shownTexts,
        nodeDescription: ctx.node.description,
        sourceExcerpt: ctx.excerpt,
      })
    );
    const verdict: ValidatorVerdict = validated.data;

    const result = gate(verdict, keyedPosition);

    if (result.regenerateOption && attempt < MAX_GENERATION_ATTEMPTS) {
      // A dead_distractor alone does not block, but it earns one regeneration
      // attempt of that option before we accept the item.
      deadDistractorNote = verdict.notes || 'one option was judged implausible';
      rejections.push({ reasons: ['dead_distractor — regenerating once'], verdict });
      continue;
    }

    if (!result.pass && !result.regenerateOption) {
      rejections.push({ reasons: result.reasons, verdict });
      logRejection(db, cellId, verdict, result.reasons);
      continue;
    }

    // Passed, or a dead_distractor that recurred — serve it and record the flag.
    const item = persistMcItem(db, {
      cellId,
      nodeId: ctx.node.id,
      gen,
      order,
      verdict,
    });
    return { item, attempts, rejections, error: null };
  }

  const error = `generation failed after ${attempts} attempts`;
  logEvent(db, 'warn', 'generate.mc_failed', {
    cellId,
    node: ctx.node.title,
    depth: ctx.cell.depth,
    attempts,
    reasons: rejections.flatMap((r) => r.reasons),
  });
  return { item: null, attempts, rejections, error };
}

function checkMcShape(gen: McItemOut): string | null {
  if (gen.options.length !== 4) return `expected 4 options, got ${gen.options.length}`;
  const correct = gen.options.filter((o) => o.is_correct);
  if (correct.length !== 1) return `expected exactly 1 correct option, got ${correct.length}`;
  // Invariant 4: every distractor is tagged to a named misconception.
  const untagged = gen.options.filter((o) => !o.is_correct && !o.misconception_label?.trim());
  if (untagged.length > 0) return `${untagged.length} distractor(s) carry no misconception label`;
  const texts = new Set(gen.options.map((o) => o.text.trim().toLowerCase()));
  if (texts.size !== 4) return 'duplicate option text';
  return null;
}

interface PersistMcInput {
  cellId: number;
  nodeId: number;
  gen: McItemOut;
  order: number[];
  verdict: ValidatorVerdict;
}

export function persistMcItem(db: Db, input: PersistMcInput): ItemRow {
  const { cellId, nodeId, gen, order, verdict } = input;

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated, validator_json)
         VALUES (?, 'mc', ?, ?, ?, 1, ?)`
      )
      .run(cellId, gen.stem, gen.explanation, iso(now()), JSON.stringify(verdict));
    const itemId = Number(info.lastInsertRowid);

    const insertOption = db.prepare(
      `INSERT INTO options (item_id, position, text, is_correct, misconception_id, rationale)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    order.forEach((sourceIndex, position) => {
      const o = gen.options[sourceIndex];
      let misconceptionId: number | null = null;

      if (!o.is_correct) {
        const label = (o.misconception_label ?? '').trim();
        // A label the generator invented is inserted with origin 'generated' before
        // the item is persisted, so options.misconception_id is never null on a
        // distractor (invariant 4).
        const m = upsertMisconception(db, {
          nodeId,
          label: label || 'unlabelled belief',
          description: o.rationale,
          origin: 'generated',
        });
        misconceptionId = m.id;
      }

      insertOption.run(
        itemId,
        position + 1,
        o.text,
        o.is_correct ? 1 : 0,
        misconceptionId,
        o.rationale
      );
    });

    return itemId;
  });

  const itemId = tx();
  return db.prepare(`SELECT * FROM items WHERE id = ?`).get(itemId) as ItemRow;
}

/* -------------------------------------------------------------- free (D6) */

export async function generateFreeItem(db: Db, cellId: number): Promise<GenerationOutcome> {
  const ctx = loadContext(db, cellId);
  if (!ctx) return fail('cell not found');

  const previous = recentStems(db, cellId, RECENT_STEMS_FREE);

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const generated = await structured<FreeItemOut>(
      buildFreeItemCall({
        nodeTitle: ctx.node.title,
        nodeDescription: ctx.node.description,
        sourceExcerpt: ctx.excerpt,
        misconceptions: ctx.misconceptions.map((m) => ({
          label: m.label,
          description: m.description,
        })),
        recentStems: previous,
        contested: ctx.contested,
      })
    );
    const gen: FreeItemOut = generated.data;

    if (tooSimilar(gen.stem, previous)) continue;
    if (gen.rubric.length < 4) continue;

    const info = db
      .prepare(
        `INSERT INTO items (cell_id, kind, stem, explanation, rubric_json, generated_at, validated)
         VALUES (?, 'free', ?, ?, ?, ?, 1)`
      )
      .run(
        cellId,
        gen.stem,
        'Graded against the rubric below. Each criterion is checked against what the answer literally says.',
        JSON.stringify(gen.rubric),
        iso(now())
      );

    const item = db
      .prepare(`SELECT * FROM items WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as ItemRow;
    return { item, attempts: attempt, rejections: [], error: null };
  }

  return {
    item: null,
    attempts: MAX_GENERATION_ATTEMPTS,
    rejections: [],
    error: 'free-response generation failed',
  };
}

/* ------------------------------------------------------------------ shared */

interface GenContext {
  cell: NonNullable<ReturnType<typeof getCell>>;
  node: NonNullable<ReturnType<typeof getNode>>;
  excerpt: string;
  misconceptions: ReturnType<typeof listMisconceptions>;
  activeLabels: string[];
  contested: boolean;
}

function loadContext(db: Db, cellId: number): GenContext | null {
  const cell = getCell(db, cellId);
  if (!cell) return null;
  const node = getNode(db, cell.node_id);
  if (!node) return null;
  const concept = getConcept(db, node.concept_id);
  if (!concept) return null;

  const misconceptions = listMisconceptions(db, node.id);
  const activeIds = new Set(activeMisconceptions(db, concept.id).map((m) => m.id));

  return {
    cell,
    node,
    excerpt: selectExcerpt(concept.source_text, `${node.title} ${node.description}`),
    misconceptions,
    activeLabels: misconceptions.filter((m) => activeIds.has(m.id)).map((m) => m.label),
    contested: looksContested(concept.name, concept.source_note),
  };
}

/**
 * Rejections are logged too. The rejection rate per node is the signal that a
 * blueprint node is badly drawn, which the item-health screen surfaces.
 */
function logRejection(
  db: Db,
  cellId: number,
  verdict: ValidatorVerdict,
  reasons: string[]
): void {
  db.prepare(
    `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated, validator_json, retired)
     VALUES (?, 'mc', ?, '', ?, 0, ?, 1)`
  ).run(
    cellId,
    '(rejected by validator — not served)',
    iso(now()),
    JSON.stringify({ ...verdict, rejected: true, reasons })
  );
}

function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emptyVerdict(): ValidatorVerdict {
  return { best_option: 0, defensible_options: [], flags: [], notes: '' };
}

function fail(error: string): GenerationOutcome {
  return { item: null, attempts: 0, rejections: [], error };
}
