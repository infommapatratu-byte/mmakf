// The identity foundation.
//
// Most of this suite is written as an ATTACK. The tables it covers hold whose
// children these are, where they live and who may see their safeguarding file,
// so the tests that matter most are the ones that must FAIL correctly:
//
//   · an asserted guardianship grants nothing;
//   · a verified guardianship with no capability still grants nothing;
//   · the office that attaches a parent to a child cannot hand over the
//     safeguarding record;
//   · a guardian of one child is a stranger to another;
//   · a revoked guardianship takes its capabilities with it;
//   · consent to version 1 is not consent to version 4;
//   · nobody approves their own change to their own date of birth.
//
// The federation's brief states the rule these enforce in one sentence:
// "Sensitive information must not become visible simply because a user has
// 'parent' status."

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  ageOn, isMinor, normaliseContact, computeMatchKey,
  addContact, verifyContact, setPrimaryContact, supersedeContact,
  contactsFor, hasVerifiedContact,
  setPersonAddress, addressHistory,
  assertRelationship, decideRelationship, revokeRelationship,
  grantGuardianCapability, revokeGuardianCapability, guardianCan,
  dependantsOf, guardiansOf, GUARDIAN_CAPABILITIES,
  recordConsent, currentConsent, isConsentInForce, consentHistory,
  detectPersonDuplicates, duplicateQueue, decideDuplicate,
  requestProfileChange, decideProfileChange, profileChangeQueue,
  GOVERNED_FIELDS, isGovernedField, backfillMatchKeys, isIdentityError,
} from '../src/db/identity';
import { upsertCountry, upsertArea } from '../src/db/geography';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let STATE: number, OTHER_STATE: number, DOJO: number, IN: number, GUWAHATI: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const superAdmin: Principal = {
  userId: 2, label: 'super admin',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
const safeguarding: Principal = {
  userId: 3, label: 'safeguarding officer',
  bindings: [{ role: 'SAFEGUARDING_OFFICER', scopeType: 'national', scopeId: null }],
};
const dojoAdmin: Principal = {
  userId: 4, label: 'a dojo administrator',
  bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: 1 }],
};
const member: Principal = {
  userId: 5, label: 'an ordinary member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = admin): AuditContext => ({
  principal: p, reason: 'test', authority: 'test',
});

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

let seq = 100000;
async function makePerson(name: string, over: Record<string, unknown> = {}) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(seq++)}`,
    fullName: name,
    matchKey: computeMatchKey(name),
    status: 'active',
    stateUnitId: STATE,
    dojoId: DOJO,
    ...over,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

beforeAll(async () => {
  const pg = new PGlite();
  for (const f of MIGRATIONS) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });

  // Real `users` rows for every principal below.
  //
  // Not a fixture nicety: person_relationships.asserted_by_user_id,
  // profile_change_requests.requested_by_user_id and
  // duplicate_candidates.decided_by_user_id are all real foreign keys, so a
  // principal whose userId is a number nobody issued cannot act. That is the
  // intended behaviour — an audit trail pointing at a user who does not exist
  // is not a trail — and the first version of this file proved it by failing.
  for (const id of [1, 2, 3, 4, 5, 20, 42]) {
    await db.insert(s.users).values({
      id, email: `user${id}@test.invalid`, status: 'active',
    }).onConflictDoNothing();
  }

  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-AS', state: 'Assam', name: 'Assam State Unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;

  const [st2] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-KL', state: 'Kerala', name: 'Kerala State Unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  OTHER_STATE = st2.id;

  const [dj] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-AS-001', name: 'Guwahati Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  DOJO = dj.id;

  const c = await upsertCountry(db, ctx(), {
    iso2: 'IN', name: 'India', defaultTimezone: 'Asia/Kolkata', source: 'test',
  });
  IN = c.id;
  const assam = await upsertArea(db, ctx(), {
    countryId: IN, level: 'state', name: 'Assam', source: 'test',
  });
  const ghy = await upsertArea(db, ctx(), {
    countryId: IN, parentId: assam.id, level: 'city', name: 'Guwahati', source: 'test',
  });
  GUWAHATI = ghy.id;
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM guardian_authorizations');
  await db.execute?.('DELETE FROM consent_records');
  await db.execute?.('DELETE FROM person_relationships');
  await db.execute?.('DELETE FROM duplicate_candidates');
  await db.execute?.('DELETE FROM profile_change_requests');
  await db.execute?.('DELETE FROM person_addresses');
  await db.execute?.('DELETE FROM person_contacts');
  await db.execute?.('DELETE FROM addresses');
  await db.execute?.('DELETE FROM persons');
});

// ─── Age ────────────────────────────────────────────────────────────────────

describe('age', () => {
  it('counts whole years on the calendar, not by dividing milliseconds', () => {
    expect(ageOn('2000-06-15', new Date('2026-06-14T00:00:00Z'))).toBe(25);
    expect(ageOn('2000-06-15', new Date('2026-06-15T00:00:00Z'))).toBe(26);
  });

  it('gets a leap-year birthday right', () => {
    // The athlete born on 29 February whose age is computed by division lands
    // in the wrong competition category roughly one year in four.
    expect(ageOn('2008-02-29', new Date('2026-02-28T00:00:00Z'))).toBe(17);
    expect(ageOn('2008-02-29', new Date('2026-03-01T00:00:00Z'))).toBe(18);
  });

  it('answers NULL — not false — when the date of birth is unknown', () => {
    // The distinction the safeguarding paths depend on. A system that answers
    // "not a minor" for an unknown date of birth hands a child's record to
    // whoever asks.
    expect(isMinor(null)).toBeNull();
    expect(isMinor(undefined)).toBeNull();
    expect(isMinor('')).toBeNull();
  });

  it('identifies a minor against the federation\'s own MINOR_AGE', () => {
    expect(isMinor('2015-01-01', new Date('2026-01-01T00:00:00Z'))).toBe(true);
    expect(isMinor('2000-01-01', new Date('2026-01-01T00:00:00Z'))).toBe(false);
  });
});

// ─── Normalisation ──────────────────────────────────────────────────────────

describe('contact normalisation', () => {
  it('makes the same telephone number one value however it is written', () => {
    const forms = ['+91 98765 43210', '098765 43210', '9876543210', '+919876543210'];
    const normalised = new Set(forms.map((f) => normaliseContact('phone', f)));
    expect(normalised.size).toBe(1);
    expect([...normalised][0]).toBe('919876543210');
  });

  it('lowercases an email and leaves the local part otherwise alone', () => {
    expect(normaliseContact('email', '  Ravi@Example.IN ')).toBe('ravi@example.in');
    // Stripping dots and +tags is a Gmail convention. Applied universally it
    // declares two different mailboxes at a self-hosted domain to be one person.
    expect(normaliseContact('email', 'a.b+x@self.example'))
      .toBe('a.b+x@self.example');
  });

  it('matches a name whichever order the clerk typed it in', () => {
    expect(computeMatchKey('Pramod Kumar Pathak'))
      .toBe(computeMatchKey('Pathak Pramod Kumar'));
  });

  it('drops honorifics, so one man is not two records', () => {
    expect(computeMatchKey('Shihan Pramod Pathak')).toBe(computeMatchKey('Pramod Pathak'));
  });
});

// ─── Contacts ───────────────────────────────────────────────────────────────

describe('contacts', () => {
  it('adds a contact UNVERIFIED, always', async () => {
    const p = await makePerson('Ravi Sharma');
    const c = await addContact(db, ctx(), { personId: p, kind: 'email', value: 'ravi@example.in' });

    const rows = await db.select().from(s.personContacts).where(eq(s.personContacts.id, c.id));
    expect(rows[0].verifiedAt).toBeNull();
    expect(await hasVerifiedContact(db, p, 'email')).toBe(false);
  });

  it('has no way to add a pre-verified contact', () => {
    // Structural. Every system that has posted a credential to an unproven
    // address had a convenience flag on its intake path.
    const params = addContact.length;
    expect(params).toBe(3);                       // db, ctx, input — no `verified`
    const src = addContact.toString();
    expect(src).not.toMatch(/input\.verified/);
  });

  it('records verification only with the method and a reference', async () => {
    const p = await makePerson('Ravi Sharma');
    const c = await addContact(db, ctx(), { personId: p, kind: 'email', value: 'ravi@example.in' });

    await expect(verifyContact(db, ctx(), { contactId: c.id, method: '', ref: '' }))
      .rejects.toThrow(/method and a reference/);

    await verifyContact(db, ctx(), { contactId: c.id, method: 'email_link', ref: 'tok_123' });
    expect(await hasVerifiedContact(db, p, 'email')).toBe(true);
  });

  it('does not move the verification date on a repeat', async () => {
    const p = await makePerson('Ravi Sharma');
    const c = await addContact(db, ctx(), { personId: p, kind: 'email', value: 'ravi@example.in' });
    await verifyContact(db, ctx(), { contactId: c.id, method: 'email_link', ref: 'tok_1' });

    const first = (await db.select().from(s.personContacts)
      .where(eq(s.personContacts.id, c.id)))[0].verifiedAt;

    await verifyContact(db, ctx(), { contactId: c.id, method: 'email_link', ref: 'tok_2' });
    const second = (await db.select().from(s.personContacts)
      .where(eq(s.personContacts.id, c.id)))[0];

    // The date the federation can say it knew is the date that matters in a
    // dispute about what was sent where.
    expect(second.verifiedAt).toEqual(first);
    expect(second.verificationRef).toBe('tok_1');
  });

  it('is idempotent — re-submitting a form does not make a second row', async () => {
    const p = await makePerson('Ravi Sharma');
    const a = await addContact(db, ctx(), { personId: p, kind: 'phone', value: '+91 98765 43210' });
    const b = await addContact(db, ctx(), { personId: p, kind: 'phone', value: '098765 43210' });
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
  });

  it('keeps exactly one primary per kind, and mirrors it onto persons', async () => {
    const p = await makePerson('Ravi Sharma');
    const first = await addContact(db, ctx(), {
      personId: p, kind: 'email', value: 'old@example.in', primary: true,
    });
    const second = await addContact(db, ctx(), {
      personId: p, kind: 'email', value: 'new@example.in', primary: true,
    });

    const rows = await db.select().from(s.personContacts).where(eq(s.personContacts.personId, p));
    expect(rows.filter((r: any) => r.isPrimary)).toHaveLength(1);
    expect(rows.find((r: any) => r.isPrimary).id).toBe(second.id);

    const person = (await db.select().from(s.persons).where(eq(s.persons.id, p)))[0];
    expect(person.email).toBe('new@example.in');
    expect(first.id).not.toBe(second.id);
  });

  it('refuses an address that is not one', async () => {
    const p = await makePerson('Ravi Sharma');
    await expect(addContact(db, ctx(), { personId: p, kind: 'email', value: 'not-an-email' }))
      .rejects.toThrow(/email address/);
  });

  it('retires a contact rather than deleting it', async () => {
    const p = await makePerson('Ravi Sharma');
    const c = await addContact(db, ctx(), { personId: p, kind: 'phone', value: '9876543210' });
    await supersedeContact(db, ctx(), { contactId: c.id, status: 'revoked', reason: 'Wrong number' });

    const rows = await db.select().from(s.personContacts).where(eq(s.personContacts.id, c.id));
    expect(rows).toHaveLength(1);                 // still there — it is history
    expect(rows[0].status).toBe('revoked');
  });

  it('does not put the contact VALUE into the audit trail', async () => {
    const p = await makePerson('Ravi Sharma');
    await addContact(db, ctx(), { personId: p, kind: 'phone', value: '9876543210' });

    const events = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'person_contact'));
    const dumped = JSON.stringify(events);
    // An audit trail readable by every auditor must not become a second,
    // unprotected copy of the federation's telephone directory.
    expect(dumped).not.toContain('9876543210');
  });

  it('refuses a reader without person:read_pii', async () => {
    const p = await makePerson('Ravi Sharma');
    await addContact(db, ctx(), { personId: p, kind: 'email', value: 'ravi@example.in' });
    await expect(contactsFor(db, member, p)).rejects.toThrow();
  });
});

// ─── Addresses ──────────────────────────────────────────────────────────────

describe('addresses', () => {
  it('keeps one current address per kind and closes the previous window', async () => {
    const p = await makePerson('Ravi Sharma');
    await setPersonAddress(db, ctx(), {
      personId: p, kind: 'home', validFrom: '2024-01-01',
      address: { countryId: IN, line1: 'Old House', localityText: 'Guwahati' },
    });
    await setPersonAddress(db, ctx(), {
      personId: p, kind: 'home', validFrom: '2026-01-01',
      address: { countryId: IN, line1: 'New House', localityText: 'Guwahati' },
    });

    const history = await addressHistory(db, admin, p);
    expect(history).toHaveLength(2);
    const open = history.filter((h: any) => h.validTo == null);
    expect(open).toHaveLength(1);
    expect(open[0].validFrom).toBe('2026-01-01');
  });

  it('mirrors the civil area onto the person for a HOME address only', async () => {
    const p = await makePerson('Ravi Sharma');
    await setPersonAddress(db, ctx(), {
      personId: p, kind: 'training',
      address: { countryId: IN, localityText: 'Guwahati' },
    });
    let person = (await db.select().from(s.persons).where(eq(s.persons.id, p)))[0];
    expect(person.residenceAreaId).toBeNull();     // a training venue is not where they live

    await setPersonAddress(db, ctx(), {
      personId: p, kind: 'home',
      address: { countryId: IN, localityText: 'Guwahati' },
    });
    person = (await db.select().from(s.persons).where(eq(s.persons.id, p)))[0];
    expect(person.residenceAreaId).toBe(GUWAHATI);
  });

  it('does not write the address lines into the audit trail', async () => {
    const p = await makePerson('A Child', { dob: '2015-03-03' });
    await setPersonAddress(db, ctx(), {
      personId: p, kind: 'home',
      address: { countryId: IN, line1: '7 Secret Lane', localityText: 'Guwahati' },
    });

    const events = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'person_address'));
    // Where a child lives is the most sensitive field in this schema, and an
    // audit trail is read by more people than the record itself.
    expect(JSON.stringify(events)).not.toContain('Secret Lane');
  });
});

// ─── Guardianship — the security spine ──────────────────────────────────────

describe('guardianship', () => {
  let parent: number, child: number, stranger: number;

  beforeEach(async () => {
    parent = await makePerson('Meera Sharma');
    child = await makePerson('Anaya Sharma', { dob: '2015-04-04' });
    stranger = await makePerson('Unrelated Child', { dob: '2016-05-05' });
  });

  it('records a claim as ASSERTED, which confers nothing', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });

    const rows = await db.select().from(s.personRelationships)
      .where(eq(s.personRelationships.id, r.id));
    expect(rows[0].status).toBe('asserted');

    for (const cap of GUARDIAN_CAPABILITIES) {
      expect(await guardianCan(db, {
        guardianPersonId: parent, subjectPersonId: child, capability: cap,
      })).toBe(false);
    }
  });

  it('refuses to grant a capability on an unverified relationship', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await expect(grantGuardianCapability(db, ctx(), {
      relationshipId: r.id, capability: 'view_profile',
    })).rejects.toThrow(/VERIFIED/);
  });

  it('STILL confers nothing once verified, until a capability is granted', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(), {
      relationshipId: r.id, decision: 'verified', reason: 'Birth certificate seen',
    });

    // Being a parent is not a permission. This is the assertion behind the
    // federation's own sentence about 'parent' status.
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(false);
  });

  it('grants exactly the capability named, and nothing adjacent', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(), {
      relationshipId: r.id, decision: 'verified', reason: 'Birth certificate seen',
    });
    await grantGuardianCapability(db, ctx(), {
      relationshipId: r.id, capability: 'view_attendance',
    });

    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_attendance',
    })).toBe(true);
    // No implication anywhere: an implied capability is one nobody granted.
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_results',
    })).toBe(false);
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_medical',
    })).toBe(false);
  });

  it('REFUSES an operational admin granting sight of the safeguarding file', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(), {
      relationshipId: r.id, decision: 'verified', reason: 'Seen',
    });

    // A FEDERATION_ADMIN holds 'guardian:verify' and can attach the parent —
    // and still cannot open that door, because the grant is gated twice.
    await expect(grantGuardianCapability(db, ctx(admin), {
      relationshipId: r.id, capability: 'view_safeguarding',
    })).rejects.toThrow();

    await expect(grantGuardianCapability(db, ctx(admin), {
      relationshipId: r.id, capability: 'view_medical',
    })).rejects.toThrow();
  });

  it('allows the safeguarding officer to grant the safeguarding capability', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(safeguarding), {
      relationshipId: r.id, decision: 'verified', reason: 'Seen',
    });
    await grantGuardianCapability(db, ctx(safeguarding), {
      relationshipId: r.id, capability: 'view_safeguarding',
    });
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_safeguarding',
    })).toBe(true);
  });

  it('makes a guardian of one child a stranger to another', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(), { relationshipId: r.id, decision: 'verified', reason: 'Seen' });
    await grantGuardianCapability(db, ctx(), { relationshipId: r.id, capability: 'view_profile' });

    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: stranger, capability: 'view_profile',
    })).toBe(false);
  });

  it('revokes the capabilities along with the relationship', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(), { relationshipId: r.id, decision: 'verified', reason: 'Seen' });
    await grantGuardianCapability(db, ctx(), { relationshipId: r.id, capability: 'view_profile' });
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(true);

    await revokeRelationship(db, ctx(), { relationshipId: r.id, reason: 'Court order' });

    // The failure mode of doing these separately: a guardianship that has ended
    // and a set of capabilities that has not.
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(false);
  });

  it('honours an expiry on the grant', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(), { relationshipId: r.id, decision: 'verified', reason: 'Seen' });
    await grantGuardianCapability(db, ctx(), {
      relationshipId: r.id, capability: 'view_profile',
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    });
    expect(await guardianCan(db, {
      guardianPersonId: parent, subjectPersonId: child, capability: 'view_profile',
    })).toBe(false);
  });

  it('refuses a decision without a reason, and a self-relationship', async () => {
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await expect(decideRelationship(db, ctx(), {
      relationshipId: r.id, decision: 'verified', reason: '  ',
    })).rejects.toThrow(/reason/);

    await expect(assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: parent, type: 'parent',
    })).rejects.toThrow(/themselves/);
  });

  it('refuses a dojo administrator verifying a guardianship', async () => {
    // They hold 'person:write' so they can fix a telephone number. Attaching an
    // adult to a child's record is a different kind of act.
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await expect(decideRelationship(db, ctx(dojoAdmin), {
      relationshipId: r.id, decision: 'verified', reason: 'Seen',
    })).rejects.toThrow();
  });

  it('lists dependants only where the relationship is verified', async () => {
    const r1 = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    await decideRelationship(db, ctx(), { relationshipId: r1.id, decision: 'verified', reason: 'Seen' });
    await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: stranger, type: 'parent',
    });

    const kids = await dependantsOf(db, parent);
    expect(kids.map((k: any) => k.personId)).toEqual([child]);
  });

  it('shows an admin every claim, verified or not', async () => {
    await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    const all = await guardiansOf(db, admin, child);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('asserted');
  });
});

// ─── Consent ────────────────────────────────────────────────────────────────

describe('consent', () => {
  let parent: number, child: number, relId: number;

  beforeEach(async () => {
    parent = await makePerson('Meera Sharma');
    child = await makePerson('Anaya Sharma', { dob: '2015-04-04' });
    const r = await assertRelationship(db, ctx(), {
      holderPersonId: parent, subjectPersonId: child, type: 'parent',
    });
    relId = r.id;
    await decideRelationship(db, ctx(), { relationshipId: relId, decision: 'verified', reason: 'Seen' });
  });

  it('demands the policy VERSION', async () => {
    await expect(recordConsent(db, ctx(), {
      subjectPersonId: child, policyKey: 'photo', policyVersion: '',
      decision: 'granted', capacity: 'staff',
    })).rejects.toThrow(/VERSION/);
  });

  it('does not consider version 1 to be consent to version 4', async () => {
    await recordConsent(db, ctx(), {
      subjectPersonId: child, policyKey: 'photo', policyVersion: '1',
      decision: 'granted', capacity: 'staff',
    });
    expect(await isConsentInForce(db, child, 'photo', '1')).toBe(true);
    expect(await isConsentInForce(db, child, 'photo', '4')).toBe(false);
  });

  it('records a withdrawal as a NEW row, keeping the history', async () => {
    await recordConsent(db, ctx(), {
      subjectPersonId: child, policyKey: 'photo', policyVersion: '1',
      decision: 'granted', capacity: 'staff',
    });
    await recordConsent(db, ctx(), {
      subjectPersonId: child, policyKey: 'photo', policyVersion: '1',
      decision: 'withdrawn', capacity: 'staff',
    });

    expect(await isConsentInForce(db, child, 'photo', '1')).toBe(false);
    const history = await consentHistory(db, admin, child, 'photo');
    // Only one of a record and a flag can answer "was consent in force when
    // that photograph was taken?".
    expect(history).toHaveLength(2);
    expect(history.map((h: any) => h.decision)).toEqual(['withdrawn', 'granted']);
  });

  it('CHECKS the authority behind guardian consent rather than believing it', async () => {
    // Without the capability, the guardian capacity is a free-text assertion by
    // whoever submitted the form.
    await expect(recordConsent(db, ctx(), {
      subjectPersonId: child, policyKey: 'photo', policyVersion: '1',
      decision: 'granted', capacity: 'guardian', givenByPersonId: parent,
    })).rejects.toThrow(/does not hold a verified guardianship/);

    await grantGuardianCapability(db, ctx(), { relationshipId: relId, capability: 'give_consent' });

    const ok = await recordConsent(db, ctx(), {
      subjectPersonId: child, policyKey: 'photo', policyVersion: '1',
      decision: 'granted', capacity: 'guardian', givenByPersonId: parent, relationshipId: relId,
    });
    expect(ok.id).toBeGreaterThan(0);
  });

  it('refuses guardian consent that names nobody', async () => {
    await expect(recordConsent(db, ctx(), {
      subjectPersonId: child, policyKey: 'photo', policyVersion: '1',
      decision: 'granted', capacity: 'guardian',
    })).rejects.toThrow(/must name the person/);
  });

  it('has no update path — the table is append-only', async () => {
    const mod = await import('../src/db/identity');
    const src = Object.values(mod)
      .filter((v) => typeof v === 'function')
      .map((f: any) => f.toString())
      .join('\n');
    // Discipline is not a guarantee; this is.
    expect(src).not.toMatch(/update\(\s*idn\.consentRecords/);
  });

  it('reports no consent at all as not in force', async () => {
    expect(await isConsentInForce(db, child, 'photo', '1')).toBe(false);
    expect(await currentConsent(db, child, 'photo')).toBeNull();
  });
});

// ─── Duplicates ─────────────────────────────────────────────────────────────

describe('duplicate detection', () => {
  it('raises a candidate on a shared verified telephone', async () => {
    const a = await makePerson('Ravi Sharma');
    const b = await makePerson('R Sharma');

    const ca = await addContact(db, ctx(), { personId: a, kind: 'phone', value: '9876543210' });
    const cb = await addContact(db, ctx(), { personId: b, kind: 'phone', value: '+91 98765 43210' });
    await verifyContact(db, ctx(), { contactId: ca.id, method: 'otp', ref: 'r1' });
    await verifyContact(db, ctx(), { contactId: cb.id, method: 'otp', ref: 'r2' });

    const raised = await detectPersonDuplicates(db, b);
    expect(raised).toHaveLength(1);
    expect(raised[0].otherPersonId).toBe(a);
    expect(raised[0].signals).toContain('verified_phone');
  });

  it('raises on the same name and date of birth', async () => {
    const dob = '2001-02-03';
    const a = await makePerson('Ravi Kumar Sharma', { dob });
    const b = await makePerson('Sharma Ravi Kumar', { dob });

    const raised = await detectPersonDuplicates(db, b);
    expect(raised.map((r) => r.otherPersonId)).toContain(a);
  });

  it('stores the pair once, whichever side detection runs from', async () => {
    const dob = '2001-02-03';
    const a = await makePerson('Ravi Kumar Sharma', { dob });
    const b = await makePerson('Sharma Ravi Kumar', { dob });

    await detectPersonDuplicates(db, b);
    await detectPersonDuplicates(db, a);

    const rows = await db.select().from(s.duplicateCandidates);
    // The CHECK on left_id < right_id plus the partial unique index. Two rows
    // would let two reviewers disagree about whether two records are one human.
    expect(rows).toHaveLength(1);
    expect(rows[0].leftId).toBeLessThan(rows[0].rightId);
  });

  it('does NOT block registration — it raises a question', async () => {
    const dob = '2001-02-03';
    await makePerson('Ravi Kumar Sharma', { dob });
    const b = await makePerson('Sharma Ravi Kumar', { dob });

    // The second person exists, is active, and has a federation id.
    const rows = await db.select().from(s.persons).where(eq(s.persons.id, b));
    expect(rows[0].status).toBe('active');
    await detectPersonDuplicates(db, b);
    expect((await db.select().from(s.persons).where(eq(s.persons.id, b)))[0].status).toBe('active');
  });

  it('scores a weak name-and-area match below the review threshold', async () => {
    const a = await makePerson('Ravi Sharma', { residenceAreaId: GUWAHATI });
    const b = await makePerson('Sharma Ravi', { residenceAreaId: GUWAHATI });
    const raised = await detectPersonDuplicates(db, b);
    // In a country with a great many common names this fires constantly;
    // scoring it highly would bury the real matches.
    expect(raised).toHaveLength(0);
    expect(a).toBeGreaterThan(0);
  });

  it('records a decision and performs NO merge', async () => {
    const dob = '2001-02-03';
    const a = await makePerson('Ravi Kumar Sharma', { dob });
    const b = await makePerson('Sharma Ravi Kumar', { dob });
    await detectPersonDuplicates(db, b);

    const queue = await duplicateQueue(db, admin);
    expect(queue).toHaveLength(1);

    await decideDuplicate(db, ctx(), {
      candidateId: queue[0].id, decision: 'merged',
      reason: 'Same athlete, confirmed by the dojo', mergedIntoId: a,
    });

    // Both people are still there. A merge is a policy MMAKF has not written,
    // and acting on it here would be inventing it at the least visible moment.
    const both = await db.select().from(s.persons).where(sql`id in (${a}, ${b})`);
    expect(both).toHaveLength(2);

    const decided = await db.select().from(s.duplicateCandidates)
      .where(eq(s.duplicateCandidates.id, queue[0].id));
    expect(decided[0].status).toBe('merged');
    expect(decided[0].mergedIntoId).toBe(a);
  });

  it('refuses a decision with no reason, and a merge naming an outsider', async () => {
    const dob = '2001-02-03';
    await makePerson('Ravi Kumar Sharma', { dob });
    const b = await makePerson('Sharma Ravi Kumar', { dob });
    const outsider = await makePerson('Somebody Else');
    await detectPersonDuplicates(db, b);
    const queue = await duplicateQueue(db, admin);

    await expect(decideDuplicate(db, ctx(), {
      candidateId: queue[0].id, decision: 'distinct', reason: '',
    })).rejects.toThrow(/reason/);

    await expect(decideDuplicate(db, ctx(), {
      candidateId: queue[0].id, decision: 'merged',
      reason: 'x', mergedIntoId: outsider,
    })).rejects.toThrow(/one of the two/);
  });

  it('refuses the queue to somebody without duplicate:review', async () => {
    await expect(duplicateQueue(db, dojoAdmin)).rejects.toThrow();
    await expect(duplicateQueue(db, member)).rejects.toThrow();
  });
});

// ─── Governed profile changes ───────────────────────────────────────────────

describe('governed profile changes', () => {
  it('names the fields where an unreviewed edit changes an outcome', () => {
    expect(isGovernedField('dob')).toBe(true);
    expect(isGovernedField('fullName')).toBe(true);
    expect(isGovernedField('nationality')).toBe(true);
    // Not everything is governed. A member correcting a landline should not
    // wait on a committee.
    expect(isGovernedField('phone')).toBe(false);
    expect(isGovernedField('photoUrl')).toBe(false);
    expect(GOVERNED_FIELDS.length).toBeGreaterThan(0);
  });

  it('refuses a change request for an ungoverned field', async () => {
    const p = await makePerson('Ravi Sharma');
    await expect(requestProfileChange(db, ctx(), {
      personId: p, field: 'phone', newValue: '9999999999',
    })).rejects.toThrow(/not a governed field/);
  });

  it('captures the old value from the record, not from the caller', async () => {
    const p = await makePerson('Ravi Sharma', { dob: '2001-02-03' });
    const r = await requestProfileChange(db, ctx(), {
      personId: p, field: 'dob', newValue: '2001-03-02',
      evidence: { document: 'birth certificate' },
    });

    const rows = await db.select().from(s.profileChangeRequests)
      .where(eq(s.profileChangeRequests.id, r.id));
    expect(rows[0].oldValue).toBe('2001-02-03');
    expect(rows[0].ref).toMatch(/^MMAKF-PCR-/);
  });

  it('allows only one open request per person per field', async () => {
    const p = await makePerson('Ravi Sharma', { dob: '2001-02-03' });
    await requestProfileChange(db, ctx(), { personId: p, field: 'dob', newValue: '2001-03-02' });
    // Two reviewers approving two different dates of birth, and the second
    // silently wins.
    await expect(requestProfileChange(db, ctx(), {
      personId: p, field: 'dob', newValue: '2001-04-04',
    })).rejects.toThrow(/already an open request/);
  });

  it('applies an approved change and stamps appliedAt', async () => {
    const p = await makePerson('Ravi Sharma', { dob: '2001-02-03' });
    const requester: Principal = {
      userId: 20, label: 'the member', bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
    };
    const r = await requestProfileChange(db, {
      principal: { ...requester, bindings: admin.bindings }, reason: 't', authority: 't',
    }, { personId: p, field: 'dob', newValue: '2001-03-02' });

    const out = await decideProfileChange(db, ctx(), {
      requestId: r.id, decision: 'approved', reason: 'Certificate verified',
    });
    expect(out.applied).toBe(true);

    const person = (await db.select().from(s.persons).where(eq(s.persons.id, p)))[0];
    expect(person.dob).toBe('2001-03-02');

    const req = (await db.select().from(s.profileChangeRequests)
      .where(eq(s.profileChangeRequests.id, r.id)))[0];
    expect(req.appliedAt).not.toBeNull();
  });

  it('REFUSES to apply when the record moved underneath the decision', async () => {
    const p = await makePerson('Ravi Sharma', { dob: '2001-02-03' });
    const r = await requestProfileChange(db, {
      principal: { ...admin, userId: 20 }, reason: 't', authority: 't',
    }, { personId: p, field: 'dob', newValue: '2001-03-02' });

    // Somebody corrects it while the request sits in the queue.
    await db.update(s.persons).set({ dob: '2001-05-05' }).where(eq(s.persons.id, p));

    await expect(decideProfileChange(db, ctx(), {
      requestId: r.id, decision: 'approved', reason: 'Certificate verified',
    })).rejects.toThrow(/changed since this request was filed/);

    const person = (await db.select().from(s.persons).where(eq(s.persons.id, p)))[0];
    expect(person.dob).toBe('2001-05-05');       // the correction stands
  });

  it('refuses the requester deciding their own request', async () => {
    const p = await makePerson('Ravi Sharma', { dob: '2001-02-03' });
    const selfCtx: AuditContext = {
      principal: { ...admin, userId: 42 }, reason: 't', authority: 't',
    };
    const r = await requestProfileChange(db, selfCtx, {
      personId: p, field: 'dob', newValue: '2001-03-02',
    });
    // Otherwise a governed change is an edit with extra steps.
    await expect(decideProfileChange(db, selfCtx, {
      requestId: r.id, decision: 'approved', reason: 'Mine',
    })).rejects.toThrow(/somebody other than/);
  });

  it('moves the match key with an approved name change', async () => {
    const p = await makePerson('Ravi Sharma');
    const r = await requestProfileChange(db, {
      principal: { ...admin, userId: 20 }, reason: 't', authority: 't',
    }, { personId: p, field: 'fullName', newValue: 'Ravi Verma' });
    await decideProfileChange(db, ctx(), {
      requestId: r.id, decision: 'approved', reason: 'Deed poll seen',
    });

    const person = (await db.select().from(s.persons).where(eq(s.persons.id, p)))[0];
    // A stale key would go on matching the name the person no longer has.
    expect(person.matchKey).toBe(computeMatchKey('Ravi Verma'));
  });

  it('records a rejection without touching the record', async () => {
    const p = await makePerson('Ravi Sharma', { dob: '2001-02-03' });
    const r = await requestProfileChange(db, {
      principal: { ...admin, userId: 20 }, reason: 't', authority: 't',
    }, { personId: p, field: 'dob', newValue: '2001-03-02' });

    const out = await decideProfileChange(db, ctx(), {
      requestId: r.id, decision: 'rejected', reason: 'No evidence supplied',
    });
    expect(out.applied).toBe(false);
    const person = (await db.select().from(s.persons).where(eq(s.persons.id, p)))[0];
    expect(person.dob).toBe('2001-02-03');
  });

  it('refuses the queue to somebody without profilechange:decide', async () => {
    await expect(profileChangeQueue(db, dojoAdmin)).rejects.toThrow();
  });

  it('reports an identity error by shape, not by instanceof', async () => {
    const p = await makePerson('Ravi Sharma');
    try {
      await requestProfileChange(db, ctx(), { personId: p, field: 'phone', newValue: 'x' });
      expect.unreachable();
    } catch (err) {
      expect(isIdentityError(err)).toBe(true);
    }
  });
});

// ─── Backfill ───────────────────────────────────────────────────────────────

describe('match key backfill', () => {
  it('fills only the missing keys, in keyset batches', async () => {
    const a = await makePerson('Ravi Sharma');
    await db.update(s.persons).set({ matchKey: null }).where(eq(s.persons.id, a));

    const first = await backfillMatchKeys(db, { batch: 10 });
    expect(first.updated).toBeGreaterThanOrEqual(1);

    const person = (await db.select().from(s.persons).where(eq(s.persons.id, a)))[0];
    expect(person.matchKey).toBe(computeMatchKey('Ravi Sharma'));

    const second = await backfillMatchKeys(db, { batch: 10 });
    expect(second.updated).toBe(0);               // idempotent
  });

  it('does not invent name parts by splitting on spaces', async () => {
    const a = await makePerson('Shihan Pramod Kumar Pathak');
    await db.update(s.persons).set({ matchKey: null }).where(eq(s.persons.id, a));
    await backfillMatchKeys(db, { batch: 10 });

    const person = (await db.select().from(s.persons).where(eq(s.persons.id, a)))[0];
    // A wrong parse is worse than an absent one: nothing downstream can tell it
    // was guessed. 'Kumar' is not this man's family name.
    expect(person.givenName).toBeNull();
    expect(person.familyName).toBeNull();
    expect(person.matchKey).not.toContain('shihan');
  });
});
