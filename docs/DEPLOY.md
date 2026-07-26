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
| Build fails compiling `better-sqlite3` | no prebuilt binary for the image's Node version | pin `"engines": { "node": "22.x" }` in `package.json`, or add `python3`, `make`, `g++` via a Nixpacks config |
| Sessions start but every item is skipped with a generation error | bad or missing `ANTHROPIC_API_KEY`, or the model is unavailable | `config.anthropicKeyPresent` in the health payload; the real error text is in `ops.recentErrors` |
| First item in a session takes 30s | buffer is empty and it is generating inline | expected on a cold start; the worker fills it within a minute or two |
| `SQLITE_BUSY` in the logs | more than one replica | set replicas back to 1 |
| Slow but working, then a burst of errors | Anthropic rate limit | `ops.recentErrors` will show it; lower `GYM_BUFFER_TARGET` |

## Cost

Two independent meters. Railway is a small always-on container plus a 1 GB volume.
Anthropic is the real variable: every item is a generation call plus a blind validation
call, both Opus. `GYM_BUFFER_TARGET` is the dial — it trades tokens for the buffer
never being empty when you sit down. Drop it to `1` if spend matters more than the
occasional pause.

## Backups

The volume is not backed up for you. There is one file and it is small:

```bash
railway ssh -- sqlite3 /data/gym.db ".backup '/data/backup.db'"
railway volume files download /data/backup.db     # or use `railway volume browse`
```

Worth doing before any blueprint regeneration you are unsure about.
