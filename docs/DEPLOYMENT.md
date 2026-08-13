# DEPLOYMENT

How MMAKF is deployed, every environment variable it reads, and the exact sequence for taking the
federation system live.

---

## 1. Where it runs

| | |
|---|---|
| Host | Vercel, `mmakf` project |
| Framework | Astro 5, `output: 'server'` (SSR) |
| Adapter | `@astrojs/vercel` v8 |
| Runtime | **Node 22** |
| Repository | `github.com/infommapatratu-byte/mmakf` |
| Production branch | `main` — every push deploys |
| Current work | `wave-2b-federation` — pushes create preview deployments only |

> **Node 22 is not optional.** Adapter v7 emitted a Node 18 runtime that Vercel discontinued, and
> **every deployment failed in 11–16 seconds** with an error that did not name the cause. The fix was
> Astro 4→5 and adapter 7→8; only the import path changed. If deployments start failing fast and
> silently again, check the runtime first.

---

## 2. Environment variables

### Required in production today

| Variable | Purpose | If missing |
|---|---|---|
| `ADMIN_PASSWORD` | Shared office password | **Production refuses all logins.** Deliberate — the dev default `mmakf2025` must never be live |
| `ADMIN_SESSION_SECRET` | Signs session cookies | Same |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis (CMS + rate limiting) | Content falls back to seed; rate limiting stops silently |

### Required to activate the federation system

| Variable | Purpose | If missing |
|---|---|---|
| `DATABASE_URL` | Postgres | **All 87 tables are inert.** `/api/health` reports `database: "not_configured"`. This is the single highest-value variable in the project |

### Payments — until set, the shop takes UPI and says so

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID` | Public; safe in the browser |
| `RAZORPAY_KEY_SECRET` | **Secret.** Signs API calls |
| `RAZORPAY_WEBHOOK_SECRET` | **Secret, and a DIFFERENT value.** Using the API secret to verify webhooks silently rejects every callback — a common integration bug |
| `MMAKF_UPI_ID` | Manual-UPI fallback |
| `PAYMENT_PROVIDER` | Pins a provider; otherwise the first configured one wins |

### YouTube live classes

| Variable | Purpose |
|---|---|
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REDIRECT_URI` | OAuth |
| `MEDIA_TOKEN_KEY` | Encrypts refresh tokens. **Without it, storing a token is refused** rather than written in plaintext |

### Operational

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Authorises `/api/cron/reconcile`. **Unset means the job cannot run at all** — an unset variable must never mean "allow" |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. Default `info` |
| `DATABASE_SCHEMA` | Defaults to `public` |
| `ALLOW_SHARED_ADMIN_PASSWORD` | **Break-glass only.** Keeps the shared password working after real accounts exist |
| `UPLOAD_STORAGE_URL` / `MALWARE_SCAN_URL` | Uploads. Unset is reported honestly, never as "clean" |

**No secret is in the repository.** Verified — four working portal access codes were committed once
and have been removed.

---

## 3. Going live: the sequence

Ordered so each step is verifiable before the next depends on it.

### Step 1 — Provision Postgres

Any provider. **Supabase recommended**, Mumbai (`ap-south-1`). Nothing in the codebase names a
vendor; `DATABASE_URL` is the only input.

> **Never reintroduce Neon or Vercel Postgres.** The federation rejected it.

The federation has supplied a Supabase project, ref `srmlqtdntkizxwnkttvz`. **No database password
has been supplied with it**, so no command in this section has been run against that project. What
follows is DNS lookups and local reproductions, which are labelled as such; anything that needs the
credential is marked **verify at cutover** rather than stated as fact.

Supabase publishes **three** endpoints. Two are used; the third cannot be used here.

| Endpoint | Host and port | Used for |
|---|---|---|
| **Transaction pooler** | `aws-N-ap-south-1.pooler.supabase.com:6543` | The app — `DATABASE_URL` in Vercel. Serverless opens a connection per invocation, which a direct connection limit cannot absorb. `prepare: false` in `src/db/index.ts` exists for this pooler |
| **Session pooler** | the **same host**, port `5432` | Everything an operator runs from a workstation: `db:migrate`, `backup`, `user:create`. Session mode holds one backend for the life of the connection, so DDL and out-of-transaction statements behave as on a direct connection |
| **Direct** | `db.<project-ref>.supabase.co:5432` | **Not usable on this project — no A record.** See below |

> **The two pooler strings differ only in the port.** `6543` is the app, `5432` is the operator. That
> one digit is the mistake to expect. Copy both out of the project's **Connect** dialog rather than
> composing them: the pooler username is project-qualified (`postgres.<project-ref>`), a shape no
> other provider uses, and the host prefix is `aws-0` on some projects and `aws-1` on others.

**Why the direct connection is not an option here.** Measured on this workstation, 2026-08-12, DNS
only — nothing was connected to, because no password exists:

```
$ nslookup db.srmlqtdntkizxwnkttvz.supabase.co
Address:  2406:da1a:314:7102:cb52:44a4:70e5:bc13     # AAAA. `-type=A` returns no address at all

$ nslookup aws-0-ap-south-1.pooler.supabase.com
Addresses:  3.111.105.85, 65.0.195.55                # IPv4, reachable
```

Supabase publishes AAAA only for `db.<ref>.supabase.co` **by design**, unless the paid **IPv4
add-on** is enabled. Buying that add-on restores the direct host and is a legitimate route — a choice
to make deliberately, not something to discover at 9pm. Until it is bought, an IPv4-only workstation
and a Vercel function both fail to reach that host, before authentication and before any statement
runs: `getaddrinfo ENOTFOUND` where the machine has no IPv6 at all, `ENETUNREACH` where it has an
address but no route. Reproduced here with `net.connect` to an unreachable IPv6 address: the OS
rejected it immediately, so the runner's `connect_timeout: 15` (`scripts/migrate.mjs:46`) never
engages — an instant failure is the normal shape of this fault, not a sign of a different one.

> **Do not paste the IPv6 address in as a workaround.** postgres.js 3.4.9 mis-parses a bracketed
> literal: `postgresql://u:p@[2001:db8::1]:5432/postgres` parses to host `[2001` with port `NaN`, and
> the process dies at connect with `RangeError [ERR_SOCKET_BAD_PORT]: Port should be >= 0 and <
> 65536. Received type number (NaN)`. Reproduced locally; `tests/deployment-runbook.test.ts` pins the
> parse so this warning cannot quietly go stale. Use the session pooler instead.

### Step 2 — Migrate, from a workstation, using the SESSION pooler string

Run from the **repository root**: `scripts/migrate.mjs:81` reads `drizzle/` relative to the working
directory, so from anywhere else the runner reports no migrations rather than a bad path.

```bash
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-N-ap-south-1.pooler.supabase.com:5432/postgres" npm run db:status    # what would run
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-N-ap-south-1.pooler.supabase.com:5432/postgres" npm run db:migrate   # applies, then lists tables
```

**Verify at cutover, with `db:status` first.** That Supabase serves *session* mode on port 5432 of
the pooler host is its documented architecture, not something measured for this project — nobody here
has held the password. `db:status` connects, prints the target and the pending list, and writes
nothing. It is a ten-second check that turns the assumption into a fact, run before the command that
matters rather than after it.

**If only the transaction pooler (`6543`) can be reached**, know exactly what is being traded. Every
migration file is applied inside one explicit transaction (`scripts/migrate.mjs:112`) with
`prepare: false` (`:45`), and a transaction pooler pins one backend for the length of a transaction —
so the migration bodies themselves are safe, and the runner's own comment says as much. What is not
safe is the two statements the runner executes **outside** any transaction, `CREATE SCHEMA IF NOT
EXISTS` and `SET search_path` (`:66-67`): transaction-mode pooling is free to hand the next
transaction a different backend, and that `SET` need not survive. At the default
`DATABASE_SCHEMA=public` losing it changes nothing — `public` is already on the default `search_path`
and the runner's verification query is hardcoded to `public` (`:135`). With **any other schema, do
not migrate over 6543**: the pin that keeps DDL out of the wrong schema is the thing being lost.

**Never reconstruct the schema by hand in a provider's dashboard.** The migration chain is the only
sanctioned path; a manually-created schema cannot be reasoned about afterwards.

### Step 3 — Back it up before it matters

```bash
npm run backup
npm run backup -- --verify backups/<file>
```

An untested backup is a file, not a backup.

`scripts/backup.mjs` opens the database with the same driver and the same pooler-safe options as the
application (`:40-41`), so it runs over whatever `DATABASE_URL` holds — the session string still in
the shell from step 2 needs no change.

### Step 4 — Set `DATABASE_URL` in Vercel

The **pooler** string, applied to Production, Preview and Development. Redeploy so functions pick it
up.

### Step 5 — Verify

```bash
curl https://www.mmakf.in/api/health     # database must read "ok"
```

`"not_configured"` means step 4 has not taken effect. `"error"` means the URL is set but unreachable
— check the pooler string and that the password is URL-encoded.

**`ENOTFOUND` or `ENETUNREACH` from any command in this section is a different fault**, and not a
credentials one: the host did not resolve, or there is no route to it, and the failure happens before
authentication is even attempted. Re-checking the password will find nothing. On a
`db.<project-ref>.supabase.co` target it means the direct, IPv6-only host — switch to the session
pooler on port `5432` of `aws-N-ap-south-1.pooler.supabase.com`.

### Step 6 — Create the first account

The same session string as step 2. (This one is plain DML and would also run over the app's `6543`
string; keeping every operator command on one string is what stops the port from being guessed.)

```bash
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-N-ap-south-1.pooler.supabase.com:5432/postgres" npm run user:create -- --email you@mmakf.in --role SUPER_ADMIN
```

The password is generated and shown **once**. The account is flagged must-change-on-first-use.

> The moment this succeeds, `sharedPasswordAllowed()` returns false and **the shared office password
> stops working**. That is the point: the federation must not end up with per-person accountability
> on paper while a shared password quietly remains a way around it. Have the new credential in hand
> before running this.

### Step 7 — Set `CRON_SECRET`

Without it the hourly reconciliation cannot run, and a captured payment that failed to fulfil stays
invisible.

---

## 4. Releasing

1. Work on a branch. `main` deploys on push.
2. Before merging:
   ```bash
   npm test                  # 1103 tests
   npx tsc --noEmit
   npm run build
   npm run db:verify
   npm run links:check
   ```
3. Merge to `main`.
4. **Verify against production, not against intent:**
   ```bash
   curl https://www.mmakf.in/api/health   # confirm the commit SHA is yours
   ```
   Then smoke-test the routes the change touched.

**Never claim a production success without checking production.**

### Migrations in a release

A migration is applied by an operator, **not by the deploy**. Order matters:

- **Additive** (new table or nullable column): migrate first, then deploy.
- **Destructive** (drop or rename): deploy code that tolerates both shapes, migrate, then deploy the
  cleanup. Postgres DDL is transactional, so a failed migration rolls back cleanly — but a
  deploy/migrate ordering mistake does not.

Back up before every migration.

---

## 5. Rollback

**Code:** revert the commit and push. Vercel also allows promoting a previous deployment instantly —
faster during an incident.

**Schema:** migrations are forward-only. There is no automatic down-migration, deliberately: a
generated rollback that has never been tested is a liability during an outage. To reverse, write a
new forward migration that undoes the change, and restore from backup if data was lost.

**A migration edited after being applied is a hard error.** The runner checksums every file. Editing
applied history is how environments silently diverge.

---

## 6. Post-deploy verification

| Check | Command | Expected |
|---|---|---|
| Deployed commit | `curl …/api/health` | your SHA |
| Redis | same | `"redis": true` |
| Database | same | `"database": "ok"` |
| Routes | `curl -o /dev/null -w '%{http_code}' …` | 200 |
| Security headers | `curl -I …` | HSTS, X-Frame-Options, CSP |
| External links | `npm run links:check` | all healthy |

---

## 7. Traps that have actually cost time

| | |
|---|---|
| **`postcss.config.cjs` at the project root is load-bearing.** A stray `postcss.config.js` in `C:\Users\user\Downloads` breaks Vite for every project beneath it. Do not delete it |
| **`astro preview` crashes** with the Vercel adapter. Use `npx astro dev --port <n>` to render-check |
| **`https://mmakf.in` redirects to `http://` www** — a protocol downgrade. HSTS preload mitigates it; the redirect target still needs fixing in the Vercel dashboard |
| **A status code does not prove a link works.** `wkf.net` serves a superseded PDF as HTTP 200 with `image/png` and 1.6KB. `npm run links:check` verifies content type and size |
| **Local Node 25 vs Vercel Node 22** produces a build warning. Harmless — the deploy uses 22 |
| **Supabase's direct host is IPv6-only.** `db.<project-ref>.supabase.co` publishes AAAA and no A record, so a migration aimed at it fails `ENOTFOUND`/`ENETUNREACH` before one statement runs — from a workstation and from a Vercel function alike. Operator commands go through the **session** pooler, `aws-N-ap-south-1.pooler.supabase.com:5432`; the app uses the same host on `6543`. §3 step 1 has the measurements, and why pasting the IPv6 literal makes it worse |

---

## 8. Not yet in place

| Gap | Consequence |
|---|---|
| **No staging environment** | Preview deployments share production Redis. A destructive CMS write from a preview would hit live content |
| **No CI** | Tests run locally by convention. Nothing enforces them before a merge |
| **No error tracking** | Failures reach the Vercel function log and nowhere else. `src/lib/observability.ts` emits structured JSON ready for an aggregator; none is configured |
| **No uptime monitoring** | `/api/health` is built to be polled and nothing polls it |
| **Backups are manual** | See `BACKUP-RESTORE.md` |
