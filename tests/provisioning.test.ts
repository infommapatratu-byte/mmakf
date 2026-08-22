// From an approved application to a person in the register.
//
// This closes the break the identity foundation was built on the wrong side of:
// migration 0025 gave the federation verified contacts, an address history, a
// consent ledger and duplicate detection, and nothing in the repository ever
// created a `persons` row for any of them to hang off.
//
// The spine of this suite is the four things that must be true of a provisioning
// step running behind a queue decision an administrator has already taken:
//
//   · IT IS SAFE TO RUN TWICE. An approval gets retried, and a second person is
//     the one outcome that cannot be undone.
//   · IT NEVER LOSES A REGISTRATION. An address that will not resolve, a
//     duplicate, a missing state unit — each is reported and none is fatal.
//   · IT CONFERS NOTHING IT HAS NOT BEEN GIVEN. Contacts arrive unverified; a
//     guardian's claim arrives asserted and grants no sight of the child.
//   · IT INVENTS NOTHING. In particular it records no MMAKF policy version, for
//     the very good reason that MMAKF has published none.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  provisionFromRegistration, consentWordingVersion, isProvisioningError,
} from '../src/db/provisioning';
import { guardianCan, GUARDIAN_CAPABILITIES, dependantsOf } from '../src/db/identity';
import { upsertCountry, upsertArea } from '../src/db/geography';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let ASSAM: number, IN_COUNTRY: number, GUWAHATI: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx = (p: Principal = admin): AuditContext => ({
  principal: p, reason: 'approved at the desk', authority: 'test',
});

let seq = 800000;
/** A registration record as src/pages/api/register.ts stores one. */
function application(over: Record<string, any> = {}) {
  return {
    id: `rec-${seq++}`,
    appNo: `MMAKF-R-${seq}`,
    type: 'Instructor',
    category: 'instructor',
    name: 'Ravi Kumar Sharma',
    email: 'ravi@example.in',
    phone: '+91 98765 43210',
    state: 'Assam',
    district: 'Kamrup',
    city: 'Guwahati',
    postalCode: '781005',
    addressLine1: '12 GS Road',
    dob: '1990-05-05',
    gender: 'Male',
    consentAccuracy: 'on',
    consentDataUse: 'on',
    status: 'Approved',
    ...over,
  };
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

  await db.insert(s.users).values({ id: 1, email: 'a@test.invalid', status: 'active' })
    .onConflictDoNothing();

  const [a] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-AS', state: 'Assam', name: 'Assam', status: 'active',
  }).returning({ id: s.stateUnits.id });
  ASSAM = a.id;
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM consent_records');
  await db.execute?.('DELETE FROM guardian_authorizations');
  await db.execute?.('DELETE FROM person_relationships');
  await db.execute?.('DELETE FROM duplicate_candidates');
  await db.execute?.('DELETE FROM person_addresses');
  await db.execute?.('DELETE FROM person_contacts');
  await db.execute?.('DELETE FROM memberships');
  await db.execute?.('DELETE FROM persons');
  await db.execute?.('DELETE FROM addresses');
  await db.execute?.('DELETE FROM postal_codes');
  await db.execute?.('DELETE FROM geo_aliases');
  await db.execute?.('DELETE FROM admin_areas');
  await db.execute?.('DELETE FROM countries');
});

async function loadMap() {
  const c = await upsertCountry(db, ctx(), {
    iso2: 'IN', name: 'India', defaultTimezone: 'Asia/Kolkata', source: 'test',
  });
  IN_COUNTRY = c.id;
  const assam = await upsertArea(db, ctx(), {
    countryId: IN_COUNTRY, level: 'state', name: 'Assam', source: 'test',
  });
  const g = await upsertArea(db, ctx(), {
    countryId: IN_COUNTRY, parentId: assam.id, level: 'city', name: 'Guwahati', source: 'test',
  });
  GUWAHATI = g.id;
}

// ─── The person ─────────────────────────────────────────────────────────────

describe('an approval creates the person', () => {
  it('creates one person, placed under the state unit the application named', async () => {
    const rec = application();
    const out = await provisionFromRegistration(db, ctx(), rec);

    expect(out.personCreated).toBe(true);
    expect(out.federationId).toMatch(/^MMAKF-MEM-/);

    const rows = await db.select().from(s.persons).where(eq(s.persons.id, out.personId));
    expect(rows).toHaveLength(1);
    expect(rows[0].fullName).toBe('Ravi Kumar Sharma');
    expect(rows[0].stateUnitId).toBe(ASSAM);
    // Created BY a decision, so active — not left pending, which would make
    // /verify report an approved member as pending for ever.
    expect(rows[0].status).toBe('active');
    // Derived, never typed.
    expect(rows[0].matchKey).toBeTruthy();
  });

  it('DOES NOT create a second person when the approval is retried', async () => {
    // The outcome that cannot be undone. Idempotency comes from
    // createPersonForSource() and the partial unique index on source_ref.
    const rec = application();
    const first = await provisionFromRegistration(db, ctx(), rec);
    const second = await provisionFromRegistration(db, ctx(), rec);

    expect(second.personId).toBe(first.personId);
    expect(second.personCreated).toBe(false);

    const all = await db.select().from(s.persons);
    expect(all).toHaveLength(1);
  });

  it('does not duplicate the address or the contacts on a retry either', async () => {
    await loadMap();
    const rec = application();
    await provisionFromRegistration(db, ctx(), rec);
    await provisionFromRegistration(db, ctx(), rec);

    const addresses = await db.select().from(s.personAddresses);
    expect(addresses).toHaveLength(1);
    const contacts = await db.select().from(s.personContacts);
    expect(contacts).toHaveLength(2);            // one email, one phone
  });

  it('refuses an application with no id rather than risking a second person', async () => {
    // Without a source ref there is nothing to tie the person back to, so a
    // re-run WOULD create a second one. Refusing is the safe direction.
    await expect(provisionFromRegistration(db, ctx(), application({ id: '' })))
      .rejects.toThrow(/no id/);
    expect(await db.select().from(s.persons)).toHaveLength(0);
  });

  it('registers somebody whose state is not a chartered unit, and says so', async () => {
    // The case the old schema could not express. A member in a state MMAKF has
    // not chartered is exactly who the federation is trying to reach.
    const out = await provisionFromRegistration(db, ctx(), application({ state: 'Kerala' }));
    const rows = await db.select().from(s.persons).where(eq(s.persons.id, out.personId));
    expect(rows[0].stateUnitId).toBeNull();
    expect(out.notes.join(' ')).toMatch(/not in the federation's unit register/);
  });

  it('reports a provisioning error by shape, not by instanceof', async () => {
    try {
      await provisionFromRegistration(db, ctx(), application({ id: '' }));
      expect.unreachable();
    } catch (err) {
      expect(isProvisioningError(err)).toBe(true);
    }
  });
});

// ─── The address ────────────────────────────────────────────────────────────

describe('the address', () => {
  it('is recorded and resolved when the map is loaded', async () => {
    await loadMap();
    const out = await provisionFromRegistration(db, ctx(), application());

    expect(out.addressId).not.toBeNull();
    expect(out.areaId).toBe(GUWAHATI);

    const person = (await db.select().from(s.persons).where(eq(s.persons.id, out.personId)))[0];
    expect(person.residenceAreaId).toBe(GUWAHATI);
  });

  it('is STORED UNRESOLVED when the locality is not in the register', async () => {
    await loadMap();
    const out = await provisionFromRegistration(db, ctx(), application({ city: 'Nowhere-in-the-map' }));

    expect(out.addressId).not.toBeNull();
    expect(out.areaId).toBeNull();
    // The applicant's own words survive, so the row can be re-resolved later.
    const addr = (await db.select().from(s.addresses).where(eq(s.addresses.id, out.addressId!)))[0];
    expect(addr.localityText).toBe('Nowhere-in-the-map');
    expect(out.notes.join(' ')).toMatch(/could not be resolved/);
  });

  it('does not fail the registration when no country is loaded at all', async () => {
    // The state every deployment is in today: the geography tables ship empty.
    const out = await provisionFromRegistration(db, ctx(), application());
    expect(out.personId).toBeGreaterThan(0);
    expect(out.addressId).toBeNull();
    expect(out.notes.join(' ')).toMatch(/place register holds no country/);
  });
});

// ─── The contacts ───────────────────────────────────────────────────────────

describe('the contacts', () => {
  it('are recorded UNVERIFIED', async () => {
    const out = await provisionFromRegistration(db, ctx(), application());
    expect(out.contactsAdded).toBe(2);

    const contacts = await db.select().from(s.personContacts)
      .where(eq(s.personContacts.personId, out.personId));
    expect(contacts).toHaveLength(2);
    for (const c of contacts) {
      expect(c.verifiedAt, `${c.kind} was created verified`).toBeNull();
    }
    expect(out.notes.join(' ')).toMatch(/UNVERIFIED/);
  });

  it('normalises the telephone so a duplicate can be spotted later', async () => {
    const out = await provisionFromRegistration(db, ctx(), application());
    const phone = (await db.select().from(s.personContacts)
      .where(eq(s.personContacts.personId, out.personId)))
      .find((c: any) => c.kind === 'phone');
    expect(phone.normalized).toBe('919876543210');
    expect(phone.value).toBe('+91 98765 43210');   // kept verbatim too
  });
});

// ─── Consent ────────────────────────────────────────────────────────────────

describe('consent', () => {
  it('records one row per ticked box, with a version', async () => {
    const out = await provisionFromRegistration(db, ctx(), application());
    expect(out.consentsRecorded).toBe(2);

    const rows = await db.select().from(s.consentRecords)
      .where(eq(s.consentRecords.subjectPersonId, out.personId));
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.policyVersion).toBeTruthy();
      expect(r.decision).toBe('granted');
    }
  });

  it('records NO MMAKF policy version, because MMAKF has published none', async () => {
    // The invariant that matters most here. A plausible '1.0' in this column
    // would be indistinguishable from a reference to a real federation
    // instrument, and there is no such instrument.
    const out = await provisionFromRegistration(db, ctx(), application());
    const rows = await db.select().from(s.consentRecords)
      .where(eq(s.consentRecords.subjectPersonId, out.personId));
    for (const r of rows) {
      expect(r.policyVersion).toMatch(/^wording:/);
      expect(r.policyVersion).not.toMatch(/^v?\d+(\.\d+)*$/);
    }
  });

  it('changes the version when the wording changes, and not otherwise', () => {
    const a = consentWordingVersion('consentDataUse');
    const b = consentWordingVersion('consentDataUse');
    expect(a).toBe(b);                                   // stable
    expect(consentWordingVersion('consentAccuracy')).not.toBe(a);
  });

  it('does not record a consent nobody ticked', async () => {
    // consentPhotography is optional and left unticked here.
    const out = await provisionFromRegistration(db, ctx(), application());
    const rows = await db.select().from(s.consentRecords)
      .where(eq(s.consentRecords.subjectPersonId, out.personId));
    expect(rows.map((r: any) => r.policyKey)).not.toContain('media.photography');
  });

  it('refuses to version a consent the form does not ask for', () => {
    expect(() => consentWordingVersion('consentInvented')).toThrow(/not a consent/);
  });
});

// ─── A minor, and the guardian's claim ──────────────────────────────────────

describe('a minor', () => {
  const minorApp = (over: Record<string, any> = {}) => application({
    type: 'Athlete',
    category: 'athlete',
    name: 'Anaya Sharma',
    dob: '2015-04-04',
    guardianName: 'Meera Sharma',
    guardianRelation: 'Mother',
    guardianPhone: '9876500000',
    consentGuardian: 'on',
    consentMedical: 'on',
    ...over,
  });

  it('creates the guardian and an ASSERTED relationship that grants nothing', async () => {
    const out = await provisionFromRegistration(db, ctx(), minorApp());

    expect(out.guardianPersonId).not.toBeNull();
    expect(out.guardianRelationshipId).not.toBeNull();

    const rel = (await db.select().from(s.personRelationships)
      .where(eq(s.personRelationships.id, out.guardianRelationshipId!)))[0];
    expect(rel.status).toBe('asserted');

    // THE POINT. An adult named on a form can see nothing.
    for (const cap of GUARDIAN_CAPABILITIES) {
      expect(await guardianCan(db, {
        guardianPersonId: out.guardianPersonId!,
        subjectPersonId: out.personId,
        capability: cap,
      }), `asserted guardianship granted ${cap}`).toBe(false);
    }
    // And the child does not appear on the guardian's own family page.
    expect(await dependantsOf(db, out.guardianPersonId!)).toHaveLength(0);
  });

  it('creates the guardian as PENDING — they have applied for nothing', async () => {
    const out = await provisionFromRegistration(db, ctx(), minorApp());
    const g = (await db.select().from(s.persons)
      .where(eq(s.persons.id, out.guardianPersonId!)))[0];
    expect(g.status).toBe('pending');
  });

  it('records guardian consent as the OFFICE\'s, with the claim preserved', async () => {
    // recordConsent() refuses capacity 'guardian' without a verified
    // guardianship — correctly. So what is recorded is what actually happened:
    // the federation noted a ticked box in which somebody claimed to be the
    // guardian.
    const out = await provisionFromRegistration(db, ctx(), minorApp());
    const rows = await db.select().from(s.consentRecords)
      .where(eq(s.consentRecords.subjectPersonId, out.personId));

    const guardianConsent = rows.find((r: any) => r.policyKey === 'guardian.application');
    expect(guardianConsent).toBeTruthy();
    expect(guardianConsent.capacity).toBe('staff');
    expect(guardianConsent.givenByPersonId).toBe(out.guardianPersonId);
    expect(guardianConsent.relationshipId).toBe(out.guardianRelationshipId);
    expect((guardianConsent.evidence as any).claimedCapacity).toBe('guardian');
    expect((guardianConsent.evidence as any).guardianRelationshipStatus).toBe('asserted');
  });

  it('does not create a relationship twice on a retry', async () => {
    const rec = minorApp();
    await provisionFromRegistration(db, ctx(), rec);
    await provisionFromRegistration(db, ctx(), rec);
    expect(await db.select().from(s.personRelationships)).toHaveLength(1);
    // Two persons only: the child and the guardian.
    expect(await db.select().from(s.persons)).toHaveLength(2);
  });

  it('flags a minor with no guardian named rather than proceeding quietly', async () => {
    const out = await provisionFromRegistration(db, ctx(),
      minorApp({ guardianName: '' }));
    expect(out.guardianPersonId).toBeNull();
    expect(out.notes.join(' ')).toMatch(/names no guardian/);
  });

  it('treats an unknown date of birth as unknown, never as adult', async () => {
    // isMinor() returns null, and the difference is the whole point: a system
    // that answers "not a minor" for a missing date of birth hands a child's
    // record to whoever asks.
    const out = await provisionFromRegistration(db, ctx(), application({ dob: '' }));
    expect(out.notes.join(' ')).toMatch(/whether the applicant is a minor is unknown/);
    expect(out.guardianPersonId).toBeNull();
  });
});

// ─── Duplicates ─────────────────────────────────────────────────────────────

describe('duplicate detection', () => {
  it('raises a candidate and does NOT block the registration', async () => {
    const first = await provisionFromRegistration(db, ctx(), application());
    // A second application with the same name and date of birth.
    const second = await provisionFromRegistration(db, ctx(),
      application({ name: 'Sharma Ravi Kumar', email: 'other@example.in', phone: '9000000001' }));

    expect(second.personId).not.toBe(first.personId);
    expect(second.duplicatesRaised).toBeGreaterThan(0);

    // Both people exist and both are active — a question was raised, not a gate.
    const rows = await db.select().from(s.persons);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.status).toBe('active');

    expect(second.notes.join(' ')).toMatch(/does NOT hold up the registration/i);
  });

  it('does NOT raise an unverified shared telephone on its own', async () => {
    // Deliberate, and worth pinning down. Two different people sharing one
    // telephone number is ordinary — a family, a dojo's front desk — so an
    // UNVERIFIED shared phone scores 300 against a review threshold of 400 and
    // stays off the queue. Scoring it higher would bury the real matches under
    // every household in the register.
    //
    // Contacts arriving from an application are always unverified, so this is
    // the case the intake path actually produces.
    await provisionFromRegistration(db, ctx(), application());
    const second = await provisionFromRegistration(db, ctx(),
      application({ name: 'Someone Else Entirely', dob: '1975-01-01' }));

    expect(second.duplicatesRaised).toBe(0);
    // And both registrations completed.
    expect(await db.select().from(s.persons)).toHaveLength(2);
  });

  it('raises it once the SAME number has been proved on both records', async () => {
    // What lifts it over the threshold is verification, not repetition: a
    // verified phone is worth 450, and two of them are the strongest signal the
    // detector has.
    const a = await provisionFromRegistration(db, ctx(), application());
    const b = await provisionFromRegistration(db, ctx(),
      application({ name: 'Someone Else Entirely', dob: '1975-01-01' }));

    const { verifyContact, detectPersonDuplicates } = await import('../src/db/identity');
    for (const personId of [a.personId, b.personId]) {
      const phone = (await db.select().from(s.personContacts)
        .where(eq(s.personContacts.personId, personId)))
        .find((c: any) => c.kind === 'phone');
      await verifyContact(db, ctx(), { contactId: phone.id, method: 'otp', ref: `r-${personId}` });
    }

    const raised = await detectPersonDuplicates(db, b.personId);
    expect(raised.length).toBeGreaterThan(0);
    expect(raised[0].signals).toContain('verified_phone');
  });
});

// ─── What never reaches the audit trail ─────────────────────────────────────

describe('the audit trail', () => {
  it('carries no contact value and no address line', async () => {
    await loadMap();
    await provisionFromRegistration(db, ctx(), application());

    const events = await db.select().from(s.auditEvents);
    const dumped = JSON.stringify(events);
    // An audit trail is read by more people than the record itself.
    expect(dumped).not.toContain('9876543210');
    expect(dumped).not.toContain('ravi@example.in');
    expect(dumped).not.toContain('12 GS Road');
  });
});
