# Institutional training

How a school, company, university, government body or community organisation
becomes an MMAKF client, and what the system does on the federation's behalf
while that happens.

---

## The one idea

> "DO NOT REQUIRE AN ADMINISTRATOR TO MANUALLY COPY DATA BETWEEN SYSTEMS."

An institution fills in one form. Everything downstream is **derived** from that
submission, never re-typed:

```
        the wizard                       derived automatically
  ┌────────────────────┐        ┌──────────────────────────────────┐
  │ 20 steps           │───────▶│ institution_applications         │  stored first
  │ saves as you go    │        │ institutions        (engagement) │
  │ works without JS   │        │ leads               (engagement) │
  └────────────────────┘        │ training_requests   (engagement) │
                                │ owner  ← routing_rules           │
                                │ tasks               (a review)   │
                                │ application_events  (a timeline) │
                                │ notifications       (an ack)     │
                                └──────────────────────────────────┘
```

The administrator's first sight of an application is a task in their queue with
all of the above already in place.

---

## Ordering, and why it is what it is

`submitApplication()` stores the application **first**, before any derived
record. If institution creation then fails, the school's submission is still on
file with its payload intact and can be completed by hand.

The opposite order — institution first, application last — loses the submission
and leaves a half-built institution behind.

The records that follow (institution, lead, request, owner) are created
**synchronously**, because an application without a lead is invisible to the
pipeline. Everything after that (tasks, acknowledgement, notifications) runs
through the workflow engine, because those are the parts that can fail and be
retried without the application being wrong.

---

## The twenty steps

Defined once, in `WIZARD_STEPS` (`src/db/applications.ts`). The wizard UI renders
from it, the server validates against it, the progress bar counts it.

Three copies of "which fields are on step 4" is three chances for the form to
accept something the server rejects — which the applicant experiences as the
form losing their work.

**Only four things are mandatory**: institution name, type, city/state, the
requirement, and a contact. An enquiry blocked on a field the enquirer cannot
answer is an enquiry the federation never receives.

### Resuming

A draft is held in the database, not the browser. Resuming needs the reference
**and** the access token — a 24-byte random value issued when the draft is
started.

Not "reference plus contact email": references are sequence-allocated
(`MMAKF-APP-2026-000001`, then `000002`) and a school's contact address is
usually printed on its own website. Both halves of that pair are guessable, and
what they unlock is the school's own submission including named contacts.

---

## Routing

`routing_rules` is a table, not a function, because the answer changes when staff
change — and re-deploying the site to move Jharkhand school enquiries to a
different manager is not an operational model.

**Most specific wins.** Specificity is the number of conditions a rule actually
states. A rule naming audience *and* district beats one naming audience alone,
whatever their priorities. Priority breaks ties between rules of equal
specificity; lowest id breaks ties after that. The outcome does not depend on row
order.

**No match is not an error and not a guess.** The application stays unowned and
appears in the unassigned queue. Assigning it to an arbitrary administrator would
look like routing while producing work nobody agreed to do.

**An unstated condition constrains nothing, and an unknown value matches
nothing.** A rule for cohorts of 100+ does not match an enquiry that never stated
a size — unknown is not "at least 100".

---

## Lead scoring

`scoreApplication()` orders a queue. It does not decide whether the federation
works with an institution, and nothing in the codebase lets it: the score is
stored beside the application and read by the sort, never by a gate.

Every component is returned in `reasons`, each carrying its own contribution:

```
180 participants (+30) · 3 campuses (+9) · 24-week commitment (+15)
the approver is named (+10) · detailed requirements (+10)
```

A score nobody can explain is a score nobody should act on. The reachable
maximum is 95 — asserted in the tests, so adding a component moves that number
visibly instead of hiding under the cap.

---

## Duplicates

Same institution name, same city, still live → **reported, never merged**.

A trust with several campuses legitimately applies more than once, and silently
folding two applications together loses one school's requirements. The reviewer
decides.

---

## What the applicant sees

`applicantStatus()` returns only timeline entries marked `visibleToApplicant`.
No routing, no lead score, no internal notes, no owner identity.

`applicationDetail()` — the staff view — strips the access token before
returning. An administrator has no reason to hold it, and a value nobody needs is
a value that leaks from a screenshot.

---

## What is deliberately absent

| Absent | Why |
|---|---|
| Any turnaround promise | MMAKF has published no service standard. `slaDueAt` is NULL, task deadlines are NULL, and a test asserts no message template contains "within N hours". |
| Any fee | The framework prices a configuration and currently holds no published rules. Every path ends at REQUEST A QUOTATION. |
| Outcome claims on audience pages | No "trusted by N schools", no wellbeing statistics. PART D: no medical or psychological claims without evidence. |
| A programme catalogue presented as available | `program_templates` has `draft → under_review → approved → published → archived`. Nothing unpublished is advertised. |

---

## Tables

Added in `0011_operations_platform.sql`:

- `institution_applications` — the submission, with both parsed columns *and*
  the raw payload. Columns are what the federation queries; the payload is what
  the school actually said, and the only thing that can settle a later
  disagreement.
- `application_events` — the timeline. One table with a `visibleToApplicant`
  flag rather than two, so it cannot disagree with itself.
- `routing_rules`
- `program_templates`
- `contracts`, `client_documents`, `institution_users`
- `program_sessions`, `program_attendance`

Reused, not duplicated: `institutions`, `institutionContacts`, `leads`,
`leadActivities`, `trainingRequests`, `quotes`, `proposals`, `trainingPrograms`,
`bookings` — all already existed in `engagement.schema.ts`.

---

## Related

- [automation.md](automation.md) — the workflow engine that runs the follow-up
- [coaches.md](coaches.md) — how a programme gets an instructor
- `src/db/applications.ts`, `src/db/automations.ts`
- `tests/operations.test.ts`
