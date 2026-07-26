'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'could not sign in');

      // A full navigation, so middleware sees the new cookie on the next request.
      window.location.href = next.startsWith('/') ? next : '/concepts';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="inline-form">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          disabled={busy}
          autoFocus
          autoComplete="current-password"
          aria-label="Password"
        />
        <button type="submit" disabled={busy || !password}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </div>

      {error && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}
    </form>
  );
}
