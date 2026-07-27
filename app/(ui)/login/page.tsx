import { AuthHero } from '@/components/AuthHero';
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
  // Split on the placeholder rather than filled, because the emphasised word carries
  // markup. Chinese puts it in a different position — 训练馆已{emphasis}。 — which a
  // split handles and a hardcoded prefix/suffix would not.
  const [headBefore, headAfter] = t.login.headline.split('{emphasis}');

  return (
    <AuthHero
      eyebrow={t.login.eyebrow}
      headline={[headBefore, t.login.headlineEmphasis, headAfter]}
      lede={t.login.lede}
    >
      <LoginForm next={next ?? '/concepts'} />
    </AuthHero>
  );
}
