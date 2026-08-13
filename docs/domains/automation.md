# The automation engine

`src/lib/workflow.ts` — the engine. `src/db/automations.ts` — what it runs.

---

## The problem it solves

A school submits the application wizard. Twelve things must then happen.
Written inline at the end of the submit handler, those twelve have three
problems that only appear in production:

1. **The eighth one fails.** The first seven already happened — including an
   email now sitting in somebody's inbox — so there is nothing to roll back to,
   and nothing records how far it got.
2. **The applicant double-clicks Submit,** or a retry fires, and the school gets
   two institutions, two leads and two acknowledgement emails.
3. **Nobody can answer "what did the system do on our behalf?"** without reading
   TypeScript.

So automations are **runs** with **steps**.

---

## Idempotency is a database constraint, not a hope

```
workflow_runs.idempotency_key   UNIQUE
tasks.idempotency_key           UNIQUE
notifications.dedupe_key        UNIQUE
domain_events                   correlation checked before insert
```

Two workers racing on the same key both attempt the insert; one wins, the loser
falls through to the claim UPDATE. There is no read-then-write window in which
both decide they are first.

The claim itself is an UPDATE guarded on the current status, so a run another
worker is already executing cannot be picked up twice.

Step keys are derived from the run and the step, so the **second attempt of step
3 computes the same key as the first** and its insert is refused rather than
duplicated. Without that, the retry that exists to finish a half-done automation
would double everything the automation had already done.

---

## Resuming, not restarting

A failed run records every step's outcome. On retry:

- steps already `succeeded` are skipped and reported as `already_done`;
- `state` is rebuilt from their recorded results, so a resume sees exactly what
  the first attempt saw;
- the first unfinished step runs;
- steps after a failure are recorded as `blocked` rather than left with no row,
  which is what makes the resume point unambiguous.

`partially_failed` is a distinct status from `failed`. It says **some effects
did happen** — an institution exists, an email went out — which is exactly what
an operator needs before deciding whether to re-run or finish by hand.

---

## Failing closed, loudly

| Situation | What happens | Why |
|---|---|---|
| Action name not in the registry | Step **fails** | A workflow that skips the step nobody implemented reports success while doing nothing. |
| Unrecognised condition operator | Step **fails** | A typo in a condition would otherwise silently disable the step it guards — the school is never acknowledged and nothing says why. |
| Condition path missing from context | Ordered comparisons return **false** | A missing participant count is not "less than 50". Unknown must not match. |
| A step marked `optional` fails | Run continues, failure **still recorded** | "Optional" means the run continues, not that nobody is told. |

---

## Workflows are data; actions are code

`workflow_definitions` is a table, so the federation can see and disable an
automation without a deployment.

The **actions** a step may call are a TypeScript registry, because an action
definable through the admin console would be a remote code execution feature
with a nice form around it.

A changed definition becomes a **new version** rather than editing the existing
row, so a run that failed under v1 is retried under v1 and the history says which
shape of the automation actually ran. Same reasoning as published fee frameworks
and superseded rank records.

---

## The registry

| Action | Does | Idempotent by |
|---|---|---|
| `record_timeline` | Appends to an application's timeline | — (append-only) |
| `create_task` | Work for a human | `tasks.idempotency_key` |
| `send_message` | Renders a template, **queues** it | `notifications.dedupe_key` |
| `notify_role` | Tells everyone holding a role, resolved live from `role_bindings` | key per role+user |
| `record_event` | Appends to the federation event feed | correlation id |
| `set_application_status` | Moves an application | idempotent by nature |
| `recommend_coaches` | Shortlists — **never appoints** | existing-assignment check |

`notify_role` with nobody in the role produces **no notifications and says so**
in the result. Silently succeeding would mean the federation believes an
administrator was told when nobody was.

---

## The workflows

- `INSTITUTION_APPLICATION_INTAKE` — record → acknowledge → timeline → review
  task → acknowledgement email → notify the owning role
- `COACH_APPLICATION_INTAKE` — record → screening task → acknowledgement
- `PROGRAMME_COACH_SHORTLIST` — shortlist eligible coaches → task for a manager
  to confirm one

---

## Retries

Backoff is 1 minute, then 5, then 25, capped at an hour. Deliberately not
seconds: everything retried here is either a database write that failed because
something was briefly unavailable, or a notification to a human — and a human
does not benefit from being emailed four seconds sooner.

`sweepRetries()` re-reads the **definition**, not the run's stored spec, so a
workflow corrected after a failure is retried in its corrected form. That is the
point of retrying at all — the usual reason a step failed is that something was
wrong and was then fixed.

Run daily from `/api/cron/reconcile` alongside task and ticket escalation. Each
sweep is independently guarded: a stuck workflow retry must not stop task
escalation running for a week.

**One cron, not four.** Vercel's Hobby plan allows daily crons only and rejects a
project asking for more *at deployment creation* — leaving no deployment, no
build log and no error anywhere in the dashboard. That cost this project
seventeen hours once. See `tests/vercel-config.test.ts`.

---

## What it will not do

The engine **recommends**; a person decides. `recommend_coaches` writes
candidates as `recommended` with their reasons and stops. Only
`confirmAssignment()` — which takes a principal and writes an audit row — can
reach `confirmed`, and it re-checks availability at that moment rather than
trusting a shortlist that may be days old.

An assignment is somebody's Saturday, their travel and their income. PART W says
it directly: do not create unfair automated employment decisions.
