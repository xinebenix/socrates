/**
 * @vitest-environment jsdom
 *
 * The registration form on the landing screen.
 *
 * Two things about it are easy to break and expensive to notice. The name is optional —
 * that is what the placeholder promises — so neither the button nor the completion bar
 * may treat it as owed; a bar that stops at three quarters for someone who declined to
 * give a name is reporting a problem that does not exist, and a button disabled on the
 * same grounds is a dead end. And the button must stay shut while the registration code
 * is missing, because the code is the only brake on who can open an account against a
 * deployment's API key.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupForm } from '../../app/(ui)/login/LoginForm';
import { I18nProvider } from '../../components/I18nProvider';
import { dictionaryFor } from '../../lib/i18n/dict';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(cleanup);

const t = dictionaryFor('en').login;

function renderForm() {
  render(
    <I18nProvider locale="en" dict={dictionaryFor('en')}>
      <SignupForm next="/concepts" />
    </I18nProvider>
  );
  return {
    email: screen.getByLabelText(t.emailAriaLabel),
    password: screen.getByLabelText(t.passwordAriaLabel),
    name: screen.getByLabelText(t.displayNameAriaLabel),
    code: screen.getByLabelText(t.codeAriaLabel),
    button: screen.getByRole('button', { name: t.signupButton }),
    // Rounded, because the assertion is about which fields were counted rather than how
    // a third of three is spelled in a style attribute.
    percent: () =>
      Math.round(
        parseFloat((document.querySelector('.progress > span') as HTMLElement).style.width)
      ),
  };
}

describe('the registration form', () => {
  it('counts only the fields that gate the button', async () => {
    const user = userEvent.setup();
    const f = renderForm();

    expect(f.percent()).toBe(0);

    await user.type(f.email, 'reader@example.com');
    expect(f.percent()).toBe(33);

    // The name is optional, so giving one moves nothing.
    await user.type(f.name, 'Reader');
    expect(f.percent(), 'the optional name was counted toward completion').toBe(33);

    await user.type(f.password, 'a-long-enough-password');
    await user.type(f.code, 'invitation');
    expect(f.percent()).toBe(100);
  });

  it('stays shut until the registration code is given', async () => {
    const user = userEvent.setup();
    const f = renderForm();

    await user.type(f.email, 'reader@example.com');
    await user.type(f.password, 'a-long-enough-password');
    await user.type(f.name, 'Reader');
    expect(f.button, 'submittable with no registration code').toBeDisabled();

    // Whitespace is not a code either.
    await user.type(f.code, '   ');
    expect(f.button, 'whitespace accepted as a registration code').toBeDisabled();

    await user.type(f.code, 'invitation');
    expect(f.button).toBeEnabled();
  });
});
