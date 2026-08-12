# DISASTER-RECOVERY

What breaks, what it costs, and what to do. Written to be read during an incident, so the procedures
come before the reasoning.

**Recovery objectives are stated as what is currently ACHIEVABLE, not as a commitment.** Agreeing an
RPO and RTO is a federation decision — it turns on what MMAKF can tolerate losing — and stating one
engineering cannot meet would be worse than stating none.

---

## 1. Current position, honestly

| | Achievable today | Why |
|---|---|---|
| **RPO** (data loss) | **Up to one week** | Backups are manual and run by hand |
| **RTO** (time to recover) | **1–4 hours** for a database loss | Restore is proven but manual; provisioning a replacement is the long pole |
| **Code recovery** | **Under 5 minutes** | Vercel promotes a previous deployment instantly |
| **Content recovery** | **Immediate, degraded** | Redis loss falls back to seed content; the site stays up with stale copy |

**One week of potential data loss is the weakest number here**, and it is the one to fix first: an
automated daily backup to off-host storage would bring the RPO to 24 hours without further
engineering.

---

## 2. Scenarios, worst first

### 2.1 Database lost or corrupted

**Impact:** every federation record — grades, certificates, competition results, cases. Irreplaceable
if backups are absent.

1. Do **not** attempt repair on the live database. Provision a new one.
2. `npm run db:migrate` against the new instance (a restore loads rows; it does not create schema).
3. `npm run backup -- --verify <file>` — **before** restoring, not after.
4. `npm run backup -- --restore <file>`.
5. Point `DATABASE_URL` at the new instance and redeploy.
6. Verify: `/api/health` reads `"ok"`; `npm run db:status` shows all migrations; spot-check a known
   certificate through `/api/verify`.

**Data written since the backup is lost.** There is no write-ahead replay. Everything between the
last backup and the failure must be re-entered from paper or from the payment gateway's own records.

### 2.2 Redis lost

**Impact:** editorial content and the private submission lists (applications, event entries,
enrolments, unit submissions).

The site **stays up**: `storage.get()` falls back to seed content. Pages render with stale copy and
nothing crashes.

> **Two things to know.** Rate limiting stops silently — the limiter never throws, by design, so a
> Redis outage removes protection without an error. And the seeded `unitAccess` list is now **empty**
> precisely so a fallback cannot re-enable committed portal credentials.

Submission lists are **not currently backed up**. That is a real gap: an application submitted and
lost is a member the federation never hears from again.

### 2.3 Payment gateway unavailable

Checkout fails cleanly with a 502 and the provider's own message. No order is marked paid — an order
becomes paid only on a **verified capture**, so an outage cannot create a false payment.

**The risk is the opposite direction:** money taken and fulfilment missed. The hourly reconciliation
job re-reads captured payments from the provider and retries, so a webhook lost during an outage is
recovered on the next run.

### 2.4 Deployment breaks the site

Promote the previous deployment in Vercel — faster than reverting and rebuilding. Then revert the
commit so the repository matches what is live.

**If a migration was applied**, reverting the code may leave it running against a newer schema.
Additive migrations are safe this way; destructive ones are not, which is why the deploy order in
`DEPLOYMENT.md §4` exists.

### 2.5 A credential is compromised

| Compromised | Action |
|---|---|
| A user account | Bump `users.session_epoch` — invalidates every session immediately. Then disable or reset |
| `ADMIN_SESSION_SECRET` | Rotate it. **Every session everywhere is invalidated**, which is the point |
| `RAZORPAY_KEY_SECRET` | Rotate at the gateway and in Vercel. Reconciliation catches anything in flight |
| A YouTube refresh token | Revoke at Google. The system detects `invalid_grant` and records `tokenStatus: 'revoked'` rather than failing silently |
| `DATABASE_URL` | Rotate the password. Existing connections drop; functions reconnect |

### 2.6 A destructive write from a preview deployment

**Preview deployments share production Redis.** A destructive CMS write from a preview hits live
content.

Recovery is the audit trail: `/api/data/[key]` writes record the **old value** alongside the new, so
a bad edit is recoverable rather than merely detectable — provided a database is configured to hold
that audit row.

**Mitigation is separate Redis per environment**, which does not exist yet.

---

## 3. What has been tested

Not asserted — run.

| | |
|---|---|
| ✅ **Backup, verify, restore** | Full cycle against a real Postgres. Transcript in `BACKUP-RESTORE.md §5` |
| ✅ **Restore refuses live data** | Naming the occupied tables |
| ✅ **Tamper detection** | Checksum mismatch on both verify and restore paths |
| ✅ **Sequences corrected** | 87 advanced past their restored maximum — without this the next insert collides with a restored row |
| ✅ **Migration rollback** | A failed migration rolls back entirely; Postgres DDL is transactional |
| ✅ **Payment reconciliation** | Captured-but-unfulfilled payments recovered by the hourly job |
| ❌ **A full production restore drill** | Never performed. **This is the most important untested item on the list** |
| ❌ **Redis loss** | Fallback is by design and unit-tested; a real outage has not been simulated |

---

## 4. Fix these first

In order of value per unit of effort.

1. **Automate the backup.** One scheduled job writing off-host takes the RPO from a week to a day.
   Highest value in this document.
2. **Encrypt backups at rest.** They contain member personal data and safeguarding case notes in
   plaintext. Anywhere one is stored must currently be treated as holding the live database.
3. **Run a restore drill.** Do it when nothing is wrong. A restore path first exercised during an
   outage is a restore path that has never worked.
4. **Back up Redis**, or move the submission lists into Postgres where they are already covered.
5. **Separate Redis per environment** (§2.6).
6. **Add uptime monitoring.** `/api/health` is built to be polled and nothing polls it, so an outage
   is currently discovered by a member.

---

## 5. Agreeing the objectives

**REQUIRES MMAKF DECISION.** Two questions, in plain terms:

- **How much data can the federation afford to lose?** An hour of entries during a championship is
  very different from a week of routine registrations.
- **How long can it be down?** On the morning of a national championship, minutes. On an ordinary
  Tuesday, hours.

Once those are answered, engineering can state what it costs to meet them. Today the honest answer is
**one week and a few hours**, and that is a statement of the current position rather than a target
anyone has agreed.
