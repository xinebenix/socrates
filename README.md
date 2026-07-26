# Socrates

A mental gym. You supply a concept and the material you are learning it from;
Socrates decomposes it into a structured map, generates test items against that map,
grades them, tracks per-cell mastery, and schedules return visits at expanding
intervals.

The framing that matters: **the act of testing is the intervention, not merely the
measurement.** This is not an assessment tool that reports a score. It is a training
loop in which measurement and treatment are the same operation. Where learning
outcome and measurement convenience conflict, the code favours the outcome.

Single user, runs locally, SQLite on disk.

---

## Running it

```bash
npm install
cp .env.example .env.local        # add ANTHROPIC_API_KEY
npm run dev                       # http://localhost:3000
npm run worker                    # in a second terminal — keeps the item buffer stocked
```

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required, server-side only |
| `GYM_STRATEGY` | `shipped` | model assignment preset: `reference` · `shipped` · `split-gate` · `sonnet-gate` · `economy` · `floor` |
| `GYM_MODEL` | `claude-opus-5` | what a strategy means by "the strong model" |
| `GYM_MODEL_ITEM` · `_BLUEPRINT` · `_VALIDATE` · `_GRADE` | — | override one call site, beating the strategy |
| `GYM_DB` | `./data/gym.db` | |
| `GYM_BUFFER_TARGET` | `3` | items kept ready per cell, and the size of one generation set (max 10) |
| `GYM_BUFFER_REFILL_AT` | 40% of target | remaining items at which a cell refills to full |
| `GYM_BUFFER_CONCURRENCY` | `4` | items generated at once, capped at 12 |
| `GYM_LOOKAHEAD_CELLS` | `12` | cells the worker pre-generates for — the main cost dial |
| `GYM_MONTHLY_BUDGET_USD` | — | pauses pre-generation past this estimate; sessions keep running |
| `GYM_PRICES` | — | JSON price overrides, if the built-in table has gone stale |
| `GYM_EFFORT_ITEM` | `medium` | reasoning effort for item generation — the hot path |
| `GYM_EFFORT_BLUEPRINT` · `_VALIDATE` · `_GRADE` | `high` | lower these only deliberately; see [docs/DEPLOY.md](docs/DEPLOY.md) |

To look at the interface without spending tokens:

```bash
GYM_DB=./data/demo.db npx tsx scripts/seed-demo.ts
GYM_DB=./data/demo.db npm run dev
```

```bash
npm test          # 178 tests, no network
npm run typecheck
npm run build
```

Deploying it somewhere: see **[docs/DEPLOY.md](docs/DEPLOY.md)**.

---

## The shape of it

Three parts, and the directories match:

- **Domain model** — the blueprint: a concept decomposed into nodes × depth levels.
- **Student model** — per-cell mastery estimates and a misconception profile.
- **Tutoring model** — the policy deciding what to serve next, and when.

| Term | Meaning |
|---|---|
| **Concept** | The top-level subject. "Socialism". |
| **Blueprint** | The decomposition: nodes plus the depth grid. |
| **Node** | One sub-concept — the *breadth* axis. |
| **Depth** | D1–D6, how far from rote — the *depth* axis. Generic across concepts. |
| **Cell** | A (node, depth) pair. **The atomic unit of mastery and scheduling.** |
| **Misconception** | A named wrong belief attached to a node. Distractors are drawn from these. |
| **Item** | One generated question. Disposable — regenerated fresh, never reused. |
| **Response** | One answered item: choice, correctness, confidence, latency. |
| **Mastery** | `p_L`, per cell. **Retrievability** `R` discounts it for time elapsed. |
| **Benchmark set** | Frozen, human-vetted items never used in practice. |

The depth ladder: **D1** recall · **D2** comprehension · **D3** application ·
**D4** boundary · **D5** discrimination · **D6** critique. D1–D5 are multiple choice.
D6 is free response only — recognition cannot assess critique, and MC'ing it produces
items that look deep and test nothing.

```
/app/api        concepts · blueprint · session · generate/item · grade/free · benchmark · stats · items
/app/(ui)       concepts · blueprint · session · dashboard · items · benchmark
/lib/db         better-sqlite3 client, schema, queries
/lib/llm        provider client, structured output, schema check + retry
/lib/prompts    one file per prompt contract
/lib/mastery    BKT update
/lib/schedule   SM-2 spacing, decay, due queue
/lib/policy     session assembly, interleaving, depth frontier
/lib/analysis   item statistics, stem similarity
/lib/pipeline   blueprint · generateItem · respond · session · buffer · benchmark
/workers        pregenerate.ts
```

Every piece of time arithmetic goes through `lib/clock.ts`. Nothing calls `Date.now()`
directly, which is what lets the acceptance tests advance the clock thirty days.

---

## The invariants

These look like details that could be simplified away. They cannot. Each one is the
mechanism that makes this a gym rather than a quiz app, and each has a test.

| # | Invariant | Where it lives | Test |
|---|---|---|---|
| 1 | Confidence is captured before submission, and is mandatory | `lib/ui/submitGuard.ts`, `components/ItemCard.tsx`, and again server-side in the respond route | AT1 |
| 2 | No answer changes after feedback is shown | `ItemCard` renders no mutating control in the feedback phase; nothing in the codebase issues `UPDATE responses` | AT2 |
| 3 | The validator does not see the answer key | `lib/prompts/validate.ts` — `ValidationInput` has no field for it, and the test asserts on the serialized request body | AT3 |
| 4 | Every distractor is tagged to a named misconception, recorded on selection | `generateItem.ts` inserts an invented label before persisting, so `options.misconception_id` is never null on a distractor | AT4 |
| 5 | Feedback explains every option, not just the correct one | `ItemCard` renders a rationale per option | AT5 |
| 6 | Items are never reused verbatim | recent stems go into the prompt, and `analysis/similarity.ts` throws away anything above 0.9 | AT6 |
| 7 | Never two consecutive items from the same node | `policy/interleave.ts` | AT7 |
| 8 | Scheduling persists and mastery decays with time | `schedule/sm2.ts` + `schedule/decay.ts`; decay is applied at read time and never written back | AT8 |
| 9 | The free-response grader is uncharitable | `prompts/gradeFree.ts`, plus code-level enforcement in `respond.ts` | AT9 |
| 10 | Benchmark items never enter practice | the `frozen = 0` predicate is inside `takeBufferedItem`, not applied by callers | AT10 |
| 11 | The blueprint is editable and revisable | `pipeline/blueprint.ts` merges rather than replaces | AT11 |

A few are worth expanding on.

**Confidence (1) is the reason the student model works.** Four states matter and a raw
score collapses them: right-and-confident is mastery, right-and-guessing is luck,
wrong-and-unsure is a gap, and wrong-and-confident is a misconception — the most
valuable signal in the system. Confidence modulates the BKT guess and slip rates, so a
confident correct answer moves mastery from 0.15 to 0.67 while a confident wrong answer
pins it at 0.16.

**The blind validator (3) is a separate call that solves the item itself.** Agreement
between generator and validator is the gate. A validator shown the key rationalises a
broken item. Rejections are logged too — the rejection rate per node is the signal that
a blueprint node is badly drawn.

**The uncharitable grader (9) is enforced twice.** The prompt says a criterion is met
only if you can quote the span that meets it; the code then checks that the quote
actually appears in the answer and downgrades it if not, and recomputes the score from
the per-criterion verdicts rather than trusting the number the model returned.
Charitable grading turns a failed retrieval into a passed one, which is the most
destructive thing this system could do.

---

## How a session is put together

A session is planned in full before it starts, not chosen one item at a time. Default
20 items, configurable 10–40.

1. **Remediation**, up to 20% — cells whose node carries an active misconception (one
   selected twice or more in the last 20 responses). The item puts that same belief
   back in the option set, so we see whether it is corrected rather than merely avoided.
2. **Due review**, up to 60% — sorted by overdueness, which is lateness measured in
   units of the cell's own interval. A one-day cell three days late outranks a
   ninety-day cell ten days late.
3. **Frontier** — the remainder, breadth-first across nodes.

Then the interleave constraint reorders so no two consecutive items share a node, and
the single D6 item goes last.

**Depth advancement.** No cell at depth *d+1* is served until at least 80% of applicable
nodes are mastered at depth *d*. A node that fails three consecutive times at *d* drops
back to *d−1* for that node only — and the cell it drops back to is re-served even
though it reads as mastered, because the failures above are the evidence that it is not.

**A cell can appear more than once in one session.** Every administration generates a
fresh item, so a second visit is a second rep rather than the same question twice.
Without this a fresh blueprint could never produce a session longer than it has nodes.

**Speculative work is billed at half price.** The worker's buffer fills go through
the Message Batches API — a 50% discount in exchange for asynchronous results, which
is free money for a buffer since nobody is waiting on it. The pipeline persists in
the database and survives restarts; sessions themselves never wait on a batch.

**Serving a session and building depth are different jobs.** Covering the remaining
plan is latency-critical, synchronous, and small — one item per slot, no more. Building
depth toward `GYM_BUFFER_TARGET` is speculative, batched at half price, and belongs to
the worker alone. Nothing on the answer path ever builds depth, so answering a question
whose session is already covered generates nothing.

**The buffer drains to a low-water mark before refilling.** A cell is not topped up
the moment it drops below target — it drains to 40% of it, then refills to full in one
call. Refilling by one after every served item would pay the cell's reasoning cost per
item and undo the whole point of generating sets. Invariant 7 is what makes the gap
safe: no two consecutive items share a node, so a cell drains at most every other item.

**Items are generated in sets, one call per cell.** Nearly all of a generation's output
is reasoning about the *cell* — what the node means, what a learner gets wrong, which
distractors are live — and that work is identical for every item on it. A cell's whole
buffer shortfall goes into one call, which roughly halves output tokens per item at four
and produces better items, because the prompt can require that they differ from each
other rather than generating them independently and hoping. **Validation does not
amortize and must not:** every item gets its own blind solve from a call that has seen
no other item and no key. A test asserts one generation call and N validations for a set
of N.

**Latency.** Generation plus validation is two sequential model calls and would feel
slow inside a session. Three things keep it off the answer path: a background worker
keeps at least three validated, unserved items ready per plausibly-due cell; planning a
session immediately starts filling that session's own cells rather than waiting for the
worker's next tick; and serving an item refills the cells still ahead of it. Items are
generated concurrently — the two calls for one item are sequential by necessity, but two
different items are not. The runner serves from the buffer and blocks on generation only
when it is empty, which after the first session on a concept should be rare. If
generation fails, the slot is dropped, the session continues, and the reason is shown
rather than swallowed.

**Model and effort are chosen per call site, not globally.** They are not all the same
work. The blueprint is the hardest reasoning in the system and everything downstream
inherits its errors; the validator is the gate; the grader is invariant 9. Writing a D1
recall item against a finished blueprint is not in that class, so **D1–D3 items go to
Sonnet and D4–D6 escalate to Opus** — boundary and discrimination items live or die on
distractors that are nearly right, which is the judgment a smaller model is worst at.
Effort follows the same shape: `medium` for item writing, `high` for the other three.

The split buys independence as well as speed. A generator and a validator on the same
model share blind spots, and an item whose flaw is invisible to Opus is invisible to an
Opus validator too. What the gate cannot catch is *shallowness* — a well-formed,
correctly keyed, boring item — so the rejection rate per node on the item-health screen
is the number to watch when changing this.

Six assignments ship as named strategies, from `reference` (all Opus) down to `floor`,
selected with one variable. `npx tsx scripts/cost-model.ts` prices them; `--measured`
re-runs the same arithmetic against your own recorded token counts instead of the
built-in assumptions. Every strategy keeps the blueprint on the strong model, and a test
enforces that. `GYM_MODEL_*` and `GYM_EFFORT_*` override whatever a strategy says, and
`/api/health` reports which model ran which call alongside median and worst-case
generation times, so the question can be settled with a number.

Worth knowing before reaching for it: **an older Opus is not a cheaper Opus** — the list
price has historically been flat across Opus generations, so substituting 4.1 for 5
saves nothing. A current Sonnet is the lever that moves.

---

## What this does not tell you

These are stated in the interface too, next to the numbers they qualify.

**Single-user statistics are thin.** Classical item analysis assumes many test-takers.
With one person and a handful of administrations, difficulty and discrimination are
noisy. They are aggregated at the cell level, withheld below n = 5, and labelled
advisory. Do not read them as measurements.

**The blueprint is the weak link.** Every item inherits its errors, and a wrong
blueprint produces well-formed items testing the wrong things — with scores that look
fine. Two mitigations: hand-editing is frictionless and is the intended workflow, and
the app surfaces the signal that the map is wrong. A validator rejection rate above 30%
on a node, or failures clustering across three or more nodes at once, prompts you to
review the decomposition. Scattered failure is usually one node that was never drawn,
not three separate gaps.

**Generated items drift in difficulty.** Practice on generated items; measure on frozen
ones. Until the benchmark set has items in it, improvement and item drift are
indistinguishable and no chart here can separate them.

**It costs real money, and the app says how much.** Every model call records its exact
token counts; the concepts page shows the running total and `/api/health` breaks it down
by call site. Tokens are exact, dollars are estimated from a price table that will drift
— `GYM_PRICES` overrides it. The number worth watching is *ahead of use*: money already
spent on pre-generated items you have not been shown. `GYM_MONTHLY_BUDGET_USD` caps it,
and deliberately caps only the speculative half — over budget, sessions still run and
generate inline, because a tool that refuses to work when you sit down to use it is a
tool you stop opening.

**Coverage is bounded by the source.** Free-generating from a topic name produces
canonically-shaped items that test the textbook version and systematically miss whatever
is idiosyncratic about your own understanding. An empty `source_text` is a degraded mode
and the interface says so.

---

## Design

The visual language — parchment ground with rule stripes, EB Garamond for reading,
Cinzel for the wordmark, Jost for interface labels, terracotta accent, verdigris for
correctness, 2–3px radii and letterpress shadows — comes from the `Socrates.dc.html`
design comp. Tokens live at the top of `app/globals.css`, with a dark variant on
`prefers-color-scheme`.

Three things in that comp are deliberately not carried over, because section 9 of the
build spec rules them out: the streak counter, the shake-on-wrong feedback animation,
and animation on the answer path generally. The absence of gamification is the point —
the target behaviour is accurate self-assessment, and reward signals attached to
correctness push toward avoiding hard cells. The comp also had no confidence control;
invariant 1 required adding one, built in the same visual language.

---

## Tests

```bash
npm test                 # 178 tests, no network, ~2s
npm run test:grader      # the grader regression set against the live model
```

`npm test` covers every acceptance test in the spec except the live half of AT9, plus the access gate. The
BKT worked examples and the SM-2 progression (1 → 3 → 7.8 → 20.67, ease 2.55 → 2.60 →
2.65 → 2.70) are asserted exactly, including the ordering subtlety that the third
interval uses the ease already in effect rather than the default.

`npm run test:grader` sends six fixtures to the real model — vague, name-dropping, a
plausible falsehood, and three contested-topic failure modes — and requires all of them
to score below threshold with `missing` naming the specific absent claim. It also runs a
control answer that genuinely meets the rubric and must pass. This is the tripwire for
prompt drift and model change; it costs tokens, so it is opt-in.
