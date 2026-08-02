# Socrates

A mental gym. You supply a concept and the material you are learning it from;
Socrates decomposes it into a structured map, generates test items against that map,
grades them, tracks per-cell mastery, and schedules return visits at expanding
intervals.

The framing that matters: **the act of testing is the intervention, not merely the
measurement.** This is not an assessment tool that reports a score. It is a training
loop in which measurement and treatment are the same operation. Where learning
outcome and measurement convenience conflict, the code favours the outcome.

Multi-user, SQLite on disk. **Blueprints and item banks are shared; progress is not.**
Ask for a topic somebody has already decomposed and you get their map and their bank for
free, with your own mastery starting where it should — at nothing. Supply your own source
material and the concept is yours alone.

---

## Running it

```bash
npm install
cp .env.example .env.local        # add ANTHROPIC_API_KEY, GYM_SESSION_SECRET, GYM_PASSWORD
npm run dev                       # http://localhost:3000
npm run worker                    # in a second terminal — keeps the item buffer stocked
```

Then open `/signup` and create an account with `GYM_PASSWORD` as the registration code.
It is needed once, to open an account, and never again to log in — see
[Accounts](#accounts).

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required, server-side only |
| `GYM_SESSION_SECRET` | — | required; signs session cookies. Without it the app refuses to serve |
| `GYM_PASSWORD` | — | the registration code. Required once per account, never to log in |
| `GYM_OWNER_EMAIL` | `owner@localhost` | only read when migrating a single-user database |
| `GYM_ACTIVE_USER_WINDOW_DAYS` | `30` | how long after a session an account is worth pre-generating for |
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
| `GYM_TTS_APPID` · `_TOKEN` | — | a ByteDance (Volcengine) speech app; unset means no [hands-free mode](#hands-free) |
| `GYM_TTS_CLUSTER` | `volcano_tts` | |
| `GYM_TTS_VOICE_EN` · `_ZH` | `BV503_streaming` · `BV700_streaming` | any voice enabled on the app |
| `GYM_TTS_SPEED` | `1` | speaking rate, 0.5–2 |
| `GYM_EFFORT_ITEM` | `medium` | reasoning effort for item generation — the hot path |
| `GYM_EFFORT_BLUEPRINT` · `_VALIDATE` · `_GRADE` | `high` | lower these only deliberately; see [docs/DEPLOY.md](docs/DEPLOY.md) |

To look at the interface without spending tokens:

```bash
GYM_DB=./data/demo.db npx tsx scripts/seed-demo.ts   # sign in as demo@localhost / demo-password
GYM_DB=./data/demo.db npm run dev
```

```bash
npm test          # 289 tests, no network
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
| **User** | An account. Owns progress, never content. |
| **Concept** | The top-level subject. "Socialism". Shared if it was created from a bare topic name, private to its owner if it was created with source material. |
| **Blueprint** | The decomposition: nodes plus the depth grid. |
| **Node** | One sub-concept — the *breadth* axis. |
| **Depth** | D1–D6, how far from rote — the *depth* axis. Generic across concepts. |
| **Cell** | A (node, depth) pair. **The atomic unit of mastery and scheduling.** |
| **Misconception** | A named wrong belief attached to a node. Distractors are drawn from these. |
| **Item** | One generated question. Disposable — regenerated fresh, never reused. |
| **Response** | One answered item: choice, correctness, confidence, latency. |
| **Mastery** | `p_L`, per cell. **Retrievability** `R` discounts it for time elapsed. |
| **Benchmark set** | Frozen, human-vetted items never used in practice. |

**Content is shared, progress is not**, and the schema draws that line rather than
leaving it to callers. `concepts · nodes · cells · misconceptions · items · options` are
content. `user_cell_state · user_item_seen · user_misconception_state · sessions ·
responses · session_plan · benchmark_runs` are progress. The two used to be one row:
`cells` carried the (node, depth) pair *and* the mastery estimate and SM-2 schedule for
it, which is coherent for exactly one learner and incoherent for two.

The depth ladder: **D1** recall · **D2** comprehension · **D3** application ·
**D4** boundary · **D5** discrimination · **D6** critique. D1–D5 are multiple choice.
D6 is free response only — recognition cannot assess critique, and MC'ing it produces
items that look deep and test nothing.

```
/app/api        concepts · blueprint · session · generate/item · grade/free · benchmark · stats · items · tts
/app/(ui)       login · signup · concepts · blueprint · session · dashboard · items · benchmark
/lib/db         better-sqlite3 client, schema, queries, name normalisation
/lib/auth.ts    session cookies, on Web Crypto so middleware and Node share one path
/lib/session.ts who is asking — resolved per request from the database, not from a header
/lib/password.ts scrypt, Node-only
/lib/llm        provider client, structured output, schema check + retry
/lib/prompts    one file per prompt contract
/lib/mastery    BKT update
/lib/schedule   SM-2 spacing, decay, due queue
/lib/policy     session assembly, interleaving, depth frontier
/lib/analysis   item statistics, stem similarity
/lib/pipeline   blueprint · generateItem · respond · session · buffer · benchmark · fork
/lib/handsfree  what hands-free mode says, and what an utterance means — pure, no browser
/lib/tts        ByteDance (Volcengine) synthesis client, server-side only
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
| 6 | Items are never reused verbatim *to one learner* | recent stems go into the prompt, `analysis/similarity.ts` throws away anything above 0.9, and `takeBufferedItem` skips anything in that learner's `user_item_seen` | AT6 |
| 7 | Never two consecutive items from the same node | `policy/interleave.ts` | AT7 |
| 8 | Scheduling persists and mastery decays with time | `schedule/sm2.ts` + `schedule/decay.ts`; decay is applied at read time and never written back | AT8 |
| 9 | The free-response grader is uncharitable | `prompts/gradeFree.ts`, plus code-level enforcement in `respond.ts` | AT9 |
| 10 | Benchmark items never enter practice | the `frozen = 0` predicate is inside `takeBufferedItem`, not applied by callers | AT10 |
| 12 | One learner's answers move nobody else's record | every mutable number is keyed by `(user_id, …)`; `cells` has no student-model column left to write | `test/multiuser.test.ts` |
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

## Accounts

<a id="accounts"></a>

Progress follows the account rather than the machine, which is the whole point: sign in
on a second device and the schedule is where you left it. Nothing is kept in the browser
— the only cookies are the session and the language toggle.

**Signing up needs a code**, and the code is `GYM_PASSWORD` — the variable that used to
be the entire gate. It is required once to open an account and never again to log in. The
reason is money rather than secrecy: a new account's first act is usually to create a
concept, and that is one large Opus call against the deployment's single API key.
`GYM_MONTHLY_BUDGET_USD` caps only *speculative* generation — sessions deliberately keep
running past it — so an ungated signup page has no brake on it at all.

The session cookie is `v2.<userId>.<expiry>.<hmac>`, signed with `GYM_SESSION_SECRET`.
The signature covers the id as well as the expiry, so a cookie cannot be edited into
somebody else's session. Middleware verifies the signature and stops there — it runs on
the Edge runtime and cannot open SQLite — and every route and server component resolves
the account itself through `lib/session.ts`. Middleware is the gate, not the identity.

There is no `GYM_ALLOW_PUBLIC` any more. "Run with no access control" was coherent for a
single-user tool and is not for one where every row belongs to somebody: an anonymous
visitor has no record to train on.

---

## Sharing, and what it is worth

The rule is one line: **supplying source material makes a concept yours; asking for a
bare topic joins the shared one.**

It is not arbitrary. A sourceless concept generates against the canonical, textbook
version of a topic — the limitation section below has always said so — and those are
exactly the items that are the same for everybody and so worth writing once. Source
material is what makes a concept idiosyncratic to one person, so it makes the concept
theirs. That also disposes of the privacy question without a setting: pasted material is
never shared, because supplying it is what makes the concept private.

Concepts are matched on a normalised name — case-folded, trimmed, internal whitespace
collapsed — and a partial unique index makes "one shared concept per name" a database
constraint rather than a convention two simultaneous signups could break. Deliberately no
stemming and no fuzzy distance: "LLM" and "Large Language Models" stay separate, because
silently merging them hands somebody a blueprint they did not ask for.

**An item is served at most once to any one learner and freely to everybody else.** The
buffer predicate used to be `served_count = 0`: an item cost two model calls, was shown
once, and was spent for the whole deployment. It is now "not in this learner's
`user_item_seen`", so the same item can be the first question of somebody's first session
years after it was written. Generation stays global, and a cell is stocked for whichever
member of its cohort is furthest through it — taking the maximum instead would multiply
the bill by the number of people on the concept, which is the thing sharing exists to
avoid.

**The owner edits, everyone else forks.** A shared blueprint is other people's map, and
their mastery history is indexed by cells an edit can retire, so `PATCH /api/blueprint`
is owner-only. Forking copies the nodes, cells and misconceptions, carries your own
mastery across by (node title, depth), and leaves the original alone. It does not copy
the items: a concept grounded in your own source should be tested from it, and mixing the
two would leave the item-health screen unable to tell you which was which.

**What the worker generates ahead for is bounded by who is still turning up.**
`GYM_LOOKAHEAD_CELLS` caps cells per concept and says nothing about how many concepts;
without a second bound, one account that signs up, joins four concepts and never returns
would have its cells stocked and restocked for as long as the deployment lives.
`GYM_ACTIVE_USER_WINDOW_DAYS` (30) is that bound. A dormant account is not cut off — it
generates inline when it comes back, at the cost of one wait.

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
the moment it drops below target — it drains to roughly 40% of it, then refills to full
in one call, and never asks for fewer than two items at a time. That second rule is load
bearing: at a target of 3, plain 40% rounds to one-below-target, which makes the mark
identical to "below target" and the whole feature a no-op. Refilling by one after every served item would pay the cell's reasoning cost per
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

**The first question of a cold session is the one unavoidable wait.** With nothing
banked it has to be written before it can be shown. Everything after it should come
from the buffer: the runner waits on a generation already in flight for the cell it
needs rather than starting a second copy, and each item is persisted the moment its
own validation passes rather than after the whole set is checked. `test/session-latency.test.ts`
injects latency and fails if the learner waits more than once, or if a 20-slot plan
buys more than 20 items.

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

## Hands-free

<a id="hands-free"></a>

Set `GYM_TTS_APPID` and `GYM_TTS_TOKEN` — a speech app from the ByteDance (Volcengine)
console — and the session screen grows a **Hands-free** toggle. On, the session becomes
a spoken loop built for the road: the question and each option are read aloud, the
answer is spoken back, and the verdict and rationale are read in full before the next
question begins. Eyes stay where they belong.

The loop, per item: read the stem and options → *"Your answer — Alpha, Beta, Gamma, or
Delta?"* → *"You chose Beta. Before it is recorded — guessing, unsure, or confident?"* →
recorded → the verdict, the correct answer if missed, and the explanation, read aloud →
a short ear for *"repeat"*, then on to the next item by itself. *"Pause"* holds the
session; *"resume"* picks it back up. The D6 free-response item is dictated — speak the
answer, say *"I am done"*, and the grader takes it from there. In the Chinese interface
the whole exchange is in Chinese — 选B, 不确定, 下一题.

**The invariants do not bend for the road.** Confidence is asked for out loud *before*
anything is submitted, and the server would refuse the submission without it (invariant
1). The controller drives exactly the callbacks the buttons drive, so nothing can mutate
a response after feedback (invariant 2). *"I don't know"* is honoured only once the
ten-second countdown has run out — said early, it is answered aloud rather than obeyed,
because the attempt to retrieve is the part that teaches.

Mechanically: the browser posts each spoken chunk to `/api/tts`; the server holds the
ByteDance credentials, calls the synthesis endpoint, and returns MP3. The fixed prompts
— the ones repeated on every item — are cached server-side, so a twenty-item session
pays for its stems and rationales, not its scaffolding. Chunks are fetched one ahead of
playback, so synthesis latency hides behind the sentence being spoken. Listening uses
the browser's own speech recognition (the Web Speech API), stopped while audio plays so
the engine does not hear itself. A browser without recognition still gets everything
read aloud and says so on screen — answers are tapped, which is most of the benefit on
a treadmill if not in a car.

A word of sense: this is for content, not a substitute for attention. If a question
deserves more thought than a red light allows, say *"pause"*.

---

## What this does not tell you

These are stated in the interface too, next to the numbers they qualify.

**Item statistics are thin until a bank has been used.** Classical item analysis assumes
many test-takers. A shared bank finally has some — `items.served_count` and
`options.selected_count` count administrations across everybody, which is why they stayed
global while everything else was split per learner. They are still noisy until a cell has
actually been seen a number of times, so they are aggregated at the cell level, withheld
below n = 5, and labelled advisory. On a concept only you train on, they mean what they
meant before: very little.

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

Two later additions live on the same answer path. **The ten-second countdown is not a
time limit** — nothing happens when it expires except that an *I don't know* control
appears. The delay exists because the attempt to retrieve an answer is the part that
teaches, and an escape hatch present from the first render gets pressed instead of
thought about. Taking it records a response — wrong, at the lowest confidence — *before*
it reveals anything, since a reveal that recorded nothing would let an item be read and
then answered, and would leave a served slot with no response behind it. **The option
marks follow the locale**: Α/Β/Γ/Δ in English, of a piece with Τέλος and Γνῶθι σεαυτόν
elsewhere in the interface, and A/B/C/D in Chinese, where that is simply what a
multiple-choice option is called.

**Two breakpoints, at 700px and 560px.** Most of the layout is fluid without them —
every column is a max-width, the display type is clamped, the tile grids are auto-fit —
so the media queries carry only what fluid layout cannot do by itself. Rows built from
fixed-width label columns stop being columns and become stacked lines: a 170px gutter
beside a 100px note is not a narrower version of that design, and inside the ledger's
`overflow: hidden` the buttons past it were not merely cramped, they were cut off the
side of the screen and unreachable. Padding chosen against a 780px column comes off.
The mastery grid's swatches shrink, which is the difference between six depth columns
plus a row label fitting a 375px phone and not: it needs 317px, so it fits from about
there up and scrolls sideways below it.
One rule sits outside the breakpoints: `overflow-wrap: break-word` on `body`, so that a
long unbreakable token — a URL in pasted source material, a provider error id echoed
into the warning box — wraps instead of turning the page into a horizontal scroll.

**The way in is the one dark screen.** `/login` and `/signup` come from the
`Socrates Landing.dc.html` comp: a photograph of the hall full-bleed behind the form,
shafts of light crossing it, dust drifting through them. Both are built from
`components/AuthHero.tsx`, and the surface does not restyle the controls that stand on
it — it re-points the design tokens for its subtree, so `.field`, `.btn`, `.note`, the
warning box and the locale toggle come out right without knowing where they are. Three
places need saying out loud anyway, and are the only exceptions in the stylesheet: the
primary button, whose fill *is* `--ink`; the warning box, drawn for parchment; and the
derived tokens like `--muted`, which are substituted where they are declared and so
still carry `:root`'s ink no matter what the subtree says. The motion is background
only — nothing here is on the answer path, and `prefers-reduced-motion` stops all of it,
which is why the shafts carry a resting transform rather than only an animated one.

Upright the composition turns over: a portrait crop, the copy resting on the bottom edge
instead of beside the picture, one shaft instead of two, and the shade attached to the
text column so that it grows with the form rather than being an ellipse the form can
outgrow. The three claims beside the fields are facts about this repository — the length
of the depth ladder, the reward mechanics section 9 rules out, the scheduler in
`lib/schedule/sm2.ts` — not figures about usage.

The background image is the one static asset the app serves, and adding it moved the
middleware matcher: everything under `public/` is public by construction, so gating it
buys nothing and cost correctness, since an unauthenticated request for the login page's
own background was answered with a redirect back to the login page.

---

## Tests

```bash
npm test                 # 289 tests, no network, ~10s
npm run test:grader      # the grader regression set against the live model
```

`npm test` covers every acceptance test in the spec except the live half of AT9, plus the
access gate, the sharing rule, and the one-way migration off the single-user schema. That
last one is worth knowing about: `test/migration.test.ts` builds a database with the
literal schema the previous build wrote — not a reconstruction from the current one — and
asserts the student model lands on the owner account before the columns are dropped. It
is the only migration here that cannot be undone. The
BKT worked examples and the SM-2 progression (1 → 3 → 7.8 → 20.67, ease 2.55 → 2.60 →
2.65 → 2.70) are asserted exactly, including the ordering subtlety that the third
interval uses the ease already in effect rather than the default.

`npm run test:grader` sends six fixtures to the real model — vague, name-dropping, a
plausible falsehood, and three contested-topic failure modes — and requires all of them
to score below threshold with `missing` naming the specific absent claim. It also runs a
control answer that genuinely meets the rubric and must pass. This is the tripwire for
prompt drift and model change; it costs tokens, so it is opt-in.
