/**
 * Item generation: generate -> similarity guard -> blind validation -> persist.
 *
 * Two sequential LLM calls per item, which is why nothing calls this on the answer
 * path. The pre-generation worker keeps a buffer ahead of the session runner.
 */

import type { Db } from '../db';
import { iso, now } from '../clock';
import { structured } from '../llm/client';
import { buildMcItemCall, type McItemOut, type McItemSetOut } from '../prompts/itemMc';
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
  const outcome = await generateItemsForCell(db, cellId, 1);
  return { ...outcome, item: outcome.items[0] ?? null };
}

/**
 * Fill one cell with up to `want` items.
 *
 * D6 is free-response and generated singly: there is one D6 item per session, so
 * there is nothing to amortize and the cell is never filled deep.
 */
export async function generateItemsForCell(
  db: Db,
  cellId: number,
  want = 1
): Promise<SetGenerationOutcome> {
  const cell = getCell(db, cellId);
  if (!cell) return { ...fail('cell not found'), items: [] };

  const started = Date.now();
  const outcome: SetGenerationOutcome =
    cell.depth === 6
      ? await (async () => {
          const one = await generateFreeItem(db, cellId);
          return { ...one, items: one.item ? [one.item] : [] };
        })()
      : await generateMcItems(db, cellId, Math.max(1, want));

  // The per-item figure is what to compare across settings — a set of four in one
  // call should land far below four times a single.
  logEvent(db, outcome.items.length > 0 ? 'info' : 'warn', 'generate.timing', {
    cellId,
    depth: cell.depth,
    ms: Date.now() - started,
    msPerItem: outcome.items.length ? Math.round((Date.now() - started) / outcome.items.length) : null,
    attempts: outcome.attempts,
    wanted: want,
    produced: outcome.items.length,
    ok: outcome.items.length > 0,
  });

  return outcome;
}

/* --------------------------------------------------------------- MC (D1-D5) */

export async function generateMcItem(db: Db, cellId: number): Promise<GenerationOutcome> {
  const outcome = await generateMcItems(db, cellId, 1);
  return { ...outcome, item: outcome.items[0] ?? null };
}

export interface SetGenerationOutcome extends Omit<GenerationOutcome, 'item'> {
  items: ItemRow[];
}

/**
 * Generate up to `want` items for one cell.
 *
 * The economics: nearly all of a generation's output tokens are the reasoning that
 * happens *before* the item — working out what the node means, what a learner gets
 * wrong about it, which distractors are live. That work is identical for every item
 * on the same cell, and doing it once per item was the single largest avoidable cost
 * in the system. Asking for four items in one call pays it once.
 *
 * Validation does not amortize and must not: each item gets its own blind solve, by
 * a call that has seen no other item and no key. That is invariant 3, and it is the
 * reason a cheaper generator is safe.
 */
export async function generateMcItems(
  db: Db,
  cellId: number,
  want: number
): Promise<SetGenerationOutcome> {
  const ctx = loadContext(db, cellId);
  if (!ctx) return { ...fail('cell not found'), items: [] };

  const previous = recentStems(db, cellId, RECENT_STEMS_MC);
  const rejections: SetGenerationOutcome['rejections'] = [];
  const accepted: ItemRow[] = [];
  const acceptedStems: string[] = [];
  let deadDistractorNote: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    attempts = attempt;
    const shortfall = want - accepted.length;
    if (shortfall <= 0) break;

    const generated = await structured<McItemSetOut>(
      buildMcItemCall({
        nodeTitle: ctx.node.title,
        nodeDescription: ctx.node.description,
        depthLevel: ctx.cell.depth,
        sourceExcerpt: ctx.excerpt,
        misconceptions: ctx.misconceptions.map((m) => ({
          label: m.label,
          description: m.description,
        })),
        // Items accepted earlier in this same call count as recent, so a retry does
        // not quietly reproduce one we already kept.
        recentStems: [...acceptedStems, ...previous],
        activeMisconceptionLabels: ctx.activeLabels,
        deadDistractorNote,
        count: shortfall,
      })
    );

    // Taken off the request rather than recomputed from modelFor(): what was actually
    // sent is the only honest answer, and it is what the pin changes.
    const genModel = String(generated.request.model ?? '');
    const candidates = generated.data.items ?? [];
    if (candidates.length === 0) {
      rejections.push({ reasons: ['generator returned no items'], verdict: emptyVerdict() });
      continue;
    }

    // Cheap checks first, so nothing malformed reaches a paid validation call.
    const viable: McItemOut[] = [];
    for (const gen of candidates) {
      const shapeProblem = checkMcShape(gen);
      if (shapeProblem) {
        rejections.push({ reasons: [shapeProblem], verdict: emptyVerdict() });
        continue;
      }
      // Invariant 6, enforced rather than requested — against recent stems, against
      // what this call already produced, and against what earlier attempts kept.
      if (tooSimilar(gen.stem, [...acceptedStems, ...previous, ...viable.map((v) => v.stem)])) {
        rejections.push({
          reasons: ['stem too similar to a recent item'],
          verdict: emptyVerdict(),
        });
        continue;
      }
      viable.push(gen);
    }

    // One blind validation per surviving item, in sequence — and each item is
    // persisted the moment its own validation passes, not after the whole set has
    // been checked.
    //
    // That ordering matters for latency, not correctness: a cell being filled three
    // deep used to make its first item available only after four call-durations, so
    // the session runner looked at an empty buffer and generated a duplicate inline.
    // Persisting incrementally puts item one in the buffer after two.
    //
    // Fanning the validations out would be faster still, but the caller's concurrency
    // limit counts model calls in flight and exists to stay under an account rate
    // limit — a cell quietly issuing four parallel calls inside one "slot" would make
    // that limit a fiction. Parallelism comes from the cell dimension instead, where
    // the buffer controls it explicitly.
    const lastAttempt = attempt === MAX_GENERATION_ATTEMPTS;

    for (const gen of viable) {
      if (accepted.length >= want) break;

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
          // Model selection only — never reaches the prompt. See ValidationInput.
          depth: ctx.cell.depth,
        })
      );
      const verdict: ValidatorVerdict = validated.data;
      const result = gate(verdict, keyedPosition);

      if (result.regenerateOption && !lastAttempt) {
        // A dead distractor alone does not block, but it earns one regeneration
        // of that option before the item is accepted.
        deadDistractorNote = verdict.notes || 'one option was judged implausible';
        rejections.push({ reasons: ['dead_distractor — regenerating once'], verdict });
        continue;
      }

      if (!result.pass && !result.regenerateOption) {
        rejections.push({ reasons: result.reasons, verdict });
        logRejection(db, cellId, verdict, result.reasons);
        continue;
      }

      accepted.push(
        persistMcItem(db, { cellId, nodeId: ctx.node.id, gen, order, verdict, genModel })
      );
      acceptedStems.push(gen.stem);
    }
  }

  if (accepted.length === 0) {
    // The reasons go into the message, not just the log. "Generation failed after 3
    // attempts" is a sentence that sends someone to read source code; "the validator
    // chose a different option than the key, twice" is one they can act on.
    const error = summarizeFailure(attempts, rejections);
    logEvent(db, 'warn', 'generate.mc_failed', {
      cellId,
      node: ctx.node.title,
      depth: ctx.cell.depth,
      attempts,
      reasons: rejections.flatMap((r) => r.reasons),
    });
    return { items: [], attempts, rejections, error };
  }

  return { items: accepted, attempts, rejections, error: null };
}

export function checkMcShape(gen: McItemOut): string | null {
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
  /** The model that wrote it, recorded on the row. Not the validator's. */
  genModel?: string | null;
}

export function persistMcItem(db: Db, input: PersistMcInput): ItemRow {
  const { cellId, nodeId, gen, order, verdict } = input;

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated, validator_json, gen_model)
         VALUES (?, 'mc', ?, ?, ?, 1, ?, ?)`
      )
      .run(
        cellId,
        gen.stem,
        gen.explanation,
        iso(now()),
        JSON.stringify(verdict),
        input.genModel ?? null
      );
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
  const rejections: GenerationOutcome['rejections'] = [];

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

    if (tooSimilar(gen.stem, previous)) {
      rejections.push({
        reasons: ['stem too similar to a recent item'],
        verdict: emptyVerdict(),
      });
      continue;
    }
    if (gen.rubric.length < 4) {
      rejections.push({
        reasons: [`rubric had ${gen.rubric.length} criteria, needs at least 4`],
        verdict: emptyVerdict(),
      });
      continue;
    }

    const info = db
      .prepare(
        `INSERT INTO items (cell_id, kind, stem, explanation, rubric_json, generated_at, validated, gen_model)
         VALUES (?, 'free', ?, ?, ?, ?, 1, ?)`
      )
      .run(
        cellId,
        gen.stem,
        'Graded against the rubric below. Each criterion is checked against what the answer literally says.',
        JSON.stringify(gen.rubric),
        iso(now()),
        String(generated.request.model ?? '') || null
      );

    const item = db
      .prepare(`SELECT * FROM items WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as ItemRow;
    return { item, attempts: attempt, rejections: [], error: null };
  }

  logEvent(db, 'warn', 'generate.free_failed', {
    cellId,
    node: ctx.node.title,
    reasons: rejections.flatMap((r) => r.reasons),
  });

  return {
    item: null,
    attempts: MAX_GENERATION_ATTEMPTS,
    rejections,
    error: `free-response ${summarizeFailure(MAX_GENERATION_ATTEMPTS, rejections)}`,
  };
}

/**
 * The generation call for a cell, built without sending it — the batch pipeline
 * submits these through the Batch API instead of the synchronous transport. Same
 * builder, same schema, same model routing; only the billing differs.
 */
export function buildMcCallForCell(
  db: Db,
  cellId: number,
  want: number
): { call: ReturnType<typeof buildMcItemCall>; nodeId: number; depth: number } | null {
  const ctx = loadContext(db, cellId);
  if (!ctx || ctx.cell.depth === 6) return null;

  const previous = recentStems(db, cellId, RECENT_STEMS_MC);
  return {
    call: buildMcItemCall({
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
      count: want,
    }),
    nodeId: ctx.node.id,
    depth: ctx.cell.depth,
  };
}

/** The context the batch pipeline needs when generation results come back. */
export function cellGenerationContext(
  db: Db,
  cellId: number
): { nodeId: number; nodeDescription: string; excerpt: string; depth: number } | null {
  const ctx = loadContext(db, cellId);
  if (!ctx) return null;
  return {
    nodeId: ctx.node.id,
    nodeDescription: ctx.node.description,
    excerpt: ctx.excerpt,
    depth: ctx.cell.depth,
  };
}

/**
 * Turn a pile of rejection reasons into one sentence someone can act on.
 *
 * Counts repeats rather than listing them, because three attempts producing the same
 * complaint means something different from three different complaints: the first is a
 * badly drawn node, the second is an unlucky run.
 */
export function summarizeFailure(
  attempts: number,
  rejections: { reasons: string[] }[]
): string {
  const counts = new Map<string, number>();
  for (const r of rejections) {
    for (const reason of r.reasons) {
      // Collapse the position numbers so "chose option 2, key is option 4" and
      // "chose option 1, key is option 3" count as the same complaint.
      const key = reason.replace(/\boption \d\b/g, 'option N');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return `generation produced nothing usable after ${attempts} attempts, with no recorded reason — check ops.recentErrors`;
  }

  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => (n > 1 ? `${reason} (x${n})` : reason));

  return `${attempts} attempts, all rejected: ${parts.join('; ')}`;
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
export function logRejection(
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
