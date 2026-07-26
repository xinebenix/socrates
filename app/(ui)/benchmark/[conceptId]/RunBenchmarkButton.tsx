'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDict } from '@/components/I18nProvider';

export function RunBenchmarkButton({
  conceptId,
  disabled,
}: {
  conceptId: number;
  disabled?: boolean;
}) {
  const t = useDict();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/benchmark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conceptId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.benchmark.runStartError);
      router.push(`/session/${data.sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn small primary"
        disabled={busy || disabled}
        onClick={() => void run()}
      >
        {busy ? t.benchmark.runButtonBusy : t.benchmark.runButton}
      </button>
      {error && (
        <span className="note" style={{ color: 'var(--terra)' }}>
          {error}
        </span>
      )}
    </>
  );
}
