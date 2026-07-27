'use client';

import { useState } from 'react';
import { useDict } from './I18nProvider';

/**
 * Who you are, and the way out.
 *
 * A full navigation after the DELETE rather than `router.refresh()`, for the same reason
 * the login form does one: the cookie changed, and middleware only sees that on the next
 * real request.
 */
export function SignOutButton({ email }: { email: string }) {
  const t = useDict();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch('/api/auth', { method: 'DELETE' });
    } finally {
      window.location.href = '/login';
    }
  }

  return (
    <span className="row gap-6" style={{ alignItems: 'center' }}>
      <span className="eyebrow" title={email}>
        {email}
      </span>
      <button type="button" className="btn small" disabled={busy} onClick={() => void signOut()}>
        {t.login.signOutButton}
      </button>
    </span>
  );
}
