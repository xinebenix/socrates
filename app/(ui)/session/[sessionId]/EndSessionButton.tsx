'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDict } from '@/components/I18nProvider';

export function EndSessionButton({
  sessionId,
  conceptId,
}: {
  sessionId: number;
  conceptId: number;
}) {
  const t = useDict();
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
      {busy ? t.session.endSessionClosing : t.session.endSession}
    </button>
  );
}
