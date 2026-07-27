import { describe, expect, it } from 'vitest';
import { maxSimilarity, similarity, tooSimilar } from '../lib/analysis/similarity';
import { effectiveMastery, isDue, overdueness, retrievability } from '../lib/schedule/decay';
import { addDays, daysBetween, iso, TestClock } from '../lib/clock';
import { checkInterleave, interleave } from '../lib/policy/interleave';
import { selectExcerpt, looksContested } from '../lib/source';
import { validateShape, wireSchema } from '../lib/llm/schema';
import { clampSessionLength } from '../lib/policy/assemble';
import { cellStats, deadDistractors } from '../lib/analysis/itemStats';
import { makeFixture } from './helpers';

describe('stem similarity', () => {
  it('scores identical strings 1', () => {
    expect(similarity('What is social ownership?', 'What is social ownership?')).toBe(1);
  });

  it('flags a lightly reworded repeat', () => {
    const a = 'Which statement best captures what social ownership requires?';
    const b = 'Which statement best captures what social ownership requires';
    expect(similarity(a, b)).toBeGreaterThan(0.9);
    expect(tooSimilar(b, [a])).toBe(true);
  });

  it('does not flag a genuinely different stem on the same topic', () => {
    const a = 'Which statement best captures what social ownership requires?';
    const b = 'A cooperative buys out its investors. Does that satisfy the definition, and why?';
    expect(similarity(a, b)).toBeLessThan(0.4);
    expect(tooSimilar(b, [a])).toBe(false);
  });

  it('catches a reordering a bag of words would miss', () => {
    const a = 'Social ownership differs from state ownership in who holds control.';
    const b = 'Who holds control differs in state ownership from social ownership.';
    // Same unigrams, different bigrams — the blend keeps this below 1.
    expect(similarity(a, b)).toBeLessThan(1);
    expect(similarity(a, b)).toBeGreaterThan(0.4);
  });

  it('maxSimilarity takes the worst of the recent set', () => {
    const candidate = 'Which statement best captures what social ownership requires?';
    expect(maxSimilarity(candidate, ['unrelated text here', candidate])).toBe(1);
    expect(maxSimilarity(candidate, [])).toBe(0);
  });
});

describe('decay', () => {
  const at = new Date('2026-02-01T00:00:00.000Z');

  it('retrievability halves at exactly one interval', () => {
    const last = iso(addDays(at, -10));
    expect(retrievability(last, 10, at)).toBeCloseTo(0.5, 6);
    expect(retrievability(last, 20, at)).toBeCloseTo(Math.pow(0.5, 0.5), 6);
    expect(retrievability(iso(at), 10, at)).toBeCloseTo(1, 6);
  });

  it('an untested cell has nothing to decay', () => {
    expect(retrievability(null, 0, at)).toBe(1);
    expect(effectiveMastery(0.15, null, 0, at)).toBeCloseTo(0.15, 10);
  });

  it('treats an interval below one day as one day', () => {
    expect(retrievability(iso(addDays(at, -1)), 0, at)).toBeCloseTo(0.5, 6);
  });

  it('overdueness is relative to the cell’s own interval', () => {
    const shortCell = overdueness(iso(addDays(at, -3)), 1, at);
    const longCell = overdueness(iso(addDays(at, -10)), 90, at);
    expect(shortCell).toBeCloseTo(3, 6);
    expect(longCell).toBeCloseTo(10 / 90, 6);
    expect(shortCell).toBeGreaterThan(longCell);
  });

  it('isDue is inclusive of the due instant and false for an unscheduled cell', () => {
    expect(isDue(iso(at), at)).toBe(true);
    expect(isDue(iso(addDays(at, 1)), at)).toBe(false);
    expect(isDue(null, at)).toBe(false);
  });
});

describe('the injectable clock', () => {
  it('only moves when moved', () => {
    const c = new TestClock('2026-01-01T00:00:00.000Z');
    const t0 = c.now();
    c.advanceDays(30);
    expect(daysBetween(t0, c.now())).toBeCloseTo(30, 10);
    expect(c.now().toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });
});

describe('interleave', () => {
  it('satisfies both constraints when the distribution allows it', () => {
    const items = [1, 2, 3].flatMap((nodeId) =>
      Array.from({ length: 4 }, (_, i) => ({ nodeId, id: `${nodeId}-${i}` }))
    );
    const { ordered, warning } = interleave(items);
    expect(ordered).toHaveLength(12);
    const check = checkInterleave(ordered.map((o) => o.nodeId));
    expect(check.adjacentViolations).toBe(0);
    expect(check.windowViolations).toBe(0);
    expect(warning).toBeNull();
  });

  /**
   * With half the items from one node the 5-window rule is arithmetically
   * unsatisfiable, but the minimum gap of 2 — invariant 7 proper — still is. When the
   * two conflict, adjacency wins and the relaxation is reported rather than hidden.
   */
  it('keeps the gap and reports the window relaxation when one node holds half the session', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ nodeId: 1, id: `a${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ({ nodeId: 2, id: `b${i}` })),
      ...Array.from({ length: 3 }, (_, i) => ({ nodeId: 3, id: `c${i}` })),
    ];
    const { ordered, warning } = interleave(items);
    expect(ordered).toHaveLength(12);
    expect(checkInterleave(ordered.map((o) => o.nodeId)).adjacentViolations).toBe(0);
    expect(warning).toMatch(/relaxed/);
  });

  it('reports the relaxation rather than hiding it', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ nodeId: 1, id: `a${i}` }));
    const { ordered, warning } = interleave(items);
    expect(ordered).toHaveLength(4);
    expect(warning).toMatch(/relaxed 3 time/);
  });

  it('is a stable permutation — nothing lost, nothing duplicated', () => {
    const items = Array.from({ length: 17 }, (_, i) => ({ nodeId: (i % 4) + 1, id: i }));
    const { ordered } = interleave(items);
    expect(new Set(ordered.map((o) => o.id)).size).toBe(17);
  });
});

describe('session length bounds', () => {
  it('clamps to 10..40 and defaults sanely', () => {
    expect(clampSessionLength(3)).toBe(10);
    expect(clampSessionLength(99)).toBe(40);
    expect(clampSessionLength(20)).toBe(20);
    expect(clampSessionLength(Number.NaN)).toBe(20);
  });
});

describe('source excerpt selection', () => {
  const source = [
    'Social ownership is ownership of the means of production by society as a whole.',
    'Central planning allocates resources administratively rather than through prices.',
    'The Peloponnesian War began in 431 BC and is unrelated to any of this.',
    'State ownership vests legal title in a government agency, which is a different arrangement.',
  ].join('\n\n');

  it('returns the whole source when it fits', () => {
    expect(selectExcerpt(source, 'ownership', 10_000)).toBe(source);
  });

  it('prefers paragraphs bearing on the node and keeps them in document order', () => {
    const excerpt = selectExcerpt(source, 'social ownership state title', 200);
    expect(excerpt).toContain('Social ownership');
    expect(excerpt).not.toContain('Peloponnesian');
    expect(excerpt.indexOf('Social ownership')).toBeLessThan(excerpt.indexOf('State ownership'));
  });

  it('handles an empty source without throwing', () => {
    expect(selectExcerpt(null, 'anything')).toBe('');
    expect(selectExcerpt('   ', 'anything')).toBe('');
  });

  it('detects contested material, and can be forced', () => {
    expect(looksContested('Socialism', null)).toBe(true);
    expect(looksContested('CSS specificity', null)).toBe(false);
    expect(looksContested('CSS specificity', 'notes [contested]')).toBe(true);
  });
});

describe('schema checking', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['stem', 'options'],
    properties: {
      stem: { type: 'string' },
      options: {
        type: 'array',
        'x-minItems': 4,
        'x-maxItems': 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'is_correct'],
          properties: { text: { type: 'string' }, is_correct: { type: 'boolean' } },
        },
      },
    },
  };

  it('accepts a conforming object', () => {
    const value = {
      stem: 's',
      options: Array.from({ length: 4 }, () => ({ text: 't', is_correct: false })),
    };
    expect(validateShape(value, schema)).toEqual([]);
  });

  it('reports the path of each problem', () => {
    const problems = validateShape({ stem: 5, options: [{ text: 't' }] }, schema);
    expect(problems.some((p) => p.includes('$.stem'))).toBe(true);
    expect(problems.some((p) => p.includes('at least 4 items'))).toBe(true);
    expect(problems.some((p) => p.includes('$.options[0].is_correct'))).toBe(true);
  });

  it('strips local x- hints before the schema goes over the wire', () => {
    const wire = JSON.stringify(wireSchema(schema));
    expect(wire).not.toContain('x-minItems');
    expect(wire).not.toContain('x-maxItems');
    expect(wire).toContain('additionalProperties');
  });
});

describe('item statistics are withheld until there is enough data', () => {
  it('reports null difficulty and discrimination below n = 5', () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const cellId = db
      .prepare(`SELECT id FROM cells WHERE node_id = ? AND depth = 1`)
      .get(nodeIds[0]) as { id: number };

    const session = db
      .prepare(
        `INSERT INTO sessions (user_id, concept_id, started_at, kind) VALUES (?, ?, ?, 'practice')`
      )
      .run(userId, conceptId, '2026-01-01T00:00:00.000Z');
    const item = db
      .prepare(
        `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated)
         VALUES (?, 'mc', 's', 'e', '2026-01-01T00:00:00.000Z', 1)`
      )
      .run(cellId.id);

    for (let i = 0; i < 4; i++) {
      db.prepare(
        `INSERT INTO responses
           (user_id, session_id, item_id, cell_id, is_correct, confidence,
            p_mastery_before, p_mastery_after, answered_at)
         VALUES (?, ?, ?, ?, ?, 'unsure', 0.3, 0.4, ?)`
      ).run(
        userId,
        Number(session.lastInsertRowid),
        Number(item.lastInsertRowid),
        cellId.id,
        i % 2,
        `2026-01-0${i + 1}T00:00:00.000Z`
      );
    }

    const stats = cellStats(db, conceptId).find((c) => c.cellId === cellId.id)!;
    expect(stats.n).toBe(4);
    expect(stats.belowThreshold).toBe(true);
    expect(stats.difficulty).toBeNull();
    expect(stats.discrimination).toBeNull();

    // A fifth response crosses the threshold.
    db.prepare(
      `INSERT INTO responses
         (user_id, session_id, item_id, cell_id, is_correct, confidence,
          p_mastery_before, p_mastery_after, answered_at)
       VALUES (?, ?, ?, ?, 1, 'confident', 0.8, 0.9, '2026-01-05T00:00:00.000Z')`
    ).run(userId, Number(session.lastInsertRowid), Number(item.lastInsertRowid), cellId.id);

    const after = cellStats(db, conceptId).find((c) => c.cellId === cellId.id)!;
    expect(after.belowThreshold).toBe(false);
    expect(after.difficulty).toBeCloseTo(3 / 5, 6);
    expect(after.discrimination).not.toBeNull();
  });

  it('finds a distractor nobody has ever chosen after five administrations', () => {
    const { db, userId, conceptId, nodeIds } = makeFixture(1);
    const cell = db
      .prepare(`SELECT id FROM cells WHERE node_id = ? AND depth = 1`)
      .get(nodeIds[0]) as { id: number };

    const item = db
      .prepare(
        `INSERT INTO items (cell_id, kind, stem, explanation, generated_at, validated, served_count)
         VALUES (?, 'mc', 's', 'e', '2026-01-01T00:00:00.000Z', 1, 6)`
      )
      .run(cell.id);
    const itemId = Number(item.lastInsertRowid);

    db.prepare(
      `INSERT INTO options (item_id, position, text, is_correct, rationale, selected_count)
       VALUES (?, 1, 'right', 1, 'r', 4)`
    ).run(itemId);
    db.prepare(
      `INSERT INTO options (item_id, position, text, is_correct, rationale, selected_count)
       VALUES (?, 2, 'plausible wrong', 0, 'r', 2)`
    ).run(itemId);
    db.prepare(
      `INSERT INTO options (item_id, position, text, is_correct, rationale, selected_count)
       VALUES (?, 3, 'dead weight', 0, 'r', 0)`
    ).run(itemId);

    const dead = deadDistractors(db, conceptId);
    expect(dead.map((d) => d.text)).toEqual(['dead weight']);
  });
});
