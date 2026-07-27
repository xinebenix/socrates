import type { Confidence } from '../mastery/bkt';

export type NodeOrigin = 'generated' | 'user' | 'evidence';
export type MisconceptionOrigin = 'generated' | 'user' | 'observed';
export type ItemKind = 'mc' | 'free';
export type SessionKind = 'practice' | 'benchmark';
export type SlotKind = 'remediation' | 'due' | 'frontier' | 'benchmark' | 'd6';

export interface ConceptRow {
  id: number;
  name: string;
  source_text: string | null;
  source_note: string | null;
  created_at: string;
}

export interface NodeRow {
  id: number;
  concept_id: number;
  title: string;
  description: string;
  order_index: number;
  created_at: string;
  origin: NodeOrigin;
}

export interface CellRow {
  id: number;
  node_id: number;
  depth: number;
  applicable: number;
  p_mastery: number;
  response_count: number;
  consecutive_correct: number;
  last_tested_at: string | null;
  next_due_at: string | null;
  interval_days: number;
  ease: number;
}

export interface MisconceptionRow {
  id: number;
  node_id: number;
  label: string;
  description: string;
  origin: MisconceptionOrigin;
  times_selected: number;
  created_at: string;
}

export interface ItemRow {
  id: number;
  cell_id: number;
  kind: ItemKind;
  stem: string;
  explanation: string;
  rubric_json: string | null;
  generated_at: string;
  validated: number;
  validator_json: string | null;
  frozen: number;
  retired: number;
  served_count: number;
  /** The model that wrote it. Null for items generated before the column existed. */
  gen_model: string | null;
}

export interface OptionRow {
  id: number;
  item_id: number;
  position: number;
  text: string;
  is_correct: number;
  misconception_id: number | null;
  rationale: string;
  selected_count: number;
}

export interface SessionRow {
  id: number;
  concept_id: number;
  started_at: string;
  ended_at: string | null;
  kind: SessionKind;
}

export interface ResponseRow {
  id: number;
  session_id: number;
  item_id: number;
  cell_id: number;
  chosen_option_id: number | null;
  free_text: string | null;
  is_correct: number | null;
  score: number | null;
  grader_json: string | null;
  confidence: Confidence;
  latency_ms: number | null;
  p_mastery_before: number;
  p_mastery_after: number;
  answered_at: string;
}

export interface SessionPlanRow {
  session_id: number;
  position: number;
  cell_id: number;
  item_id: number | null;
  slot_kind: SlotKind;
  served_at: string | null;
}

export interface BenchmarkRunRow {
  id: number;
  concept_id: number;
  run_at: string;
  results_json: string;
}

/** A cell joined to the node it belongs to — the unit the policy layer reasons about. */
export interface CellWithNode extends CellRow {
  node_title: string;
  node_order: number;
  concept_id: number;
}

/** Rubric criterion, stored JSON-encoded in items.rubric_json. */
export interface RubricCriterion {
  id: string;
  criterion: string;
  why_it_matters: string;
}

export interface GraderCriterionVerdict {
  id: string;
  met: boolean;
  evidence_quote: string | null;
  comment: string;
}

export interface GraderVerdict {
  criteria: GraderCriterionVerdict[];
  missing: string[];
  misconceptions_detected: string[];
  score: number;
  verdict_summary: string;
}

export interface ValidatorVerdict {
  best_option: number;
  defensible_options: number[];
  flags: string[];
  notes: string;
}
