# Coaches

Application, screening, approval, assignment, calendar.

---

## Two rules shape this whole domain

### 1. The engine recommends; a person decides

`rankCandidates()` scores who is eligible and why. `recommendCoaches()` writes
the top eligible candidates as `recommended` — and stops.

Only `confirmAssignment()`, which takes a principal and writes an audit row, can
reach `confirmed`. It **re-checks availability at that moment** rather than
trusting a shortlist that may be hours or days old. A confirmation that trusts a
stale list is how two schools are promised the same person on the same morning.

This is not timidity. An assignment is somebody's Saturday, their travel and
their income. PART W: *do not create unfair automated employment decisions.*

### 2. An absent clearance is not a clearance

`safeguardingClearedOn` is nullable, and **NULL means NOT CLEARED**. A coach with
no recorded child-protection clearance is *excluded* from any programme involving
minors — not warned about, excluded. A lapsed clearance is treated the same way.

The alternative reading — "we have no record, so it is probably fine" — is how
the wrong person ends up in a room with children.

---

## The lifecycle

```
candidate → screening → interview → technical_review → document_check
          → approved → active → (suspended | inactive)

withdrawn / rejected reachable from any live stage; both terminal
```

**Stages cannot be skipped.** `candidate → approved` is refused. The recorded
stages exist so that an approval means the stages before it actually happened.

**Backward steps are allowed where they are real** — an interview that raises a
technical doubt sends the candidate back to technical review — because pretending
recruitment is a straight line means recording an outcome that did not happen.

**A rejection needs a reason.** Refused without one. The candidate may ask, and
"no reason recorded" is not an answer the federation should have to give.

`coach_stage_events` is **append-only**. A rejection that can be edited
afterwards is a record of the current opinion, not of the decision taken.

### Activation is separate from approval

`activateCoach()` requires an existing `personId`. The coach must already be in
the federation's register of people; creating one here from the application would
let the recruitment queue write into the member register — which is the exact
separation that keeps applicants out of it.

---

## Applying

`applyAsCoach()` is public and unauthenticated. It creates a **candidate record
and nothing else**: no person record, no role binding, no coach profile. Those
are consequences of being approved.

An open application from the same email is **returned, not duplicated**. Somebody
who submits twice because the first page did not obviously succeed should not
become two candidates in the pipeline.

Refused with no email and no telephone — otherwise MMAKF cannot tell them the
outcome.

---

## The assignment engine

### Hard filters (produce `eligible: false` with a stated reason)

- a conflicting booking, session or unavailability block
- no safeguarding clearance, or a lapsed one, where the programme involves minors
- Dan grade below a stated minimum, or none recorded
- a required language not spoken
- already at their own stated weekly session limit

### Soft scoring (produces `reasons`, each with its contribution)

```
based in the same district (+25) · same city (+10) · speaks hindi (+10)
cleared for this programme (+15) · 3 sessions of headroom that week (+6)
```

**Ineligible candidates are returned, not dropped.** An administrator asking "why
isn't Vikas on this list?" deserves an answer, and a silently shorter list does
not give one. They are returned for display and **never written as
recommendations** — suggesting an uncleared coach for a children's programme is
not a suggestion the federation should make even with a caveat attached.

---

## Collision detection

Overlap is `startsAt < otherEnd AND endsAt > otherStart` — **half-open**. A
session ending at 17:00 does not collide with one starting at 17:00.

Closed intervals would make every back-to-back school timetable unbookable, which
is the shape most institutional work actually takes.

Checked against: `bookings` (proposed, confirmed, rescheduled),
`program_sessions` (scheduled, rescheduled), and `coach_availability` of kind
`unavailable`, `leave` or `travel`. Kinds `available` and `tentative` are not
conflicts — they are the opposite.

`venueConflicts()` does the same for a room, including `venue_blackouts`.

---

## Privacy

> PART AC: "Coach A cannot access Coach B's private calendar."

`coachCalendar()` refuses unless the caller **is** that coach (resolved through
`users.personId`) or holds `coach:read`.

Even then, the `reason` on an availability block is **never returned** to anybody
but the coach themselves. A manager needing to know somebody is away does not
need to know it is a funeral. The block renders as `leave`, `travel` or
`unavailable` and nothing more.

`setAvailability()` refuses to mark a coach unavailable over a commitment already
made. The booking has a school expecting somebody, and the right action is to
cancel or reassign it — not to make the diary disagree with the commitment.

---

## Performance

`coach_performance` stores **counts and rates**: sessions scheduled, sessions
delivered, attendance, feedback count.

There is deliberately **no `overall_score` column**. The moment one exists,
something will sort by it and someone will be dismissed by a number nobody can
explain.

---

## Documents

`coach_documents.confidential` defaults to **true**. `coachApplicationDetail()`
returns the fact that a document exists and was verified to anyone with
`coach:read`; only `hr:read` sees the storage key. Résumés and identity papers
are HR data, and PART X says HR data must not reach ordinary administrators.

---

## Tables

`coach_profiles`, `coach_applications`, `coach_stage_events`,
`coach_qualifications`, `coach_documents`, `coach_assignments`, `coach_cpd`,
`coach_performance` — all added in `0011`.

Reused: `coachAvailability` and `bookings` from `engagement.schema.ts`,
`persons` and `users` from `schema.ts`.

---

## Not yet built

The coach application **form**. `applyAsCoach()` and
`applyAsCoachWithAutomation()` exist, are tested, and create the candidate,
the screening task and the acknowledgement — but nothing on the learn surface
calls them yet. See [IMPLEMENTATION-STATUS.md](../IMPLEMENTATION-STATUS.md).
