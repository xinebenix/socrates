import { Topbar } from '@/components/Chrome';
import { getDict } from '@/lib/i18n/server';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const t = await getDict();

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
            <span className="eyebrow">{t.login.eyebrow}</span>
          </div>

          <h1 className="display" style={{ fontSize: 'clamp(30px,5vw,46px)' }}>
            The gym is <em className="accent">locked</em>.
          </h1>
          <p className="lede">{t.login.lede}</p>

          <LoginForm next={next ?? '/concepts'} />
        </div>
      </main>
    </div>
  );
}
