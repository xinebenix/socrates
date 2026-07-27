'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LabModel } from '@/lib/lab';

/**
 * The switch itself.
 *
 * Not localized, and that is deliberate rather than an omission. The string tables are
 * product surface — two locales, a Dict type that fails the build when a key is missing
 * in one. This screen is a diagnostic instrument in the same category as /api/health,
 * which is English-only JSON: it exists for whoever is running the comparison, and
 * putting it through the translation machinery would imply it is part of the app.
 */
export function LabSwitch({ pin, models }: { pin: string | null; models: LabModel[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(model: string | null) {
    setBusy(model ?? 'off');
    setError(null);
    try {
      const res = await fetch('/api/lab', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'could not change the pin');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack gap-9">
      {models.map((m) => {
        const on = pin === m.id;
        return (
          <button
            key={m.id}
            type="button"
            className={`lab-option${on ? ' on' : ''}`}
            aria-pressed={on}
            disabled={busy !== null}
            onClick={() => void choose(on ? null : m.id)}
          >
            <span className="lab-option-head">
              <span className="lab-option-id tabular">{m.id}</span>
              <span className="eyebrow">{m.providerLabel}</span>
              {!m.ready && (
                <span className="eyebrow" style={{ color: 'var(--terra)' }}>
                  no {m.keyVar}
                </span>
              )}
              <span className="eyebrow push tabular">
                ${m.inputUsd}/${m.outputUsd} per M
              </span>
            </span>
            <span className="note">{m.note}</span>
          </button>
        );
      })}

      <div className="row gap-14" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn small"
          disabled={busy !== null || pin === null}
          onClick={() => void choose(null)}
        >
          {pin === null ? 'Not pinned' : 'Clear the pin'}
        </button>
        <span className="note">
          {pin === null
            ? 'Routing is whatever GYM_STRATEGY and the GYM_MODEL_* variables say.'
            : 'Clearing puts every call site back on the configured strategy immediately.'}
        </span>
      </div>

      {error && (
        <p className="note" style={{ color: 'var(--terra)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
