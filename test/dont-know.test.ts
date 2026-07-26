/**
 * "I don't know" — giving up on an item and being shown the answer.
 *
 * The thing worth testing here is not the reveal, which is a render. It is that the
 * reveal costs something: a response is recorded, wrong, at the lowest confidence,
 * before anything is shown. Without that, an item could be looked at and then
 * answered, and the served slot would carry no response at all.
 */

import { describe, expect, it } from 'vitest';
import { addMisconceptions, makeFixture, masterCell } from './helpers';
import { installFakeLlm } from './fakeLlm';

import { generateFreeItem, generateMcItem } from '../lib/pipeline/generateItem';
import { submitDontKnowResponse } from '../lib/pipeline/respond';
import { startSession } from '../lib/pipeline/session';
import { getCell, listOptions, listResponsesForConcept } from '../lib/db/queries';
import { bktUpdate } from '../lib/mastery/bkt';
import type { Db } from '../lib/db';

function cellIdFor(db: Db, nodeId: number, depth: number): number {
  const row = db.prepare(`SELECT id FROM cells WHERE node_id = ? AND depth = ?`).get(nodeId, depth) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`no cell for node ${nodeId} depth ${depth}`);
  return row.id;
}

describe('declining a multiple-choice item', () => {
  it('records a wrong response at the lowest confidence, with no option chosen', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = cellIdFor(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const session = startSession(db, conceptId, { length: 10 });

    const feedback = submitDontKnowResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      latencyMs: 10_000,
    });

    expect(feedback.correct).toBe(false);
    expect(feedback.response.is_correct).toBe(0);
    expect(feedback.response.confidence).toBe('guessing');
    expect(feedback.response.chosen_option_id).toBeNull();
    expect(feedback.response.free_text).toBeNull();

    const responses = listResponsesForConcept(db, conceptId);
    expect(responses).toHaveLength(1);
  });

  it('reveals the explanation and a rationale for every option', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = cellIdFor(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const session = startSession(db, conceptId, { length: 10 });

    const feedback = submitDontKnowResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      latencyMs: 10_000,
    });

    expect(feedback.kind).toBe('mc');
    if (feedback.kind !== 'mc') throw new Error('expected mc feedback');

    expect(feedback.explanation).toBe(item!.explanation);
    expect(feedback.options).toHaveLength(listOptions(db, item!.id).length);
    for (const o of feedback.options) {
      expect(o.rationale.length).toBeGreaterThan(0);
    }
    expect(feedback.options.filter((o) => o.is_correct === 1)).toHaveLength(1);

    // Nothing was chosen, so nothing is attributed to the learner.
    expect(feedback.chosenOptionId).toBeNull();
    expect(feedback.misconceptionLabel).toBeNull();
  });

  it('attributes no misconception and moves no selection counter', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = cellIdFor(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const session = startSession(db, conceptId, { length: 10 });

    submitDontKnowResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      latencyMs: 10_000,
    });

    for (const o of listOptions(db, item!.id)) {
      expect(o.selected_count).toBe(0);
    }
    const beliefs = db
      .prepare(`SELECT times_selected FROM misconceptions WHERE node_id = ?`)
      .all(nodeIds[0]) as { times_selected: number }[];
    for (const b of beliefs) {
      expect(b.times_selected).toBe(0);
    }
  });

  it('updates the student model exactly as a wrong answer at the lowest confidence does', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = cellIdFor(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const session = startSession(db, conceptId, { length: 10 });

    const before = getCell(db, cellId)!;
    const feedback = submitDontKnowResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      latencyMs: 10_000,
    });
    const after = getCell(db, cellId)!;

    expect(feedback.pMasteryAfter).toBe(
      bktUpdate({
        pL: before.p_mastery,
        correct: false,
        confidence: 'guessing',
        numOptions: listOptions(db, item!.id).length,
      })
    );
    expect(after.p_mastery).toBe(feedback.pMasteryAfter);
    expect(after.response_count).toBe(before.response_count + 1);
    expect(after.last_tested_at).not.toBeNull();
  });

  it('collapses a long interval back to a day, as any failure does', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = cellIdFor(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    // A cell that was long since mastered and is not due for months.
    masterCell(db, nodeIds[0], 1);
    const session = startSession(db, conceptId, { length: 10 });

    submitDontKnowResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      latencyMs: 10_000,
    });

    const after = getCell(db, cellId)!;
    expect(after.interval_days).toBe(1);
    expect(after.consecutive_correct).toBe(0);
    expect(after.p_mastery).toBeLessThan(0.97);
    expect(after.next_due_at).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('declining a free-response item', () => {
  it('returns the rubric and spends nothing on grading an answer that was never written', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    const llm = installFakeLlm();

    const cellId = cellIdFor(db, nodeIds[0], 6);
    const { item } = await generateFreeItem(db, cellId);
    const session = startSession(db, conceptId, { length: 10 });

    const callsBefore = llm.calls.length;
    const feedback = submitDontKnowResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      latencyMs: 10_000,
    });

    expect(feedback.kind).toBe('free');
    if (feedback.kind !== 'free') throw new Error('expected free feedback');

    // No grader call: there is nothing to grade.
    expect(llm.calls.length).toBe(callsBefore);
    expect(feedback.verdict).toBeNull();
    expect(feedback.score).toBe(0);
    expect(feedback.rubric.length).toBeGreaterThanOrEqual(4);
    expect(feedback.response.grader_json).toBeNull();
    expect(feedback.response.free_text).toBeNull();
    expect(feedback.response.is_correct).toBe(0);
  });
});
