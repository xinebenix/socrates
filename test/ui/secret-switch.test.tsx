/**
 * @vitest-environment jsdom
 *
 * The secret switch in the nav bar.
 *
 * Two properties, and they pull in opposite directions on purpose. The way in is
 * hidden — no link, a key sequence someone has to know — and the way out is not: while
 * a model pin is set, the badge is there on every screen saying which model. A hidden
 * switch that stayed hidden while it was on would fill the item bank with one model's
 * work and let the bill explain it later.
 *
 * The third property is the boring one that would actually get hit: typing source
 * material must never teleport the reader out of the form they are typing into.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecretSwitch } from '../../components/SecretSwitch';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

beforeEach(() => {
  cleanup();
  push.mockClear();
});

describe('the badge', () => {
  it('renders nothing at all while the app is routing normally', () => {
    const { container } = render(<SecretSwitch pin={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the pinned model and links back to the switch', () => {
    render(<SecretSwitch pin="deepseek-v4-pro" />);
    const badge = screen.getByRole('link');
    expect(badge.textContent).toContain('deepseek-v4-pro');
    expect(badge).toHaveAttribute('href', '/lab');
    // The one thing someone needs to be told: this is not a status, it is a state
    // they can turn off.
    expect(badge.getAttribute('title')).toMatch(/pinned|clear/i);
  });
});

describe('the way in', () => {
  it('opens the lab on g then l', async () => {
    const user = userEvent.setup();
    render(<SecretSwitch pin={null} />);

    await user.keyboard('gl');
    expect(push).toHaveBeenCalledWith('/lab');
  });

  it('ignores the sequence while a text field has focus', async () => {
    const user = userEvent.setup();
    render(
      <>
        <textarea aria-label="source" />
        <SecretSwitch pin={null} />
      </>
    );

    await user.click(screen.getByLabelText('source'));
    await user.keyboard('gl');

    expect(push).not.toHaveBeenCalled();
    expect(screen.getByLabelText('source')).toHaveValue('gl');
  });

  it('does not fire on an l that follows something else', async () => {
    const user = userEvent.setup();
    render(<SecretSwitch pin={null} />);

    await user.keyboard('xl');
    expect(push).not.toHaveBeenCalled();

    // ...and a modifier means the keystroke belonged to the browser.
    await user.keyboard('{Control>}g{/Control}l');
    expect(push).not.toHaveBeenCalled();
  });

  it('disarms after a pause, so a stray l later does not open it', () => {
    // Raw events rather than userEvent: this one is about the timer, and userEvent's
    // own scheduling does not survive being put on a fake clock.
    vi.useFakeTimers();
    try {
      render(<SecretSwitch pin={null} />);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
      vi.advanceTimersByTime(2000);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }));

      expect(push).not.toHaveBeenCalled();

      // Still armed within the window, though — the chord itself is not slow.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }));
      vi.advanceTimersByTime(400);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }));
      expect(push).toHaveBeenCalledWith('/lab');
    } finally {
      vi.useRealTimers();
    }
  });
});
