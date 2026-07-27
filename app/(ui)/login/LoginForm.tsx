'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDict } from '@/components/I18nProvider';

/**
 * The two forms that stand on the hero image.
 *
 * Both are stacked fields over one full-width button rather than the inline
 * field-and-button pair the rest of the app uses for search boxes: on a photograph the
 * input's own translucent fill is the only thing separating the text from the picture,
 * and a control welded to a button gives that fill an awkward shape to hold.
 */
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
      <div className="stack gap-6">
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
          autoComplete="current-password"
          aria-label={t.login.passwordAriaLabel}
        />
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !email || !password}
          style={{ alignSelf: 'flex-start', marginTop: 8 }}
        >
          {busy ? t.login.submitButtonBusy : t.login.submitButton}
        </button>
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

  const required = [email.trim(), password, code.trim()];
  const ready = required.every((v) => v.length > 0);

  /*
   * How much of the form is done, over the three fields that actually gate the button.
   * The name is left out of the count on purpose: it is optional, and a bar that never
   * reaches the end for someone who declined to give a name would be reporting a
   * problem that does not exist.
   */
  const filledPct = (required.filter((v) => v.length > 0).length / required.length) * 100;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;

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
      <div className="stack gap-6">
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

        {/* Decorative: it restates the state of the fields above it, which is already
            visible, so it is hidden from the accessibility tree rather than announced
            as a progress bar that moves whenever a character is typed. */}
        <div className="progress" style={{ marginTop: 6 }} aria-hidden>
          <span style={{ width: `${filledPct}%` }} />
        </div>

        <span className="note">{t.login.codeNote}</span>
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !ready}
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
