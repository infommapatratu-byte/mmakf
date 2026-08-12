# BACKUP-RESTORE

**An untested backup is a file, not a backup.** Everything below has been run end to end against a
real Postgres server, and the transcript of that run is in §5.

---

## 1. What is at risk

| Data | Where | If lost |
|---|---|---|
| Grading records, certificates, rank history | Postgres | **Irreplaceable.** No paper equivalent exists for anything issued through this system. Every member's grade would have to be re-established from personal certificates, and revocations would be lost entirely. |
| Competition results, rankings | Postgres | Reconstructible from paper score sheets, at enormous cost, if they were kept. |
| Members, dojos, units, affiliations | Postgres | Reconstructible from applications, slowly. |
| Orders, payments, ledger | Postgres | The gateway holds its own record; MMAKF's reconciliation would be lost. |
| Safeguarding, medical, disciplinary cases | Postgres | **Irreplaceable, and legally consequential.** |
| Editorial content | Redis | Reconstructible. Lowest priority. |
| Uploaded documents | Object storage | Depends on the provider's own durability — not covered by this script. |

**The grading chain is the thing that matters.** A federation that cannot prove what it awarded is
not a federation.

---

## 2. Commands

```bash
npm run backup                              # dump every table
npm run backup -- --verify <file>           # confirm it is restorable
npm run backup -- --restore <file>          # load into an EMPTY database
```

`DATABASE_URL` must be set. There is no fallback target — pointing a backup or a restore at the wrong
environment is worse than failing loudly.

### Why not `pg_dump`

It is not installed on every operator's machine, its version must match the server or it refuses, and
it is absent from the deploy environment entirely. `scripts/backup.mjs` uses the same driver the
application uses: **if the application can reach the database, so can the backup.**

---

## 3. What the script guarantees

| Guarantee | How |
|---|---|
| **Every table, including new ones** | Table list is derived from the live schema, not hardcoded. A table added in a future migration is backed up automatically — the failure mode of every hand-maintained backup list. |
| **Restorable order** | Tables are topologically sorted by foreign key, so a restore never inserts a child before its parent. Circular references are broken rather than refused; Postgres permits them. |
| **Tamper evidence** | SHA-256 over the dump body. Verification recomputes it; restore refuses on mismatch. |
| **Schema version travels with the data** | The `_mmakf_migrations` state is embedded. Restoring rows into a database at a different schema version is how a restore appears to work and fails weeks later. |
| **Never overwrites live data** | Restore refuses if *any* target table contains rows. A restore over live data is an irreversible mistake made in a hurry — which is exactly when restores happen. |
| **Atomic** | One transaction. A half-restored federation is worse than none. |
| **Sequences corrected** | Every serial is advanced past its restored maximum. Without this the next insert collides with a restored row — a subtle failure that appears hours later. |

---

## 4. Operating procedure

### Routine

1. **Weekly, and before any migration.**
   ```bash
   npm run backup
   npm run backup -- --verify backups/mmakf-<timestamp>.json
   ```
2. Copy the file **off the machine that produced it.** A backup on the same host as the database is
   not a backup; it is a second copy of the same failure.
3. Keep four weekly and twelve monthly. **Retention beyond that is a federation decision** — it turns
   on the data-protection commitments MMAKF makes to its members, and it is not for engineering to
   set. Recorded as an open item.

### Restore

1. Provision an **empty** database.
2. `npm run db:migrate` — a restore loads rows, it does not create the schema.
3. `npm run backup -- --verify <file>` **before** attempting it.
4. `npm run backup -- --restore <file>`.
5. Verify: `/api/health` reports `database: "ok"`; `npm run db:status` shows all migrations applied;
   spot-check a known certificate through `/api/verify`.

### Quarterly drill

**Do the restore when nothing is wrong.** A restore path first exercised during an outage is a
restore path that has never worked. Restore the latest backup into a scratch database, confirm the
row counts, then throw it away.

---

## 5. Verified — transcript of the actual run

Against a real Postgres server on 2026-08-12. Not a description of intent.

```
BACKUP
  2 rows across 87 tables → backups/mmakf-2026-08-12T06-20-57-635Z.json
  sha256 0370a482d9eac38ea4be4072cabaa7f98b5caca1048d73896907205e227f47c4

VERIFY
  format      mmakf-backup-v1
  checksum    INTACT
  migrations  4 recorded
  tables      87
  rows        2
  RESTORABLE.

RESTORE INTO A NON-EMPTY DATABASE
  REFUSING TO RESTORE: 2 table(s) already contain data.
    state_units, persons

TAMPERED FILE — VERIFY
  checksum    MISMATCH — the file has been altered or truncated
  NOT RESTORABLE — do not rely on this file.

TAMPERED FILE — RESTORE
  CHECKSUM MISMATCH. Refusing to restore an altered or truncated file.

RESTORE INTO A CLEAN DATABASE
        1  state_units
        1  persons
  87 sequence(s) advanced past the restored maximum
  Restored 2 rows.
```

All five behaviours confirmed: backup, verify, refusal to overwrite live data, tamper detection on
both paths, and a clean restore with sequences corrected.

---

## 6. Not covered

Stated plainly rather than left to be discovered during an incident.

| Gap | Consequence |
|---|---|
| **Uploaded files** | The script backs up the database only. Object storage durability is the provider's, and no separate copy is taken. Relevant once uploads are live (Q-30). |
| **Redis content** | Editorial content is not dumped. Reconstructible, so accepted — but it *is* a gap, not an oversight. |
| **No automated schedule** | Backups are run by hand today. A scheduled job needs somewhere to write that is not the application host. |
| **No off-site copy** | Step 4.2 is a manual instruction, not an enforced control. |
| **No encryption at rest** | The dump contains member personal data and safeguarding case notes in plaintext. **Anywhere it is stored must be treated as holding the live database**, and it should be encrypted before leaving the machine. This is the most serious item on this list. |
| **RPO/RTO not agreed** | See `DISASTER-RECOVERY.md`. Engineering can state what is achievable; how much data loss is acceptable is MMAKF's decision. |
