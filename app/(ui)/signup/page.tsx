import { AuthHero } from '@/components/AuthHero';
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
  // Split on the placeholder rather than filled, because the emphasised word carries
  // markup and sits in a different position in Chinese.
  const [headBefore, headAfter] = t.login.signupHeadline.split('{emphasis}');

  return (
    <AuthHero
      eyebrow={t.login.signupEyebrow}
      headline={[headBefore, t.login.signupHeadlineEmphasis, headAfter]}
      lede={t.login.signupLede}
    >
      <SignupForm next={next ?? '/concepts'} />
    </AuthHero>
  );
}
