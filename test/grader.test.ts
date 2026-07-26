/**
 * AT9 — the grader regression set (invariant 9).
 *
 * Two tiers, because charitable grading can creep in from two directions:
 *
 *   1. Offline, always run. The uncharitable rules that are enforced in code rather
 *      than merely asked for in the prompt: the score is recomputed from the
 *      per-criterion verdicts, and a criterion claiming to be met without a quote
 *      that actually appears in the answer is downgraded. These hold whatever the
 *      model returns.
 *
 *   2. Live, run with GYM_RUN_LLM_TESTS=1. The fixtures go to the real model and
 *      must all score below threshold, with `missing` naming the specific absent
 *      claim. This is the tripwire for prompt drift and model change; it costs
 *      tokens, so it is opt-in rather than part of `npm test`.
 */

import { describe, expect, it } from 'vitest';
import { gradeFree } from '../lib/pipeline/respond';
import { FREE_PASS_THRESHOLD, scoreFromCriteria } from '../lib/prompts/gradeFree';
import { setTransport } from '../lib/llm/client';
import { GRADER_FIXTURES, GRADER_PASSING_FIXTURE } from './grader.fixtures';
import type { GraderVerdict } from '../lib/db/types';

const RUN_LIVE = process.env.GYM_RUN_LLM_TESTS === '1';

/* ------------------------------------------------------------------ offline */

describe('the grader is uncharitable by construction, not only by instruction', () => {
  const fixture = GRADER_FIXTURES[0];

  function stubGrader(verdict: Partial<GraderVerdict>) {
    setTransport(async () =>
      JSON.stringify({
        criteria: [],
        missing: [],
        misconceptions_detected: [],
        score: 1,
        verdict_summary: 'stub',
        ...verdict,
      })
    );
  }

  it('downgrades a criterion marked met whose quote is not in the answer', async () => {
    stubGrader({
      criteria: [
        {
          id: 'c1',
          met: true,
          evidence_quote: 'the learner clearly distinguishes social from state ownership',
          comment: 'Well done.',
        },
        { id: 'c2', met: false, evidence_quote: null, comment: 'Absent.' },
      ],
      score: 1,
    });

    const verdict = await gradeFree({ stem: fixture.stem }, fixture.rubric, fixture.answer);

    expect(verdict.criteria[0].met).toBe(false);
    expect(verdict.criteria[0].comment).toMatch(/does not appear in the answer/);
    expect(verdict.score).toBe(0);
  });

  it('keeps a criterion whose quote really is in the answer', async () => {
    const answer = 'Residual control rights sit with the citizenry, not with the ministry.';
    stubGrader({
      criteria: [
        {
          id: 'c2',
          met: true,
          evidence_quote: 'Residual control rights sit with the citizenry',
          comment: 'Stated.',
        },
      ],
    });

    const verdict = await gradeFree({ stem: fixture.stem }, fixture.rubric, answer);
    expect(verdict.criteria[0].met).toBe(true);
    expect(verdict.score).toBe(1);
  });

  it('a met claim with no quote at all is not met', async () => {
    stubGrader({
      criteria: [{ id: 'c1', met: true, evidence_quote: null, comment: 'Implied throughout.' }],
      score: 1,
    });
    const verdict = await gradeFree({ stem: fixture.stem }, fixture.rubric, fixture.answer);
    expect(verdict.criteria[0].met).toBe(false);
    expect(verdict.score).toBe(0);
  });

  it('ignores a score the grader inflated and recomputes it from the criteria', async () => {
    stubGrader({
      criteria: [
        { id: 'c1', met: false, evidence_quote: null, comment: 'Absent.' },
        { id: 'c2', met: false, evidence_quote: null, comment: 'Absent.' },
        { id: 'c3', met: false, evidence_quote: null, comment: 'Absent.' },
        { id: 'c4', met: false, evidence_quote: null, comment: 'Absent.' },
      ],
      // The grader claims a pass; four unmet criteria say otherwise.
      score: 0.95,
    });

    const verdict = await gradeFree({ stem: fixture.stem }, fixture.rubric, fixture.answer);
    expect(verdict.score).toBe(0);
    expect(verdict.score).toBeLessThan(FREE_PASS_THRESHOLD);
  });

  it('quote matching tolerates whitespace and smart quotes but not paraphrase', async () => {
    const answer = 'The  fund’s   residual control sits with the finance ministry.';
    stubGrader({
      criteria: [
        {
          id: 'c2',
          met: true,
          evidence_quote: "The fund's residual control sits with the finance ministry.",
          comment: 'Stated.',
        },
      ],
    });
    const ok = await gradeFree({ stem: fixture.stem }, fixture.rubric, answer);
    expect(ok.criteria[0].met).toBe(true);

    stubGrader({
      criteria: [
        {
          id: 'c2',
          met: true,
          evidence_quote: 'control of the fund rests with the ministry of finance',
          comment: 'Paraphrased.',
        },
      ],
    });
    const paraphrase = await gradeFree({ stem: fixture.stem }, fixture.rubric, answer);
    expect(paraphrase.criteria[0].met).toBe(false);
  });

  it('the pass threshold is 0.8 and the arithmetic is a plain fraction', () => {
    expect(FREE_PASS_THRESHOLD).toBe(0.8);
    expect(scoreFromCriteria([{ met: true }, { met: true }, { met: true }, { met: false }])).toBe(0.75);
    expect(scoreFromCriteria([{ met: true }, { met: true }, { met: true }, { met: true }])).toBe(1);
    expect(scoreFromCriteria([])).toBe(0);
    // 3 of 4 is below threshold. A rubric of four cannot be passed with one gap.
    expect(0.75).toBeLessThan(FREE_PASS_THRESHOLD);
  });
});

describe('the anti-sycophancy prompt keeps its load-bearing constraints', () => {
  it('states the rules that make the grader uncharitable', async () => {
    const { buildGradeFreeCall } = await import('../lib/prompts/gradeFree');
    const { buildRequest } = await import('../lib/llm/client');
    const body = JSON.stringify(
      buildRequest(
        buildGradeFreeCall({
          stem: 'x',
          rubric: GRADER_FIXTURES[0].rubric,
          answerText: 'y',
          contested: true,
        })
      )
    );

    expect(body).toContain('Grade only what is literally written');
    expect(body).toContain('you can quote the specific span');
    expect(body).toContain('Vagueness is failure, not partial credit');
    expect(body).toContain('Name-dropping is not knowledge');
    expect(body).toContain('never agreement with any position');
    expect(body).toContain('not a tutor');
  });
});

/* --------------------------------------------------------------------- live */

describe.skipIf(!RUN_LIVE)('AT9 live — fixtures must score below threshold', () => {
  for (const fixture of GRADER_FIXTURES) {
    it(
      `${fixture.failureMode}: ${fixture.name}`,
      async () => {
        setTransport(null);
        const verdict = await gradeFree(
          { stem: fixture.stem },
          fixture.rubric,
          fixture.answer,
          fixture.contested
        );

        expect(
          verdict.score,
          `scored ${verdict.score}; summary: ${verdict.verdict_summary}`
        ).toBeLessThan(FREE_PASS_THRESHOLD);

        for (const id of fixture.mustBeUnmet) {
          const c = verdict.criteria.find((x) => x.id === id);
          expect(c, `no verdict returned for criterion ${id}`).toBeDefined();
          expect(c!.met, `criterion ${id} was marked met: ${c!.comment}`).toBe(false);
        }

        // `missing` must name the specific absent claim, not "could be more detailed".
        expect(verdict.missing.length).toBeGreaterThan(0);
        const missingText = verdict.missing.join(' ').toLowerCase();
        expect(
          fixture.missingMustMention.some((m) => missingText.includes(m.toLowerCase())),
          `missing did not name the absent claim. Got: ${JSON.stringify(verdict.missing)}`
        ).toBe(true);
      },
      120_000
    );
  }

  it(
    'control: an answer that does the work is not failed',
    async () => {
      setTransport(null);
      const f = GRADER_PASSING_FIXTURE;
      const verdict = await gradeFree({ stem: f.stem }, f.rubric, f.answer);
      expect(
        verdict.score,
        `the control answer scored ${verdict.score}: ${verdict.verdict_summary}`
      ).toBeGreaterThanOrEqual(FREE_PASS_THRESHOLD);
    },
    120_000
  );
});
