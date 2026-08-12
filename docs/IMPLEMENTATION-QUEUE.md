# IMPLEMENTATION-QUEUE

**Always execute the highest-priority unblocked task.** If a dependency is missing, build the
dependency first — never build temporary fake infrastructure to make a screen render.

Priority: **P0** blocks other work or is an integrity defect · **P1** core federation capability ·
**P2** operational depth · **P3** polish.

Last updated 2026-08-12.

---

## Blocked on MMAKF — do NOT work around by inventing content

| ID | Needs | Blocks |
|---|---|---|
| BLK-1 | **`DATABASE_URL`** in Vercel | Every subsystem with a system of record. **Highest-value single action in the project.** |
| BLK-2 | Merchant account (needs registration certificate, PAN, bank) | FIN-003, real fee collection |
| BLK-3 | Grading syllabus content | GRD-005, CERT-001, and therefore MEM-005 |
| BLK-4 | Constitution, bye-laws, policies | GOV-002 publication |
| BLK-5 | YouTube OAuth client + channel consent | LIVE-002 |
| BLK-6 | Photograph of Sensei Vikas Pathak | His news item carries no image, deliberately |
| BLK-7 | Sensei Sumitra's name and grade | Three sources disagree |
| BLK-8 | Claims decisions — WKF standing, Limca/Guinness | `CLAIMS-AUDIT.md` §1, §4 |

**Everything below is buildable without them.** Schema and workflow get built; content stays empty
and says so.

---

## Now

| ID | P | Task | Depends on | Status |
|---|---|---|---|---|
| Q-01 | **P0** | Review and integrate the six agent-built surfaces; apply their shared-file edits | — | IN PROGRESS |
| Q-02 | **P0** | Grading workflow backend: application → eligibility → panel → scorecard → approval → certificate | GRD-001..004 (schema done) | NOT_STARTED |
| Q-03 | **P0** | Certificate issuance + QR + public verification, replacing the hand-typed register | Q-02 | NOT_STARTED |
| Q-04 | **P0** | Migrate `/api/verify` off the 7-row Redis list onto real certificate records | Q-03 | NOT_STARTED |

`MEM-005` — the public member register — is the most serious remaining integrity defect: the
credential-verification service a parent is told to trust can only confirm seven hand-typed people.
It cannot be fixed by editing the list. It is fixed by Q-02 → Q-04, because a credential is only
trustworthy if it came from an examination.

## Next

| ID | P | Task | Depends on |
|---|---|---|---|
| Q-05 | P1 | Domain event publisher + consumer cursor (`domain_events` exists, nothing writes to it) | — |
| Q-06 | P1 | Competition backend: event creation, sanction, categories, entries with eligibility | CMP-001..003 |
| Q-07 | P1 | Draw engine — reproducible from `randomSeed` + `seedInput`, with a test proving reproducibility | Q-06 |
| Q-08 | P1 | Live scoring + match event log + result locking | Q-07 |
| Q-09 | P1 | Ranking calculation with per-athlete `contributions`, and a page that explains a position | Q-08, RANK-001 |
| Q-10 | P1 | Affiliation lifecycle: application → documents → review → charter → renewal → lapse | ORG-001 |
| Q-11 | P1 | Athlete registry + public profile + Athlete Passport | MEM-001, Q-03, Q-08 |
| Q-12 | P1 | Officials registries + CPD + appointment with licence check | MEM-003 |

## Then

| ID | P | Task | Depends on |
|---|---|---|---|
| Q-13 | P2 | YouTube broadcast poller — idempotent, never duplicates a broadcast | BLK-5 |
| Q-14 | P2 | Live classroom: attendance policy, Q&A, resources, recording association | Q-13 |
| Q-15 | P2 | Academy LMS surfaces: course player, progress, quizzes, certificates | EDU-001..003 |
| Q-16 | P2 | Governance surfaces: committees, documents with versions, meetings, resolutions | GOV-001..003 |
| Q-17 | P2 | Safeguarding + medical + disciplinary consoles, access-controlled | SAFE-001, MED-003, DISC-001 |
| Q-18 | P2 | National command centre | Most of the above |
| Q-19 | P2 | State / district / dojo dashboards, scope-enforced | Q-10 |
| Q-20 | P2 | Global search respecting permissions | — |
| Q-21 | P2 | Notification engine + a transport (none is configured today) | Q-05 |
| Q-22 | P2 | Annual report generated from real data only | Analytics |
| Q-23 | P2 | Documented public API with versioning and error contracts | Q-05 |
| Q-24 | P2 | Real-time transport for live scores and live classes | Q-08, Q-14 |

## Hardening

| ID | P | Task |
|---|---|---|
| Q-25 | P1 | **Two-person control** on revocation, Dan approval, result correction, financial settlement |
| Q-26 | P1 | **Backups, restore drill, documented RPO/RTO** — none exist |
| Q-27 | P2 | MFA for national-scope accounts |
| Q-28 | P2 | Full WCAG 2.2 AA audit |
| Q-29 | P2 | Observability: structured logs, error tracking, uptime alerting |
| Q-30 | P2 | Upload subsystem with content-type and malware validation (documents, photos, certificates) |
| Q-31 | P3 | Low-bandwidth build for Android and low-end devices |

## Deliberately last

| ID | Task | Why |
|---|---|---|
| Q-32 | AI federation assistant | Must sit on authoritative data. Building it first would mean an assistant confidently answering from invented records — the exact failure mode this project forbids. It must cite the underlying record, distinguish official curriculum from AI explanation, and must never award grades, change results or rankings, select teams, or decide cases. |
| Q-33 | Computer-vision kata analysis | Architected for, not built. Experimental AI must never become the official judge without formal validation and human oversight. |

---

## Working rules

1. **Dependency order, not visual popularity.** A dashboard over an empty table is a lie with a
   chart on it.
2. **Every task ends with a test**, and the test must fail before the fix.
3. **Every task updates `IMPLEMENTATION-STATUS.md`.** A subsystem is not done because a route exists.
4. **Never claim production success without verifying against production.**
5. **Read `PROJECT-CONTEXT.md` first** if you have no memory of this project. It is the entry point;
   chat history is not the source of truth.
