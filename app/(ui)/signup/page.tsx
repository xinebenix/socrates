import { Topbar } from '@/components/Chrome';
import { getDict } from '@/lib/i18n/server';
import { SignupForm } from '../login/LoginForm';

export const dynamic = 'force-dynamic';

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const t = await getDict();
  const [headBefore, headAfter] = t.login.signupHeadline.split('{emphasis}');

  return (
    <div className="shell">
      <Topbar subtitle={t.concepts.topbarSubtitle} spend={false} />
      <main className="page">
        <div className="column narrow rise" style={{ maxWidth: 520 }}>
          <div className="row gap-14" style={{ marginBottom: 24 }}>
            <span
              style={{ width: 9, height: 9, background: 'var(--terra)', borderRadius: '50%' }}
              aria-hidden
            />
            <span className="eyebrow">{t.login.signupEyebrow}</span>
          </div>

          {/* Split on the placeholder rather than filled, because the emphasised word
              carries markup and sits in a different position in Chinese. */}
          <h1 className="display" style={{ fontSize: 'clamp(30px,5vw,46px)' }}>
            {headBefore}
            <em className="accent">{t.login.signupHeadlineEmphasis}</em>
            {headAfter}
          </h1>
          <p className="lede">{t.login.signupLede}</p>

          <SignupForm next={next ?? '/concepts'} />
        </div>
      </main>
    </div>
  );
}
