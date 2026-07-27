/**
 * The speculative pipeline, through the Message Batches API.
 *
 * Everything here is work nobody is waiting on — the worker filling the buffer ahead
 * of future sessions — so it takes the Batch API's 50% discount, which costs latency
 * only a buffer can afford. The quality machinery is unchanged: the same prompt
 * builders, the same shape and similarity checks, and one blind validation per item
 * with no sight of the key. A batch-generated item is indistinguishable from a
 * synchronous one by design, and cheaper by half.
 *
 * Two-phase state machine, persisted in gen_batches so it survives restarts:
 *
 *   generate:  one request per short cell, asking for that cell's whole shortfall
 *   validate:  one request per surviving item from a completed generate batch
 *
 * A failed or expired entry is simply dropped — the shortfall is still visible to
 * the next tick, which resubmits. No retry machinery, no zombie state.
 */

import type { Db } from '../db';
import { iso, now } from '../clock';
import { buildRequest } from '../llm/client';
import { getBatchTransport, type BatchRequest, type BatchResultEntry } from '../llm/batch';
import { validateShape } from '../llm/schema';
import { MC_ITEM_SET_SCHEMA, type McItemOut, type McItemSetOut } from '../prompts/itemMc';
import {
  buildValidationCall,
  gate,
  VALIDATION_SCHEMA,
} from '../prompts/validate';
import {
  buildMcCallForCell,
  cellGenerationContext,
  checkMcShape,
  logRejection,
  persistMcItem,
} from './generateItem';
import { recentStems } from '../db/queries';
import { holdCells } from './cellLock';
import { tooSimilar } from '../analysis/similarity';
import { recordUsage } from '../cost';
import { logEvent } from '../ops';
import type { ValidatorVerdict } from '../db/types';

interface GenPayloadCell {
  customId: string;
  cellId: number;
  want: number;
  /** The model the request was routed to, recorded for accounting. */
  model: string;
  depth: number;
}

interface ValPayloadItem {
  customId: string;
  cellId: number;
  nodeId: number;
  depth: number;
  /** The validator's model, for accounting. */
  model: string;
  /** The generator's model, recorded on the item it wrote. Often not the same one. */
  genModel: string;
  gen: McItemOut;
  order: number[];
  keyedPosition: number;
}

interface BatchRow {
  id: number;
  provider_batch_id: string;
  phase: 'generate' | 'validate';
  payload: string;
  created_at: string;
}

/** Batches older than this are written off — the provider expires them at 24h. */
const ABANDON_AFTER_MS = 26 * 60 * 60 * 1000;

function openBatches(db: Db): BatchRow[] {
  return db
    .prepare(`SELECT * FROM gen_batches WHERE completed_at IS NULL ORDER BY id`)
    .all() as BatchRow[];
}

function complete(db: Db, id: number): void {
  db.prepare(`UPDATE gen_batches SET completed_at = ? WHERE id = ?`).run(iso(now()), id);
}

/**
 * Cells with generation already in flight, so the shortfall pass does not submit the
 * same cell twice while its first batch is still processing.
 */
export function cellsInFlight(db: Db): Set<number> {
  const out = new Set<number>();
  for (const row of openBatches(db)) {
    if (row.phase === 'generate') {
      for (const c of (JSON.parse(row.payload) as { cells: GenPayloadCell[] }).cells) {
        out.add(c.cellId);
      }
    } else {
      for (const i of (JSON.parse(row.payload) as { items: ValPayloadItem[] }).items) {
        out.add(i.cellId);
      }
    }
  }
  return out;
}

/** Submit one generation batch covering the given shortfalls. */
export async function submitGenerationBatch(
  db: Db,
  shortfalls: { cellId: number; want: number }[]
): Promise<number> {
  const requests: BatchRequest[] = [];
  const cells: GenPayloadCell[] = [];

  for (const { cellId, want } of shortfalls) {
    const built = buildMcCallForCell(db, cellId, want);
    if (!built) continue;
    const customId = `cell-${cellId}`;
    const request = buildRequest(built.call);
    requests.push({ customId, request });
    cells.push({ customId, cellId, want, model: String(request.model), depth: built.depth });
  }

  if (requests.length === 0) return 0;

  // The gen_batches row — the only thing cellsInFlight() can see — cannot be written
  // until the provider returns an id. Hold the cells in the in-process registry across
  // that round trip so a synchronous fill cannot claim them in the gap.
  const held = holdCells(cells.map((c) => c.cellId));
  try {
    const providerId = await getBatchTransport().submit(requests);
    db.prepare(
      `INSERT INTO gen_batches (provider_batch_id, phase, payload, created_at) VALUES (?, 'generate', ?, ?)`
    ).run(providerId, JSON.stringify({ cells }), iso(now()));

    logEvent(db, 'info', 'batch.submitted', { phase: 'generate', requests: requests.length });
    return requests.length;
  } finally {
    held();
  }
}

export interface BatchProgress {
  itemsPersisted: number;
  validationsSubmitted: number;
  failed: number;
}

/**
 * Advance every open batch: retrieve what has ended, turn generation results into a
 * validation batch, and turn validation results into persisted items.
 */
export async function processBatches(db: Db): Promise<BatchProgress> {
  const progress: BatchProgress = { itemsPersisted: 0, validationsSubmitted: 0, failed: 0 };

  // Expiry is swept first and unconditionally, before any network call can fail and
  // skip it. An open gen_batches row is not inert: cellsInFlight() is built from it,
  // so a row that never completes excludes its cells from generation *forever* — the
  // buffer for them silently stops filling, and nothing says so.
  sweepExpired(db);

  for (const row of openBatches(db)) {
    let results;
    try {
      results = await getBatchTransport().poll(row.provider_batch_id);
    } catch (err) {
      logEvent(db, 'error', 'batch.poll_failed', {
        batch: row.provider_batch_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (results === null) continue; // still processing; expiry handled by the sweep

    try {
      if (row.phase === 'generate') {
        progress.validationsSubmitted += await handleGenerateResults(db, row, results, progress);
      } else {
        handleValidateResults(db, row, results, progress);
      }
    } catch (err) {
      // A throw here — most likely submitting the follow-on validation batch — used to
      // propagate out and leave this row open for good. The results are lost either
      // way; closing the row is what lets the next tick see the shortfall and retry.
      logEvent(db, 'error', 'batch.handle_failed', {
        batch: row.provider_batch_id,
        phase: row.phase,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      complete(db, row.id);
    }
  }

  return progress;
}

/**
 * Close out batches the provider will never answer.
 *
 * Runs on every tick regardless of what else succeeds or fails, because the cost of
 * missing it is unbounded: the row's cells stay excluded from generation until someone
 * edits the database.
 */
function sweepExpired(db: Db): void {
  const cutoff = now().getTime() - ABANDON_AFTER_MS;
  for (const row of openBatches(db)) {
    if (Date.parse(row.created_at) < cutoff) {
      complete(db, row.id);
      logEvent(db, 'warn', 'batch.abandoned', {
        batch: row.provider_batch_id,
        phase: row.phase,
        ageHours: Math.round((now().getTime() - Date.parse(row.created_at)) / 3_600_000),
      });
    }
  }
}

async function handleGenerateResults(
  db: Db,
  row: BatchRow,
  results: BatchResultEntry[],
  progress: BatchProgress
): Promise<number> {
  const payload = JSON.parse(row.payload) as { cells: GenPayloadCell[] };
  const byId = new Map(payload.cells.map((c) => [c.customId, c]));
  const toValidate: ValPayloadItem[] = [];
  const requests: BatchRequest[] = [];

  for (const entry of results) {
    const cell = byId.get(entry.customId);
    if (!cell) continue;

    const ctx = cellGenerationContext(db, cell.cellId);
    if (!ctx) continue;

    // Usage is recorded per entry, flagged as batch — half rate.
    recordUsage(db, {
      name: `item-mc-d${cell.depth}`,
      model: cell.model,
      usage: entry.usage,
      ms: 0,
      batch: true,
    });

    if (!entry.ok || !entry.text) {
      progress.failed += cell.want;
      continue;
    }

    let parsed: McItemSetOut;
    try {
      parsed = JSON.parse(entry.text) as McItemSetOut;
    } catch {
      progress.failed += cell.want;
      continue;
    }
    if (validateShape(parsed, MC_ITEM_SET_SCHEMA).length > 0) {
      progress.failed += cell.want;
      continue;
    }

    // The same cheap gates the synchronous path applies, before any paid validation.
    const previous = recentStems(db, cell.cellId, 5);
    const kept: McItemOut[] = [];
    for (const gen of parsed.items ?? []) {
      if (checkMcShape(gen)) continue;
      if (tooSimilar(gen.stem, [...previous, ...kept.map((k) => k.stem)])) continue;
      kept.push(gen);
    }

    kept.slice(0, cell.want).forEach((gen, i) => {
      const order = shuffled(gen.options.length);
      const keyedIndex = gen.options.findIndex((o) => o.is_correct);
      const customId = `item-${cell.cellId}-${i}`;

      const request = buildRequest(
        buildValidationCall({
          stem: gen.stem,
          optionTexts: order.map((x) => gen.options[x].text),
          nodeDescription: ctx.nodeDescription,
          sourceExcerpt: ctx.excerpt,
          depth: ctx.depth,
        })
      );
      requests.push({ customId, request });
      toValidate.push({
        customId,
        cellId: cell.cellId,
        nodeId: ctx.nodeId,
        depth: ctx.depth,
        model: String(request.model),
        genModel: cell.model,
        gen,
        order,
        keyedPosition: order.indexOf(keyedIndex) + 1,
      });
    });
  }

  if (requests.length === 0) return 0;

  const providerId = await getBatchTransport().submit(requests);
  db.prepare(
    `INSERT INTO gen_batches (provider_batch_id, phase, payload, created_at) VALUES (?, 'validate', ?, ?)`
  ).run(providerId, JSON.stringify({ items: toValidate }), iso(now()));

  logEvent(db, 'info', 'batch.submitted', { phase: 'validate', requests: requests.length });
  return requests.length;
}

function handleValidateResults(
  db: Db,
  row: BatchRow,
  results: BatchResultEntry[],
  progress: BatchProgress
): void {
  const payload = JSON.parse(row.payload) as { items: ValPayloadItem[] };
  const byId = new Map(payload.items.map((i) => [i.customId, i]));
  const persistedBefore = progress.itemsPersisted;
  const failedBefore = progress.failed;

  for (const entry of results) {
    const item = byId.get(entry.customId);
    if (!item) continue;

    recordUsage(db, {
      name: 'validate-mc',
      model: item.model,
      usage: entry.usage,
      ms: 0,
      batch: true,
    });

    if (!entry.ok || !entry.text) {
      progress.failed++;
      continue;
    }

    let verdict: ValidatorVerdict;
    try {
      verdict = JSON.parse(entry.text) as ValidatorVerdict;
    } catch {
      progress.failed++;
      continue;
    }
    if (validateShape(verdict, VALIDATION_SCHEMA).length > 0) {
      progress.failed++;
      continue;
    }

    const result = gate(verdict, item.keyedPosition);

    // Same semantics as the synchronous path's final attempt: a hard rejection is
    // logged and dropped; a dead_distractor alone is accepted with the flag recorded,
    // since a batch has no cheap way to ask for one option rewritten.
    if (!result.pass && !result.regenerateOption) {
      logRejection(db, item.cellId, verdict, result.reasons);
      progress.failed++;
      continue;
    }

    persistMcItem(db, {
      cellId: item.cellId,
      nodeId: item.nodeId,
      gen: item.gen,
      order: item.order,
      verdict,
      // A batch spans a restart, so this comes off the payload rather than from
      // today's routing: the pin may well have been cleared since it was submitted.
      genModel: item.genModel,
    });
    progress.itemsPersisted++;
  }

  // This batch's own numbers. Logging the shared running total made every batch in a
  // tick look progressively larger than it was.
  logEvent(db, 'info', 'batch.completed', {
    phase: 'validate',
    batch: row.provider_batch_id,
    persisted: progress.itemsPersisted - persistedBefore,
    failed: progress.failed - failedBefore,
  });
}

function shuffled(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
