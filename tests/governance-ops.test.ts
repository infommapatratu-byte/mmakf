// Governance operations, against real Postgres.
//
// These tests exist to protect four claims, each of which is the difference
// between a record that survives a challenge and one that does not:
//
//   · who held office on a PAST date is answerable, and an empty answer says
//     which kind of empty it is;
//   · a superseded document version is still readable in the words it had;
//   · a swapped file is detected, and a missing checksum is not a pass;
//   · an unconfigured quorum is reported as unconfigured, never as met — and a
//     resolution taken without a proven quorum is flagged on its own record.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  constituteCommittee, setCommitteeQuorum, appointToOffice, endAppointment, voidAppointment,
  officeHoldersAt, committeeRoster,
  registerDocument, publishVersion, currentVersion, documentHistory, verifyDocumentIntegrity,
  openMeeting, recordAttendance, recordQuorum, moveResolution,
  raiseActionItem, completeActionItem, overdueActions,
  declareInterest, withdrawInterest, checkConflict,
  recordPartner, publishedPartners,
  GovernanceError,
} from '../src/db/governance-ops';
import { ForbiddenError, type Principal } from '../src/lib/rbac';

let db: any, JH: number, MH: number, DOJO: number, DOJO_B: number;

const NOW = new Date('2026-08-12T00:00:00Z');
const TODAY = '2026-08-12';

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** Bound to Jharkhand only — used to prove scope is actually enforced. */
let jharkhandAdmin: Principal;
const athlete: Principal = {
  userId: 3, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const ctx = { principal: national };

let seq = 0;
const uniq = (p: string) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

async function makePerson(name: string, over: Record<string, unknown> = {}) {
  return createPerson(db, ctx, { fullName: name, stateUnitId: JH, dojoId: DOJO, ...over } as any);
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [mh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-MH', state: 'Maharashtra', name: 'MH', status: 'active' })
    .returning({ id: s.stateUnits.id });
  MH = mh.id;

  const [d] = await db.insert(s.dojos)
    .values({ code: 'DJ-1', name: 'Hombu', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO = d.id;
  const [d2] = await db.insert(s.dojos)
    .values({ code: 'DJ-2', name: 'Branch', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO_B = d2.id;

  jharkhandAdmin = {
    userId: 2, label: 'jh-admin',
    bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
  };
});

// ─── Office holders ─────────────────────────────────────────────────────────

describe('office is held for a dated term, and past dates are answerable', () => {
  it('returns who held office on a past date, long after the term ended', async () => {
    const c = await constituteCommittee(db, ctx, {
      code: uniq('COM-EXEC'), name: 'Executive Committee', kind: 'executive',
      constitutedUnder: 'Constitution cl. 12',
    });
    const first = await makePerson('First Chair');
    const second = await makePerson('Second Chair');

    const a1 = await appointToOffice(db, ctx, {
      committeeId: c.id, personId: first.id, office: 'chair',
      termFrom: '2024-01-01', appointedUnder: 'election',
    });
    await endAppointment(db, ctx, {
      appointmentId: a1.id, endedOn: '2026-03-31', reason: 'Term expired at the AGM.',
    });
    await appointToOffice(db, ctx, {
      committeeId: c.id, personId: second.id, office: 'chair',
      termFrom: '2026-04-01', appointedUnder: 'election',
    });

    // The question a challenged decision actually asks.
    const then = await officeHoldersAt(db, c.id, '2025-06-01');
    expect(then.status).toBe('filled');
    expect(then.holders.map((h) => h.fullName)).toEqual(['First Chair']);

    const now = await officeHoldersAt(db, c.id, '2026-08-01');
    expect(now.status).toBe('filled');
    expect(now.holders.map((h) => h.fullName)).toEqual(['Second Chair']);

    // The ended term is not deleted; it is still in the roster with its reason.
    const roster = await committeeRoster(db, national, c.id);
    expect(roster).toHaveLength(2);
    const ended = roster.find((r: any) => r.appointmentId === a1.id);
    expect(ended.status).toBe('ended');
    expect(ended.termTo).toBe('2026-03-31');
    expect(ended.endedReason).toBe('Term expired at the AGM.');
  });

  it('a term ending does not rewrite history: the holder still answers for their own dates', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-TECH'), name: 'Technical', kind: 'technical' });
    const p = await makePerson('Technical Chair');
    const a = await appointToOffice(db, ctx, { committeeId: c.id, personId: p.id, office: 'chair', termFrom: '2025-01-01' });
    await endAppointment(db, ctx, { appointmentId: a.id, endedOn: '2025-12-31', reason: 'Resigned.' });

    expect((await officeHoldersAt(db, c.id, '2025-07-01')).holders).toHaveLength(1);
    expect((await officeHoldersAt(db, c.id, '2025-12-31')).holders).toHaveLength(1);   // inclusive
    expect((await officeHoldersAt(db, c.id, '2026-01-01')).status).toBe('vacant');
  });

  it('tells VACANT apart from NOT CONFIGURED', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-EMPTY'), name: 'Finance Committee', kind: 'standing' });

    const vacant = await officeHoldersAt(db, c.id, TODAY);
    expect(vacant.status).toBe('vacant');
    expect(vacant.committee?.name).toBe('Finance Committee');
    expect(vacant.holders).toEqual([]);

    const missing = await officeHoldersAt(db, 9_999_999, TODAY);
    expect(missing.status).toBe('not_configured');
    expect(missing.committee).toBeNull();
    // Crucially, the two notes do not say the same thing.
    expect(missing.note).not.toBe(vacant.note);
    expect(missing.note).toMatch(/not a report that the committee is vacant/i);
  });

  it('a voided appointment never held office at any date; an ended one did', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-VOID'), name: 'Ad Hoc', kind: 'ad_hoc' });
    const p = await makePerson('Wrongly Recorded');
    const a = await appointToOffice(db, ctx, { committeeId: c.id, personId: p.id, office: 'member', termFrom: '2026-01-01' });

    expect((await officeHoldersAt(db, c.id, '2026-02-01')).status).toBe('filled');
    await voidAppointment(db, ctx, { appointmentId: a.id, reason: 'Entered against the wrong person.' });
    expect((await officeHoldersAt(db, c.id, '2026-02-01')).status).toBe('vacant');

    // Not deleted — the correction is itself part of the record.
    expect(await committeeRoster(db, national, c.id)).toHaveLength(1);
  });

  it('refuses a duplicate of the same person in the same office over overlapping dates', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-DUP'), name: 'Dup', kind: 'standing' });
    const p = await makePerson('Double Entered');
    await appointToOffice(db, ctx, { committeeId: c.id, personId: p.id, office: 'chair', termFrom: '2024-01-01', termTo: '2026-03-31' });

    await expect(appointToOffice(db, ctx, {
      committeeId: c.id, personId: p.id, office: 'chair', termFrom: '2026-01-01',
    })).rejects.toMatchObject({ code: 'overlapping_term' });

    // A non-overlapping later term is fine.
    await expect(appointToOffice(db, ctx, {
      committeeId: c.id, personId: p.id, office: 'chair', termFrom: '2026-04-01',
    })).resolves.toBeTruthy();
  });

  it('refuses a term that ends before it begins, and an end date before the start', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-DATES'), name: 'Dates', kind: 'standing' });
    const p = await makePerson('Bad Dates');
    await expect(appointToOffice(db, ctx, {
      committeeId: c.id, personId: p.id, office: 'member', termFrom: '2026-06-01', termTo: '2026-01-01',
    })).rejects.toMatchObject({ code: 'bad_dates' });

    const a = await appointToOffice(db, ctx, { committeeId: c.id, personId: p.id, office: 'member', termFrom: '2026-06-01' });
    await expect(endAppointment(db, ctx, {
      appointmentId: a.id, endedOn: '2026-01-01', reason: 'x',
    })).rejects.toMatchObject({ code: 'bad_dates' });
    await expect(endAppointment(db, ctx, {
      appointmentId: a.id, endedOn: '2026-07-01', reason: '  ',
    })).rejects.toMatchObject({ code: 'reason_required' });
  });

  it('a state administrator cannot constitute or staff a NATIONAL committee', async () => {
    const stateCtx = { principal: jharkhandAdmin };
    await expect(constituteCommittee(db, stateCtx, {
      code: uniq('COM-NAT'), name: 'National Selection', kind: 'technical',
    })).rejects.toBeInstanceOf(ForbiddenError);

    // …but may constitute one in their own state.
    const own = await constituteCommittee(db, stateCtx, {
      code: uniq('COM-JH'), name: 'JH State Committee', kind: 'standing', scopeType: 'state', scopeId: JH,
    });
    expect(own.scopeId).toBe(JH);

    // …and not in someone else's.
    await expect(constituteCommittee(db, stateCtx, {
      code: uniq('COM-MH'), name: 'MH State Committee', kind: 'standing', scopeType: 'state', scopeId: MH,
    })).rejects.toBeInstanceOf(ForbiddenError);

    const nat = await constituteCommittee(db, ctx, { code: uniq('COM-NAT2'), name: 'National', kind: 'executive' });
    const p = await makePerson('Would-be National Officer');
    await expect(appointToOffice(db, stateCtx, {
      committeeId: nat.id, personId: p.id, office: 'member', termFrom: '2026-01-01',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('publishes WHO holds office but gates WHY a term ended', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-WHY'), name: 'Why', kind: 'standing' });
    const p = await makePerson('Departed Officer');
    const a = await appointToOffice(db, ctx, { committeeId: c.id, personId: p.id, office: 'member', termFrom: '2025-01-01' });
    await endAppointment(db, ctx, {
      appointmentId: a.id, endedOn: '2026-01-31', reason: 'Removed following a disciplinary finding.',
    });

    // Who held office is public governance information.
    const held = await officeHoldersAt(db, c.id, '2025-06-01');
    expect(held.status).toBe('filled');
    expect(JSON.stringify(held)).not.toMatch(/disciplinary/i);

    // The reason is not.
    await expect(committeeRoster(db, athlete, c.id)).rejects.toBeInstanceOf(ForbiddenError);
    const roster = await committeeRoster(db, national, c.id);
    expect(roster[0].endedReason).toMatch(/disciplinary/i);
  });

  it('refuses to re-end a term, or to end one that was voided', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-REEND'), name: 'Re-end', kind: 'standing' });
    const p = await makePerson('Ended Once');
    const a = await appointToOffice(db, ctx, { committeeId: c.id, personId: p.id, office: 'chair', termFrom: '2025-01-01' });
    await endAppointment(db, ctx, { appointmentId: a.id, endedOn: '2026-03-31', reason: 'Term expired at the AGM.' });

    // ATTACK: re-ending moves, in place, the boundary that decides who chaired
    // in April 2026 — every past-dated read changes answer and the real date
    // survives only in the audit log.
    await expect(endAppointment(db, ctx, {
      appointmentId: a.id, endedOn: '2026-06-30', reason: 'Actually stayed on until June.',
    })).rejects.toMatchObject({ code: 'already_ended' });

    const row = (await db.select().from(s.committeeAppointments).where(eq(s.committeeAppointments.id, a.id)))[0];
    expect(row.termTo).toBe('2026-03-31');
    expect((await officeHoldersAt(db, c.id, '2026-05-01')).status).toBe('vacant');

    // ATTACK: resurrect a record that was voided as never having happened.
    const q = await makePerson('Voided Then Ended');
    const b = await appointToOffice(db, ctx, { committeeId: c.id, personId: q.id, office: 'member', termFrom: '2025-01-01' });
    await voidAppointment(db, ctx, { appointmentId: b.id, reason: 'Entered against the wrong person.' });
    await expect(endAppointment(db, ctx, {
      appointmentId: b.id, endedOn: '2026-01-01', reason: 'Tidying up.',
    })).rejects.toMatchObject({ code: 'appointment_void' });
    expect((await officeHoldersAt(db, c.id, '2025-06-01')).holders.map((h) => h.personId)).not.toContain(q.id);
  });
});

// ─── Documents ──────────────────────────────────────────────────────────────

const V1_TEXT = '# Constitution\n\nArticle 1. The federation is national in jurisdiction.\n';
const V2_TEXT = '# Constitution\n\nArticle 1. The federation is national in jurisdiction.\nArticle 2. Added 2026.\n';

describe('document versions are frozen, dated and checksummed', () => {
  it('keeps a superseded version readable in the words it had, and resolves by date', async () => {
    const code = uniq('MMAKF-DOC-CONST');
    await registerDocument(db, ctx, { code, title: 'Constitution', category: 'constitution' });

    const first = await publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: V1_TEXT },
      effectiveFrom: '2026-01-01', approvedUnder: 'AGM Resolution 2025/07',
    }, NOW);
    expect(first.supersededVersionId).toBeNull();

    const second = await publishVersion(db, ctx, {
      documentCode: code, version: '2.0', content: { bodyMarkdown: V2_TEXT },
      effectiveFrom: '2026-06-01', approvedUnder: 'EGM Resolution 2026/02',
    }, NOW);
    expect(second.supersededVersionId).toBe(first.version.id);
    // The window closes the day before the successor takes effect.
    expect(second.supersededEffectiveTo).toBe('2026-05-31');

    // A rule that applied in March 2026 must still read as it did in March 2026.
    const inMarch = await currentVersion(db, code, '2026-03-01');
    expect(inMarch.status).toBe('in_force');
    expect(inMarch.version.version).toBe('1.0');
    expect(inMarch.version.bodyMarkdown).toBe(V1_TEXT);
    expect(inMarch.version.status).toBe('superseded');   // superseded, and still authoritative for that date

    const inJuly = await currentVersion(db, code, '2026-07-01');
    expect(inJuly.version.version).toBe('2.0');
    expect(inJuly.version.bodyMarkdown).toBe(V2_TEXT);

    // The boundary itself.
    expect((await currentVersion(db, code, '2026-05-31')).version.version).toBe('1.0');
    expect((await currentVersion(db, code, '2026-06-01')).version.version).toBe('2.0');

    // Nothing before the first version was ever in force.
    const before = await currentVersion(db, code, '2025-12-31');
    expect(before.status).toBe('none_in_force');
    expect(before.version).toBeNull();

    // Both versions survive, and v1's CONTENT and CHECKSUM are untouched.
    const history = await documentHistory(db, code);
    expect(history).toHaveLength(2);
    const v1 = history.find((h: any) => h.version === '1.0');
    expect(v1.bodyMarkdown).toBe(V1_TEXT);
    expect(v1.fileSha256).toBe(first.sha256);
  });

  it('distinguishes an unregistered document from one with nothing in force', async () => {
    const missing = await currentVersion(db, 'MMAKF-DOC-NOT-A-THING', TODAY);
    expect(missing.status).toBe('document_not_registered');

    const code = uniq('MMAKF-DOC-EMPTY');
    await registerDocument(db, ctx, { code, title: 'Selection Policy', category: 'policy' });
    const empty = await currentVersion(db, code, TODAY);
    expect(empty.status).toBe('none_in_force');
    expect(empty.note).not.toBe(missing.note);
  });

  it('detects a swapped file by checksum mismatch', async () => {
    const code = uniq('MMAKF-DOC-SAFE');
    await registerDocument(db, ctx, { code, title: 'Safeguarding Policy', category: 'policy' });

    const published = Uint8Array.from(Buffer.from('%PDF-1.4 the approved safeguarding policy', 'utf8'));
    const swapped = Uint8Array.from(Buffer.from('%PDF-1.4 the approved safeguarding policy.', 'utf8'));

    const r = await publishVersion(db, ctx, {
      documentCode: code, version: '1.0',
      content: { bytes: published, fileUrl: 'https://example.invalid/safeguarding.pdf', fileContentType: 'application/pdf' },
      effectiveFrom: '2026-02-01',
    }, NOW);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.version.fileSizeBytes).toBe(published.length);

    const good = await verifyDocumentIntegrity(db, r.version.id, { bytes: published });
    expect(good.status).toBe('verified');
    expect(good.computedSha256).toBe(good.recordedSha256);

    // One byte different — the document approved is not the document served.
    const bad = await verifyDocumentIntegrity(db, r.version.id, { bytes: swapped });
    expect(bad.status).toBe('mismatch');
    expect(bad.computedSha256).not.toBe(bad.recordedSha256);
    expect(bad.note).toMatch(/CHECKSUM MISMATCH/);
  });

  it('a missing checksum is reported as such and is NEVER a pass', async () => {
    const code = uniq('MMAKF-DOC-LEGACY');
    const doc = await registerDocument(db, ctx, { code, title: 'Legacy Bye-law', category: 'byelaw' });
    // A row imported from an older system, carrying no hash.
    const [row] = await db.insert(s.documentVersions).values({
      documentId: doc.id, version: '0.9', status: 'published',
      bodyMarkdown: 'old text', effectiveFrom: '2020-01-01',
    }).returning();

    const r = await verifyDocumentIntegrity(db, row.id, { bodyMarkdown: 'old text' });
    expect(r.status).toBe('no_checksum_recorded');
    expect(r.status).not.toBe('verified');
    expect(r.note).toMatch(/not a pass/i);

    expect((await verifyDocumentIntegrity(db, 9_999_999, { bodyMarkdown: 'x' })).status).toBe('unknown_version');
  });

  it('refuses to publish a version with nothing to checksum, or with no effective date', async () => {
    const code = uniq('MMAKF-DOC-THIN');
    await registerDocument(db, ctx, { code, title: 'Thin', category: 'policy' });

    await expect(publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: {}, effectiveFrom: '2026-01-01',
    }, NOW)).rejects.toMatchObject({ code: 'no_content' });

    await expect(publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: 'x' }, effectiveFrom: '',
    }, NOW)).rejects.toMatchObject({ code: 'effective_from_required' });
  });

  it('refuses to re-issue a version number, so a published version cannot be replaced in place', async () => {
    const code = uniq('MMAKF-DOC-REISSUE');
    await registerDocument(db, ctx, { code, title: 'Reissue', category: 'regulation' });
    await publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: 'original' }, effectiveFrom: '2026-01-01',
    }, NOW);

    await expect(publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: 'quietly different' }, effectiveFrom: '2026-02-01',
    }, NOW)).rejects.toMatchObject({ code: 'duplicate_version' });

    const history = await documentHistory(db, code);
    expect(history).toHaveLength(1);
    expect(history[0].bodyMarkdown).toBe('original');
  });

  it('leaves public documents open and gates a classified one', async () => {
    const open = uniq('MMAKF-DOC-OPEN');
    await registerDocument(db, ctx, { code: open, title: 'Bye-laws', category: 'byelaw' });
    await publishVersion(db, ctx, {
      documentCode: open, version: '1.0', content: { bodyMarkdown: 'open text' }, effectiveFrom: '2026-01-01',
    }, NOW);
    // No principal at all: the constitution and the bye-laws are published to be read.
    expect((await currentVersion(db, open, TODAY)).status).toBe('in_force');
    expect(await documentHistory(db, open)).toHaveLength(1);

    const closed = uniq('MMAKF-DOC-CLOSED');
    await registerDocument(db, ctx, {
      code: closed, title: 'Panel Procedure', category: 'policy', classification: 'confidential',
    });
    await publishVersion(db, ctx, {
      documentCode: closed, version: '1.0', content: { bodyMarkdown: 'closed text' }, effectiveFrom: '2026-01-01',
    }, NOW);

    await expect(currentVersion(db, closed, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(documentHistory(db, closed)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await currentVersion(db, closed, TODAY, national)).status).toBe('in_force');
  });

  it('a state administrator cannot publish a federation document', async () => {
    const code = uniq('MMAKF-DOC-GATED');
    await registerDocument(db, ctx, { code, title: 'Gated', category: 'policy' });
    await expect(publishVersion(db, { principal: jharkhandAdmin }, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: 'x' }, effectiveFrom: '2026-01-01',
    }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('does not serve an unadopted draft merely because the document is public', async () => {
    const code = uniq('MMAKF-DOC-DRAFT');
    const doc = await registerDocument(db, ctx, { code, title: 'Constitution', category: 'constitution' });
    await publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: 'the article in force' }, effectiveFrom: '2026-01-01',
    }, NOW);
    // A proposed amendment, circulating but not adopted.
    await db.insert(s.documentVersions).values({
      documentId: doc.id, version: '2.0-draft', status: 'draft',
      bodyMarkdown: 'PROPOSED: the president shall hold office for life.', effectiveFrom: '2027-01-01',
    });

    // ATTACK: read the federation's unadopted working text with no principal.
    const anonymous = await documentHistory(db, code);
    expect(anonymous.map((v: any) => v.version)).toEqual(['1.0']);
    expect(JSON.stringify(anonymous)).not.toMatch(/for life/i);
    // …and it must not become the rule by the back door either.
    expect((await currentVersion(db, code, '2027-06-01')).version.version).toBe('1.0');

    const insider = await documentHistory(db, code, national);
    expect(insider).toHaveLength(2);
  });

  it('closes a back-dated version at the next one instead of leaving it open-ended', async () => {
    const code = uniq('MMAKF-DOC-BACKDATE');
    await registerDocument(db, ctx, { code, title: 'Competition Regulations', category: 'regulation' });
    await publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: 'v1' }, effectiveFrom: '2026-01-01',
    }, NOW);
    await publishVersion(db, ctx, {
      documentCode: code, version: '3.0', content: { bodyMarkdown: 'v3' }, effectiveFrom: '2026-06-01',
    }, NOW);

    // A version entered late, with the effective date it really had.
    const back = await publishVersion(db, ctx, {
      documentCode: code, version: '2.0', content: { bodyMarkdown: 'v2' }, effectiveFrom: '2026-03-01',
    }, NOW);
    // Two versions claiming the same dates would make "which rule applied" a
    // tie-break rather than a fact.
    expect(back.version.effectiveTo).toBe('2026-05-31');

    expect((await currentVersion(db, code, '2026-02-01')).version.version).toBe('1.0');
    expect((await currentVersion(db, code, '2026-04-01')).version.version).toBe('2.0');
    expect((await currentVersion(db, code, '2026-07-01')).version.version).toBe('3.0');

    // The present-tense pointer is not dragged backwards by a back-dated entry.
    const doc = (await db.select().from(s.officialDocuments).where(eq(s.officialDocuments.code, code)))[0];
    expect(doc.currentVersionId).not.toBe(back.version.id);
  });

  it('will not answer integrity questions about a classified document to an anonymous caller', async () => {
    const code = uniq('MMAKF-DOC-ORACLE');
    await registerDocument(db, ctx, {
      code, title: 'Panel Procedure', category: 'policy', classification: 'restricted',
    });
    const r = await publishVersion(db, ctx, {
      documentCode: code, version: '1.0', content: { bodyMarkdown: 'the restricted procedure' }, effectiveFrom: '2026-01-01',
    }, NOW);

    // ATTACK: a checksum check is an oracle. Anyone who may ask "does this text
    // hash to what you published?" can confirm a guess without being shown it,
    // and gets the recorded digest back besides.
    await expect(verifyDocumentIntegrity(db, r.version.id, { bodyMarkdown: 'the restricted procedure' }))
      .rejects.toBeInstanceOf(ForbiddenError);
    await expect(verifyDocumentIntegrity(db, r.version.id, { bodyMarkdown: 'a guess' }))
      .rejects.toBeInstanceOf(ForbiddenError);

    expect((await verifyDocumentIntegrity(db, r.version.id, { bodyMarkdown: 'the restricted procedure' }, national)).status)
      .toBe('verified');
  });
});

// ─── Meetings and quorum ────────────────────────────────────────────────────

describe('quorum is configuration, and an unset quorum is never treated as met', () => {
  it('reports an unset quorum as UNSET, records the headcount, and leaves quorum_met NULL', async () => {
    // Deliberately no quorum: the federation has not set one for this committee.
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-NOQ'), name: 'Unconfigured Committee', kind: 'standing' });
    const opened = await openMeeting(db, ctx, {
      code: uniq('MTG-NOQ'), committeeId: c.id, title: 'First meeting', kind: 'committee', heldOn: '2026-05-01',
    }, NOW);
    expect(opened.quorumConfigured).toBe(false);
    expect(opened.quorumRequired).toBeNull();
    expect(opened.note).toMatch(/No quorum is configured/i);

    for (const n of ['A', 'B', 'C']) {
      const p = await makePerson(`Unconf ${n}`);
      await recordAttendance(db, ctx, { meetingId: opened.meeting.id, personId: p.id, present: true });
    }

    const q = await recordQuorum(db, ctx, opened.meeting.id);
    expect(q.status).toBe('not_configured');
    expect(q.status).not.toBe('met');
    expect(q.headcount).toBe(3);
    expect(q.quorumRequired).toBeNull();
    expect(q.quorumSource).toBe('none');
    expect(q.note).toMatch(/NOT KNOWN/);

    // NULL means unknown. `false` would be a finding of inquoracy nobody made.
    const row = (await db.select().from(s.meetings).where(eq(s.meetings.id, opened.meeting.id)))[0];
    expect(row.quorumPresent).toBe(3);
    expect(row.quorumMet).toBeNull();
  });

  it('freezes the configured quorum on the meeting and applies it to the headcount', async () => {
    const c = await constituteCommittee(db, ctx, {
      code: uniq('COM-Q3'), name: 'Quorate Committee', kind: 'executive', quorum: 3,
    });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-Q3'), committeeId: c.id, title: 'Executive', kind: 'executive', heldOn: '2026-05-02',
    }, NOW);
    expect(m.quorumConfigured).toBe(true);
    expect(m.quorumRequired).toBe(3);

    for (const n of ['A', 'B', 'C', 'D']) {
      const p = await makePerson(`Q3 ${n}`);
      await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: p.id, present: n !== 'D' });
    }

    const q = await recordQuorum(db, ctx, m.meeting.id);
    expect(q).toMatchObject({ status: 'met', headcount: 3, quorumRequired: 3, quorumSource: 'meeting' });

    // Changing the committee's quorum afterwards must not re-judge a past meeting.
    await setCommitteeQuorum(db, ctx, { committeeId: c.id, quorum: 9, authority: 'Bye-law 4.2 as amended' });
    const again = await recordQuorum(db, ctx, m.meeting.id);
    expect(again.quorumRequired).toBe(3);
    expect(again.status).toBe('met');
  });

  it('counts proxies separately, because whether they count is not configured', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-PROXY'), name: 'Proxy', kind: 'standing', quorum: 4 });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-PROXY'), committeeId: c.id, title: 'AGM-ish', kind: 'committee', heldOn: '2026-05-03',
    }, NOW);

    const absent = await makePerson('Absent Member');
    const holder = await makePerson('Proxy Holder');
    const plain = await makePerson('Plain Attendee');
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: absent.id, present: false, apologies: true });
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: holder.id, present: true, proxyForPersonId: absent.id });
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: plain.id, present: true });

    const q = await recordQuorum(db, ctx, m.meeting.id);
    expect(q.headcount).toBe(2);        // the proxy does NOT silently become a third head
    expect(q.proxiesHeld).toBe(1);
    expect(q.apologies).toBe(1);
    expect(q.status).toBe('not_met');
  });

  it('refuses contradictory attendance, self-proxy, and corrects only the person re-recorded', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-ATT'), name: 'Attendance', kind: 'standing', quorum: 2 });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-ATT'), committeeId: c.id, title: 'Attendance', kind: 'committee', heldOn: '2026-05-04',
    }, NOW);
    const p1 = await makePerson('Att One');
    const p2 = await makePerson('Att Two');

    await expect(recordAttendance(db, ctx, {
      meetingId: m.meeting.id, personId: p1.id, present: true, apologies: true,
    })).rejects.toMatchObject({ code: 'contradictory_attendance' });

    await expect(recordAttendance(db, ctx, {
      meetingId: m.meeting.id, personId: p1.id, proxyForPersonId: p1.id,
    })).rejects.toMatchObject({ code: 'self_proxy' });

    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: p1.id, present: true });
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: p2.id, present: true });
    // A correction to p1 leaves p2 alone.
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: p1.id, present: false, apologies: true });

    const q = await recordQuorum(db, ctx, m.meeting.id);
    expect(q.headcount).toBe(1);
    expect(q.status).toBe('not_met');
  });

  it('does not apply a quorum configured AFTER a meeting to that meeting', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-LATEQ'), name: 'Late Quorum', kind: 'standing' });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-LATEQ'), committeeId: c.id, title: 'Held before the bye-law', kind: 'committee', heldOn: '2026-05-10',
    }, NOW);
    const p = await makePerson('Late Q A');
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: p.id });

    // The bye-law fixing the quorum is adopted afterwards.
    await setCommitteeQuorum(db, ctx, {
      committeeId: c.id, quorum: 5, authority: 'Bye-law 4.2, adopted after this meeting',
    });

    // A rule made in August cannot decide whether a meeting held in May was
    // competent — in either direction.
    const q = await recordQuorum(db, ctx, m.meeting.id);
    expect(q.status).toBe('not_configured');
    expect(q.status).not.toBe('not_met');
    expect(q.quorumRequired).toBeNull();
    expect(q.quorumSource).toBe('none');
    expect(q.committeeQuorumNotApplied).toBe(5);
    expect(q.note).toMatch(/NOT applied to it/i);

    const row = (await db.select().from(s.meetings).where(eq(s.meetings.id, m.meeting.id)))[0];
    expect(row.quorumRequired).toBeNull();
    expect(row.quorumMet).toBeNull();

    const r = await moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/01', text: 'That the venue be booked.', outcome: 'carried',
    });
    expect(r.flags).toContain('QUORUM_NOT_CONFIGURED');
    expect(r.challengeable).toBe(true);
  });

  it('invalidates a quoracy finding when the attendance it was derived from changes', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-DRIFT'), name: 'Drift', kind: 'executive', quorum: 2 });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-DRIFT'), committeeId: c.id, title: 'Drift', kind: 'executive', heldOn: '2026-05-11',
    }, NOW);
    const a = await makePerson('Drift A');
    const b = await makePerson('Drift B');
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: a.id });
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: b.id });
    expect((await recordQuorum(db, ctx, m.meeting.id)).status).toBe('met');

    // ATTACK: the sheet the finding was computed from is corrected afterwards.
    // A stored `quorum_met = true` would outlive its own evidence.
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: b.id, present: false, apologies: true });

    const row = (await db.select().from(s.meetings).where(eq(s.meetings.id, m.meeting.id)))[0];
    expect(row.quorumMet).toBeNull();
    expect(row.quorumPresent).toBeNull();
    expect(row.quorumRequired).toBe(2);        // the frozen configuration is untouched

    // Unknown, not proven — so a decision taken now is challengeable.
    const r = await moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/01', text: 'That the minutes be approved.', outcome: 'carried',
    });
    expect(r.quorum.status).toBe('not_recorded');
    expect(r.challengeable).toBe(true);

    // The correction is on the record with what the row said before it.
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'meeting_attendance'));
    const corrections = audit.filter((x: any) => x.action === 'update' && x.oldValue?.present === true);
    expect(corrections.length).toBeGreaterThan(0);

    // Counting again is a deliberate act, and now says what the sheet says.
    expect((await recordQuorum(db, ctx, m.meeting.id)).status).toBe('not_met');
  });
});

// ─── Resolutions ────────────────────────────────────────────────────────────

describe('a decision taken without a proven quorum is flagged on its own record', () => {
  it('flags a resolution passed at an INQUORATE meeting', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-INQ'), name: 'Inquorate', kind: 'executive', quorum: 5 });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-INQ'), committeeId: c.id, title: 'Thin meeting', kind: 'executive', heldOn: '2026-05-05',
    }, NOW);
    const mover = await makePerson('Mover');
    const seconder = await makePerson('Seconder');
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: mover.id });
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: seconder.id });

    const q = await recordQuorum(db, ctx, m.meeting.id);
    expect(q.status).toBe('not_met');

    const r = await moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/01', text: 'That the affiliation fee schedule be adopted.',
      movedByPersonId: mover.id, secondedByPersonId: seconder.id,
      votesFor: 2, votesAgainst: 0, abstentions: 0, outcome: 'carried',
    });

    expect(r.challengeable).toBe(true);
    expect(r.flags).toContain('PASSED_AT_INQUORATE_MEETING');
    expect(r.quorum).toMatchObject({ status: 'not_met', required: 5, present: 2 });
    expect(r.note).toMatch(/challengeable/i);

    // Reconstructible from stored data alone: the audit row carries the flags.
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityId, String(r.resolution.id)));
    const created = audit.find((a: any) => a.entityType === 'resolution');
    expect(created.newValue.flags).toContain('PASSED_AT_INQUORATE_MEETING');
  });

  it('flags a resolution where the quorum was never configured, and one where it was never counted', async () => {
    const noQ = await constituteCommittee(db, ctx, { code: uniq('COM-RNQ'), name: 'No quorum set', kind: 'standing' });
    const m1 = await openMeeting(db, ctx, {
      code: uniq('MTG-RNQ'), committeeId: noQ.id, title: 'Unconfigured', kind: 'committee', heldOn: '2026-05-06',
    }, NOW);
    const p = await makePerson('Attendee NQ');
    await recordAttendance(db, ctx, { meetingId: m1.meeting.id, personId: p.id });
    await recordQuorum(db, ctx, m1.meeting.id);

    const r1 = await moveResolution(db, ctx, {
      meetingId: m1.meeting.id, number: '2026/01', text: 'That the minutes be approved.', outcome: 'carried',
    });
    expect(r1.quorum.status).toBe('not_configured');
    expect(r1.flags).toContain('QUORUM_NOT_CONFIGURED');
    expect(r1.challengeable).toBe(true);        // unproven is not the same as proven

    // Quorum configured, but nobody counted the room.
    const withQ = await constituteCommittee(db, ctx, { code: uniq('COM-RNC'), name: 'Never counted', kind: 'standing', quorum: 3 });
    const m2 = await openMeeting(db, ctx, {
      code: uniq('MTG-RNC'), committeeId: withQ.id, title: 'Uncounted', kind: 'committee', heldOn: '2026-05-07',
    }, NOW);
    const r2 = await moveResolution(db, ctx, {
      meetingId: m2.meeting.id, number: '2026/01', text: 'That the report be received.', outcome: 'carried',
    });
    expect(r2.quorum.status).toBe('not_recorded');
    expect(r2.flags).toContain('QUORUM_NOT_RECORDED');
    expect(r2.challengeable).toBe(true);
  });

  it('a resolution at a quorate meeting carries no quorum flag', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-OK'), name: 'Quorate', kind: 'executive', quorum: 2 });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-OK'), committeeId: c.id, title: 'Proper meeting', kind: 'executive', heldOn: '2026-05-08',
    }, NOW);
    const a = await makePerson('Ok A');
    const b = await makePerson('Ok B');
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: a.id });
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: b.id });
    await recordQuorum(db, ctx, m.meeting.id);

    const r = await moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/01', text: 'That the accounts be adopted.',
      movedByPersonId: a.id, secondedByPersonId: b.id,
      votesFor: 2, votesAgainst: 0, outcome: 'carried',
    });
    expect(r.challengeable).toBe(false);
    expect(r.flags).toEqual([]);
  });

  it('does not compute the outcome from the votes, but flags numbers that do not support it', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-VOTE'), name: 'Votes', kind: 'executive', quorum: 1 });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-VOTE'), committeeId: c.id, title: 'Votes', kind: 'executive', heldOn: '2026-05-09',
    }, NOW);
    const a = await makePerson('Vote A');
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: a.id });
    await recordQuorum(db, ctx, m.meeting.id);

    // Recorded as carried on 2-for / 5-against. The federation's majority rule is
    // not this module's to apply — but the arithmetic is reported.
    const r = await moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/01', text: 'That the chair be authorised to sign.',
      votesFor: 2, votesAgainst: 5, abstentions: 1, outcome: 'carried',
    });
    expect(r.resolution.outcome).toBe('carried');       // stated, not recomputed
    expect(r.flags).toContain('VOTES_DO_NOT_SHOW_A_MAJORITY_FOR');

    await expect(moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/02', text: 'x', outcome: 'carried', votesFor: 1.5 as any,
    })).rejects.toMatchObject({ code: 'bad_votes' });

    await expect(moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/01', text: 'duplicate number', outcome: 'carried',
    })).rejects.toMatchObject({ code: 'duplicate_resolution' });
  });
});

// ─── Action items ───────────────────────────────────────────────────────────

describe('action items surface what is overdue, undated and unowned', () => {
  it('reports overdue items and does not hide the undated or the unowned', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-ACT'), name: 'Actions', kind: 'standing', quorum: 1 });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-ACT'), committeeId: c.id, title: 'Actions', kind: 'committee', heldOn: '2026-01-10',
    }, NOW);
    const owner = await makePerson('Action Owner');
    await recordAttendance(db, ctx, { meetingId: m.meeting.id, personId: owner.id });
    await recordQuorum(db, ctx, m.meeting.id);
    const res = await moveResolution(db, ctx, {
      meetingId: m.meeting.id, number: '2026/01', text: 'That the register be published.', outcome: 'carried',
    });

    const late = await raiseActionItem(db, ctx, {
      resolutionId: res.resolution.id, description: 'Publish the register.',
      ownerPersonId: owner.id, dueOn: '2026-01-31',
    });
    const future = await raiseActionItem(db, ctx, {
      meetingId: m.meeting.id, description: 'Review in December.', ownerPersonId: owner.id, dueOn: '2026-12-31',
    });
    const undated = await raiseActionItem(db, ctx, {
      meetingId: m.meeting.id, description: 'Draft the safeguarding policy.', ownerPersonId: owner.id,
    });
    const unowned = await raiseActionItem(db, ctx, {
      meetingId: m.meeting.id, description: 'Someone should book the venue.', dueOn: '2026-02-01',
    });

    const report = await overdueActions(db, national, TODAY);
    const ids = (xs: any[]) => xs.map((x) => x.id);
    expect(ids(report.overdue)).toContain(late.id);
    expect(ids(report.overdue)).toContain(unowned.id);
    expect(ids(report.overdue)).not.toContain(future.id);

    // An action nobody dated is not an action nobody has to do.
    expect(ids(report.undated)).toContain(undated.id);
    expect(ids(report.unowned)).toContain(unowned.id);

    const lateRow = report.overdue.find((x: any) => x.id === late.id) as any;
    expect(lateRow.daysOverdue).toBe(193);          // 2026-01-31 → 2026-08-12
    expect(lateRow.ownerName).toBe('Action Owner');
    expect(lateRow.meetingCode).toBe(m.meeting.code);

    await completeActionItem(db, ctx, { actionItemId: late.id, completedOn: '2026-08-01' });
    const after = await overdueActions(db, national, TODAY);
    expect(ids(after.overdue)).not.toContain(late.id);

    await expect(completeActionItem(db, ctx, {
      actionItemId: late.id, completedOn: '2026-08-02',
    })).rejects.toMatchObject({ code: 'already_completed' });
  });

  it('refuses an action item with no meeting or resolution behind it', async () => {
    await expect(raiseActionItem(db, ctx, { description: 'Do a thing.' }))
      .rejects.toMatchObject({ code: 'no_provenance' });
    await expect(raiseActionItem(db, ctx, { meetingId: 1, description: '   ' }))
      .rejects.toMatchObject({ code: 'description_required' });
  });

  it('refuses the overdue report to a principal with no read authority', async () => {
    await expect(overdueActions(db, athlete, TODAY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('scope-filters the overdue report IN SQL, and says that it did', async () => {
    const nat = await constituteCommittee(db, ctx, { code: uniq('COM-NATACT'), name: 'National Executive', kind: 'executive' });
    const natM = await openMeeting(db, ctx, {
      code: uniq('MTG-NATACT'), committeeId: nat.id, title: 'National Executive', kind: 'executive', heldOn: '2026-01-05',
    }, NOW);
    const natAction = await raiseActionItem(db, ctx, {
      meetingId: natM.meeting.id, dueOn: '2026-02-01',
      description: 'Respond to the complaint about the national coach.',
    });

    // A meeting of no committee — an AGM — is a national act.
    const agm = await openMeeting(db, ctx, {
      code: uniq('MTG-AGM'), title: 'Annual General Meeting', kind: 'agm', heldOn: '2026-01-07',
    }, NOW);
    const agmAction = await raiseActionItem(db, ctx, {
      meetingId: agm.meeting.id, description: 'File the annual return.', dueOn: '2026-02-15',
    });

    const jh = await constituteCommittee(db, ctx, {
      code: uniq('COM-JHACT'), name: 'JH Committee', kind: 'standing', scopeType: 'state', scopeId: JH,
    });
    const jhM = await openMeeting(db, ctx, {
      code: uniq('MTG-JHACT'), committeeId: jh.id, title: 'JH Committee', kind: 'committee', heldOn: '2026-01-06',
    }, NOW);
    const jhAction = await raiseActionItem(db, ctx, {
      meetingId: jhM.meeting.id, description: 'Book the state championship venue.', dueOn: '2026-02-01',
    });

    // ATTACK: a state administrator holds `unit:read`, so the list gate lets
    // them in. Without a filter in the query they receive the whole federation.
    const ids = (xs: any[]) => xs.map((x) => x.id);
    const mine = await overdueActions(db, jharkhandAdmin, TODAY);
    expect(ids(mine.overdue)).toContain(jhAction.id);
    expect(ids(mine.overdue)).not.toContain(natAction.id);
    expect(ids(mine.overdue)).not.toContain(agmAction.id);
    expect(JSON.stringify(mine)).not.toMatch(/national coach/i);
    // An empty answer must not read as "nothing is outstanding".
    expect(mine.scope).toBe('scoped');
    expect(mine.note).toMatch(/Limited to the committees within your scope/i);

    const all = await overdueActions(db, national, TODAY);
    expect(all.scope).toBe('all');
    expect(ids(all.overdue)).toEqual(expect.arrayContaining([natAction.id, agmAction.id, jhAction.id]));
  });

  it('refuses to close another scope\'s action item', async () => {
    const nat = await constituteCommittee(db, ctx, { code: uniq('COM-NATCLOSE'), name: 'National', kind: 'executive' });
    const m = await openMeeting(db, ctx, {
      code: uniq('MTG-NATCLOSE'), committeeId: nat.id, title: 'National', kind: 'executive', heldOn: '2026-01-08',
    }, NOW);
    const item = await raiseActionItem(db, ctx, {
      meetingId: m.meeting.id, description: 'Publish the audited accounts.', dueOn: '2026-03-01',
    });

    // ATTACK: holding `unit:write` SOMEWHERE is not authority over this.
    await expect(completeActionItem(db, { principal: jharkhandAdmin }, {
      actionItemId: item.id, completedOn: '2026-04-01',
    })).rejects.toBeInstanceOf(ForbiddenError);

    const row = (await db.select().from(s.actionItems).where(eq(s.actionItems.id, item.id)))[0];
    expect(row.status).toBe('open');
    expect(row.completedOn).toBeNull();

    await completeActionItem(db, ctx, { actionItemId: item.id, completedOn: '2026-04-01' });
  });
});

// ─── Conflict of interest ───────────────────────────────────────────────────

describe('conflict checks report what was declared, and never mistake silence for clearance', () => {
  it('finds a declared interest touching the decision', async () => {
    const examiner = await makePerson('Conflicted Examiner');
    const student = await makePerson('Their Own Student');

    await declareInterest(db, ctx, {
      personId: examiner.id, kind: 'coaching',
      description: 'Coaches this candidate weekly at the Hombu dojo.',
      relatedPersonId: student.id, declaredOn: '2026-01-01',
    });

    const found = await checkConflict(db, national, examiner.id, {
      personIds: [student.id], asAt: '2026-08-01', purpose: 'examiner assignment',
    });
    expect(found.status).toBe('conflict_found');
    expect(found.interests).toHaveLength(1);
    expect(found.interests[0]).toMatchObject({ matchedOn: 'related_person', kind: 'coaching' });
    // The panel is told WHAT the interest is, not merely that there is one.
    expect(found.interests[0].description).toMatch(/Coaches this candidate/);
    expect(found.purpose).toBe('examiner assignment');
  });

  it('distinguishes NONE DECLARED from NO MATCH — silence is not a clearance', async () => {
    const silent = await makePerson('Has Declared Nothing');
    const candidate = await makePerson('Some Candidate');

    const none = await checkConflict(db, national, silent.id, { personIds: [candidate.id], asAt: '2026-08-01' });
    expect(none.status).toBe('none_declared');
    expect(none.declarationsInForce).toBe(0);
    expect(none.note).toMatch(/ABSENCE OF A DECLARATION/);
    expect(none.note).toMatch(/not a finding that no conflict exists/i);

    // Same person, now with a declaration that has nothing to do with this decision.
    const unrelated = await makePerson('Unrelated Person');
    await declareInterest(db, ctx, {
      personId: silent.id, kind: 'family', description: 'Sibling competes for another dojo.',
      relatedPersonId: unrelated.id, declaredOn: '2026-02-01',
    });

    const noMatch = await checkConflict(db, national, silent.id, { personIds: [candidate.id], asAt: '2026-08-01' });
    expect(noMatch.status).toBe('declared_no_match');
    expect(noMatch.declarationsInForce).toBe(1);
    expect(noMatch.interests).toEqual([]);
    // Three different empties, three different messages.
    expect(noMatch.note).not.toBe(none.note);
    expect(noMatch.note).toMatch(/Only declared interests were examined/i);
  });

  it('matches on a dojo, and treats a declaration naming nothing as unruleable-out', async () => {
    const selector = await makePerson('Selector');
    await declareInterest(db, ctx, {
      personId: selector.id, kind: 'dojo', description: 'Teaches at the branch dojo.',
      relatedDojoId: DOJO_B, declaredOn: '2026-01-01',
    });
    const byDojo = await checkConflict(db, national, selector.id, { dojoIds: [DOJO_B], asAt: '2026-08-01' });
    expect(byDojo.status).toBe('conflict_found');
    expect(byDojo.interests[0].matchedOn).toBe('related_dojo');

    const vague = await makePerson('Vague Declarer');
    await declareInterest(db, ctx, {
      personId: vague.id, kind: 'financial',
      description: 'Holds an interest in a supplier to the federation.', declaredOn: '2026-01-01',
    });
    // Names nobody, so it cannot be excluded from any decision. Fail closed.
    const anything = await checkConflict(db, national, vague.id, { personIds: [selector.id], asAt: '2026-08-01' });
    expect(anything.status).toBe('conflict_found');
    expect(anything.interests[0].matchedOn).toBe('unspecific');
    expect(anything.note).toMatch(/cannot be ruled out/i);
  });

  it('judges an interest as at the decision date, not as at today', async () => {
    const person = await makePerson('Time-bound Declarer');
    const related = await makePerson('Related To');
    await declareInterest(db, ctx, {
      personId: person.id, kind: 'other', description: 'Joint venture, ended mid-year.',
      relatedPersonId: related.id, declaredOn: '2026-03-01', validTo: '2026-06-30',
    });

    // Before it was declared.
    expect((await checkConflict(db, national, person.id, { personIds: [related.id], asAt: '2026-02-01' })).status)
      .toBe('none_declared');
    // While in force.
    expect((await checkConflict(db, national, person.id, { personIds: [related.id], asAt: '2026-05-01' })).status)
      .toBe('conflict_found');
    // After it lapsed.
    expect((await checkConflict(db, national, person.id, { personIds: [related.id], asAt: '2026-07-01' })).status)
      .toBe('none_declared');
  });

  it('a withdrawn declaration still explains a decision taken while it stood', async () => {
    const person = await makePerson('Withdrawer');
    const related = await makePerson('Formerly Related');
    const d = await declareInterest(db, ctx, {
      personId: person.id, kind: 'family', description: 'Parent of the candidate.',
      relatedPersonId: related.id, declaredOn: '2026-01-01',
    });
    await withdrawInterest(db, ctx, {
      declarationId: d.id, endedOn: '2026-04-30', reason: 'Candidate no longer a member.',
    });

    expect((await checkConflict(db, national, person.id, { personIds: [related.id], asAt: '2026-03-01' })).status)
      .toBe('conflict_found');
    expect((await checkConflict(db, national, person.id, { personIds: [related.id], asAt: '2026-08-01' })).status)
      .toBe('none_declared');
    // Never deleted.
    expect((await db.select().from(s.interestDeclarations).where(eq(s.interestDeclarations.id, d.id)))).toHaveLength(1);
  });

  it('refuses a declaration with no description, and refuses out-of-scope reads', async () => {
    const person = await makePerson('Terse');
    await expect(declareInterest(db, ctx, {
      personId: person.id, kind: 'other', description: '  ', declaredOn: '2026-01-01',
    })).rejects.toMatchObject({ code: 'description_required' });

    // A Maharashtra administrator has no business reading a Jharkhand member's
    // register of interests.
    const mhAdmin: Principal = {
      userId: 9, label: 'mh-admin',
      bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: MH }],
    };
    await expect(checkConflict(db, mhAdmin, person.id, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses the register of interests to a principal holding only person:read', async () => {
    const subject = await makePerson('Register Subject');
    const related = await makePerson('Named In The Register');
    await declareInterest(db, ctx, {
      personId: subject.id, kind: 'family', description: 'Parent of the candidate.',
      relatedPersonId: related.id, declaredOn: '2026-01-01',
    });

    // ATTACK: this principal holds `person:read` NATIONALLY. A declaration is
    // free text about someone's family, money or loyalties; it is not readable
    // by every member who can look up a name.
    await expect(checkConflict(db, athlete, subject.id, { personIds: [related.id] }))
      .rejects.toBeInstanceOf(ForbiddenError);

    const seen = await checkConflict(db, national, subject.id, { personIds: [related.id] });
    expect(seen.status).toBe('conflict_found');
    expect(seen.interests[0].description).toMatch(/Parent of the candidate/);
  });
});

// ─── Partners ───────────────────────────────────────────────────────────────

describe('partners appear publicly only when published and in force', () => {
  it('omits unpublished and lapsed agreements, and returns no contact details', async () => {
    await recordPartner(db, ctx, {
      name: 'Published In Force', kind: 'sponsor', published: true,
      agreementFrom: '2026-01-01', agreementTo: '2026-12-31',
      contactEmail: 'private@example.invalid',
    });
    await recordPartner(db, ctx, { name: 'Not Published', kind: 'sponsor', published: false });
    await recordPartner(db, ctx, {
      name: 'Lapsed', kind: 'sponsor', published: true,
      agreementFrom: '2024-01-01', agreementTo: '2025-12-31',
    });

    const shown = await publishedPartners(db, TODAY);
    const names = shown.map((p: any) => p.name);
    expect(names).toContain('Published In Force');
    expect(names).not.toContain('Not Published');
    expect(names).not.toContain('Lapsed');
    expect(Object.keys(shown[0])).not.toContain('contactEmail');
  });
});

// ─── Error contract ─────────────────────────────────────────────────────────

describe('failures are typed, never bare', () => {
  it('carries a machine-readable code on every refusal', async () => {
    const err = await appointToOffice(db, ctx, {
      committeeId: 9_999_999, personId: 1, office: 'chair', termFrom: '2026-01-01',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GovernanceError);
    expect(err.code).toBe('unknown_committee');
    expect(err.name).toBe('GovernanceError');
  });

  it('rejects a malformed date rather than coercing it', async () => {
    const c = await constituteCommittee(db, ctx, { code: uniq('COM-BADDATE'), name: 'Bad date', kind: 'standing' });
    const p = await makePerson('Bad Date Appointee');
    await expect(appointToOffice(db, ctx, {
      committeeId: c.id, personId: p.id, office: 'member', termFrom: '01/01/2026',
    })).rejects.toMatchObject({ code: 'bad_date' });
  });
});
