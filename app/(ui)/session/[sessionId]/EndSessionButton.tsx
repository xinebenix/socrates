'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function EndSessionButton({
  sessionId,
  conceptId,
}: {
  sessionId: number;
  conceptId: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function end() {
    setBusy(true);
    try {
      await fetch(`/api/session/${sessionId}/end`, { method: 'POST' });
    } finally {
      router.push(`/dashboard/${conceptId}`);
    }
  }

  return (
    <button type="button" className="btn small" disabled={busy} onClick={() => void end()}>
      {busy ? 'Closing…' : "I'm done"}
    </button>
  );
}
