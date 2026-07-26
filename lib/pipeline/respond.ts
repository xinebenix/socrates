/**
 * Recording a response: grade it, update the student model, reschedule the cell.
 *
 * Invariant 2: once submitted, the response is final and logged. Nothing in this
 * file or downstream of it mutates a stored response.
 */

import type { Db } from '../db';
import { iso, now } from '../clock';
import { bktUpdate, type Confidence } from '../mastery/bkt';
import { scheduleUpdate } from '../schedule/sm2';
import { structured } from '../llm/client';
import { buildGradeFreeCall, FREE_PASS_THRESHOLD, scoreFromCriteria } from '../prompts/gradeFree';
import type { GraderVerdict, ItemRow, OptionRow, ResponseRow, RubricCriterion } from '../db/types';
import {
  getCell,
  getItem,
  getNode,
  incrementMisconceptionSelected,
  incrementOptionSelected,
  insertResponse,
  listOptions,
  updateCellAfterResponse,
} from '../db/queries';

export interface McSubmission {
  sessionId: number;
  itemId: number;
  chosenOptionId: number;
  confidence: Confidence;
  latencyMs: number | null;
}

export interface FreeSubmission {
  sessionId: number;
  itemId: number;
  answerText: string;
  confidence: Confidence;
  latencyMs: number | null;
}

export interface McFeedback {
  response: ResponseRow;
  correct: boolean;
  /** Every option, with its rationale. Invariant 5: feedback explains all of them. */
  options: (OptionRow & { misconception_label: string | null })[];
  explanation: string;
  chosenOptionId: number;
  misconceptionLabel: string | null;
  pMasteryBefore: number;
  pMasteryAfter: number;
}

export function submitMcResponse(db: Db, input: McSubmission): McFeedback {
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  const cell = getCell(db, item.cell_id);
  if (!cell) throw new Error(`cell ${item.cell_id} not found`);

  const options = listOptions(db, item.id);
  const chosen = options.find((o) => o.id === input.chosenOptionId);
  if (!chosen) throw new Error(`option ${input.chosenOptionId} does not belong to item ${item.id}`);

  const correct = chosen.is_correct === 1;
  const pBefore = cell.p_mastery;
  const pAfter = bktUpdate({
    pL: pBefore,
    correct,
    confidence: input.confidence,
    numOptions: options.length,
  });

  const sched = scheduleUpdate(
    {
      intervalDays: cell.interval_days,
      ease: cell.ease,
      consecutiveCorrect: cell.consecutive_correct,
    },
    correct,
    now()
  );

  const tx = db.transaction(() => {
    const response = insertResponse(db, {
      session_id: input.sessionId,
      item_id: item.id,
      cell_id: cell.id,
      chosen_option_id: chosen.id,
      free_text: null,
      is_correct: correct ? 1 : 0,
      score: null,
      grader_json: null,
      confidence: input.confidence,
      latency_ms: input.latencyMs,
      p_mastery_before: pBefore,
      p_mastery_after: pAfter,
    });

    incrementOptionSelected(db, chosen.id);
    // Invariant 4: a wrong answer is positive evidence about what the user believes
    // instead, so the tag is recorded on selection.
    if (!correct && chosen.misconception_id != null) {
      incrementMisconceptionSelected(db, chosen.misconception_id);
    }

    updateCellAfterResponse(db, cell.id, {
      pMastery: pAfter,
      intervalDays: sched.intervalDays,
      ease: sched.ease,
      consecutiveCorrect: sched.consecutiveCorrect,
      lastTestedAt: iso(now()),
      nextDueAt: sched.nextDueAt,
    });

    return response;
  });

  const response = tx();

  return {
    response,
    correct,
    options: withLabels(db, options),
    explanation: item.explanation,
    chosenOptionId: chosen.id,
    misconceptionLabel: correct ? null : labelFor(db, chosen.misconception_id),
    pMasteryBefore: pBefore,
    pMasteryAfter: pAfter,
  };
}

export interface DontKnowSubmission {
  sessionId: number;
  itemId: number;
  latencyMs: number | null;
}

export type DontKnowFeedback =
  | {
      kind: 'mc';
      response: ResponseRow;
      correct: false;
      options: (OptionRow & { misconception_label: string | null })[];
      explanation: string;
      chosenOptionId: null;
      misconceptionLabel: null;
      pMasteryBefore: number;
      pMasteryAfter: number;
    }
  | {
      kind: 'free';
      response: ResponseRow;
      correct: false;
      score: 0;
      verdict: null;
      rubric: RubricCriterion[];
      pMasteryBefore: number;
      pMasteryAfter: number;
    };

/**
 * "I don't know" — the learner declines the item and asks to be shown the answer.
 *
 * This records a response before it reveals anything, and that ordering is the whole
 * design. A reveal that recorded nothing would let the item be looked at and then
 * answered, which is not an answer to a question; and the served slot would carry no
 * response, which is the same silent hole in the record that invariant 2 exists to
 * prevent. So the reveal costs what it is worth: the cell is marked wrong and
 * rescheduled, exactly as a wrong answer would be.
 *
 * Confidence is set to `guessing` by the server rather than accepted from the client.
 * Invariant 1 wants the learner's own estimate before they see the answer, and
 * declining *is* that estimate stated at its floor — but it is not something a client
 * should be able to report as anything else.
 *
 * A free-response decline is not sent to the grader. There is nothing to grade, and
 * spending a model call to be told that an empty answer meets no criterion is spending
 * for no signal.
 */
export function submitDontKnowResponse(db: Db, input: DontKnowSubmission): DontKnowFeedback {
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  const cell = getCell(db, item.cell_id);
  if (!cell) throw new Error(`cell ${item.cell_id} not found`);

  const isMc = item.kind === 'mc';
  const options = isMc ? listOptions(db, item.id) : [];

  const pBefore = cell.p_mastery;
  const pAfter = bktUpdate({
    pL: pBefore,
    correct: false,
    confidence: 'guessing',
    numOptions: options.length,
  });

  const sched = scheduleUpdate(
    {
      intervalDays: cell.interval_days,
      ease: cell.ease,
      consecutiveCorrect: cell.consecutive_correct,
    },
    false,
    now()
  );

  const tx = db.transaction(() => {
    const response = insertResponse(db, {
      session_id: input.sessionId,
      item_id: item.id,
      cell_id: cell.id,
      // No option was chosen and no text was written: nothing to attribute a
      // misconception to, so no selection counter moves either.
      chosen_option_id: null,
      free_text: null,
      is_correct: 0,
      score: isMc ? null : 0,
      grader_json: null,
      confidence: 'guessing',
      latency_ms: input.latencyMs,
      p_mastery_before: pBefore,
      p_mastery_after: pAfter,
    });

    updateCellAfterResponse(db, cell.id, {
      pMastery: pAfter,
      intervalDays: sched.intervalDays,
      ease: sched.ease,
      consecutiveCorrect: sched.consecutiveCorrect,
      lastTestedAt: iso(now()),
      nextDueAt: sched.nextDueAt,
    });

    return response;
  });

  const response = tx();

  if (isMc) {
    return {
      kind: 'mc',
      response,
      correct: false,
      options: withLabels(db, options),
      explanation: item.explanation,
      chosenOptionId: null,
      misconceptionLabel: null,
      pMasteryBefore: pBefore,
      pMasteryAfter: pAfter,
    };
  }

  // For a free item the rubric *is* the answer: it is the list of things a passing
  // answer has to contain, which is the closest thing to a model answer that exists.
  return {
    kind: 'free',
    response,
    correct: false,
    score: 0,
    verdict: null,
    rubric: parseRubric(item),
    pMasteryBefore: pBefore,
    pMasteryAfter: pAfter,
  };
}

export interface FreeFeedback {
  response: ResponseRow;
  correct: boolean;
  score: number;
  verdict: GraderVerdict;
  rubric: RubricCriterion[];
  pMasteryBefore: number;
  pMasteryAfter: number;
}

export async function submitFreeResponse(db: Db, input: FreeSubmission): Promise<FreeFeedback> {
  const item = getItem(db, input.itemId);
  if (!item) throw new Error(`item ${input.itemId} not found`);
  const cell = getCell(db, item.cell_id);
  if (!cell) throw new Error(`cell ${item.cell_id} not found`);

  const rubric = parseRubric(item);
  const verdict = await gradeFree(item, rubric, input.answerText);

  const correct = verdict.score >= FREE_PASS_THRESHOLD;
  const pBefore = cell.p_mastery;
  const pAfter = bktUpdate({
    pL: pBefore,
    correct,
    confidence: input.confidence,
    numOptions: 0,
  });

  const sched = scheduleUpdate(
    {
      intervalDays: cell.interval_days,
      ease: cell.ease,
      consecutiveCorrect: cell.consecutive_correct,
    },
    correct,
    now()
  );

  const tx = db.transaction(() => {
    const response = insertResponse(db, {
      session_id: input.sessionId,
      item_id: item.id,
      cell_id: cell.id,
      chosen_option_id: null,
      free_text: input.answerText,
      is_correct: correct ? 1 : 0,
      score: verdict.score,
      grader_json: JSON.stringify(verdict),
      confidence: input.confidence,
      latency_ms: input.latencyMs,
      p_mastery_before: pBefore,
      p_mastery_after: pAfter,
    });

    updateCellAfterResponse(db, cell.id, {
      pMastery: pAfter,
      intervalDays: sched.intervalDays,
      ease: sched.ease,
      consecutiveCorrect: sched.consecutiveCorrect,
      lastTestedAt: iso(now()),
      nextDueAt: sched.nextDueAt,
    });

    return response;
  });

  const response = tx();

  return {
    response,
    correct,
    score: verdict.score,
    verdict,
    rubric,
    pMasteryBefore: pBefore,
    pMasteryAfter: pAfter,
  };
}

/**
 * The grader's own arithmetic is not trusted: `score` is recomputed from the
 * per-criterion verdicts, and a criterion claiming to be met without a quote that
 * actually appears in the answer is downgraded to unmet. Rule 2 of the anti-sycophancy
 * prompt is the one most worth enforcing in code as well as in the prompt.
 */
export async function gradeFree(
  item: Pick<ItemRow, 'stem'>,
  rubric: RubricCriterion[],
  answerText: string,
  contested = false
): Promise<GraderVerdict> {
  const { data } = await structured<GraderVerdict>(
    buildGradeFreeCall({ stem: item.stem, rubric, answerText, contested })
  );

  const normalizedAnswer = normalizeForQuoteCheck(answerText);
  const criteria = data.criteria.map((c) => {
    if (!c.met) return c;
    const quote = (c.evidence_quote ?? '').trim();
    if (!quote || !normalizedAnswer.includes(normalizeForQuoteCheck(quote))) {
      return {
        ...c,
        met: false,
        comment:
          `${c.comment} [Marked unmet: the quote offered does not appear in the answer.]`.trim(),
      };
    }
    return c;
  });

  return { ...data, criteria, score: scoreFromCriteria(criteria) };
}

function normalizeForQuoteCheck(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRubric(item: ItemRow): RubricCriterion[] {
  if (!item.rubric_json) return [];
  try {
    const parsed = JSON.parse(item.rubric_json) as RubricCriterion[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function withLabels(db: Db, options: OptionRow[]) {
  return options.map((o) => ({ ...o, misconception_label: labelFor(db, o.misconception_id) }));
}

function labelFor(db: Db, misconceptionId: number | null): string | null {
  if (misconceptionId == null) return null;
  const row = db.prepare(`SELECT label FROM misconceptions WHERE id = ?`).get(misconceptionId) as
    | { label: string }
    | undefined;
  return row?.label ?? null;
}

/** Used by the blueprint-health signal: which node does this cell belong to. */
export function nodeForCell(db: Db, cellId: number) {
  const cell = getCell(db, cellId);
  return cell ? getNode(db, cell.node_id) : undefined;
}
