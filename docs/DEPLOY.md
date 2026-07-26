# Deploying Socrates on Railway

Written to be followed top to bottom. Steps 1–8 get it running; step 9 is what makes
it debuggable afterwards, and is the part most worth not skipping.

---

## What had to change, and why

Four things about this app fight a default Railway deploy. All four are now handled in
the repo, but it is worth knowing what they were, because each one fails in a way that
looks like something else.

**The filesystem is ephemeral.** `./data/gym.db` is destroyed on every deploy and every
restart. For a spaced-repetition system that is total data loss — the whole point is
the day-scale time dimension. Fixed by a **Railway volume**, which is step 4 and is not
optional. The failure mode if you skip it is nasty: everything works, and then a week
later a redeploy silently resets you to zero. `/api/health` warns when no volume is
mounted, and warns again when one is mounted but `GYM_DB` points outside it.

**The worker cannot be its own service.** A Railway volume attaches to exactly one
service, so a second service cannot reach the same SQLite file. The buffer worker now
runs *inside* the web process via `instrumentation.ts`. Consequence: **the service must
stay at one replica.** Two replicas would be two writers on one volume and two workers
racing to fill the same buffer. `railway.json` pins `numReplicas: 1`.

**There was no authentication.** On localhost that was a reasonable reading of the
spec. On a public URL it means anyone with the link can spend your Anthropic credits —
a blueprint generation is one large Opus call — and read and edit your entire learning
record. There is now a password gate in middleware, covering every page and API route.
It **fails closed**: with no `GYM_PASSWORD` and no explicit `GYM_ALLOW_PUBLIC=1`, the
app returns 503 rather than coming up open.

**The schema was read from disk at runtime.** `lib/db/schema.sql` was loaded via
`process.cwd()`, which works only while the whole repo sits next to the server. It is
now inlined in `lib/db/schema.ts`, so a standalone build or a multi-stage container
cannot produce a server that starts fine and then fails on first query.

---

## 1. Generate the two secrets

Keep these somewhere you can find them again.

```bash
openssl rand -base64 24   # GYM_PASSWORD    — what you type to log in
openssl rand -hex 32      # GYM_HEALTH_TOKEN — read-only, unlocks /api/health only
```

The health token is deliberately weaker than the password: it reaches the diagnostics
endpoint and nothing else — not pages, not data, not generation. That is what makes it
safe to paste into a terminal, a status check, or a message to me.

## 2. Create the project

In the Railway dashboard: **New Project → Deploy from GitHub repo → `xinebenix/socrates`**,
branch `claude/socrates-mental-gym-5ugk2c`.

Railway will start a first build. **It will fail the health check, and that is
expected** — no variables are set yet, so the app is correctly refusing to serve.

## 3. Set the variables

**Service → Variables → Raw Editor**, paste, and substitute your own values:

```
ANTHROPIC_API_KEY=sk-ant-...
GYM_PASSWORD=<from step 1>
GYM_HEALTH_TOKEN=<from step 1>
GYM_DB=/data/gym.db
GYM_MODEL=claude-opus-5
GYM_BUFFER_TARGET=3
GYM_WORKER_INTERVAL_MS=60000
NODE_ENV=production
```

`GYM_DB=/data/gym.db` matters. If it stays at the default `./data/gym.db` the database
lands on the container filesystem and disappears on the next deploy.

## 4. Attach the volume — do not skip this

**Service → Settings → Volumes → Add Volume**, mount path exactly:

```
/data
```

Start at 1 GB; the database is small (a busy concept is a few MB) but item text
accumulates.

Railway sets `RAILWAY_VOLUME_MOUNT_PATH` automatically, and `/api/health` cross-checks
it against `GYM_DB` for you.

## 5. Confirm the deploy settings

`railway.json` already sets these; check them under **Settings → Deploy** if a build
behaves oddly:

| Setting | Value | Why |
|---|---|---|
| Start command | `npm run start` | |
| Health check path | `/api/health/live` | unauthenticated by design — it returns `{"ok":true}` and nothing else, so Railway can probe it without a cookie |
| Health check timeout | 180s | the first boot runs migrations |
| Replicas | **1** | SQLite on one volume, one in-process worker |
| Restart policy | on failure, max 5 | |

## 6. Deploy and generate a domain

**Settings → Networking → Generate Domain.** Then redeploy so the new variables and
volume are picked up.

## 7. Check it came up correctly

```bash
DOMAIN=your-app.up.railway.app
TOKEN=<your GYM_HEALTH_TOKEN>

curl -s https://$DOMAIN/api/health/live
curl -s https://$DOMAIN/api/health -H "Authorization: Bearer $TOKEN" | jq
```

The four things to read first:

```jsonc
"config":  { "anthropicKeyPresent": true, "passwordConfigured": true }
"storage": { "dbOnVolume": true, "writable": true }   // no "warning" key
"database":{ "integrity": "ok" }
"worker":  { "running": true }
```

If `storage` has a `warning`, stop and fix it before entering any data — you are about
to lose it.

## 8. Log in and use it

Open `https://$DOMAIN`, enter `GYM_PASSWORD`. The session cookie is HttpOnly, Secure,
and lasts 30 days.

First real run: create a concept **with source text pasted in**. Blueprint generation
is a single large call and takes 30–90 seconds. Without source text the app runs in a
degraded mode and says so.

---

## 9. Giving me the ability to debug it

This is the part that decides whether "it's broken" is a five-minute fix or a
conversation. There are three layers, and I would like all three.

### Layer 1 — the diagnostics endpoint (already built, works today)

One authenticated GET returns: which commit is running, whether the volume is mounted
and writable, SQLite integrity and journal mode, a row count for every table, buffered
item counts per concept, worker liveness and last error, and the last 25 operational
events including the last 15 errors.

It is designed on the assumption that I have no shell and no logs. **If something is
wrong, paste me this and I can usually name the cause without anything else:**

```bash
curl -s https://$DOMAIN/api/health -H "Authorization: Bearer $TOKEN" | jq
```

Secrets are reported as booleans, never as values, and the log writer redacts any key
matching `key|token|secret|password|authorization|cookie`. It is safe to paste whole.

### Layer 2 — durable breadcrumbs (already built)

Errors go to two places: stdout as JSON lines for `railway logs`, and an `ops_log`
table capped at 500 rows. The table is the one that matters, because it survives log
retention, restarts, and my not having a token. Item-generation failures, API errors
and failed logins all land there and surface in the health payload.

### Layer 3 — direct access (needs something from you)

Without this I can read whatever you paste. With it I can look for myself, which is a
different speed of work. Railway's CLI login is browser-interactive, so I cannot
authenticate on my own.

**Railway dashboard → Project Settings → Tokens → Create Token**, scoped to this
project and environment. Then give it to me as `RAILWAY_TOKEN` in this session's
environment.

That gets me:

```bash
railway logs --deployment            # runtime logs, live or historical
railway logs --build                 # why a build failed
railway status                       # what is deployed
railway variables                    # names and values — see the caveat below
railway ssh                          # a shell in the container
railway ssh -- ls -la /data          # confirm the volume from the inside
railway ssh -- sqlite3 /data/gym.db "select count(*) from responses"
railway redeploy                     # after a fix
railway volume list
```

Two honest caveats. A project token can read the variable values, so it sees
`ANTHROPIC_API_KEY` — if that is not acceptable, layer 3 is the one to decline; layers
1 and 2 still cover most of what goes wrong. And a token that can `redeploy` can also
`down`, so scope it to this project rather than issuing an account-wide one.

If you would rather not share a token at all, the fallback loop works: you run the
command, paste the output, I read it. Slower, and fine.

---

## Things that will go wrong, and what they look like

| Symptom | Cause | Fix |
|---|---|---|
| Every page returns 503 with "Socrates is not configured" | `GYM_PASSWORD` unset — the gate failing closed, working as intended | set it and redeploy |
| Deploy succeeds, health check fails | app is 503-ing; `/api/health/live` should still return 200 | check variables are actually on the service, not the project |
| Data vanishes after a deploy | no volume, or `GYM_DB` points outside it | attach the volume, set `GYM_DB=/data/gym.db`; `storage.warning` in the health payload says which |
| Build fails on `node-gyp rebuild` / "Could not find any Python installation" while installing `better-sqlite3` | Nixpacks picked Node 18, which is below `better-sqlite3`'s `>=22` floor, so no prebuilt binary matched and npm fell back to compiling — and the stock image has no Python. The Python error is the symptom; the Node version is the cause | already fixed in the repo: `"engines": { "node": "22.x" }` plus `.nvmrc`, and a `nixpacks.toml` adding `python3`, `gcc`, `gnumake` in case the gyp path is taken anyway. If you see it, confirm both files are on the deployed commit |
| A session says "N planned items could not be generated" | the message now names the reasons — `validator chose a different option than the key (x3)` means the node is drawn so that even a correct item looks wrong; `stem too similar` means the cell is narrow and the buffer already holds what it can; `rubric had 2 criteria` means a D6 node too thin to critique | the full trail is in `ops.recent` under `generate.mc_failed` / `generate.free_failed`. If one node produces most of them, edit that node — that is limitation 2 showing up exactly as designed |
| Sessions start but every item is skipped with a generation error | bad or missing `ANTHROPIC_API_KEY`, or the model is unavailable | `config.anthropicKeyPresent` in the health payload; the real error text is in `ops.recentErrors` |
| First item in a session takes 30s | buffer is empty and it is generating inline | expected on a genuinely cold start; planning a session now kicks a concurrent fill of its own cells, so this should be the first session on a new concept and not much else |
| Generation feels slow generally | check `latency` in the health payload before changing anything — it reports median and worst-case ms for items and blueprints, and the effort level each call is running at | `GYM_EFFORT_ITEM=low` and a higher `GYM_BUFFER_CONCURRENCY` are the two dials; see the table below |
| `SQLITE_BUSY` in the logs | more than one replica | set replicas back to 1 |
| Slow but working, then a burst of errors | Anthropic rate limit | `ops.recentErrors` will show it; lower `GYM_BUFFER_TARGET` |

## Latency, and the dials that change it

An item is **two sequential calls** — write it, then blind-validate it — and a blueprint
is one large one.

Not all of those are the same work, so they no longer all run on the same model. The
blueprint is the hardest reasoning in the system and everything downstream inherits its
errors. The validator is the gate. The grader is invariant 9. Writing a **D1 recall item
against a finished blueprint** is not in that class — the hard thinking already happened
when the node was drawn — so D1–D3 items go to Sonnet and D4–D6 escalate back to Opus,
because boundary and discrimination items live or die on distractors that are nearly
right, and that is the judgment a smaller model is worst at.

There is a quality argument for the split as well as a cost one: a generator and a
validator on the same model share blind spots, and an item whose flaw is invisible to
Opus is invisible to an Opus validator too.

The thing the gate does *not* catch is shallowness. A weaker generator's items can be
well-formed, unambiguous, correctly keyed — and boring. Watch the rejection rate per
node on the item-health screen, and read a few D3 items yourself before trusting the
setting.

So the strategy is to move the waiting off the answer path rather than to think less.
Items are generated concurrently, planning a session immediately starts filling that
session's own cells, and serving an item refills the cells still ahead of it. What is
left is the first session on a brand-new concept, where there is genuinely nothing
buffered yet.

Read `latency` in the health payload before turning anything:

```jsonc
"latency": {
  "models": {
    "itemShallow": "claude-sonnet-5",   // D1-D3
    "itemDeep":    "claude-opus-5",     // D4-D6
    "blueprint":   "claude-opus-5",
    "validate":    "claude-opus-5",
    "grade":       "claude-opus-5"
  },
  "effort": { "item": "medium", "blueprint": "high", "validate": "high", "grade": "high" },
  "bufferConcurrency": 4,
  "item":      { "n": 50, "medianMs": 41000, "maxMs": 138000 },
  "blueprint": { "n": 2,  "medianMs": 96000, "maxMs": 121000 }
}
```

A median item far above its floor usually means regeneration, not slow inference — a
node whose items keep failing validation burns two calls per attempt. `ops.recent` will
show `generate.timing` with an `attempts` above 1, and the fix is the blueprint node,
not the dial.

| Variable | Default | What it costs you |
|---|---|---|
| `GYM_BUFFER_CONCURRENCY` | `4` | items generated at once, capped at 12. The cheapest speedup, until you hit your account's rate limit — then it produces 429s and gets slower |
| `GYM_MODEL` | `claude-opus-5` | the fallback for every call site that has not been named individually |
| `GYM_MODEL_ITEM` | *(unset)* | naming a model here overrides the depth rule at **every** depth. Set it to `claude-opus-5` to put item writing back the way it was, or to `claude-sonnet-5` to use the cheaper model at D4–D6 too |
| `GYM_MODEL_BLUEPRINT` | `GYM_MODEL` | the one place a shortcut compounds — every item inherits the map |
| `GYM_MODEL_VALIDATE` | `GYM_MODEL` | **leave it on the strong model.** It is the gate, and a weaker one rejects sound items at two calls a rejection |
| `GYM_MODEL_GRADE` | `GYM_MODEL` | leave it. Invariant 9 |
| `GYM_EFFORT_ITEM` | `medium` | `low` is noticeably faster and the items get blander. This is the hot path, so it is the dial with the most effect |
| `GYM_EFFORT_BLUEPRINT` | `high` | `medium` roughly halves the one-time wait. It is also the one place a shortcut compounds — every item inherits the map's errors |
| `GYM_EFFORT_VALIDATE` | `high` | **leave it.** A weaker validator rejects sound items, and each rejection costs two more calls — lowering this can make generation slower as well as worse |
| `GYM_EFFORT_GRADE` | `high` | leave it. Invariant 9: charitable grading turns a failed retrieval into a passed one |
| `GYM_BUFFER_TARGET` | `3` | items per cell **and per generation call**, max 10. Raising it lowers cost *per item* — the shared reasoning divides further — at the price of committing money earlier and a slower first fill |
| `GYM_WORKER_INTERVAL_MS` | `60000` | how often the background fill runs |

If you want one change: raise `GYM_BUFFER_CONCURRENCY` to `8`. It costs no quality at
all, and on a fresh concept it is the difference between the buffer filling during your
first session and filling after it.

## Cost

Two independent meters. Railway is a small always-on container plus a 1 GB volume, and
it is not the one to worry about. Anthropic is.

### Where the money actually goes

The unit is not the session, it is the **item**, and an item is two calls: write it,
then blind-validate it. On top of that the worker generates *ahead* of you. That
multiplier is the thing that surprises people:

| | Default | |
|---|---|---|
| Cells the worker looks ahead over | 12 | `GYM_LOOKAHEAD_CELLS` |
| Items kept ready per cell | 3 | `GYM_BUFFER_TARGET` |
| **Items committed per concept** | **36** | = 72 model calls |
| Items a 20-question session uses | 20 | |

Those pre-generated items are not wasted — they are served eventually — but they are
next month's spending brought forward into today. Before this was tunable the lookahead
was 24 cells, i.e. 72 items and 144 calls per concept. If you train once every few days,
`GYM_LOOKAHEAD_CELLS=6` and `GYM_BUFFER_TARGET=1` cut the commitment by 6× and cost you
a slower first item.

### Seeing it

The app meters itself. Every call records its exact token counts, and the concepts page
shows the running total; `/api/health` has the full breakdown under `spend`:

```bash
curl -s https://$DOMAIN/api/health -H "Authorization: Bearer $TOKEN" | jq .spend
```

**Tokens are exact — they come from the API. Dollars are an estimate** from a price
table baked into `lib/cost.ts` that will go stale. Check it against your billing page
once, and if it is wrong set `GYM_PRICES`:

```
GYM_PRICES={"claude-opus-5":{"input":15,"output":75,"cachedInput":1.5}}
```

`spend.aheadOfUse` is the number to watch: money already spent on items you have not
been shown yet. If it keeps climbing, your lookahead is wider than your training habit.

### Capping it

```
GYM_MONTHLY_BUDGET_USD=20
```

When the month's *estimate* passes the limit, **pre-generation stops and sessions keep
working.** Being told you are out of budget when you sit down to train is how a tool
gets abandoned, so the cap only ever stops speculative work. Over budget, items are
generated one at a time as you reach them — slower, and you only pay for questions you
actually see. It resets on the first of the month, and because it runs off the estimate
it is a guardrail rather than a guarantee.

### Model strategies

`GYM_STRATEGY` picks a whole model assignment in one variable. Run
`npx tsx scripts/cost-model.ts` to price them against the current table — and once you
have a day of real usage, `--measured` re-runs it against your own token counts instead
of the built-in assumptions.

Estimated monthly cost at 20 sessions x 20 items, two concepts, 75% of served items at
D1-D3, x1.4 generated per served:

| `GYM_STRATEGY` | items D1-3 / D4-6 | gate D1-3 / D4-6 | blueprint | grade | $/mo | vs ref |
|---|---|---|---|---|---|---|
| `reference` | opus / opus | opus / opus | opus | opus | $285 | — |
| `shipped` *(default)* | sonnet / opus | opus / opus | opus | opus | $197 | −31% |
| `split-gate` | sonnet / opus | **sonnet** / opus | opus | opus | $128 | −55% |
| `sonnet-gate` | sonnet / opus | sonnet / **sonnet** | opus | opus | $105 | −63% |
| `economy` | **haiku** / sonnet | sonnet / sonnet | opus | opus | $48 | −83% |
| `floor` | haiku / sonnet | sonnet / sonnet | opus | **sonnet** | $45 | −84% |

Individual `GYM_MODEL_*` variables still override whatever the strategy says, and
`GYM_MODEL` redefines what a strategy means by "the strong model" — so
`GYM_STRATEGY=split-gate GYM_MODEL=claude-opus-4-1` is a valid combination.

**Every strategy keeps the blueprint on the strong model**, and there is a test that
says so. It runs once per concept, it is a rounding error against a month of items, and
it is the one error that compounds into every item ever generated from it.

Where I would stop: `split-gate`. It halves the bill by moving only the shallow half of
the gate, and the deep items — where a missed flaw is expensive — keep the strong
validator. Past that, `economy` is a real change in item character, and `floor` gives up
the uncharitable grader, which is invariant 9.

### About older Opus models

Worth saying plainly, because it is the natural thing to try: **an older Opus is not a
cheaper Opus.** Opus has historically carried the same list price across generations, so
substituting 4.1 for 5 in the price table changes the total by nothing:

| | $/mo | vs ref |
|---|---|---|
| `shipped` | $197 | −31% |
| `shipped` + Opus 4.1 on both gates | $197 | −31% |
| Opus 4.1 + Sonnet 4.5 throughout | $155 | −46% |

That third row only saves anything because it also moves deep item writing from Opus to
Sonnet 4.5 — the saving is the Sonnet, not the older Opus. If the goal is spend, a
current Sonnet is roughly 5x cheaper than any Opus and is the lever that actually moves.

Pinning an older Opus is still reasonable for other reasons — you may prefer its
behaviour on a particular task, or want to stop a model change from moving your item
quality under you. Just do not expect a discount, and verify both prices against your
billing page before planning around it. The script prints a warning when two models in a
comparison share a price.

### Structural changes — cheaper without changing models

Model choice is the obvious dial and the least interesting one. **90% of the bill is
output tokens**, and deep items are 67% of spend at 25% of volume — so what matters is
output tokens per *served* item.

**Items are generated in sets.** A generation's output is reasoning about the *cell* —
what this node means, what a learner gets wrong, which distractors are live — followed
by the item text. That reasoning is identical for every item on the same cell, and
paying for it once per item was the largest avoidable cost in the system. A cell's whole
shortfall now goes into one call. At four items that is roughly **half the output tokens
per item**, and it makes the items better: the prompt can require that they differ from
each other, which is a stronger guarantee than generating four independently and hoping.

**Validation deliberately does not amortize.** Each item still gets its own blind solve
from a call that has seen no other item and no key. That is invariant 3, and it is what
makes a cheaper generator safe. There is a test asserting one generation call and N
validation calls for a set of N.

A note on a tempting idea that does not work: *sampling* validation — checking only a
fraction of items — is strictly worse than downgrading the validator. For the same
money, a cheaper model checking 100% beats an expensive model checking 40%, because the
failure mode of sampling is *no gate at all* on the rest. It is not implemented for
that reason.

What each lever is worth, on `split-gate`, from `npx tsx scripts/cost-model.ts`:

| Lever | $/mo | saves | |
|---|---|---|---|
| *(none — one call per item)* | $128 | — | how it originally worked |
| items per call → 4 | $89 | −31% | **built** |
| prompt caching | $118 | −8% | **built** — input is only ~10% of the bill |
| shallow validation at low effort | $118 | −8% | **built** — the deep gate stays high |
| Batch API on the worker's fills | $80 | −38% | **built, on by default** |
| tighter buffer | $107 | −17% | `GYM_LOOKAHEAD_CELLS` / `GYM_BUFFER_TARGET` |
| **all of them** | **$40** | **−69%** | |

**The Batch API is built, and on by default.** The worker's speculative fills go
through Message Batches at half price; results land a tick or two later, which a
buffer can afford. The pipeline is persisted in the `gen_batches` table, so a batch
survives a restart — the provider keeps working while the app is down and the next
tick collects the results. The session's own paths (inline generation, session-start
warm, grading) stay synchronous: a user waiting on an item is never waiting on a
batch. `GYM_BATCH=0` turns it off, at double the price. `/api/health` reports open
batches under `batching`.

**Shallow validation runs at low effort by default.** The validator's output is
almost entirely reasoning, so effort is its cost. Solving a D1–D3 item that already
survived the shape checks does not need extended thinking; catching a subtly wrong
D4–D5 key does, so the deep gate stays at high. `GYM_EFFORT_VALIDATE` overrides both
ends at once.

### Reaching $20/month

| `GYM_STRATEGY` | before | default | tuned | under $20? |
|---|---|---|---|---|
| `reference` | $285 | $89 | $71 | no |
| `shipped` | $197 | $64 | $52 | no |
| `split-gate` | $128 | $49 | $40 | no |
| `sonnet-gate` | $105 | $37 | $30 | no |
| **`economy`** | $48 | **$20** | **$17** | **yes, at defaults** |
| `floor` | $45 | $16 | $14 | yes — but see below |

*before* = one call per item, no caching, no batching. *default* = what now ships.
*tuned* = default + `GYM_BUFFER_TARGET=4 GYM_LOOKAHEAD_CELLS=6`

**`GYM_STRATEGY=economy` is now at the $20 line with no tuning at all**, and $17
tuned. It keeps **Opus on the blueprint and on the grader** — the two places where a
shortcut compounds or breaks an invariant. `floor` buys three more dollars by giving
up the uncharitable grader, which is invariant 9; that is the one trade I would not
make, because a charitable grader corrupts the training signal itself rather than
merely blanding an item.

One thing that shows up only at this budget: the **fixed floor** is about $7.50/month
(blueprints $3.15, D6 grading $4.35) regardless of how many items you answer. At $200 that
is noise; at $20 it is a third of the budget. Past this point the item pipeline is no
longer where the money is.

### Making it cheaper

In rough order of savings per unit of regret:

1. **`GYM_LOOKAHEAD_CELLS=6`, `GYM_BUFFER_TARGET=1`** — the big one, and it costs only
   latency. Combined with `GYM_MONTHLY_BUDGET_USD` this is the whole answer for most
   people.
2. **`GYM_EFFORT_ITEM=low`** — thinking tokens are billed as output, at the output rate.
   Effort is a cost dial as much as a latency one.
3. **`GYM_MODEL_VALIDATE=claude-sonnet-5`** — the validator runs on *every* item and is
   now the largest single line, since D1–D3 writing already moved to Sonnet. I argued
   against touching it on quality grounds and I still would, but if the choice is
   between a Sonnet validator and not using the app, take the Sonnet validator: an
   imperfect gate beats no practice.
4. **Fewer, longer sessions.** The fixed cost is per item, so session length is a linear
   dial you already have in the UI.

What I would not cut: the blueprint. It runs once per concept, it is a rounding error
against a month of items, and everything downstream inherits it.

## Backups

The volume is not backed up for you. There is one file and it is small:

```bash
railway ssh -- sqlite3 /data/gym.db ".backup '/data/backup.db'"
railway volume files download /data/backup.db     # or use `railway volume browse`
```

Worth doing before any blueprint regeneration you are unsure about.
