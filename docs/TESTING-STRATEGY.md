# TESTING-STRATEGY

**1103 tests across 31 files.** What they are for, how they are written, and what they deliberately
do not cover.

---

## 1. The rule that produced most of them

> **A test that has never failed proves nothing about the defence it claims to verify.**

Every security and integrity test in this repository was written to **succeed as an attack first**,
then fixed. Ten of the twenty-six RBAC attacks succeeded on their first run. Those ten are the
reason the authorisation model can be trusted; the sixteen that failed immediately are worth far
less, and are kept only as regressions.

When adding a test for a defect: **write it, watch it fail, then fix the code.** A test written
after the fix, against the fixed code, tends to assert what the code does rather than what it should
do.

---

## 2. Real Postgres, not a mock

Most suites boot **PGlite** — a genuine Postgres engine in-process — and apply the real migration
files from `drizzle/`.

This is not a preference. A mocked database cannot catch:

| Defect actually caught this way | |
|---|---|
| Two active ranks after concurrent promotion | A partial unique index was needed; a mock would have agreed with the buggy code |
| `ON CONFLICT` never firing | Postgres treats NULLs as **distinct** in a unique index — invisible without a real planner |
| Foreign keys proving existence but not *agreement* | The scope-laundering P0 |
| Enum rejection, cascade behaviour, sequence drift after restore | |

`tests/e2e-postgres.test.ts` goes further and spawns a Postgres **wire-protocol server**, talking to
it over TCP with `postgres.js` — the exact driver, protocol and connection settings production uses.
In-process SQL exercises the queries; only this exercises the driver.

**No Docker, no installed Postgres, no hosted database** is needed for any of it.

---

## 3. Layers

| Layer | Example | What it protects |
|---|---|---|
| **Pure unit** | `password`, `origin`, `unit-scope`, `registration`, `uploads`, `observability` | Logic with no I/O. Fast, exhaustive on edge cases. |
| **Database integration** | `federation-db`, `grading`, `competition`, `matches`, `cases` | Constraints, transactions, concurrency, cross-table invariants. |
| **Adversarial** | `rbac-adversarial`, `auth-audience`, `hardening`, `rank-race` | Named attacks. Each `it()` is one attack; passing means it **failed**. |
| **Wire protocol** | `e2e-postgres` | The driver, over TCP, as production runs it. |
| **Operational** | `scripts/verify-migrate.mjs`, `scripts/backup.mjs --verify`, `npm run links:check` | The tools an operator depends on in an incident. |

---

## 4. What a good test looks like here

**Name the attack, not the function.**

```
✗  it('validates state')
✓  it('ATTACK: a district admin cannot file a person into ANOTHER state by naming their own district')
```

**Assert the mechanism, not just the outcome.** A refusal test that only checks `toThrow()` passes
when the code throws for the wrong reason:

```ts
expect(interval.detail).toMatch(/1 months since 2026-07-01, 3 required/);
```

**Prove the negative where it matters.** Not "the response omits the email" but "the entire
serialised response contains no email, phone or date of birth":

```ts
expect(JSON.stringify(result)).not.toContain('private@example.in');
```

**Distinguish absent from zero.** `careerStatistics` returns `null` — not `0` — for someone who has
never competed. "Never competed" and "lost everything" are different facts, and a profile page would
repeat that small lie forever.

**Test the unconfigured path.** Given the rule that MMAKF supplies policy and the schema supplies
structure, the most common defect is a module inventing a default. Every configurable rule has a test
asserting that when unset it is **not applied** and the result **says so**.

---

## 5. Concurrency

Race conditions do not appear in sequential tests, and every one found here was a real defect:

```ts
await Promise.all([awardRank(...), awardRank(...)]);   // → two active ranks
```

Covered: concurrent promotion (2-way and 5-way), 40-way identifier allocation, concurrent person
creation, repeated webhook delivery, double execution of an approved action.

**Known gap:** competition entry quotas count-then-insert non-atomically, so two concurrent entries
can both pass a cap of one. Reported rather than silently left — the fix belongs in a migration.

---

## 6. Running them

```bash
npm test                  # everything
npm test -- tests/grading.test.ts
npm run db:verify         # migration runner against real Postgres
npm run backup -- --verify <file>
npm run links:check       # external links by content type and size, not status code
npx tsc --noEmit
```

`vitest.config.ts` sets `hookTimeout: 120_000`. Each suite applies four migrations — 87 tables,
roughly a thousand statements — inside `beforeAll`. The 10s default failed whole files with no useful
message, which looks exactly like a broken test.

---

## 7. What is NOT covered

Stated plainly, because an untested area presented as tested is worse than an untested area.

| Gap | Why it matters |
|---|---|
| **No browser tests** | Rendering is verified by fetching routes and asserting on the HTML. Real interaction — clicking through a grading scorecard, a checkout, a live-scoring flow — has not been driven by a browser. |
| **No visual regression** | A CSS change can silently break a layout. Earlier work found a 143px overflow on `/about` that screenshots had mis-attributed. |
| **No load testing** | Every suite runs against tens of rows. Query performance at federation scale — 10,000 members, 200 events — is unmeasured. |
| **No accessibility automation** | Specific issues fixed by hand; no axe pass, no screen-reader testing. |
| **No mutation testing** | Coverage says lines ran, not that assertions would catch a change. |
| **Payment provider not integration-tested** | Signature verification is tested against real HMACs, but no call has been made to Razorpay's sandbox — no merchant account exists. |
| **YouTube integration not integration-tested** | Same reason: no OAuth credentials. Token encryption and idempotency are tested; the API calls are not. |

---

## 8. Coverage is not the measure

Line coverage is not tracked, deliberately. It rewards exercising code, not asserting behaviour, and
a module can reach 100% while proving nothing.

What is tracked instead:

1. **Every P0 and P1 defect ever found has a regression test.** See `AUDIT-REGISTER.md`.
2. **Every attack in the adversarial suites is a real attack** that was written to succeed.
3. **Every configurable rule has an unset-path test.**
4. **Every public projection has a "does not leak" test** naming the fields it must never carry.
