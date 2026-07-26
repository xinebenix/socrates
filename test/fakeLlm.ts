import { setTransport } from '../lib/llm/client';

/**
 * A deterministic stand-in for the model, so the generation pipeline can be exercised
 * end to end without the network.
 *
 * It routes on the schema shape of the request rather than on prompt text, and the
 * correct option always carries the marker CORRECT_MARK so the fake validator can
 * find it after the pipeline has shuffled the options — the validator genuinely does
 * not receive the key, and the fake has to solve for it the same way.
 */
export const CORRECT_MARK = '[key]';

export interface FakeOptions {
  /** Produce a stem for administration `n` of a cell. */
  stem?: (n: number) => string;
  /** Make the validator disagree with the key. */
  validatorPicks?: 'key' | 'wrong';
  /** Extra flags on every verdict. */
  flags?: string[];
  /** How many defensible options the validator reports. */
  defensibleCount?: number;
}

export interface FakeHandle {
  calls: { kind: string; request: Record<string, unknown> }[];
  generations: number;
  validations: number;
}

export function installFakeLlm(opts: FakeOptions = {}): FakeHandle {
  const { handle, handler } = makeFakeLlm(opts);
  setTransport(handler);
  return handle;
}

/**
 * The same fake, handed back rather than installed, so a test can wrap it — to add a
 * delay, count what overlaps, or fail the first call.
 */
export function makeFakeLlm(opts: FakeOptions = {}): {
  handle: FakeHandle;
  handler: (request: Record<string, unknown>) => Promise<string>;
} {
  const handle: FakeHandle = { calls: [], generations: 0, validations: 0 };

  const handler = async (request: Record<string, unknown>): Promise<string> => {
    const kind = classify(request);
    handle.calls.push({ kind, request });

    switch (kind) {
      case 'validate': {
        handle.validations++;
        const keyed = findKeyedPosition(request);
        const best = opts.validatorPicks === 'wrong' ? (keyed % 4) + 1 : keyed;
        const defensible =
          opts.defensibleCount && opts.defensibleCount > 1
            ? Array.from({ length: opts.defensibleCount }, (_, i) => ((best - 1 + i) % 4) + 1)
            : [best];
        return JSON.stringify({
          best_option: best,
          defensible_options: defensible,
          flags: opts.flags ?? [],
          notes: 'fake verdict',
        });
      }

      case 'item-mc': {
        handle.generations++;
        const n = handle.generations;
        const stem = opts.stem ? opts.stem(n) : defaultStem(n);
        return JSON.stringify({
          stem,
          options: [
            {
              text: `${CORRECT_MARK} The socialized-ownership reading, variant ${n}`,
              is_correct: true,
              misconception_label: null,
              rationale: 'This is what the source actually says about ownership.',
            },
            {
              text: `The state-title reading, variant ${n}`,
              is_correct: false,
              misconception_label: 'state ownership = social ownership',
              rationale: 'Conflates a government holding title with society holding it.',
            },
            {
              text: `The redistribution reading, variant ${n}`,
              is_correct: false,
              misconception_label: 'socialism = redistribution',
              rationale: 'Mistakes a transfer of income for a change in ownership.',
            },
            {
              text: `The central-planning reading, variant ${n}`,
              is_correct: false,
              misconception_label: 'socialism requires central planning',
              rationale: 'Treats one allocation mechanism as definitional.',
            },
          ],
          explanation: `Ownership, not administration, is the distinguishing feature. (variant ${n})`,
        });
      }

      case 'item-free': {
        handle.generations++;
        const n = handle.generations;
        return JSON.stringify({
          stem: `Steelman the calculation objection, then state its strongest reply. (variant ${n})`,
          rubric: [
            { id: 'c1', criterion: 'States the calculation objection accurately.', why_it_matters: 'Representation.' },
            { id: 'c2', criterion: 'Distinguishes social from state ownership.', why_it_matters: 'The core distinction.' },
            { id: 'c3', criterion: 'Gives a concrete separating case.', why_it_matters: 'Application.' },
            { id: 'c4', criterion: 'States what evidence would settle it.', why_it_matters: 'Falsifiability.' },
          ],
        });
      }

      case 'blueprint':
        return JSON.stringify({
          nodes: [
            {
              title: 'Ownership structures',
              description: 'What social ownership is and how it differs from state ownership.',
              applicable_depths: [1, 2, 3, 4, 5, 6],
              misconceptions: [
                { label: 'state ownership = social ownership', description: 'I think state-owned means socially owned.' },
                { label: 'socialism = redistribution', description: 'I think socialism just means taxing and transferring.' },
              ],
            },
          ],
          gaps: [],
        });

      case 'grade':
        return JSON.stringify({
          criteria: [{ id: 'c1', met: false, evidence_quote: null, comment: 'Not stated.' }],
          missing: ['the ownership distinction'],
          misconceptions_detected: [],
          score: 0,
          verdict_summary: 'fake grade',
        });

      default:
        throw new Error(`fake llm: unrecognized request kind ${kind}`);
    }
  };

  return { handle, handler };
}

/**
 * Substantively different stems rather than a template with a counter, so acceptance
 * test 6 is measuring the similarity guard against real variation and not against a
 * single word swapped in a fixed sentence.
 */
const STEM_POOL = [
  'Which statement best captures what social ownership requires?',
  'A worker cooperative buys out its investors. Does that satisfy the definition given, and why?',
  'Which of the following is NOT entailed by the account in the source?',
  'A municipality nationalises the water utility. What has changed, in the terms the text uses?',
  'Two economies allocate steel differently but both call themselves socialist. What distinguishes them?',
  'The text draws a line between title and control. Where exactly does it fall?',
  'Suppose prices remain but shares are held collectively. How would the source classify that arrangement?',
  'Which case would falsify the claim that socialism entails administrative allocation?',
  'A pension fund owns most of an industry on behalf of retirees. Is that social ownership?',
  'What does the calculation debate assume about the relationship between prices and knowledge?',
  'Identify the flaw in the argument that any expansion of public services is a move toward socialism.',
  'Under what condition does the source say market mechanisms and socialised ownership coexist?',
  'Which comparison correctly separates market socialism from central planning?',
  'A state seizes an industry and runs it for revenue. Which term applies, on the text’s usage?',
  'What would have to be true for the phrase "society as a whole" to have operational content?',
  'The source treats one feature as definitional and another as contingent. Which is which?',
  'Given a firm owned by its employees but competing in open markets, what follows?',
  'Which reading of the passage survives the objection that ownership without control is nominal?',
  'What observation would distinguish a genuinely socialised industry from a nationalised one?',
  'A commentator says central planning is what socialism means. On the text, where does that go wrong?',
  'How does the passage handle industries where no meaningful market price exists?',
  'Which of these arrangements does the definition exclude, and on what grounds?',
  'If title passes to a public trust but managers are appointed by ministers, how should that be described?',
  'What role does the distribution of surplus play in the account, if any?',
];

function defaultStem(n: number): string {
  return STEM_POOL[(n - 1) % STEM_POOL.length];
}

function classify(request: Record<string, unknown>): string {
  const schema = (
    (request.output_config as { format?: { schema?: Record<string, unknown> } } | undefined)
      ?.format?.schema ?? {}
  ) as { properties?: Record<string, unknown> };
  const props = Object.keys(schema.properties ?? {});

  if (props.includes('best_option')) return 'validate';
  if (props.includes('nodes')) return 'blueprint';
  if (props.includes('criteria')) return 'grade';
  if (props.includes('rubric')) return 'item-free';
  if (props.includes('options')) return 'item-mc';
  return 'unknown';
}

/** Locate the keyed option in the validator payload by its marker. */
function findKeyedPosition(request: Record<string, unknown>): number {
  const user = String((request.messages as { content: string }[])[0].content);
  const lines = user.split('\n');
  for (const line of lines) {
    const m = /^([1-4])\.\s+(.*)$/.exec(line.trim());
    if (m && m[2].includes(CORRECT_MARK)) return Number(m[1]);
  }
  return 1;
}
