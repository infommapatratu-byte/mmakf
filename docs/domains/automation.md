# The automation engine

§AF / §R. `src/lib/workflow.ts` is the engine. `src/db/automations.ts` binds it
to the domain. `/admin/workflows` is how the federation reads it without opening
TypeScript.

---

## The problem it solves

A school submits the application wizard. Twelve things must then happen. Written
inline at the end of the submit handler, those twelve have three problems that
only appear in production:

1. **The eighth one fails.** The first seven already happened — including an
   email now sitting in somebody's inbox — so there is nothing to roll back to,
   and nothing records how far it got.
2. **The applicant double-clicks Submit,** or a retry fires, and the school gets
   two institutions, two leads and two acknowledgement emails.
3. **Nobody can answer "what did the system do on our behalf?"** without reading
   TypeScript.

So automations are **runs** with **steps**. Each step's outcome is recorded
whether it worked or not, the run carries an idempotency key the database
enforces, and a failed run resumes from the first step that has not yet
succeeded rather than starting over.

---

## The engine imports no domain logic

`src/lib/workflow.ts` takes its action registry as a parameter.
`src/db/automations.ts` builds the registry from the domain modules and
re-exports a bound `dispatch`.

That is what stops the cycle: `applications.ts` needs the engine, and the
engine's actions need `applications.ts`. It also means the engine is testable
against a registry of stubs, with no database schema in the way.

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
worker is already executing cannot be picked up twice. `claimRun()` returns a
`skipReason` instead of running when it declines:

| `skipReason` | Meaning |
|---|---|
| `already_succeeded` | This exact work is done. |
| `in_progress` | Another worker holds it. |
| `attempts_exhausted` | `attempt >= maxAttempts`. |
| `no_definition` | Nothing registered for this trigger. |

Step keys are derived from the run and the step, so the **second attempt of step
3 computes the same key as the first** and its insert is refused rather than
duplicated. Without that, the retry that exists to finish a half-done automation
would double everything the automation had already done. In `send_message`, a
unique violation is caught and returned as `{ deduplicated: true }` — for a
retry that is the success case, not a failure.

---

## Resuming, not restarting

A failed run records every step's outcome. On retry:

- steps already `succeeded` or `skipped` are not re-run and are reported as
  `already_done`;
- `state` is rebuilt from the recorded results of the succeeded steps, so a
  resume sees exactly what the first attempt saw;
- the first unfinished step runs;
- steps after a failure are recorded as `blocked` rather than left with no row,
  which is what makes the resume point unambiguous.

`state` is keyed by action name. That is how step 3 uses the institution step 1
created without either step knowing about the other. The trigger payload
(`context`) is never mutated by a step.

### The six step statuses

`succeeded` · `skipped` (its condition did not hold) · `already_done` (a prior
attempt did it) · `blocked` (an earlier step failed) · `failed` ·
`failed_optional`.

### The four run statuses

| Status | When |
|---|---|
| `succeeded` | Nothing non-optional failed. |
| `partially_failed` | Something failed **and** something else succeeded. |
| `failed` | It failed having achieved nothing. |
| `skipped` | It never ran — see `skipReason`. |

**`partially_failed` is the one that matters.** It says *some effects did
happen* — an institution exists, an email went out — which is exactly what an
operator needs before deciding whether to re-run or to finish by hand. The
status dictionary carries that warning in words:
*"SOME EFFECTS ALREADY HAPPENED. Check what completed before re-running."*

---

## Failing closed, loudly

| Situation | What happens | Why |
|---|---|---|
| Action name not in the registry | Step **fails** | A workflow that skips the step nobody implemented reports success while doing nothing. |
| Unrecognised condition operator | Step **fails** (throws) | A typo in a condition would otherwise silently disable the step it guards — the school is never acknowledged and nothing says why. |
| Condition path missing from context | Ordered comparisons return **false** | A missing participant count is not "less than 50". Unknown must not match. |
| A step marked `optional` fails | Run continues, failure **still recorded** as `failed_optional` | "Optional" means the run continues, not that nobody is told. |
| Definition deleted under a failed run | Run marked `failed`, `nextAttemptAt` cleared | Retrying is impossible; pretending otherwise leaves it in the queue for ever. |

### Conditions

`when` accepts `{ all: [...] }`, `{ any: [...] }`, `{ not: ... }`, or a leaf of
`{ path, op, value? }`. The twelve operators are `eq`, `ne`, `gt`, `gte`, `lt`,
`lte`, `in`, `nin`, `present`, `absent`, `truthy`, `falsy`.

The asymmetry is deliberate. A **malformed** condition throws, because it is a
programming error that must surface. A **missing value** in an ordered
comparison returns false, because unknown is not "less than". Both `gt` and
`lt` require both sides to be numbers.

---

## Workflows are data; actions are code

`workflow_definitions` is a table, so the federation can see and disable an
automation without a deployment.

The **actions** a step may call are a TypeScript registry, because an action
definable through the admin console would be a remote code execution feature
with a nice form around it.

A changed definition becomes a **new version** rather than editing the existing
row, so a run that failed under v1 is retried under v1 and the history says
which shape of the automation actually ran. Same reasoning as published fee
frameworks and superseded rank records.

`dispatch()` runs **only the highest active version of each code**. Two versions
of the same automation both firing would double every effect it has. The
idempotency key is suffixed per workflow and version
(`${key}:${code}:${version}`), so two automations on the same event do not
collide on one key — which would silently run only the first.

A trigger with no definition returns `[]` and is **not** an error: the
federation may legitimately have switched an automation off, and the submit
handler that fired the trigger has no opinion about whether one exists.

---

## The registry

| Action | Does | Idempotent by |
|---|---|---|
| `record_timeline` | Appends to an application's timeline | — (append-only) |
| `create_task` | Work for a human | `tasks.idempotency_key` |
| `send_message` | Renders a template, **queues** it | `notifications.dedupe_key` |
| `notify_role` | Tells everyone holding a role, resolved live from `role_bindings` | key per role + user |
| `record_event` | Appends to the federation event feed | correlation id |
| `set_application_status` | Moves an application | idempotent by nature |
| `recommend_coaches` | Shortlists — **never appoints** | existing-assignment check |

`send_message` renders through `src/lib/email-templates.ts` and writes a
`queued` row. It does not send: there is no email transport in this project. A
missing template value is an error, not "Dear ,". See
[notifications.md](notifications.md).

`notify_role` with nobody in the role produces **no notifications and says so**
in the result. Silently succeeding would mean the federation believes an
administrator was told when nobody was.

---

## The workflows

Three intake automations, installed by `installWorkflow()`:

- `INSTITUTION_APPLICATION_INTAKE` — record → acknowledge → timeline → review
  task → acknowledgement message → notify the owning role
- `COACH_APPLICATION_INTAKE` — record → screening task → acknowledgement
- `PROGRAMME_COACH_SHORTLIST` — shortlist eligible coaches → task for a manager
  to confirm one

Four task templates back them: `REVIEW_INSTITUTION_APPLICATION`,
`SCREEN_COACH_APPLICATION`, `CONFIRM_COACH_ASSIGNMENT`, `ANSWER_SUPPORT_TICKET`.

**Every template's `due_in_hours` is NULL**, because MMAKF has not supplied a
service standard. Nothing is ever late and nothing escalates on time — see
[PENDING-FEDERATION-VERIFICATION.md](../PENDING-FEDERATION-VERIFICATION.md) §1.2.
`escalateOverdueTasks()` runs daily and correctly finds nothing.

---

## Retries

`backoffMs(attempt)` is 1 minute, then 5, then 25, capped at an hour
(`min(60, 5^(attempt-1))` minutes). Deliberately not seconds: everything retried
here is either a database write that failed because something was briefly
unavailable, or a notification to a human — and a human does not benefit from
being emailed four seconds sooner.

`sweepRetries()` selects runs that are `failed` or `partially_failed`, have
attempts remaining, and whose `nextAttemptAt` has elapsed. It re-reads the
**definition**, not the run's stored spec, so a workflow corrected after a
failure is retried in its corrected form. That is the point of retrying at all —
the usual reason a step failed is that something was wrong and was then fixed.
Batched at 50 per sweep so one run cannot run long.

`runDailySweeps()` runs workflow retries, task escalation and ticket escalation.
Each is independently wrapped: a stuck workflow retry must not stop task
escalation running for a week.

Invoked from `/api/cron/reconcile`, daily at 03:00, authorised by `CRON_SECRET`.
An unset secret means the job cannot be triggered at all, rather than being open
to anyone — an unset variable must never mean "allow".

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

---

## What is not built

- **Nothing runs sub-daily.** The retry sweep is on the daily cron, so a step
  that fails at 03:05 waits until the next day regardless of what `backoffMs`
  computed. The backoff is a floor, not a schedule, and on the Hobby plan it is
  effectively always 24 hours.
- **There is no queue and no worker.** A run executes inline, in the request
  that triggered it. A slow action makes a form submission slow.
- **Steps are not transactional across the run.** Each step commits its own
  effects. That is what makes `partially_failed` a real state rather than an
  impossible one, and it is why re-running is an operator's judgement.
- **`/admin/workflows` is read-only.** Definitions, runs, steps and failures can
  be read. A run cannot be retried, cancelled or re-run from the screen, and a
  definition cannot be disabled from it — `workflow_definitions.active` is a
  column with no surface that writes it.
- **No dead-letter queue.** A run that exhausts `maxAttempts` stops with
  `nextAttemptAt` cleared and stays in the table. Nothing alerts on it; somebody
  has to look.
- **No timeout on an action.** A handler that hangs hangs the run.
- **Only three workflows exist**, all intake. Nothing automates grading,
  competition, membership renewal or affiliation.
- **`notify_role` reaches roles, not people who asked to be reached.** It has no
  preference check, because [notifications.md](notifications.md) §7 explains
  there is no preference model for anything but push.

---

## Related

- [notifications.md](notifications.md) — where `send_message` lands, and why it stops there
- [status-model.md](status-model.md) — `partially_failed`, and why it is `warn`
- [coaches.md](coaches.md) — `recommend_coaches` and the assignment engine
- `tests/vercel-config.test.ts` — the cron limit, guarded
