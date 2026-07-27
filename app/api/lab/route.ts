/**
 * The lab switch, over HTTP.
 *
 * Behind the same middleware gate as everything else — hidden is not the same as
 * open, and this endpoint decides where the account's money goes.
 *
 * The write is deliberately narrow: a model id from a fixed list, or null. There is no
 * free-text field anywhere in this path, which is what keeps the guarantee that a
 * pinned model is a priced model, and keeps a typo from routing every call in the app
 * at a model id that does not exist.
 */

import { getDb } from '@/lib/db';
import { labStatus, setLabPin } from '@/lib/lab';
import { logEvent } from '@/lib/ops';
import { bad, fail, ok } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return ok(labStatus(getDb()));
  } catch (err) {
    return fail(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { model?: unknown };
    const model = body.model;

    if (model !== null && typeof model !== 'string') {
      return bad('model must be a string, or null to clear the pin');
    }

    const db = getDb();
    const next = model === null || model.trim() === '' ? null : model.trim();
    const previous = labStatus(db).pin;

    try {
      setLabPin(db, next);
    } catch (err) {
      return bad(err instanceof Error ? err.message : String(err));
    }

    // Logged at warn when set and info when cleared. A pin is a temporary state that
    // costs money for as long as it is on, and ops_log is the record that outlives
    // both the session that set it and anyone's memory of having done so.
    logEvent(db, next ? 'warn' : 'info', next ? 'lab.pin_set' : 'lab.pin_cleared', {
      model: next,
      previous,
      effect: next
        ? 'every call site routed to this model, overriding GYM_STRATEGY and GYM_MODEL_*'
        : 'routing returned to the configured strategy',
    });

    return ok(labStatus(db));
  } catch (err) {
    return fail(err);
  }
}
