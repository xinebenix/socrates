'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The way in, and the way you are reminded you went in.
 *
 * Two halves of one idea. The lab is not in the navigation, because a model switch is
 * not a feature of a learning tool and a permanent link to it would be an invitation
 * to fiddle mid-session. So the entrance is a key sequence — `g` then `l`, the
 * convention borrowed from every keyboard-driven tool that has a "go to" — and it
 * lives here, in the one component that renders on every screen.
 *
 * The other half matters more. A hidden switch that stays hidden while it is *on* is a
 * trap: the buffer fills quietly with one model's work, the bill is not the one you
 * expect, and nothing on screen disagrees with you. So while a pin is set, this
 * renders a badge in the nav bar that says which model, and links back to the switch.
 * Hidden until armed, plainly visible after.
 *
 * The sequence is ignored while a text field has focus. Someone typing source material
 * about geology should not be teleported out of the form.
 */
export function SecretSwitch({ pin }: { pin: string | null }) {
  const router = useRouter();

  useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const disarm = () => {
      armed = false;
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const onKey = (e: KeyboardEvent) => {
      // A modifier means the keystroke belongs to the browser or the OS.
      if (e.metaKey || e.ctrlKey || e.altKey) return disarm();

      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) {
        return disarm();
      }

      const key = e.key.toLowerCase();
      if (armed && key === 'l') {
        disarm();
        router.push('/lab');
        return;
      }
      if (key === 'g') {
        armed = true;
        if (timer) clearTimeout(timer);
        // A chord that stays armed forever eventually fires on an unrelated `l`.
        timer = setTimeout(disarm, 1200);
        return;
      }
      disarm();
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  if (!pin) return null;

  return (
    <Link
      href="/lab"
      className="lab-badge"
      title={`Every model call is pinned to ${pin}. Click to change or clear it.`}
    >
      <span className="lab-badge-dot" aria-hidden />
      <span className="tabular">{pin}</span>
    </Link>
  );
}
