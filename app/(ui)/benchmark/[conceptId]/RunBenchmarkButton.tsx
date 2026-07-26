'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function RunBenchmarkButton({
  conceptId,
  disabled,
}: {
  conceptId: number;
  disabled?: boolean;
}) {
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
      if (!res.ok) throw new Error(data.error ?? 'could not start the run');
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
        {busy ? 'Starting…' : 'Run benchmark'}
      </button>
      {error && (
        <span className="note" style={{ color: 'var(--terra)' }}>
          {error}
        </span>
      )}
    </>
  );
}
