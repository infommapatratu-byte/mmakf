# MASTER-SPECIFICATION

**The canonical specification for the MMAKF National Federation Digital Operating System.**

Detailed domain documents may expand this; none may silently contradict it. If a requirement changes,
update this file first.

Start at [`PROJECT-CONTEXT.md`](PROJECT-CONTEXT.md) if you have no memory of this project.

---

## 1. What is being built

A **national sports federation operating system** for MMAKF — Modern Martial Arts Karate-Do
Federation of India, Shotokan karate, national jurisdiction.

Not a website. The site is one surface over a system of record that holds people, credentials,
examinations, competitions, money and governance.

**MMAKF ≠ mixed martial arts.** The confusion wastes research time and produces wrong answers.

### The distinction that decides everything

> **The schema defines STRUCTURE. MMAKF defines CONTENT AND AUTHORITY.**

The grading engine knows what a syllabus *is* — versions, grades, requirements, eligibility rules,
scorecards. It contains **no technique, no minimum interval, no pass mark**. Those are the
federation's, supplied through configuration, versioned, and attributable to whoever approved them.

Every configurable rule is **nullable and unset by default**. An unset rule is **not applied**, and
the result **says so** — never "failed" against a threshold nobody approved.

This is the rule most likely to be broken by an agent trying to be helpful, and the one whose breach
does most damage. An invented grading syllabus is fraud.

---

## 2. Non-negotiable invariants

Every one has been violated at least once and caught by a test.

1. **Never invent MMAKF content.** No fee, rule, statistic, member, office holder, championship,
   date, record or document. Missing information gets a data model and an administrative mechanism,
   and renders as absent.
2. **No fake features.** Never render a control that cannot work. Unavailable capability states the
   reason in the UI.
3. **Version anything that changes meaning.** A 2026 grading keeps the meaning it had in 2026.
4. **Append, never overwrite.** Corrections supersede. Revocation never deletes — a vanished
   credential is indistinguishable from one that never existed.
5. **Derive rather than store.** Current rank, progress, medal counts. A cached total survives a
   correction and then contradicts the register.
6. **Integers only.** Money in paise, weight in grams, kata scores in hundredths.
7. **Fail closed.** Unknown state, missing configuration or unresolvable scope grants nothing.
8. **Everything explainable.** A refusal, a ranking or a draw must be reconstructible from stored
   data. "Trust me" is not an output.
9. **One person, one record.** Roles attach to a person; credentials are separate tables.
10. **Provenance travels with every claim.** `examined` and `unverified_legacy` are different claims
    and are never presented identically.

---

## 3. Architecture

**Astro 5 SSR on Vercel, Node 22.** No React, no client framework.

**Two stores.** Redis for editorial content (no integrity requirements, the office edits it
directly). Postgres for every federation record. One system of record per fact.

**Vendor-neutral database driver** — `postgres.js` over plain TCP. `DATABASE_URL` is the only input.
Never Neon or Vercel Postgres; the federation rejected it.

**Four choke points.** Learn these before changing anything:

| | |
|---|---|
| `identify()` — `src/lib/session.ts` | Request → identity. Nothing else reads a cookie |
| `can()` — `src/lib/rbac.ts` | 16 roles, deny-by-default, scope always checked |
| `writeAudit()` — `src/db/federation.ts` | Actor, old, new, reason, authority |
| `confirmPayment()` — `src/db/orders.ts` | Only a verified capture marks an order paid |

**87 tables, 4 migrations.** Forward-only, checksummed, transactional. Detailed in
[`DATA-ARCHITECTURE.md`](DATA-ARCHITECTURE.md).

---

## 4. Domains

| Domain | Module | State |
|---|---|---|
| Federation hierarchy, people, memberships | `federation.ts` | Built, tested |
| Authentication and authorisation | `users.ts`, `rbac.ts`, `session.ts` | Built, tested |
| Shotokan technical system | `technical.schema.ts` | Schema built; **content is MMAKF's** |
| **Grading and certificates** | `grading.ts` | Built, tested — *the federation's core authority* |
| Competition, draws, matches, results | `competition.ts`, `draws.ts`, `matches.ts` | Built, tested |
| Rankings | `rankings.ts` | Built, tested |
| Athletes and the passport | `athletes.ts` | Built, tested |
| Officials and licensing | `officials.ts` | Built, tested |
| Affiliation lifecycle | `affiliation.ts` | Built, tested |
| Academy and live classroom | `academy.ts` | Built, tested |
| Media, YouTube, live detection | `youtube.ts` | Built; **needs OAuth credentials** |
| Governance | `governance-ops.ts` | Built, tested |
| Safeguarding, medical, disciplinary | `cases.ts` | Built, tested |
| Commerce and finance | `orders.ts`, `payments/` | Built, tested; **needs a merchant account** |
| Two-person control | `approvals.ts` | Built, tested |
| Analytics | `analytics.ts` | Built, tested |
| Search | `search.ts` | Built, tested |
| Domain event feed | `domain-events.ts` | Built, tested |

Per-subsystem state: [`IMPLEMENTATION-STATUS.md`](IMPLEMENTATION-STATUS.md).

---

## 5. The grading chain

The single most important flow, because every credential the federation issues depends on it.

```
AUTHORISED PERSON → ELIGIBILITY → APPLICATION → PANEL → EXAMINATION
  → SCORECARD → DECISION → CERTIFICATE → CREDENTIAL → PUBLIC VERIFICATION
```

**No certificate can exist that is not traceable to an examination.** A pass cannot be recorded
before an examiner has scored. A certificate cannot be issued for anything but a recorded pass. An
ineligible candidate cannot be examined. Locking makes scores immutable.

**Legacy grades are admitted and always disclosed.** Decades of real gradings predate any digital
record, and refusing them would erase the federation's history. They are recorded with no invented
grading event, marked `UNVERIFIED_LEGACY_RECORD`, require a note of the evidence held, and every
verification says so.

---

## 6. Security

Threat model, controls and gaps: [`SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md).

Summary: deny-by-default RBAC with scope enforced in SQL; per-person accounts with roles resolved
live so revocation is immediate; CSRF on every mutating request; classification at row level;
safeguarding separated in the role model, not by a flag.

**Not in place:** MFA, Postgres RLS, malware scanning, encrypted backups, a breach procedure.

---

## 7. Verification standards

- **`VERIFIED` means proven against production**, not "the tests pass".
- **Never claim a production success without checking production.**
- **A test that has never failed proves nothing.** Every security test here was written to succeed as
  an attack first.
- **Status codes do not prove a link works.** `wkf.net` serves a dead PDF as HTTP 200 with
  `image/png`.

```bash
npm test && npx tsc --noEmit && npm run build && npm run db:verify && npm run links:check
```

---

## 8. Blocked on MMAKF

Engineering cannot proceed on these, and must not work around them by inventing content.

| | Blocks |
|---|---|
| **`DATABASE_URL`** | Every system of record. The single highest-value action |
| Merchant account (needs registration certificate, PAN, bank) | Real fee collection |
| Grading syllabus content | Gradings, certificates, the register |
| Constitution, bye-laws, policies | Document publication |
| YouTube OAuth credentials | Live class detection |
| A photograph of Sensei Vikas Pathak | None exists publicly; his item deliberately carries no image |
| Sensei Sumitra's name and grade | Three sources disagree |
| WKF standing, Limca/Guinness | [`CLAIMS-AUDIT.md`](CLAIMS-AUDIT.md) |
| Retention periods, privacy notice, grievance officer | [`PRIVACY.md`](PRIVACY.md) |
| RPO/RTO | [`DISASTER-RECOVERY.md`](DISASTER-RECOVERY.md) |
| Four competition policy questions | Quotas, fee reconciliation, dan-vs-kyu ordering, guest eligibility |

---

## 9. Definition of done

A domain is complete when **all** of these exist — not when a route renders.

```
DATA → BUSINESS LOGIC → AUTHORISATION → API → UI → MOBILE
     → ACCESSIBILITY → AUDIT → TESTS → DOCUMENTATION → ERROR HANDLING → RECOVERY
```

Specifically: every mutation audited; every list scope-filtered in SQL; every configurable rule with
an unset-path test; every public projection with a "does not leak" test; every error path visibly
handled; usable at 360px.

---

## 10. Deliberately last

**AI features.** They must sit on authoritative data. Built first, an assistant would confidently
answer from invented records — the exact failure this specification forbids. It must cite the
underlying record, distinguish official curriculum from AI explanation, and must **never** award
grades, change results or rankings, select teams, or decide cases.

**Computer-vision kata analysis.** Architected for, not built. Experimental AI must never become the
official judge without formal validation and human oversight.
