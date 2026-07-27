'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDict } from '@/components/I18nProvider';

export function LoginForm({ next }: { next: string }) {
  const t = useDict();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password || busy) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.login.signInFailedFallback);

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
      <div className="stack gap-6" style={{ maxWidth: 380 }}>
        <input
          type="email"
          className="field"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.login.emailPlaceholder}
          disabled={busy}
          autoFocus
          autoComplete="username"
          aria-label={t.login.emailAriaLabel}
        />
        <div className="inline-form">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t.login.passwordPlaceholder}
            disabled={busy}
            autoComplete="current-password"
            aria-label={t.login.passwordAriaLabel}
          />
          <button type="submit" disabled={busy || !email || !password}>
            {busy ? t.login.submitButtonBusy : t.login.submitButton}
          </button>
        </div>
      </div>

      {error && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      <p className="note" style={{ marginTop: 16 }}>
        {t.login.toSignupPrompt}{' '}
        <Link href="/signup" className="accent">
          {t.login.toSignupLink}
        </Link>
      </p>
    </form>
  );
}

export function SignupForm({ next }: { next: string }) {
  const t = useDict();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password || !code || busy) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, code, displayName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t.login.signupFailedFallback);

      // Same reason as the login form: a full navigation so middleware sees the cookie.
      window.location.href = next.startsWith('/') ? next : '/concepts';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="stack gap-6" style={{ maxWidth: 380 }}>
        <input
          type="email"
          className="field"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.login.emailPlaceholder}
          disabled={busy}
          autoFocus
          autoComplete="username"
          aria-label={t.login.emailAriaLabel}
        />
        <input
          type="password"
          className="field"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t.login.passwordPlaceholder}
          disabled={busy}
          autoComplete="new-password"
          aria-label={t.login.passwordAriaLabel}
        />
        <input
          type="text"
          className="field"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t.login.displayNamePlaceholder}
          disabled={busy}
          aria-label={t.login.displayNameAriaLabel}
        />
        <input
          type="text"
          className="field"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t.login.codePlaceholder}
          disabled={busy}
          aria-label={t.login.codeAriaLabel}
        />
        <span className="note">{t.login.codeNote}</span>
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !email || !password || !code}
          style={{ alignSelf: 'flex-start', marginTop: 6 }}
        >
          {busy ? t.login.signupButtonBusy : t.login.signupButton}
        </button>
      </div>

      {error && (
        <div className="warnbox" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      <p className="note" style={{ marginTop: 16 }}>
        {t.login.toLoginPrompt}{' '}
        <Link href="/login" className="accent">
          {t.login.toLoginLink}
        </Link>
      </p>
    </form>
  );
}
