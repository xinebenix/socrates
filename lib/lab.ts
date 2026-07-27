/**
 * The lab switch.
 *
 * One setting — a model id — that overrides every routing decision in the app until
 * it is cleared. It exists to answer a question the configuration cannot: *is this
 * other model actually any good at this job?* Answering that means running a real
 * concept through the real pipeline, looking at the items it writes, and switching
 * back, all inside a few minutes. An environment variable and a redeploy is the wrong
 * instrument for that; so is a permanent settings screen for something that should be
 * off almost always.
 *
 * Hence: not in the navigation, not in the string tables, reachable at /lab by someone
 * who knows it is there. Hidden, not unprotected — it sits behind the same password as
 * everything else, and it can only select a model from a fixed list.
 *
 * Three properties are worth stating outright, because each is a decision rather than
 * an accident:
 *
 *   - **It beats everything.** Strategy, depth rule, GYM_MODEL_*. Including the
 *     blueprint, which every named strategy protects. A comparison that silently left
 *     one call site on the old model would produce a number that means nothing.
 *
 *   - **It is never invisible.** While it is set, the nav bar carries a badge, the
 *     health report names it, and every item it writes records its author in
 *     items.gen_model. The failure this guards against is forgetting: a pin left on
 *     for a week quietly fills the buffer with one model's work and bills you for it.
 *
 *   - **It can only pin a priced model.** Everything selectable has a row in the price
 *     table, so the spend readout keeps telling the truth while the switch is on.
 *     An unknown model would silently estimate $0.00 — the exact moment you are least
 *     able to afford a cost readout that lies.
 */

import type { Db } from './db';
import { iso, now } from './clock';
import { DEFAULT_MODEL, STRATEGIES, modelFor } from './llm/client';
import { DEEPSEEK_FAST, DEEPSEEK_SOTA } from './llm/deepseek';
import { API_KEY_VAR, PROVIDER_LABEL, hasKeyFor, providerFor, type Provider } from './llm/providers';
import { DEFAULT_PRICES, priceFor } from './cost';

export const LAB_PIN_KEY = 'lab.model_pin';

/* --------------------------------------------------------------- settings */

export function readSetting(db: Db, key: string): { value: string; updatedAt: string } | null {
  const row = db.prepare(`SELECT value, updated_at FROM app_settings WHERE key = ?`).get(key) as
    | { value: string; updated_at: string }
    | undefined;
  return row ? { value: row.value, updatedAt: row.updated_at } : null;
}

export function writeSetting(db: Db, key: string, value: string | null): void {
  if (value === null) {
    db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
    return;
  }
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, iso(now()));
}

/* -------------------------------------------------------------------- pin */

/**
 * The pinned model, or null.
 *
 * Read straight from the database on every call rather than cached. This is on the
 * path of a call that is about to spend seconds on the network, so the read is free in
 * context — and a cache would mean the switch appearing not to work for a while after
 * being flipped, which is precisely the confusion a test switch must not create.
 */
export function labPin(db: Db): string | null {
  const stored = readSetting(db, LAB_PIN_KEY)?.value.trim();
  if (!stored) return null;
  // A model that has since left the allowlist is ignored rather than honoured: the
  // list is what guarantees a pinned model is priced.
  return isPinnable(stored) ? stored : null;
}

export function setLabPin(db: Db, model: string | null): void {
  if (model !== null && !isPinnable(model)) {
    throw new Error(`${model} is not one of the models the lab can pin`);
  }
  writeSetting(db, LAB_PIN_KEY, model);
}

export function pinnedSince(db: Db): string | null {
  return labPin(db) ? (readSetting(db, LAB_PIN_KEY)?.updatedAt ?? null) : null;
}

/* ------------------------------------------------------------- the models */

export interface LabModel {
  id: string;
  provider: Provider;
  providerLabel: string;
  /** What it is, in one line, on the screen that offers it. */
  note: string;
  /** False when this provider's key is missing, so the screen can say so before you pin it. */
  ready: boolean;
  keyVar: string;
  inputUsd: number;
  outputUsd: number;
}

/**
 * What the switch can select.
 *
 * Short by design. This is a comparison instrument, not a model browser: the two
 * DeepSeek models are what the switch was built for, and the Anthropic entries are
 * here so that "put it back" and "compare against the cheap end" are one click rather
 * than a redeploy.
 */
const PINNABLE: { id: string; note: string }[] = [
  {
    id: DEEPSEEK_SOTA,
    note: 'DeepSeek V4 Pro — their frontier model. Two-level thinking mode, so every call site runs at high effort or above.',
  },
  {
    id: DEEPSEEK_FAST,
    note: 'DeepSeek V4 Flash — the cheap end of the same family. Useful as the floor of a comparison.',
  },
  {
    id: DEFAULT_MODEL,
    note: 'Claude Opus 5 — what a strategy means by "the strong model", on every call site at once.',
  },
  {
    id: STRATEGIES.shipped.itemShallow,
    note: 'Claude Sonnet 5 — the shipped strategy writes shallow items on this. Pinning it puts it everywhere.',
  },
];

export function pinnableModels(): LabModel[] {
  return PINNABLE.map(({ id, note }) => {
    const provider = providerFor(id);
    const price = priceFor(id);
    return {
      id,
      provider,
      providerLabel: PROVIDER_LABEL[provider],
      note,
      ready: hasKeyFor(provider),
      keyVar: API_KEY_VAR[provider],
      inputUsd: price.input,
      outputUsd: price.output,
    };
  });
}

export function isPinnable(model: string): boolean {
  return PINNABLE.some((m) => m.id === model);
}

/** The invariant the allowlist exists to keep: everything selectable is priced. */
export function unpricedPinnableModels(): string[] {
  return PINNABLE.filter((m) => !(m.id in DEFAULT_PRICES)).map((m) => m.id);
}

/* ----------------------------------------------------------------- status */

export interface LabStatus {
  pin: string | null;
  since: string | null;
  /** Where each call site would actually go, pin included. */
  routing: { blueprint: string; itemShallow: string; itemDeep: string; validate: string; grade: string };
  models: LabModel[];
  /** Items in the bank by the model that wrote them, most recent authors first. */
  itemsByModel: { model: string; items: number }[];
}

export function labStatus(db: Db): LabStatus {
  const pin = labPin(db);

  return {
    pin,
    since: pin ? (readSetting(db, LAB_PIN_KEY)?.updatedAt ?? null) : null,
    routing: {
      blueprint: modelFor('blueprint'),
      itemShallow: modelFor('item', 1),
      itemDeep: modelFor('item', 6),
      validate: modelFor('validate', 6),
      grade: modelFor('grade'),
    },
    models: pinnableModels(),
    itemsByModel: itemsByModel(db),
  };
}

/**
 * Who wrote what is in the bank.
 *
 * Rejected items are excluded: they are logged as retired rows by logRejection() and
 * counting them here would read as though a model had produced items it did not.
 */
export function itemsByModel(db: Db): { model: string; items: number }[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(gen_model, 'unrecorded') AS model, COUNT(*) AS n
         FROM items
        WHERE validated = 1 AND retired = 0
        GROUP BY model
        ORDER BY n DESC`
    )
    .all() as { model: string; n: number }[];
  return rows.map((r) => ({ model: r.model, items: r.n }));
}
