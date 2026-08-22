// From an approved application to a person in the register.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BREAK THIS CLOSES
// ─────────────────────────────────────────────────────────────────────────────
//
// Migration 0025 built verified contacts, an address history, a consent ledger
// and duplicate detection. Every one of them hangs off `persons.id`.
//
// And nothing in this repository ever created a person. `createPersonForSource()`
// has sat in src/db/federation.ts, written and tested, with no caller anywhere in
// `src/`. A membership application was validated, queued, reviewed and approved —
// and stopped. The queue said "Approved", the applicant was told they were
// registered, and the register held nothing.
//
// Worse, the approval path in src/pages/api/queue/decide.ts already tried to
// issue a membership and read the person from `(result as any).record`, a field
// `DecisionResult` never declared. So it was always `undefined`, the code always
// took its "this application carries no linked person record — link it to a
// person and re-run the approval" branch, and there was no way to perform the
// action that message asked for. A dead end wearing an instruction.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE WILL NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//
//  · IT WILL NOT INVENT A POLICY VERSION. `consent_records.policy_version` is
//    NOT NULL and MMAKF has published no versioned privacy or photography
//    policy. Writing '1.0' would be this file minting a federation instrument.
//    What it records instead is a digest of THE WORDING THE APPLICANT ACTUALLY
//    SAW — see consentWordingVersion() — so "consented to version X" means
//    "consented to this exact sentence", which is true and stays checkable when
//    the sentence changes.
//  · IT WILL NOT CLAIM A GUARDIAN'S AUTHORITY. A minor's application carries a
//    tick-box in which an adult asserts they are the guardian. That is a CLAIM.
//    The relationship is created 'asserted', which confers nothing, and the
//    consent is recorded in the capacity of the STAFF who processed the intake
//    with the claim preserved as evidence — never as capacity 'guardian', which
//    recordConsent() would rightly refuse because guardianCan() is false.
//  · IT WILL NOT VERIFY A CONTACT. addContact() takes no such parameter.
//  · IT WILL NOT BLOCK ON A DUPLICATE. detectPersonDuplicates() runs last, in
//    its own try, and raises a question for a human.
//  · IT WILL NOT SPLIT A NAME. `given_name`/`family_name` stay NULL unless the
//    application supplied them separately.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT IS SAFE TO RUN TWICE
// ─────────────────────────────────────────────────────────────────────────────
//
// An approval gets retried — a browser resubmits, an operator re-runs one that
// reported a warning. Idempotency comes from `createPersonForSource()` and the
// partial unique indexes that already exist, NOT from a check-then-insert here:
//
//   · one person per `source_ref`  (persons_source_ref_uk)
//   · one active contact per (person, kind, normalised value)
//   · one current address per (person, kind)
//   · one live relationship per (holder, subject, type)
//
// So the second run finds what the first made and reports it as unchanged.

import { and, eq, isNull } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import * as idn from './identity.schema';
import { createPersonForSource, type AuditContext } from './federation';
import {
  addContact, setPersonAddress, assertRelationship, recordConsent,
  detectPersonDuplicates, computeMatchKey, isMinor,
} from './identity';
import { CONSENTS } from '@/lib/registration';

type DB = any;

export class ProvisioningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProvisioningError';
    this.code = code;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isProvisioningError(err: unknown): err is ProvisioningError {
  return !!err && typeof err === 'object' && (err as any).name === 'ProvisioningError'
    && typeof (err as any).code === 'string';
}

// ─── Consent versioning ─────────────────────────────────────────────────────

/**
 * A version identifier for a consent, derived from the WORDING it was given to.
 *
 * THIS IS NOT AN MMAKF POLICY VERSION, and the string says so out loud: it is
 * prefixed `wording:` precisely so that nobody reading a consent row six months
 * from now mistakes it for a reference to a published federation instrument.
 * MMAKF has published none, and a plausible-looking '1.0' in this column would
 * be indistinguishable from one it had.
 *
 * What it does guarantee is the thing a consent record has to guarantee: that
 * the exact sentence the applicant agreed to can be identified, and that
 * changing that sentence changes the version — so a later reader can tell
 * whether the consent on file was given to the words now on the form.
 *
 * Derived from src/lib/registration.ts's own CONSENTS array, so the wording and
 * the version cannot drift apart: there is one definition of the sentence.
 */
export function consentWordingVersion(fieldName: string): string {
  const field = CONSENTS.find((f) => f.name === fieldName);
  if (!field) {
    throw new ProvisioningError('unknown_consent',
      `'${fieldName}' is not a consent this registration form asks for.`);
  }
  const digest = crypto.createHash('sha256').update(field.label).digest('hex').slice(0, 12);
  return `wording:${digest}`;
}

/** Consent field → the stable policy key the ledger groups it under. */
const CONSENT_POLICY_KEYS: Record<string, string> = {
  consentAccuracy: 'declaration.accuracy',
  consentDataUse: 'privacy.administration',
  consentGuardian: 'guardian.application',
  consentMedical: 'medical.emergency-treatment',
  consentPhotography: 'media.photography',
};

const truthy = (v: unknown) =>
  v === true || v === 'on' || v === 'yes' || v === 'true' || v === 1 || v === '1';

// ─── The result ─────────────────────────────────────────────────────────────

export interface ProvisionResult {
  personId: number;
  federationId: string;
  /** False when this application had already produced the person. */
  personCreated: boolean;
  addressId: number | null;
  /** Null when the locality could not be placed — the address is still stored. */
  areaId: number | null;
  contactsAdded: number;
  consentsRecorded: number;
  /** The guardian's person id and the ASSERTED relationship, for a minor. */
  guardianPersonId: number | null;
  guardianRelationshipId: number | null;
  duplicatesRaised: number;
  /**
   * Everything that did not happen, and why, in sentences an administrator can
   * read. A provisioning run that silently skips half its work is the failure
   * this whole module exists to end, so the skips are part of the result rather
   * than a log line.
   */
  notes: string[];
}

// ─── The provisioning ───────────────────────────────────────────────────────

/**
 * Turn an approved registration record into a person and everything that hangs
 * off one.
 *
 * `record` is the queue row — see DecisionResult.record in src/lib/queue.ts. It
 * is the applicant's own submitted data and is PII; nothing here puts any of it
 * into an audit payload or a domain event.
 *
 * Throws only for a fault that means nothing was written. Every PARTIAL outcome
 * is reported through `notes`, because the caller has already moved the queue
 * row and needs to tell the office precisely what did and did not reach the
 * register.
 */
export async function provisionFromRegistration(
  db: DB,
  ctx: AuditContext,
  record: Record<string, any>
): Promise<ProvisionResult> {
  const sourceRef = String(record?.id ?? '').trim();
  if (!sourceRef) {
    throw new ProvisioningError('no_source_ref',
      'This application has no id, so a person created from it could not be tied back to it — '
      + 'and a re-run would create a second person. Nothing was written.');
  }

  const notes: string[] = [];
  const fullName = String(record.name ?? '').trim();
  if (!fullName) {
    throw new ProvisioningError('no_name',
      'This application carries no applicant name. A person record cannot be created without one.');
  }

  const dob = String(record.dob ?? '').trim() || null;
  const minor = isMinor(dob);

  // ── 1. The person ─────────────────────────────────────────────────────────
  //
  // Placement is the FEDERATION unit that will administer them, resolved from
  // the state the applicant chose against the unit register. `residenceAreaId`
  // is set later, from the address, and is civil geography — see the header of
  // src/db/geography.ts for why the two are not the same column.
  let stateUnitId: number | null = null;
  const stateName = String(record.state ?? '').trim();
  if (stateName) {
    const unit = (await db.select({ id: s.stateUnits.id }).from(s.stateUnits)
      .where(eq(s.stateUnits.state, stateName)).limit(1))[0];
    stateUnitId = unit?.id ?? null;
    if (!stateUnitId) {
      notes.push(
        `The application names the state '${stateName}', which is not in the federation's unit `
        + 'register, so the person is recorded with no administering unit. That is a placement to '
        + 'correct, not a reason to refuse the registration.'
      );
    }
  }

  const person = await createPersonForSource(db, ctx, {
    sourceRef,
    fullName,
    dob,
    gender: String(record.gender ?? '').trim() || null,
    email: String(record.email ?? '').trim() || null,
    phone: String(record.phone ?? '').trim() || null,
    city: String(record.city ?? '').trim() || null,
    stateUnitId,
    // A person created BY a decision is active. Leaving them 'pending' would
    // make /verify report an approved member as pending for ever — the note on
    // NewPerson.status in src/db/federation.ts says so.
    status: 'active',
  });

  // The matching key is derived, never typed. Set on the first run only; a
  // re-run must not rewrite a key a later name change has already moved.
  if (person.created) {
    await db.update(s.persons)
      .set({ matchKey: computeMatchKey(fullName) })
      .where(eq(s.persons.id, person.id));
  }

  const result: ProvisionResult = {
    personId: person.id,
    federationId: person.federationId,
    personCreated: person.created,
    addressId: null,
    areaId: null,
    contactsAdded: 0,
    consentsRecorded: 0,
    guardianPersonId: null,
    guardianRelationshipId: null,
    duplicatesRaised: 0,
    notes,
  };

  // ── 2. The address ────────────────────────────────────────────────────────
  //
  // Only when the country is known. The geography tables ship empty, so on most
  // deployments today there is no country row and therefore no address — the
  // free-text city on the person carries the location, which is exactly what
  // isOffered() arranged at intake.
  const hasAddressData = [
    record.addressLine1, record.addressLine2, record.landmark,
    record.postalCode, record.city,
  ].some((v) => String(v ?? '').trim());

  if (hasAddressData) {
    try {
      const countryIso = String(record.country ?? '').trim().toUpperCase();
      const country = countryIso
        ? (await db.select({ id: s.countries.id }).from(s.countries)
            .where(eq(s.countries.iso2, countryIso)).limit(1))[0]
        // Exactly one country loaded needs no choosing — the same rule the form
        // and the intake endpoint apply.
        : (await db.select({ id: s.countries.id }).from(s.countries).limit(2))[0];

      if (!country) {
        notes.push(
          'The address was not recorded: the place register holds no country, so there is nothing '
          + 'to record an address against. The applicant\'s locality is kept on the application and '
          + 'on the person\'s city field, and can be recorded once the register is loaded.'
        );
      } else {
        const already = (await db.select({ id: idn.personAddresses.id })
          .from(idn.personAddresses)
          .where(and(
            eq(idn.personAddresses.personId, person.id),
            eq(idn.personAddresses.kind, 'home'),
            isNull(idn.personAddresses.validTo),
          )).limit(1))[0];

        if (already) {
          notes.push('A current home address was already on file for this person; it was left as it is.');
        } else {
          const placed = await setPersonAddress(db, ctx, {
            personId: person.id,
            kind: 'home',
            address: {
              countryId: country.id,
              line1: String(record.addressLine1 ?? '').trim() || null,
              line2: String(record.addressLine2 ?? '').trim() || null,
              landmark: String(record.landmark ?? '').trim() || null,
              // The applicant's own words, kept verbatim so the row can be
              // re-resolved when the register grows.
              localityText: String(record.city ?? '').trim() || null,
              postalCode: String(record.postalCode ?? '').trim() || null,
              // The id they CHOSE, when the ambiguity question was answered.
              // Never a guess: an unresolved address is stored unresolved.
              areaId: Number(record.cityAreaId) > 0 ? Number(record.cityAreaId) : null,
              within: Number(record.civilDistrictAreaId) > 0
                ? Number(record.civilDistrictAreaId)
                : (Number(record.civilStateAreaId) > 0 ? Number(record.civilStateAreaId) : null),
              source: 'registration',
            },
          });
          result.addressId = placed.addressId;
          result.areaId = placed.areaId;
          if (placed.areaId == null) {
            notes.push(
              'The address is recorded but its place could not be resolved in the register. The '
              + 'words the applicant typed are kept, and the row appears in the re-resolution '
              + 'backlog — unresolvedAddresses() — for when the register covers it.'
            );
          }
        }
      }
    } catch (err: any) {
      // An address that fails must not lose a registration.
      notes.push(`The address was not recorded: ${String(err?.message ?? err)}`);
    }
  }

  // ── 3. The contacts, UNVERIFIED ───────────────────────────────────────────
  for (const [kind, value] of [
    ['email', record.email],
    ['phone', record.phone],
  ] as Array<['email' | 'phone', unknown]>) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    try {
      const c = await addContact(db, ctx, {
        personId: person.id, kind, value: raw, primary: true,
      });
      if (c.created) result.contactsAdded++;
    } catch (err: any) {
      notes.push(`The ${kind} was not recorded: ${String(err?.message ?? err)}`);
    }
  }
  if (result.contactsAdded > 0) {
    notes.push(
      'The email and telephone are recorded as UNVERIFIED. Nobody has proved either, and nothing '
      + 'in this system treats them as proven until somebody does.'
    );
  }

  // ── 4. The guardian's CLAIM, for a minor ──────────────────────────────────
  //
  // Before the consents, because a guardian consent should be able to name the
  // relationship it was given under even though that relationship confers
  // nothing yet.
  const guardianName = String(record.guardianName ?? '').trim();
  if (minor === true && guardianName) {
    try {
      const guardian = await createPersonForSource(db, ctx, {
        // Its own source ref, so a re-run finds this guardian rather than
        // making a second one — and so the guardian is traceable to the
        // application that named them.
        sourceRef: `${sourceRef}:guardian`,
        fullName: guardianName,
        phone: String(record.guardianPhone ?? '').trim() || null,
        email: String(record.guardianEmail ?? '').trim() || null,
        stateUnitId,
        // PENDING. This person has not applied for anything and has proved
        // nothing; they exist because a child's application named them.
        status: 'pending',
      });
      result.guardianPersonId = guardian.id;

      const rel = await assertRelationship(db, ctx, {
        holderPersonId: guardian.id,
        subjectPersonId: person.id,
        // The form asks for a relationship in free text and MMAKF has published
        // no mapping from that to a legal category, so the neutral claim is
        // recorded and the reviewer decides what it is.
        type: 'authorized_guardian',
        evidence: {
          source: 'registration-form',
          statedRelationship: String(record.guardianRelation ?? '').trim() || null,
          note: 'Asserted on a membership application. No evidence of guardianship was supplied '
            + 'or checked at intake.',
        },
      });
      result.guardianRelationshipId = rel.id;

      notes.push(
        'The guardian named on this application is recorded as an ASSERTED relationship, which '
        + 'confers nothing at all. Until somebody with guardian:verify decides it and grants '
        + 'capabilities one at a time, that adult can see nothing of this child\'s record.'
      );
    } catch (err: any) {
      notes.push(`The guardian was not recorded: ${String(err?.message ?? err)}`);
    }
  } else if (minor === true && !guardianName) {
    notes.push(
      'This applicant is a minor and the application names no guardian. Nothing was recorded, and '
      + 'this needs an administrator.'
    );
  } else if (minor === null) {
    // The distinction isMinor() exists to preserve: unknown is not "adult".
    notes.push(
      'This application records no date of birth, so whether the applicant is a minor is unknown. '
      + 'No guardian relationship was created and none was ruled out.'
    );
  }

  // ── 5. Consent ────────────────────────────────────────────────────────────
  for (const field of CONSENTS) {
    if (!truthy(record[field.name])) continue;
    const policyKey = CONSENT_POLICY_KEYS[field.name];
    if (!policyKey) continue;

    try {
      const guardianGiven = field.showWhen === 'minor' || minor === true;
      await recordConsent(db, ctx, {
        subjectPersonId: person.id,
        policyKey,
        // Not a federation policy version. See consentWordingVersion().
        policyVersion: consentWordingVersion(field.name),
        decision: 'granted',
        // 'staff', NEVER 'guardian'.
        //
        // recordConsent() checks guardianCan('give_consent') for the guardian
        // capacity and would refuse — correctly, because the relationship is
        // only asserted. What actually happened is that the federation's intake
        // recorded a tick-box in which somebody claimed to be the guardian, and
        // that is what is written: the office's own record of a claim, with the
        // claim preserved beside it, rather than an assertion of an authority
        // nobody has checked.
        capacity: 'staff',
        givenByPersonId: guardianGiven ? result.guardianPersonId : person.id,
        relationshipId: guardianGiven ? result.guardianRelationshipId : null,
        channel: 'registration-form',
        evidence: {
          field: field.name,
          wording: field.label,
          claimedCapacity: guardianGiven ? 'guardian' : 'self',
          guardianRelationshipStatus: guardianGiven ? 'asserted' : null,
          note: 'Recorded by the federation from a ticked box on a membership application. The '
            + 'capacity is the office\'s, because the person who ticked it had proved nothing at '
            + 'the time.',
        },
      });
      result.consentsRecorded++;
    } catch (err: any) {
      notes.push(`The consent '${field.name}' was not recorded: ${String(err?.message ?? err)}`);
    }
  }

  // ── 6. Duplicates — LAST, and never fatal ─────────────────────────────────
  try {
    const raised = await detectPersonDuplicates(db, person.id);
    result.duplicatesRaised = raised.length;
    if (raised.length) {
      notes.push(
        `${raised.length} possible duplicate ${raised.length === 1 ? 'record' : 'records'} `
        + 'was raised for review. This does NOT hold up the registration — the person is '
        + 'registered and a reviewer decides separately whether two records are one human being.'
      );
    }
  } catch (err: any) {
    // A detector that fails must never fail a registration. It raises questions;
    // it does not grant anything and it does not gate anything.
    notes.push(`Duplicate detection did not run: ${String(err?.message ?? err)}`);
  }

  return result;
}
