# PROJECT-CONTEXT — read this first

**If you are picking this project up with no memory of previous conversations, start here.**
This file, and the documents it points to, are the source of truth. Chat history is not.

---

## 1. What this is

**MMAKF — Modern Martial Arts Karate-Do Federation of India.** A national federation for
**Shotokan karate**. Jurisdiction is **national (India)** — never describe it as international.

Live at **https://www.mmakf.in**. Headquarters: Patratu, Ramgarh District, Jharkhand.
Contact: `admin@mmakf.in`, `+91 99391 44318`.

The objective is a **national federation digital operating system**, not a website: membership,
grading, certificates, competition, rankings, education, governance, safeguarding, finance and
commerce — each backed by a real system of record.

**MMAKF ≠ mixed martial arts.** This confusion wastes research time and produces wrong results.

---

## 2. The rule that overrides every other instruction

**NEVER INVENT ANYTHING ABOUT MMAKF.**

Not a fee, a grading requirement, an affiliation, a recognition, a statistic, a member, an office
holder, a championship, a date, a record, a photograph caption, or a constitution.

Where information is missing, build the **data model and the administrative mechanism** to capture
it, and render the absence honestly — "not yet published by the federation". A stated gap is
credible. A fabricated syllabus or a fabricated recognition is the one failure this project treats
as unforgivable, and it is the failure most likely to be committed by an agent trying to be helpful.

Corollary: **no fake features.** Never render a control that cannot work. If a capability depends on
a database or gateway that is not configured, say so in the UI. Check `isConfigured()` from `@/db`
or `paymentStatusReport()` from `@/lib/payments`.

---

## 3. Where things stand

| | |
|---|---|
| Branch | `wave-2b-federation` — **production still runs `6a44fdf`** |
| Tests | 254 passing across 15 files |
| Schema | **87 tables**, 4 migrations, applied and verified against real Postgres |
| Typecheck / build | clean |
| External links | 28/28 verified live by content type and size |

### The single most important fact

**`DATABASE_URL` is not set in production.** `/api/health` reports
`{"redis":true,"database":"not_configured"}`.

All 87 tables, the RBAC engine, the audit spine, the order/payment/ledger spine and per-user
accounts are **built, migrated and tested — and carry no data in production.** Every subsystem
needing a system of record is blocked behind one environment variable. Redis holds the editorial
content and four private submission lists; that is the entire live data layer.

---

## 4. How to run it

```bash
npm install
npm run dev:db          # real Postgres on 127.0.0.1:5433, persists to .pgdata/
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres" npm run db:migrate
npm run dev

npm test                # 254 tests, includes real-Postgres suites
npm run db:verify       # proves the migration runner end-to-end (5 checks)
npm run links:check     # external rulebook links, by content type not status code
npm run user:create -- --email you@mmakf.in --role SUPER_ADMIN
```

`npm run dev:db` runs a genuine Postgres wire-protocol server in-process. **No Docker, no installed
Postgres, no hosted database needed to build or test the whole system.**

---

## 5. Architecture in one page

**Astro 5 SSR on Vercel** (Node 22 — adapter v7/Node 18 caused every deploy to fail).
No React, no client framework.

**Two stores, by design** — see `docs/FEDERATION-ARCHITECTURE.md §1`:
- **Redis (Upstash)** — editorial CMS content. Correct for news and pages; wrong for records.
- **Postgres (via `postgres.js`, deliberately vendor-neutral)** — federation records. Any provider
  works; `DATABASE_URL` is the only input. **Never reintroduce Neon or Vercel Postgres** — the
  federation rejected it.

**The choke points.** Learn these four before changing anything:

| Module | Owns |
|---|---|
| `src/lib/session.ts` → `identify()` | Request → identity. Never read cookies elsewhere. |
| `src/lib/rbac.ts` → `can()` | Authorisation. 16 roles, deny-by-default, scope always checked. |
| `src/db/federation.ts` → `writeAudit()` | Audit. Actor, old, new, reason, authority. |
| `src/db/orders.ts` → `confirmPayment()` | Money. Only a verified capture marks an order paid. |

**Invariants that are load-bearing:**
- Rank history is append-only; current rank is *derived*. A partial unique index enforces at most
  one active rank per person per kind, even against a raw INSERT.
- Money is integer paise everywhere. Never a float.
- Results and certificates lock. Corrections create new versions; nothing is edited in place.
- Everything is versioned — syllabus, ranking rulesets, documents — so a 2026 record keeps the
  meaning it had in 2026.
- Roles are resolved from the database on **every request**, never embedded in the session cookie,
  so revoking authority takes effect immediately.

---

## 6. Read these next

| Document | For |
|---|---|
| `docs/MASTER-SPECIFICATION.md` | **The canonical specification.** Invariants, domains, definition of done |
| `docs/MMAKF-SYSTEM-AUDIT.md` | What exists, what is fake, what is missing — classified |
| `docs/IMPLEMENTATION-STATUS.md` | Per-subsystem state |
| `docs/IMPLEMENTATION-QUEUE.md` | What to build next, in dependency order |
| `docs/FEDERATION-ARCHITECTURE.md` | Storage decision, ID scheme, provisioning runbook |
| `docs/AUDIT-REGISTER.md` | Every defect found, with evidence and fix |
| `docs/CLAIMS-AUDIT.md` | Every public claim checked against evidence |
| `docs/MASTER-SPEC.md` | The original governing engineering directive |
| `docs/SECURITY-ARCHITECTURE.md` | Threat model, every control, and every gap |
| `docs/DATA-ARCHITECTURE.md` | The 87 tables and the five rules that shape them |
| `docs/TESTING-STRATEGY.md` | Why the tests look the way they do, and what is not covered |
| `docs/DEPLOYMENT.md` | Every variable, and the sequence for going live |
| `docs/BACKUP-RESTORE.md` | Proven cycle, with the transcript |
| `docs/DISASTER-RECOVERY.md` | What breaks, what it costs, what to do |
| `docs/PRIVACY.md` | Children's data, DPDP, and what MMAKF must supply |

---

## 7. Blocked on MMAKF, not on engineering

Do not work around these by inventing content.

1. **`DATABASE_URL`** — Supabase, Mumbai region, pooler string (port 6543) for the app, direct
   string (5432) for migrations. Runbook: `FEDERATION-ARCHITECTURE.md §10.1`.
2. **Merchant account** — needs the federation's registration certificate, PAN and bank details.
   Razorpay adapter is built and tested; it goes live the day keys exist.
3. **The syllabus** — grading requirements, intervals, pass marks. Schema is built; it is empty.
4. **Governance documents** — constitution, bye-laws, safeguarding and selection policies.
5. **A photograph of Sensei Vikas Pathak** — none exists publicly; his news item deliberately
   carries no image rather than a misattributed one.
6. **Sensei Sumitra's name and grade** — three sources disagree.
7. **Claims decisions** — WKF standing, and the Limca/Guinness reports. See `CLAIMS-AUDIT.md`.

---

## 8. Things that will waste your time if you do not know them

- **`postcss.config.cjs` at the project root is load-bearing.** A stray `postcss.config.js` in
  `C:\Users\user\Downloads` breaks Vite for every project beneath it. Do not delete it.
- **`astro preview` crashes** with the Vercel adapter. Use `npx astro dev --port <n>` to render-check.
- **The dev database is single-connection.** PGlite behind a socket accepts one client; opening a
  second resets the first. Tests that need isolation spawn their own server.
- **Status codes do not prove a link works.** `wkf.net` serves a superseded rules PDF as HTTP 200
  with `image/png` and 1.6KB; WADA returned 202 with a zero-byte body. `npm run links:check`
  verifies content type and size. An agent already published a link recording evidence it never
  measured — check, do not trust.
- **Drizzle wraps driver errors**, so SQLSTATE is not on the outermost object. Use
  `isUniqueViolation()` from `src/db/pgerror.ts`; matching the wrapper silently never fires.
- **Search-engine AI summaries restate mmakf.in's own claims as if independently established.**
  Every underlying link is mmakf.in. That echo is not corroboration.
