# Notifications

§T / §47 / §48. `src/lib/notifications.ts` is the engine; `src/lib/push.ts` is
the push channel; `src/db/automations.ts` writes to the same table from the
other direction.

**Read this first:** nothing is delivered outside the application today. No
email provider, no SMS provider and no VAPID keys are configured, and there is
no user-facing surface for notifications or push. Everything below describes
machinery that runs, is tested, and currently queues. §7 of this document is
the honest accounting.

---

## The rule that shapes it: do not spam

A federation that emails a member about every event in the system trains them to
ignore it, and the one message that mattered — a grading result, a safeguarding
acknowledgement, a membership about to lapse — arrives in a stream they stopped
reading months ago.

So every notification is derived from a domain event that **already happened**,
deduplicated, and suppressed where the recipient has said no. Nothing here
invents a reason to contact someone.

---

## The allow-list

`NOTIFIABLE` in `src/lib/notifications.ts`. A domain event not listed here
produces nothing. An allow-list is the only version of this that stays quiet by
default.

| Event | Audience | Essential |
|---|---|---|
| `GRADING_APPROVED` | subject | yes |
| `CERTIFICATE_ISSUED` | subject | yes |
| `CERTIFICATE_REVOKED` | subject | yes |
| `MEMBERSHIP_EXPIRING` | subject | yes |
| `ENTRY_CONFIRMED` | subject | yes |
| `AFFILIATION_EXPIRING` | unit | yes |
| `CASE_ACKNOWLEDGED` | subject | yes |
| `APPROVAL_REQUESTED` | approvers | yes |
| `RESULT_FINALIZED` | subject | no |
| `DRAW_PUBLISHED` | entrants | no |
| `RANKING_UPDATED` | subject | no |
| `LIVE_STARTED` | enrolled | no |

**Essential messages cannot be unsubscribed from, by anything.** A grading
result, a certificate revocation and a safeguarding acknowledgement are
consequences of the federation's own decisions *about that person* — allowing an
opt-out would let somebody opt out of being told their credential was withdrawn.

`src/lib/push.ts` reads this list rather than restating it. A second copy would
disagree with the first the day somebody adds a topic, and the disagreement
would show up as a member not being told their certificate was withdrawn.

### Recipients are resolved from the event, never from the caller

`notifyForEvent()` takes no recipient list. Audiences resolve against the
database:

- **subject** — the person the event is about
- **entrants** — everyone with a `confirmed`, `checked_in` or `weighed_in` entry
  in the category
- **enrolled** — everyone with an `active` enrolment on the course
- **approvers** — `SUPER_ADMIN`, `FEDERATION_ADMIN` and `PRESIDENT` role
  bindings, **with the requester excluded** (they cannot approve their own
  request, so telling them one is waiting is noise)
- **unit** — the affiliated unit

A fan-out that accepted a recipient list is a mail-merge waiting to be pointed
at the whole membership.

---

## Transports, and telling the truth about them

`transportStatus()` reports each channel and the reason for its state:

| Channel | Configured when | Today |
|---|---|---|
| `in_app` | always | Works. The row **is** the notification. |
| `email` | `EMAIL_PROVIDER_URL` **and** `EMAIL_FROM` are set | Not configured |
| `sms` | `SMS_PROVIDER_URL` is set | Not configured |

Delivery is a thin HTTP POST rather than a vendor SDK, so the federation can
change provider without changing the file, and no dependency is taken on for
something this simple.

**The recipient address is resolved inside `sendVia()`, from the person record,
and is never passed in** — so a caller cannot redirect a notification to an
address of its choosing.

`deliverQueued()` has three outcomes, and the middle one is the point:

| Outcome | Meaning |
|---|---|
| `sent` | A transport accepted it. |
| `queued_no_transport` | No provider configured. **It stays queued, visibly.** |
| `failed` | A provider rejected it, with the reason recorded on the row. |

A message with no transport is not marked failed and not discarded. It waits,
the report says how many are waiting, and a `log.warn` fires — so configuring a
provider later delivers the backlog rather than losing it. A notification that
was never delivered and never recorded as undelivered is worse than one that
failed loudly.

`queueHealth()` is the operator's view. `oldestQueued` is the number that
matters: a backlog with nothing older than a few minutes is a working system,
and one holding a message from three weeks ago is a provider nobody configured.

---

## One table, two writers, two dedupe mechanisms

`notifications` (defined in `src/db/governance.schema.ts`, re-exported through
`src/db/schema.ts`) is written by two paths, and they deduplicate differently.
This is worth knowing before adding a third.

| Writer | Path | Deduplicated by |
|---|---|---|
| `queue()` in `lib/notifications.ts` | the domain-event fan-out | a **lookup** on `(domain_event_id, person_id, channel)` |
| `send_message` in `db/automations.ts` | a workflow step | the **unique index** on `dedupe_key` |

The lookup is not a unique index because a person may legitimately receive the
same event on two channels. The workflow path can use a constraint because its
key is derived from the run and the step, so the second attempt of step 3
computes the same key as the first and the insert is refused. A unique violation
there is the *success* case for a retry.

Both write `status: 'queued'`. **Only a transport that actually delivered may
write `sent`.**

The automation path also carries `recipient_email` / `recipient_name` for
someone with no account at all — a school principal who filled in the
application wizard is not a member, has no person record, and is exactly who the
acknowledgement is for.

---

## Reads

`myNotifications()` and `markRead()` **take no id**. They read the caller's own,
resolved from their user record. That is the structural way to make reading
somebody else's impossible, rather than a check that must be remembered.

---

## Push (§48)

`src/lib/push.ts` implements Web Push properly: RFC 8291 `aes128gcm` payload
encryption, RFC 8292 VAPID signing, and verification for both. It is a
**channel under the rules `notifications.ts` already sets**, not a parallel
system.

### Preferences and suppression

`PushOutcome` is `queued | sent | failed | expired | suppressed_quiet_hours |
suppressed_preference | suppressed_duplicate`. The three suppressions are
recorded as `neutral` in the status dictionary, not as failures: the system
honoured a preference or a quiet hour, which is the behaviour that was asked
for.

`DEFAULT_CHANNEL_PUSH = false`, matching the column default in
`drizzle/0007_engagement_and_fees.sql`, and `tests/push.test.ts` asserts the
constant still agrees with the DDL. The consequence is deliberate: **granting a
browser permission subscribes the device, it does not opt the member into every
topic.** Essential topics are never subject to a preference at all.

### Quiet hours

`inQuietHours()` returns `true`, `false`, or **`null` meaning undeterminable** —
no window set, or no timezone known — and every caller treats `null` as "do not
suppress".

Evaluating quiet hours in the *server's* timezone would be worse than not
evaluating them at all: it would silence a message at two in the afternoon and
deliver one at three in the morning, which is precisely the failure quiet hours
exist to prevent. So the window is evaluated in the member's own IANA zone,
reported by the browser at subscribe time.

The window is inclusive of `from`, exclusive of `to`, and wraps midnight,
because 22:00–07:00 is the window somebody actually wants. `from === to` is
**not** a 24-hour silence — it is no window at all. Reading it the other way
would mute a member permanently through a single mis-set field.

### The diagnostic topic

`PUSH_TEST` bypasses the preference check and quiet hours, because the member
asked for it in that second: a test push that is silently suppressed looks
exactly like a broken one, and the member turns the feature off. It cannot be
addressed to anyone else — `sendTestToSelf()` resolves the recipient from the
caller's own session.

---

## What runs on a schedule

One cron: `/api/cron/reconcile`, daily at 03:00 (`vercel.json`), authorised by
`CRON_SECRET`. An unset secret means the job **cannot be triggered at all**
rather than being open to anyone.

**Neither `deliverQueued()` nor any push delivery is wired into it.** The cron
runs order expiry, fulfilment retries and `runDailySweeps()` (workflow retries,
task escalation, ticket escalation). Queued notifications are not swept, because
no transport is configured for them to be swept to. Wiring that up is a line in
`reconcile.ts` on the day a provider exists — see §7.

---

## What is not built

This is the part that matters, and it is larger than what is.

1. **No user-facing notification surface exists.** There is no bell, no
   notification centre, no `/my/notifications` page. `myNotifications()`,
   `markRead()` and `queueHealth()` have **no caller anywhere in `src/pages`**.
   A member cannot read an in-app notification today, which means `in_app`
   being "always available" is true of the transport and not of the experience.

2. **`src/lib/push.ts` is imported by nothing.** 1,386 lines of tested crypto
   and delivery logic with zero callers: no API route to subscribe from, no
   settings page, no VAPID keys, and no `push` event handler in `public/sw.js`
   — the service worker handles caching only. `VAPID_PUBLIC_KEY` and
   `VAPID_PRIVATE_KEY` appear nowhere outside this one file. It is a complete
   engine that has never run outside its tests.

3. **`notifyForEvent()` has no consumer.** The domain-event feed is not being
   walked by anything that calls it, so the allow-list above describes what
   *would* be sent. `send_message` inside a workflow is the only path that
   currently puts a row in the table on a real request.

4. **No email or SMS provider is configured**, so `deliverQueued()` would report
   everything as `queued_no_transport`. This is registered in
   [PENDING-FEDERATION-VERIFICATION.md](../PENDING-FEDERATION-VERIFICATION.md) §4.

5. **No batching or digest.** §47 anticipates batching where batching is honest;
   the code deduplicates but does not group. Ten results published in a minute
   would queue ten rows.

6. **No delivery-failure escalation.** A `failed` row records its reason and is
   never retried. There is no backoff and no dead-letter handling, unlike the
   workflow engine, which has both.

7. **No per-member email/SMS preferences.** Preferences exist for push topics
   only. The email and SMS channels have an allow-list and an essential flag and
   nothing else.

8. **Quiet hours apply to push only.** Nothing else consults them.

---

## Related

- [automation.md](automation.md) — `send_message`, and the retry model
  notifications does not have
- [status-model.md](status-model.md) — why the suppressions are `neutral`
- [../PENDING-FEDERATION-VERIFICATION.md](../PENDING-FEDERATION-VERIFICATION.md) §4 — the provider credentials this waits on
