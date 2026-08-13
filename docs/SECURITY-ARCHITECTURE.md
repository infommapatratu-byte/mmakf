# SECURITY-ARCHITECTURE

How MMAKF decides who may do what, and every defence that has been built, attacked and verified.

Written to be actionable rather than aspirational: each control names the file that implements it
and the test that proves it. Controls that do **not** exist are listed as plainly as those that do —
a security document that only lists strengths is a liability.

---

## 1. Threat model

A national federation's attackers are mostly not sophisticated. They are:

| | Who | What they want |
|---|---|---|
| T1 | A member or parent | A grade, a certificate or a competition entry they are not entitled to |
| T2 | A rival state or club official | Another unit's membership list, or their applicants' contact details |
| T3 | Someone whose credential was revoked | The revocation to be invisible |
| T4 | A person with a grievance | A safeguarding or disciplinary file naming them, or its reporter |
| T5 | An opportunist | Bulk membership data — names, grades, phone numbers — to poach or to sell |
| T6 | A commodity attacker | Credential stuffing, form spam, a shop order that pays less than it owes |

Every one of these is an **authorisation** problem or a **data-integrity** problem, not a
cryptography problem. The architecture is shaped accordingly.

---

## 2. Identity

**One choke point.** `identify()` in [`src/lib/session.ts`](../src/lib/session.ts) is the only place
a request becomes an identity. Pages and endpoints never read cookies.

Three credentials, in descending trust:

| Cookie | What it proves | Shared? |
|---|---|---|
| `mmakf_user` | A per-person account | No — attributable to a human |
| `mmakf_admin` | The legacy shared office password | Yes — labelled `legacy-admin` in every audit row |
| `mmakf_unit` | A shared unit access code | Yes |

**Cookies are domain-separated.** Each audience signs with its own key derived from the master
secret, and the payload carries an audience claim the verifier must match. A unit token replayed as
an admin token fails twice over.

> This closed a **real P0**: a unit token replayed as `mmakf_admin` previously granted full national
> access — dashboard, private leads, and a successful content write, all HTTP 200. Both replay
> directions are now regression-tested in `tests/auth-audience.test.ts`.

**Roles are never in the cookie.** The session carries only a user id and a session epoch; bindings
are read from `role_bindings` on **every request**. Embedding them would be faster, but withdrawing a
state secretary's authority would then take up to a week to take effect. Revocation has to be
immediate, so one indexed read per request is the right trade.

**A revoked account does not fall back.** A user cookie that no longer resolves returns `null` even
when a valid shared-password cookie is presented alongside it. Without that, disabling an account
silently restores shared-level access. Tested in `tests/session.test.ts`.

**Sign out everywhere.** `users.session_epoch` is stamped into every session. Bumping it invalidates
all of them at once. A password change bumps it automatically — a change made after a suspected
compromise is useless if the attacker's session keeps working.

### Passwords

scrypt from `node:crypto`, N=2¹⁵, r=8, p=1, 16-byte salt, 64-byte key
([`src/lib/password.ts`](../src/lib/password.ts)).

Chosen over argon2 and bcrypt because the deploy target is serverless: a native addon must compile
for the exact runtime and fails at **deploy** time rather than test time. The encoded form carries
its own parameters, so the cost factor can be raised later without invalidating stored hashes, and a
hash below current parameters is transparently upgraded on the owner's next sign-in.

**Enumeration is closed by construction.** A sign-in for an unknown address still performs a full
hash comparison against a dummy, so response timing does not disclose which addresses hold accounts.
Wrong password, unknown address and disabled account return the identical shape.

**Lockout: five failures, fifteen minutes, self-clearing.** Deliberately account-scoped, which means
someone who knows an administrator's address can lock them out on purpose. That denial of service is
accepted: the alternative makes online guessing viable, and it is mitigated by the IP rate limiter in
front and by the lock expiring without administrator action.

### The shared password retires itself

`sharedPasswordAllowed()` returns false once the first real account exists. The federation cannot end
up with per-person accountability on paper while a shared password quietly remains a way around it.
Two deliberate escapes: no database configured (nothing to sign in with yet), and an explicit
`ALLOW_SHARED_ADMIN_PASSWORD` break-glass for a locked-out office.

---

## 3. Authorisation

[`src/lib/rbac.ts`](../src/lib/rbac.ts). 16 roles, **deny by default**, scope always checked.

```
can(principal, action, resource) -> boolean
```

**Scope is what prevents IDOR.** Knowing an id is never sufficient; the id must fall inside the
caller's scope. A resource with no location (site-wide content) is reachable only from a national
binding — a state administrator cannot edit national content by omission.

**List queries filter in SQL.** `visibleScopes()` returns the ids a principal may see, applied to the
`WHERE` clause. Fetching then filtering is one refactor away from leaking, so it is not done
anywhere.

**Two questions, two functions.** `can()` answers about one resource; `canAnywhere()` gates a list
endpoint. Conflating them was itself a defect — passing an empty resource to `can()` refuses every
scoped administrator, because a state admin holds no national binding.

### Adversarial verification

26 attacks in [`tests/rbac-adversarial.test.ts`](../tests/rbac-adversarial.test.ts). Ten succeeded on
first run. All are now blocked and regression-tested:

| Severity | Attack |
|---|---|
| **P0** | **Scope laundering** — placement was authorised against caller-supplied ids, and foreign keys prove existence, not *agreement*. A district admin could name their own district with another state's state id and land records in a state they had no authority over. `resolvePlacement()` now validates the hierarchy *before* authorisation, and rejects mismatches rather than silently correcting them. |
| **P1** | **Audit-trail IDOR** — a state finance officer could read every other state's history. Now scope-checked against the entity's resolved placement, fail-closed for unknown entity types. |
| **P1** | **Unguarded role granting** — a `FEDERATION_ADMIN` could mint a `SUPER_ADMIN`. `canGrantRole()` now requires `role:grant` covering the target scope, restricts SUPER_ADMIN and SAFEGUARDING_OFFICER to a super admin, and forbids amplification: the target role's actions must be a subset of the granter's own. |

Attacks that failed on first attempt — forged role names, non-array bindings, null principals, a
state binding with a null scope id escalating to national, unknown scope types defaulting open,
expired and suspended bindings, string/number scope-id coercion.

### Safeguarding is separated in the role model, not by a flag

Only `SUPER_ADMIN` and `SAFEGUARDING_OFFICER` hold `safeguarding:read`. **`FEDERATION_ADMIN`
deliberately does not.** Child-protection casework is not general administration, and the role model
says so rather than relying on everyone remembering.

---

## 4. Request security

**CSRF.** [`src/middleware.ts`](../src/middleware.ts) checks `Sec-Fetch-Site` (browser-set,
unforgeable by script) or a matching `Origin` on every mutating request, and requires
`application/json` on API routes.

> Before this there was **no CSRF defence at all**. `SameSite=Lax` is site-scoped, so any subdomain
> could drive authenticated admin writes, and `/api/data/[key]` parsed `request.json()` with no
> content-type check — a cross-site form with `enctype="text/plain"` was accepted as JSON.

A request with no origin information is **refused**, because that is exactly what a forged cross-site
form produces. Webhooks are exempt by explicit path and authenticated by signature instead.

**Rate limiting.** Redis fixed-window on every public write; the IP is hashed, never stored raw. The
limiter never throws — a Redis outage must not take the site down.

**Payment verification is server-side only.** An order becomes paid on a verified `captured` status
matching the exact amount *and* currency. Returning from a payment page proves nothing — the customer
controls that redirect. A mismatched capture is flagged for a human, never quietly accepted. Webhooks
are HMAC-verified over the **raw body**; re-serialised JSON has different bytes and correctly fails.

**Replay protection.** `payment_events` carries a unique index on (provider, event id). Every gateway
retries webhooks, and fulfilling twice is worse than fulfilling late.

---

## 5. Data classification

Every sensitive table carries a `data_class` column, enforced at the row level:

`public` · `member` · `official` · `confidential` · `restricted` · `highly_restricted`

Defence in depth: RBAC should already have refused the read, and this is the second gate for when it
does not.

**Safeguarding and medical are separate tables, not flags on `persons`.** Merging them would put
child-protection material one careless join — or one `SELECT *` — away from a general admin list, and
they carry different lawful bases, different retention and a different readership. A safeguarding
subject need not be, and may never become, a federation member; the schema does not require a
`persons` row for them.

**Public projections are separate functions, never a flag.** `publicAthleteProfile()` and
`athletePassport()` are distinct. A boolean defaulting the wrong way leaks a date of birth; two
functions cannot.

**The member register is not a download.** `/api/data` previously served the entire register —
every member's name, grade, unit and state — unauthenticated and CDN-cached for five minutes. It was
a verification service that was actually a bulk export. `PRIVATE_KEYS` now filters on the way out, so
a key added to that list is excluded automatically.

---

## 6. Integrity

Security here is mostly about records that cannot be quietly changed.

| Control | Where |
|---|---|
| Rank history append-only; current rank **derived** | Partial unique index enforces one active rank per person per kind — even against a raw INSERT |
| Certificates freeze a snapshot | A later name correction or syllabus revision cannot alter an issued document |
| Revocation never deletes | A vanished credential is indistinguishable from one that never existed — which is what a holder of a revoked certificate would prefer |
| Results lock on finalisation | Corrections supersede with recorded authority and reason |
| Match scoring append-only | A correction appends a reversing event; the running score is recomputed from the log so the cache cannot drift |
| Documents versioned with SHA-256 | A published file cannot be swapped after approval |
| Everything versioned | A 2026 grading keeps the meaning it had in 2026 |
| Audit rows carry old *and* new value | A bad edit is recoverable, not merely detectable |

**Money is integer paise throughout.** `paise(0.1) + paise(0.2) === paise(0.3)` is a test, because a
federation's accounts cannot drift by rounding.

**Identifiers are CSPRNG-derived, never `Date.now()`.** A dojo submitting a batch of students
produced colliding ids, and one silently overwrote another.

**Lists archive rather than discard.** `pushToList` previously LTRIM'd at its cap: the 2001st
membership application permanently deleted the 1st, with no warning. Overflow now moves to an archive
via `RPOPLPUSH` — atomic, so a record is never in neither list.

---

## 7. Secrets

| | |
|---|---|
| In the repository | **None.** Verified — four working portal access codes were committed and have been removed |
| OAuth refresh tokens | AES-256-GCM, authenticated so a tampered ciphertext fails rather than yielding garbage later sent to Google as a credential |
| Missing `MEDIA_TOKEN_KEY` | Storing a token is **refused**, not silently stored in plaintext |
| IP addresses | SHA-256 hashed before storage, everywhere |
| Passwords | Never logged, never in an audit payload — asserted by test |

> The seeded access codes were a genuine P0. `storage.get()` falls back to the seed whenever a Redis
> key is unset or a read throws, so a Redis outage or a mistyped variable silently made four
> committed state and district portal logins valid again. The seed is now empty: a degraded read
> grants **nothing**.

---

## 8. What does NOT exist

Listed as plainly as the rest. Tracked in `IMPLEMENTATION-QUEUE.md`.

| Gap | Consequence | Queue |
|---|---|---|
| **MFA** | A national-admin password is the only factor | Q-27 |
| **Backups, restore drill, RPO/RTO** | No tested recovery path | Q-26 |
| **Upload validation / malware scanning** | No upload subsystem exists yet; it must not ship without them | Q-30 |
| **Observability** | `/api/health` only. A quiet failure stays quiet | Q-29 |
| **Row-level security *policies*** | The schema is now closed rather than governed. Migration `0010` enables RLS on every table and revokes the provider's Data API roles, which denies everyone except the owner role the application connects as — but no policy exists, so the database cannot yet express *who* may read *what*, and the Data API setting on the federation's own project is still unverified. §8.1 | Q-36 |
| **Full WCAG 2.2 AA audit** | Specific fixes made; no systematic pass | Q-28 |

**Two-person control** (Q-25) is in build. Until it lands, certificate revocation, Dan approval,
result correction and financial settlement are single-authority acts — which is a real exposure, not
a theoretical one.

### 8.1 The second system is not a future condition

This row previously deferred the risk to a future in which "more than one system touches the database". That framing was wrong the day it was written: Supabase publishes the `public` schema over HTTP with a key that ships to browsers, so a SECOND system already touched it — the managed platform itself. Closed by `drizzle/0010_data_api_lockdown.sql`, which enables row-level security on every table and revokes the PostgREST roles. An em
dash where every other gap carried a queue number. Both halves were wrong in the same direction, and
the direction was deferral.

The federation has provisioned a **Supabase** project. Supabase installs **PostgREST**. It is not
opted into, it listens on the public internet at a URL derived from the project ref, and its
anonymous key is documented by the vendor as safe to publish — on the stated assumption that RLS is
on. The condition the register described as a future trigger is satisfied by the act of
provisioning.

The application policy layer does not help here. [`src/lib/rbac.ts`](../src/lib/rbac.ts) is reached
only over HTTP to mmakf.in; a PostgREST request never executes a line of it. Nothing the application
does would notice either — `/api/health` opens a TCP connection as the app role and reports
`"database":"ok"` whether or not the same tables are also being served to the world.

**Measured, on a real Postgres engine on a developer machine, with all migrations applied:** before
`0010`, **117 tables, 0 with RLS, 0 policies**. After it, RLS is on for all of them and the
`anon` / `authenticated` grants — present *and* default — are gone. Two layers, because either alone
fails: a grant is one pasted `GRANT` wide, and RLS hides rows but not the data model, so with a
grant intact `anon` still enumerates every table and column and the API answers `200 []` instead of
refusing.

`FORCE ROW LEVEL SECURITY` is deliberately **not** set. The app connects as the table owner, and an
owner is exempt from RLS unless FORCE is set; forcing it with no policies would not harden the
federation, it would take it offline.

**What has NOT been measured, and must not be written as though it had.** No database password has
been supplied for the federation's project, and nothing in this repository has connected to it.
Whether its Data API is enabled, and what its default privileges currently are, is **unknown
here**. (The project ref is deliberately not written down in this repository: it is what the
PostgREST endpoint's URL is built from, and until the check below has been run there is no reason to
publish the address of an unverified endpoint.) Before `DATABASE_URL` is pointed at it, the operator
must run the check below against the
project, record the result, and switch the project-level Data API off — this app uses PostgREST for
nothing, so the switch costs the federation nothing. The dashboard setting is not a substitute for
the migration: a setting is mutable, unreviewable, invisible to CI, and not carried into a restored
or rebuilt project.

```sql
-- Must return no rows. Any row is a table the Data API can serve.
SELECT c.relname, pg_get_userbyid(a.grantee) AS role, a.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND pg_get_userbyid(a.grantee) IN ('anon', 'authenticated');

-- Must return no rows. Any row re-grants every table created from now on.
SELECT pg_get_userbyid(a.grantee) AS role, a.privilege_type
FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
WHERE pg_get_userbyid(a.grantee) IN ('anon', 'authenticated');

-- Must return 0. Any table without RLS was added behind the lockdown.
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;
```

**Re-verify after every new migration.** `ENABLE ROW LEVEL SECURITY` is a per-table act, so a
migration that adds a table adds it *unsecured* unless a fresh lockdown migration follows. A
comment asking the next author to remember is not an enforcement mechanism; the RLS assertion in
the Data API suite is, and it fails the moment a table is left open.

`service_role` is left with its grants on purpose: it is the **secret** key, the vendor documents it
as bypassing RLS, and it must be handled with the same care as the database password itself.

---

## 9. Verifying these claims

Nothing here should be taken on trust:

```bash
npm test                  # 300+ tests, including every attack described above
npm run db:verify         # migration runner against real Postgres
npm run links:check       # external links by content type and size, not status code
npx tsc --noEmit          # type checking
```

The adversarial suites are the ones that matter: `tests/rbac-adversarial.test.ts`,
`tests/auth-audience.test.ts`, `tests/hardening.test.ts`, `tests/rank-race.test.ts`,
`tests/grading.test.ts`.

**Every attack listed in §3 was written to succeed first.** A test that never failed proves nothing
about the defence it claims to verify.
