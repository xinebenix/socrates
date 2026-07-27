import { DEPTHS } from '@/lib/prompts/depth';
import { getDict } from '@/lib/i18n/server';
import { LocaleToggle } from './LocaleToggle';

export interface AuthHeroProps {
  eyebrow: string;
  /**
   * The display heading, already split around its emphasised word. Split rather than
   * interpolated because the emphasis carries markup and sits in a different position
   * in Chinese — 训练馆已{上锁}。 — which a prefix/suffix pair cannot express.
   */
  headline: readonly [before: string, emphasis: string, after: string];
  lede: string;
  /** The form. */
  children: React.ReactNode;
}

/**
 * The way into the app: a photograph of the hall, with the form standing in the dark
 * part of it.
 *
 * Everything atmospheric here — the shafts, the drifting motes, the breathing dot — is
 * background, and none of it is on the path to answering anything. That is the line the
 * build spec draws: motion that decorates the door is fine, motion attached to being
 * right is not, because a reward signal on correctness teaches avoidance of the cells
 * worth practising. `prefers-reduced-motion` stops all of it anyway.
 *
 * The image is decorative and carries an empty alt. Nothing about signing in depends on
 * seeing it, and a screen reader announcing a long description of a marble bust before
 * the email field is a worse experience than silence.
 */
export async function AuthHero({ eyebrow, headline, lede, children }: AuthHeroProps) {
  const t = await getDict();
  const [before, emphasis, after] = headline;

  // Claims about the product, so every one of them is checkable in this repository:
  // the depth ladder's own length, the absence of reward mechanics that section 9 of
  // the build spec rules out, and the scheduler in lib/schedule/sm2.ts.
  const proof = [
    { value: String(DEPTHS.length), label: t.login.proofDepthsLabel },
    { value: '0', label: t.login.proofGamificationLabel },
    { value: 'SM-2', label: t.login.proofScheduleLabel },
  ];

  return (
    <div className="auth-hero">
      <div className="hero-art">
        <picture>
          <source
            media="(max-width: 860px)"
            srcSet="/hero/academy-tall-720.webp 720w, /hero/academy-tall-1080.webp 1080w"
            sizes="100vw"
          />
          <img
            src="/hero/academy-wide-1920.webp"
            srcSet="/hero/academy-wide-1280.webp 1280w, /hero/academy-wide-1920.webp 1920w"
            sizes="100vw"
            alt=""
            fetchPriority="high"
          />
        </picture>
      </div>

      <div className="hero-scrim" aria-hidden />
      <div className="hero-shaft one" aria-hidden />
      <div className="hero-shaft two" aria-hidden />
      <div className="hero-motes" aria-hidden />

      <header className="hero-head">
        <div className="stack" style={{ gap: 4 }}>
          <span className="wordmark">Socrates</span>
          <span className="hero-subtitle">{t.concepts.topbarSubtitle}</span>
        </div>
        {/* On the login page most of all: someone who cannot read the form is exactly
            the person who needs the switch. */}
        <div className="push">
          <LocaleToggle />
        </div>
      </header>

      <div className="hero-body">
        <div className="hero-panel rise">
          <div className="hero-eyebrow">
            <span className="hero-dot" aria-hidden />
            <span className="eyebrow">{eyebrow}</span>
          </div>

          <h1 className="display hero-headline">
            {before}
            <em className="accent">{emphasis}</em>
            {after}
          </h1>
          <p className="lede">{lede}</p>

          {children}

          <div className="hero-proof">
            {proof.map((p) => (
              <div className="hero-proof-item" key={p.label}>
                <span className="hero-proof-value">{p.value}</span>
                <span className="hero-proof-label">{p.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
