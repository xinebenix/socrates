import Link from 'next/link';
import { getDb } from '@/lib/db';
import { labStatus } from '@/lib/lab';
import { batchingEnabled } from '@/lib/llm/batch';
import { effortFor } from '@/lib/llm/client';
import { providerFor } from '@/lib/llm/providers';
import { dayKey, spendBy } from '@/lib/cost';
import { Topbar } from '@/components/Chrome';
import { LabSwitch } from './LabClient';

export const dynamic = 'force-dynamic';

/**
 * The lab. Not in the navigation, not linked from anywhere, reachable at /lab or by
 * pressing `g` then `l` on any screen.
 *
 * What it is for: pointing the whole pipeline at a different model for long enough to
 * judge its work, then putting it back. Everything on the page exists to answer one of
 * three questions — what is routed where right now, what has it cost, and who wrote
 * the items currently in the bank.
 */
export default async function LabPage() {
  const db = getDb();
  const status = labStatus(db);
  const spend = spendBy(db, 'model', dayKey(-29));
  const pinnedProvider = status.pin ? providerFor(status.pin) : null;

  return (
    <div className="shell">
      <Topbar subtitle="lab" />
      <main className="page">
        <div className="column stack gap-22 rise">
          <div>
            <p className="eyebrow" style={{ marginBottom: 14 }}>
              Not part of the app
            </p>
            <h1 className="display">Model lab</h1>
            <p className="advisory">
              Pins every call site — blueprint, item writing, validation and grading — to one
              model, overriding <code>GYM_STRATEGY</code> and every <code>GYM_MODEL_*</code>{' '}
              variable, until it is cleared. The pin is stored in the database, so it survives a
              restart and the background worker obeys it too.
            </p>
          </div>

          <div className="panel">
            <p className="section-label">The switch</p>
            <LabState pin={status.pin} since={status.since} />
            <div style={{ marginTop: 16 }}>
              <LabSwitch pin={status.pin} models={status.models} />
            </div>
          </div>

          <div className="panel">
            <p className="section-label">Where calls go now</p>
            <div className="ledger">
              <RoutingRow label="Blueprint" model={status.routing.blueprint} effort={effortFor('blueprint')} />
              <RoutingRow label="Items D1–D3" model={status.routing.itemShallow} effort={effortFor('item')} />
              <RoutingRow label="Items D4–D6" model={status.routing.itemDeep} effort={effortFor('item')} />
              <RoutingRow label="Validation" model={status.routing.validate} effort={effortFor('validate', 6)} />
              <RoutingRow label="Grading" model={status.routing.grade} effort={effortFor('grade')} />
            </div>

            <p className="note" style={{ marginTop: 14 }}>
              {batchingEnabled()
                ? 'Speculative fills are going through the Batch API at half price.'
                : 'Batching is off, so the worker is filling synchronously at full price. ' +
                  'DeepSeek publishes no batch tier — its discount comes from automatic prefix ' +
                  'caching instead, which applies to every call and needs no configuration.'}
            </p>

            {pinnedProvider === 'deepseek' && (
              <p className="note" style={{ marginTop: 8 }}>
                DeepSeek has two thinking levels rather than five: <code>low</code> and{' '}
                <code>medium</code> both arrive as <code>high</code>, and <code>xhigh</code> as{' '}
                <code>max</code>. The item hot path normally runs at <code>medium</code>, so it is
                doing more thinking here than the effort settings suggest — slower per call, and
                the reason a like-for-like latency comparison will flatter Anthropic.
              </p>
            )}
          </div>

          <div className="panel">
            <p className="section-label">Items in the bank, by author</p>
            {status.itemsByModel.length === 0 ? (
              <p className="note">Nothing generated yet.</p>
            ) : (
              <div className="ledger">
                {status.itemsByModel.map((row) => (
                  <div className="ledger-row" key={row.model}>
                    <span className="serif-body col-fill" style={{ fontSize: 16 }}>
                      {row.model === 'unrecorded' ? 'written before this was recorded' : row.model}
                    </span>
                    <span className="eyebrow tabular" style={{ flex: 'none' }}>
                      {row.items} items
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="note" style={{ marginTop: 14 }}>
              Validated, unretired items only. An item outlives the pin that wrote it — it can sit
              in the buffer for days — so this is the honest answer to “whose work am I actually
              being asked?”. The rejection rates per node are on the item-health screen.
            </p>
          </div>

          <div className="panel">
            <p className="section-label">Spend by model · last 30 days</p>
            {spend.length === 0 ? (
              <p className="note">No calls recorded yet.</p>
            ) : (
              <div className="ledger">
                {spend.map((row) => (
                  <div className="ledger-row" key={row.key}>
                    <span className="serif-body col-fill" style={{ fontSize: 16 }}>
                      {row.key}
                    </span>
                    <span className="eyebrow tabular" style={{ flex: 'none' }}>
                      {row.calls} calls · {row.outputTokens.toLocaleString()} out · $
                      {row.estimatedUsd.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="note" style={{ marginTop: 14 }}>
              Tokens are exact. Dollars are estimated from the built-in price table, which will
              drift — <code>GYM_PRICES</code> overrides it.
            </p>
          </div>

          <p className="note">
            <Link href="/concepts">Back to the concepts</Link>
          </p>
        </div>
      </main>
    </div>
  );
}

function LabState({ pin, since }: { pin: string | null; since: string | null }) {
  if (!pin) {
    return (
      <p className="serif-body" style={{ fontSize: 17, margin: 0 }}>
        No pin. The app is routing normally.
      </p>
    );
  }
  return (
    <div className="warnbox">
      Pinned to <strong>{pin}</strong>
      {since ? ` since ${since.replace('T', ' ').slice(0, 16)} UTC` : ''}. Everything the app
      generates — including items the worker is writing right now — is coming from this model.
    </div>
  );
}

function RoutingRow({
  label,
  model,
  effort,
}: {
  label: string;
  model: string;
  effort: string;
}) {
  return (
    <div className="ledger-row">
      <span className="eyebrow col-label short">{label}</span>
      <span className="serif-body col-fill" style={{ fontSize: 16 }}>
        {model}
      </span>
      <span className="eyebrow tabular" style={{ flex: 'none' }}>
        {effort} effort
      </span>
    </div>
  );
}
