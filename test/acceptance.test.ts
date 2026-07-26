/**
 * Section 11 acceptance tests, one describe block per invariant.
 *
 * Tests 1, 2 and 5 are UI-level and live in test/ui/item-card.test.tsx.
 * Test 9 is the grader regression set and lives in test/grader.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { addMisconceptions, makeFixture, masterCell, setCellState } from './helpers';
import { CORRECT_MARK, installFakeLlm } from './fakeLlm';

import { buildValidationCall } from '../lib/prompts/validate';
import { buildRequest } from '../lib/llm/client';
import { generateMcItem } from '../lib/pipeline/generateItem';
import { submitMcResponse } from '../lib/pipeline/respond';
import { assembleSession } from '../lib/policy/assemble';
import { loadCellSnapshots } from '../lib/policy/snapshot';
import { checkInterleave } from '../lib/policy/interleave';
import { effectiveMastery, isDue } from '../lib/schedule/decay';
import { similarity } from '../lib/analysis/similarity';
import { mergeBlueprint } from '../lib/pipeline/blueprint';
import { startSession, nextItem } from '../lib/pipeline/session';
import {
  getCell,
  listMisconceptions,
  listNodes,
  listOptions,
  listResponsesForConcept,
  setItemFrozen,
  takeBufferedItem,
} from '../lib/db/queries';
import { addDays, iso } from '../lib/clock';

/* ------------------------------------------------------------------- test 3 */

describe('AT3 — the validator does not see the answer key (invariant 3)', () => {
  it('the serialized request body contains no is_correct, rationale or explanation', () => {
    const call = buildValidationCall({
      stem: 'Which statement best captures social ownership?',
      optionTexts: ['Society holds title.', 'The state holds title.', 'Income is transferred.', 'Prices are set centrally.'],
      nodeDescription: 'The distinction between social and state ownership.',
      sourceExcerpt: 'Social ownership is ownership by society as a whole.',
    });

    const body = JSON.stringify(buildRequest(call));

    expect(body).not.toContain('is_correct');
    expect(body).not.toContain('rationale');
    expect(body).not.toContain('explanation');
  });

  it('the input type has no field that could carry the key', () => {
    const call = buildValidationCall({
      stem: 's',
      optionTexts: ['a', 'b', 'c', 'd'],
      nodeDescription: 'n',
      sourceExcerpt: 'e',
    });
    // Everything that goes over the wire, flattened.
    const body = JSON.stringify(buildRequest(call)).toLowerCase();
    for (const forbidden of ['is_correct', 'iscorrect', 'correct_option', 'answer_key', 'rationale', 'explanation']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('still asks the validator to independently solve and audit', () => {
    const body = JSON.stringify(
      buildRequest(
        buildValidationCall({
          stem: 's',
          optionTexts: ['a', 'b', 'c', 'd'],
          nodeDescription: 'n',
          sourceExcerpt: 'e',
        })
      )
    );
    expect(body).toContain('best_option');
    expect(body).toContain('defensible_options');
    expect(body).toContain('dead_distractor');
  });
});

/* ------------------------------------------------------------------- test 4 */

describe('AT4 — every distractor is tagged to a misconception (invariant 4)', () => {
  it('a served item has exactly 3 distractors, each with a non-null misconception_id', async () => {
    const { db, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    expect(item).not.toBeNull();

    const options = listOptions(db, item!.id);
    expect(options).toHaveLength(4);

    const distractors = options.filter((o) => o.is_correct === 0);
    expect(distractors).toHaveLength(3);
    for (const d of distractors) {
      expect(d.misconception_id).not.toBeNull();
    }

    const correct = options.filter((o) => o.is_correct === 1);
    expect(correct).toHaveLength(1);
    expect(correct[0].misconception_id).toBeNull();
  });

  it('selecting a distractor writes its id into the response and increments the counter', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const distractor = listOptions(db, item!.id).find((o) => o.is_correct === 0)!;

    const before = listMisconceptions(db, nodeIds[0]).find((m) => m.id === distractor.misconception_id)!;

    const session = startSession(db, conceptId, { length: 10 });
    const feedback = submitMcResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      chosenOptionId: distractor.id,
      confidence: 'confident',
      latencyMs: 1000,
    });

    expect(feedback.correct).toBe(false);
    expect(feedback.response.chosen_option_id).toBe(distractor.id);

    const after = listMisconceptions(db, nodeIds[0]).find((m) => m.id === distractor.misconception_id)!;
    expect(after.times_selected).toBe(before.times_selected + 1);

    // The response record carries the tag through the option it points at.
    const responses = listResponsesForConcept(db, conceptId);
    expect(responses).toHaveLength(1);
    const chosen = listOptions(db, item!.id).find((o) => o.id === responses[0].chosen_option_id)!;
    expect(chosen.misconception_id).toBe(distractor.misconception_id);
  });

  it('a label the generator invents is inserted before the item is persisted', async () => {
    const { db, nodeIds } = makeFixture(1);
    // No misconception bank at all — the generator must propose all three.
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    expect(item).not.toBeNull();

    const distractors = listOptions(db, item!.id).filter((o) => o.is_correct === 0);
    expect(distractors.every((d) => d.misconception_id !== null)).toBe(true);

    const bank = listMisconceptions(db, nodeIds[0]);
    expect(bank.length).toBeGreaterThanOrEqual(3);
    expect(bank.every((m) => m.origin === 'generated')).toBe(true);
  });
});

/* ------------------------------------------------------------------- test 6 */

describe('AT6 — items are never reused verbatim (invariant 6)', () => {
  it('20 consecutive administrations of one cell produce no identical stems and none above 0.9 similarity', async () => {
    const { db, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const stems: string[] = [];

    for (let i = 0; i < 20; i++) {
      const { item } = await generateMcItem(db, cellId);
      expect(item, `administration ${i + 1} failed to generate`).not.toBeNull();
      stems.push(item!.stem);
      // Serve it, so the next administration sees it as a recent stem.
      db.prepare(`UPDATE items SET served_count = 1 WHERE id = ?`).run(item!.id);
    }

    expect(new Set(stems).size).toBe(20);

    for (let i = 0; i < stems.length; i++) {
      for (let j = i + 1; j < stems.length; j++) {
        expect(
          similarity(stems[i], stems[j]),
          `stems ${i + 1} and ${j + 1} are too alike:\n${stems[i]}\n${stems[j]}`
        ).toBeLessThanOrEqual(0.9);
      }
    }
  });

  it('the pipeline rejects a repeat even when the model keeps producing one', async () => {
    const { db, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);

    // Attempts 1 and 2 repeat the previous stem verbatim; attempt 3 varies.
    installFakeLlm({
      stem: (n) =>
        n <= 3
          ? 'Which statement best captures what social ownership requires?'
          : 'A cooperative buys out its investors — does that satisfy the definition, and why?',
    });

    const cellId = getCellId(db, nodeIds[0], 1);

    const first = await generateMcItem(db, cellId);
    expect(first.item).not.toBeNull();
    const firstStem = first.item!.stem;

    const second = await generateMcItem(db, cellId);
    expect(second.item).not.toBeNull();
    expect(second.item!.stem).not.toBe(firstStem);
    expect(similarity(second.item!.stem, firstStem)).toBeLessThanOrEqual(0.9);
    // It took more than one attempt, because the repeats were thrown away.
    expect(second.attempts).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------- test 7 */

describe('AT7 — interleaving (invariant 7)', () => {
  it('a 20-item session over 5 nodes has no adjacent repeats and no node twice in a 5-window', () => {
    const { db, conceptId } = makeFixture(5);
    const cells = loadCellSnapshots(db, conceptId);

    const { slots, warning } = assembleSession({
      cells,
      remediationNodeIds: new Set(),
      targetLength: 20,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(slots).toHaveLength(20);
    expect(warning).toBeNull();

    const nodeIds = slots.map((s) => s.nodeId);
    const { adjacentViolations, windowViolations } = checkInterleave(nodeIds);
    expect(adjacentViolations).toBe(0);
    expect(windowViolations).toBe(0);
  });

  it('holds at exactly four nodes', () => {
    const { db, conceptId } = makeFixture(4);
    const { slots } = assembleSession({
      cells: loadCellSnapshots(db, conceptId),
      remediationNodeIds: new Set(),
      targetLength: 20,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const { adjacentViolations, windowViolations } = checkInterleave(slots.map((s) => s.nodeId));
    expect(adjacentViolations).toBe(0);
    expect(windowViolations).toBe(0);
  });

  it('warns rather than silently violating when the blueprint is too small', () => {
    const { db, conceptId } = makeFixture(1);
    const { slots, warning } = assembleSession({
      cells: loadCellSnapshots(db, conceptId),
      remediationNodeIds: new Set(),
      targetLength: 10,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(slots.length).toBeGreaterThan(1);
    expect(warning).toMatch(/relaxed/);
  });
});

/* ------------------------------------------------------------------- test 8 */

describe('AT8 — scheduling persists and mastery decays with time (invariant 8)', () => {
  it('a cell answered correctly today is due in the future; 30 days on it has decayed and is due', async () => {
    const { db, conceptId, nodeIds, clock } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const correct = listOptions(db, item!.id).find((o) => o.is_correct === 1)!;

    const session = startSession(db, conceptId, { length: 10 });
    submitMcResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      chosenOptionId: correct.id,
      confidence: 'confident',
      latencyMs: 900,
    });

    const afterAnswer = getCell(db, cellId)!;
    expect(afterAnswer.next_due_at).not.toBeNull();
    expect(new Date(afterAnswer.next_due_at!).getTime()).toBeGreaterThan(clock.now().getTime());
    expect(isDue(afterAnswer.next_due_at, clock.now())).toBe(false);

    const storedMastery = afterAnswer.p_mastery;
    const effectiveToday = effectiveMastery(
      storedMastery,
      afterAnswer.last_tested_at,
      afterAnswer.interval_days,
      clock.now()
    );
    expect(effectiveToday).toBeCloseTo(storedMastery, 6);

    // Advance the clock 30 days.
    clock.advanceDays(30);

    const cell = getCell(db, cellId)!;
    // The stored latent estimate is untouched — decay is applied at read time.
    expect(cell.p_mastery).toBeCloseTo(storedMastery, 10);

    const effectiveLater = effectiveMastery(
      cell.p_mastery,
      cell.last_tested_at,
      cell.interval_days,
      clock.now()
    );
    expect(effectiveLater).toBeLessThan(storedMastery * 0.5);
    expect(isDue(cell.next_due_at, clock.now())).toBe(true);

    // And it shows up in the due queue the assembler builds.
    const snapshots = loadCellSnapshots(db, conceptId);
    const { slots } = assembleSession({
      cells: snapshots,
      remediationNodeIds: new Set(),
      targetLength: 10,
      now: clock.now(),
    });
    const dueSlot = slots.find((s) => s.cellId === cellId);
    expect(dueSlot).toBeDefined();
    expect(dueSlot!.slotKind).toBe('due');
  });
});

/* ------------------------------------------------------------------ test 10 */

describe('AT10 — benchmark items never enter practice (invariant 10)', () => {
  it('the buffer query never returns a frozen item', async () => {
    const { db, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);

    expect(takeBufferedItem(db, cellId, 'mc')?.id).toBe(item!.id);

    setItemFrozen(db, item!.id, true);
    expect(takeBufferedItem(db, cellId, 'mc')).toBeUndefined();
  });

  it('a practice session never serves a frozen item, even when it is the only one', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    const fake = installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const { item: frozenItem } = await generateMcItem(db, cellId);
    setItemFrozen(db, frozenItem!.id, true);

    const generationsBefore = fake.generations;

    const session = startSession(db, conceptId, { length: 10 });
    const { item: served } = await nextItem(db, session.sessionId);

    expect(served).not.toBeNull();
    expect(served!.itemId).not.toBe(frozenItem!.id);
    // It had to generate a fresh one rather than reach for the frozen item.
    expect(fake.generations).toBeGreaterThan(generationsBefore);
  });

  it('the SQL itself carries the predicate, not the caller', () => {
    const { db, nodeIds } = makeFixture(1);
    const cellId = getCellId(db, nodeIds[0], 1);
    db.prepare(
      `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated, frozen)
       VALUES (?, 'mc', 'frozen stem', 'x', '2026-01-01T00:00:00.000Z', 1, 1)`
    ).run(cellId);

    const rows = db
      .prepare(`SELECT * FROM items WHERE cell_id = ? AND frozen = 1`)
      .all(cellId) as unknown[];
    expect(rows).toHaveLength(1);
    expect(takeBufferedItem(db, cellId, 'mc')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ test 11 */

describe('AT11 — the blueprint is editable and regeneration merges (invariant 11)', () => {
  it('editing a node title and description preserves cells, mastery and response history', async () => {
    const { db, conceptId, nodeIds } = makeFixture(1);
    addMisconceptions(db, nodeIds[0]);
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[0], 1);
    const { item } = await generateMcItem(db, cellId);
    const correct = listOptions(db, item!.id).find((o) => o.is_correct === 1)!;

    const session = startSession(db, conceptId, { length: 10 });
    submitMcResponse(db, {
      sessionId: session.sessionId,
      itemId: item!.id,
      chosenOptionId: correct.id,
      confidence: 'confident',
      latencyMs: 500,
    });

    const before = getCell(db, cellId)!;
    const responsesBefore = listResponsesForConcept(db, conceptId).length;

    const { updateNode } = await import('../lib/db/queries');
    updateNode(db, nodeIds[0], {
      title: 'Ownership structures (revised)',
      description: 'A better description of what mastery here means.',
    });

    const after = getCell(db, cellId)!;
    expect(after.id).toBe(before.id);
    expect(after.p_mastery).toBeCloseTo(before.p_mastery, 10);
    expect(after.response_count).toBe(before.response_count);
    expect(after.next_due_at).toBe(before.next_due_at);
    expect(listResponsesForConcept(db, conceptId)).toHaveLength(responsesBefore);
  });

  it('regeneration merges rather than truncating: survivors keep mastery, absent nodes are kept', () => {
    const { db, conceptId, nodeIds } = makeFixture(2);
    masterCell(db, nodeIds[0], 1);
    const survivorCellId = getCellId(db, nodeIds[0], 1);
    const survivorBefore = getCell(db, survivorCellId)!;

    const report = mergeBlueprint(db, conceptId, {
      nodes: [
        {
          // Same title as node 1 — this one survives.
          title: 'Node 1',
          description: 'Rewritten description from the regeneration.',
          applicable_depths: [1, 2, 3],
          misconceptions: [{ label: 'a fresh belief', description: 'I think something new.' }],
        },
        {
          title: 'A brand new node',
          description: 'Was not in the blueprint before.',
          applicable_depths: [1, 2],
          misconceptions: [],
        },
      ],
      gaps: ['the source says nothing about X'],
    });

    expect(report.updated).toContain('Node 1');
    expect(report.created).toContain('A brand new node');
    // Node 2 was not produced by the regeneration and was kept, not dropped.
    expect(report.unmatched).toContain('Node 2');
    expect(listNodes(db, conceptId).map((n) => n.title)).toContain('Node 2');

    const survivorAfter = getCell(db, survivorCellId)!;
    expect(survivorAfter.id).toBe(survivorBefore.id);
    expect(survivorAfter.p_mastery).toBeCloseTo(survivorBefore.p_mastery, 10);
    expect(survivorAfter.response_count).toBe(survivorBefore.response_count);

    // The rewritten description landed, and the new misconception joined the bank.
    expect(listNodes(db, conceptId).find((n) => n.title === 'Node 1')!.description).toBe(
      'Rewritten description from the regeneration.'
    );
    expect(listMisconceptions(db, nodeIds[0]).map((m) => m.label)).toContain('a fresh belief');

    // Depths the regeneration dropped are marked not applicable, not deleted.
    const d5 = getCellId(db, nodeIds[0], 5);
    expect(getCell(db, d5)!.applicable).toBe(0);
  });
});

/* -------------------------------------------------- depth advancement (7.4) */

describe('depth advancement and D6 promotion', () => {
  it('does not serve depth 2 until 80% of applicable nodes are mastered at depth 1', () => {
    const { db, conceptId, nodeIds } = makeFixture(5);

    let cells = loadCellSnapshots(db, conceptId);
    let result = assembleSession({
      cells,
      remediationNodeIds: new Set(),
      targetLength: 20,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(result.frontier).toBe(1);
    expect(result.slots.every((s) => s.depth === 1)).toBe(true);

    // Master four of five at D1 → 80%.
    for (const id of nodeIds.slice(0, 4)) masterCell(db, id, 1);

    cells = loadCellSnapshots(db, conceptId);
    result = assembleSession({
      cells,
      remediationNodeIds: new Set(),
      targetLength: 20,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(result.frontier).toBe(2);
    expect(result.slots.some((s) => s.depth === 2)).toBe(true);
    expect(result.slots.every((s) => s.depth <= 2)).toBe(true);
  });

  it('a node that fails three consecutive times at depth d drops back to d-1 for that node only', () => {
    const { db, conceptId, nodeIds } = makeFixture(5);
    for (const id of nodeIds) masterCell(db, id, 1);

    const laggingCell = setCellState(db, nodeIds[0], 2, { pMastery: 0.2, responseCount: 3 });
    // Three trailing incorrect responses at D2 for node 1.
    const session = db
      .prepare(`INSERT INTO sessions (concept_id, started_at, kind) VALUES (?, ?, 'practice')`)
      .run(conceptId, '2026-01-01T00:00:00.000Z');
    const itemInfo = db
      .prepare(
        `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated)
         VALUES (?, 'mc', 's', 'e', '2026-01-01T00:00:00.000Z', 1)`
      )
      .run(laggingCell);
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO responses
           (session_id, item_id, cell_id, is_correct, confidence, p_mastery_before, p_mastery_after, answered_at)
         VALUES (?, ?, ?, 0, 'confident', 0.2, 0.2, ?)`
      ).run(
        Number(session.lastInsertRowid),
        Number(itemInfo.lastInsertRowid),
        laggingCell,
        `2026-01-0${i + 1}T00:00:00.000Z`
      );
    }

    const cells = loadCellSnapshots(db, conceptId);
    const { slots } = assembleSession({
      cells,
      remediationNodeIds: new Set(),
      targetLength: 20,
      now: new Date('2026-01-05T00:00:00.000Z'),
      includeSpacing: false,
    });

    // The concept frontier is D2, but node 1 is capped at D1.
    const node1Slots = slots.filter((s) => s.nodeId === nodeIds[0]);
    expect(node1Slots.length).toBeGreaterThan(0);
    expect(node1Slots.every((s) => s.depth === 1)).toBe(true);
    expect(slots.some((s) => s.nodeId !== nodeIds[0] && s.depth === 2)).toBe(true);
  });

  it('serves at most one D6 item, and places it last', () => {
    const { db, conceptId, nodeIds } = makeFixture(3);
    // Master every node at D1-D5 so all three become D6-eligible.
    for (const id of nodeIds) for (let d = 1; d <= 5; d++) masterCell(db, id, d);

    const { slots } = assembleSession({
      cells: loadCellSnapshots(db, conceptId),
      remediationNodeIds: new Set(),
      targetLength: 20,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const d6 = slots.filter((s) => s.depth === 6);
    expect(d6).toHaveLength(1);
    expect(slots[slots.length - 1].depth).toBe(6);
    if (slots.length >= 2) {
      expect(slots[slots.length - 2].nodeId).not.toBe(slots[slots.length - 1].nodeId);
    }
  });
});

/* --------------------------------------------------- remediation slice (7.3) */

describe('remediation slice driven by active misconceptions', () => {
  it('an active misconception puts its node at the front of the next session', async () => {
    const { db, conceptId, nodeIds } = makeFixture(4);
    addMisconceptions(db, nodeIds[2]);
    installFakeLlm();

    const cellId = getCellId(db, nodeIds[2], 1);
    const { item } = await generateMcItem(db, cellId);
    const distractor = listOptions(db, item!.id).find((o) => o.is_correct === 0)!;

    const session = startSession(db, conceptId, { length: 10 });
    // Select the same belief twice within the last 20 responses.
    for (let i = 0; i < 2; i++) {
      submitMcResponse(db, {
        sessionId: session.sessionId,
        itemId: item!.id,
        chosenOptionId: distractor.id,
        confidence: 'confident',
        latencyMs: 400,
      });
    }

    const { activeMisconceptions } = await import('../lib/db/queries');
    const active = activeMisconceptions(db, conceptId);
    expect(active.map((m) => m.id)).toContain(distractor.misconception_id);

    const { slots } = assembleSession({
      cells: loadCellSnapshots(db, conceptId),
      remediationNodeIds: new Set(active.map((m) => m.node_id)),
      targetLength: 20,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    const remediation = slots.filter((s) => s.slotKind === 'remediation');
    expect(remediation.length).toBeGreaterThan(0);
    expect(remediation.every((s) => s.nodeId === nodeIds[2])).toBe(true);
    // Capped at 20% of the session.
    expect(remediation.length).toBeLessThanOrEqual(4);
  });
});

/* ----------------------------------------------------------- due sort order */

describe('due queue ordering', () => {
  it('sorts by overdueness, not by absolute lateness', () => {
    const { db, conceptId, nodeIds } = makeFixture(3);
    const at = new Date('2026-02-01T00:00:00.000Z');

    // Short-interval cell three days late: overdueness 3.0
    setCellState(db, nodeIds[0], 1, {
      pMastery: 0.5,
      responseCount: 2,
      intervalDays: 1,
      lastTestedAt: iso(addDays(at, -4)),
      nextDueAt: iso(addDays(at, -3)),
    });
    // Long-interval cell ten days late: overdueness 0.11
    setCellState(db, nodeIds[1], 1, {
      pMastery: 0.5,
      responseCount: 2,
      intervalDays: 90,
      lastTestedAt: iso(addDays(at, -100)),
      nextDueAt: iso(addDays(at, -10)),
    });

    const { slots } = assembleSession({
      cells: loadCellSnapshots(db, conceptId),
      remediationNodeIds: new Set(),
      targetLength: 10,
      now: at,
    });

    const due = slots.filter((s) => s.slotKind === 'due');
    expect(due.length).toBe(2);
    expect(due[0].nodeId).toBe(nodeIds[0]);
  });
});

function getCellId(db: ReturnType<typeof makeFixture>['db'], nodeId: number, depth: number): number {
  const row = db.prepare(`SELECT id FROM cells WHERE node_id = ? AND depth = ?`).get(nodeId, depth) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`no cell for node ${nodeId} depth ${depth}`);
  return row.id;
}
