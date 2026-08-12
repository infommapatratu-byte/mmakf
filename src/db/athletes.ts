// Athlete registry and the Athlete Passport.
//
// Q-11. The passport is a person's whole federation life in one record:
// identity, membership, every grade they have ever held, every certificate,
// every competition, every medal, every squad. It is the thing a member most
// wants to see and the thing a federation most needs to be able to produce.
//
// TWO RULES SHAPE IT:
//
//  1. IT IS DERIVED, NEVER STORED. Every field is read from the authoritative
//     tables at request time. A denormalised copy would drift the first time a
//     result was corrected or a certificate revoked, and a passport that
//     disagrees with the register is worse than none.
//
//  2. PROVENANCE TRAVELS WITH EVERY CLAIM. A grade traced to an examination and
//     a grade carried over from paper records are both real, and they are not
//     the same claim. Every entry says which it is.
//
// The public projection and the private one are SEPARATE FUNCTIONS, not one
// function with a flag. A flag defaulting the wrong way leaks a date of birth;
// two functions cannot.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import * as s from './schema';
import { assertCan, assertCanAnywhere, can, visibleScopes, type Principal } from '@/lib/rbac';

type DB = any;

export class AthleteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AthleteError';
    this.code = code;
  }
}

/** How a claim came to be. Never omitted from anything this module returns. */
export type Provenance = 'examined' | 'unverified_legacy';

function provenanceOf(rank: { gradingEventId: number | null }): Provenance {
  return rank.gradingEventId ? 'examined' : 'unverified_legacy';
}

// ─── Public profile ─────────────────────────────────────────────────────────

export interface PublicAthleteProfile {
  federationId: string;
  fullName: string;
  city: string | null;
  stateUnitId: number | null;
  dojoId: number | null;
  currentGrade: { label: string; kind: string; awardedOn: string; provenance: Provenance } | null;
  /** Year only. A full date of birth is personal data; an age category is not. */
  birthYear: number | null;
  medals: { gold: number; silver: number; bronze: number };
  results: Array<{
    eventCode: string; eventTitle: string; category: string;
    placing: number; medal: string | null; date: string | null;
  }>;
  certificates: Array<{ certificateNo: string; title: string; issuedOn: string; status: string; provenance: Provenance }>;
  squads: Array<{ title: string; season: string; role: string }>;
}

/**
 * What anyone may see about an athlete.
 *
 * Competition results and medals are inherently public — they happened in front
 * of an audience. Personal data is not, and none is returned here: no email, no
 * phone, no address, no full date of birth. Birth YEAR is included because an
 * age category is a competition fact, and withholding it while publishing the
 * category it implies would be theatre.
 *
 * Only FINAL results appear. A provisional result on a public profile is a claim
 * the federation has not yet stood behind.
 */
export async function publicAthleteProfile(db: DB, federationId: string): Promise<PublicAthleteProfile | null> {
  const person = (await db.select().from(s.persons)
    .where(eq(s.persons.federationId, federationId.trim().toUpperCase())).limit(1))[0];
  if (!person || person.status !== 'active') return null;

  const ranks = await db.select().from(s.rankRecords)
    .where(and(eq(s.rankRecords.personId, person.id), eq(s.rankRecords.status, 'active')))
    .orderBy(desc(s.rankRecords.awardedOn));

  // Dan outranks kyu; within a kind the most recent award stands.
  const current = ranks.sort((a: any, b: any) => {
    if (a.kind !== b.kind) return a.kind === 'dan' ? -1 : 1;
    return String(b.awardedOn).localeCompare(String(a.awardedOn));
  })[0] ?? null;

  const results = await db
    .select({
      placing: s.competitionResults.placing,
      medal: s.competitionResults.medal,
      eventCode: s.competitionEvents.code,
      eventTitle: s.competitionEvents.title,
      startsOn: s.competitionEvents.startsOn,
      category: s.eventCategories.label,
    })
    .from(s.competitionResults)
    .innerJoin(s.competitionEvents, eq(s.competitionResults.eventId, s.competitionEvents.id))
    .innerJoin(s.eventCategories, eq(s.competitionResults.categoryId, s.eventCategories.id))
    .where(and(
      eq(s.competitionResults.personId, person.id),
      eq(s.competitionResults.status, 'final')
    ))
    .orderBy(desc(s.competitionEvents.startsOn));

  const certificates = await db
    .select({
      certificateNo: s.certificates.certificateNo,
      title: s.certificates.title,
      issuedOn: s.certificates.issuedOn,
      status: s.certificates.status,
      gradingEventId: s.certificates.gradingEventId,
    })
    .from(s.certificates)
    .where(and(eq(s.certificates.personId, person.id), eq(s.certificates.status, 'issued')))
    .orderBy(desc(s.certificates.issuedOn));

  const squads = await db
    .select({
      title: s.nationalSquads.title,
      season: s.nationalSquads.season,
      role: s.squadMembers.role,
      status: s.nationalSquads.status,
    })
    .from(s.squadMembers)
    .innerJoin(s.nationalSquads, eq(s.squadMembers.squadId, s.nationalSquads.id))
    .where(eq(s.squadMembers.personId, person.id));

  const medals = { gold: 0, silver: 0, bronze: 0 };
  for (const r of results) {
    if (r.medal === 'gold') medals.gold++;
    else if (r.medal === 'silver') medals.silver++;
    else if (r.medal === 'bronze') medals.bronze++;
  }

  return {
    federationId: person.federationId,
    fullName: person.fullName,
    city: person.city ?? null,
    stateUnitId: person.stateUnitId ?? null,
    dojoId: person.dojoId ?? null,
    currentGrade: current
      ? {
          label: current.gradeLabel,
          kind: current.kind,
          awardedOn: current.awardedOn,
          provenance: provenanceOf(current),
        }
      : null,
    birthYear: person.dob ? Number(String(person.dob).slice(0, 4)) : null,
    medals,
    results: results.map((r: any) => ({
      eventCode: r.eventCode,
      eventTitle: r.eventTitle,
      category: r.category,
      placing: r.placing,
      medal: r.medal ?? null,
      date: r.startsOn ?? null,
    })),
    certificates: certificates.map((c: any) => ({
      certificateNo: c.certificateNo,
      title: c.title,
      issuedOn: c.issuedOn,
      status: c.status,
      provenance: c.gradingEventId ? 'examined' : 'unverified_legacy',
    })),
    // Only squads the federation has actually published.
    squads: squads
      .filter((q: any) => q.status === 'published' || q.status === 'active')
      .map((q: any) => ({ title: q.title, season: q.season, role: q.role })),
  };
}

// ─── Athlete Passport ───────────────────────────────────────────────────────

export interface AthletePassport extends PublicAthleteProfile {
  personId: number;
  dob: string | null;
  gender: string | null;
  email: string | null;
  phone: string | null;
  memberships: Array<{ category: string; status: string; validFrom: string; validTo: string | null }>;
  /** EVERY grade ever held, superseded and revoked included. */
  gradeHistory: Array<{
    label: string; kind: string; ordinal: number; awardedOn: string;
    status: string; provenance: Provenance; syllabusVersion: string | null;
    revokedReason: string | null;
  }>;
  gradings: Array<{
    eventCode: string; heldOn: string | null; grade: string;
    outcome: string | null; status: string; feedback: string | null;
  }>;
  licences: Array<{ registry: string; level: string | null; status: string; expiresOn: string | null }>;
  /** Provisional results too — the athlete may see what is not yet public. */
  provisionalResults: Array<{ eventTitle: string; category: string; placing: number }>;
  attendanceCount: number;
}

/**
 * The full lifelong record.
 *
 * Authorisation is deliberately strict and explicit: the athlete themselves, or
 * someone holding `person:read_pii` WITHIN THE ATHLETE'S OWN SCOPE. A state
 * administrator cannot open a passport in another state — this is the same IDOR
 * boundary the rest of the system enforces, and a passport is exactly the kind
 * of rich record that makes a scope leak expensive.
 *
 * Grade history includes superseded and revoked entries. A passport showing only
 * the current grade would hide a revocation, which is precisely what someone
 * whose grade was withdrawn would want it to do.
 */
export async function athletePassport(
  db: DB,
  principal: Principal,
  federationId: string
): Promise<AthletePassport | null> {
  const person = (await db.select().from(s.persons)
    .where(eq(s.persons.federationId, federationId.trim().toUpperCase())).limit(1))[0];
  if (!person) return null;

  const isSelf = principal.userId != null && await isOwnRecord(db, principal.userId, person.id);
  if (!isSelf) {
    assertCan(principal, 'person:read_pii', {
      stateUnitId: person.stateUnitId,
      districtUnitId: person.districtUnitId,
      dojoId: person.dojoId,
    });
  }

  const publicPart = await publicAthleteProfile(db, federationId);
  // publicAthleteProfile refuses inactive people; a passport must still open for
  // them, so the shell is rebuilt rather than returning null here.
  const base: PublicAthleteProfile = publicPart ?? {
    federationId: person.federationId,
    fullName: person.fullName,
    city: person.city ?? null,
    stateUnitId: person.stateUnitId ?? null,
    dojoId: person.dojoId ?? null,
    currentGrade: null,
    birthYear: person.dob ? Number(String(person.dob).slice(0, 4)) : null,
    medals: { gold: 0, silver: 0, bronze: 0 },
    results: [],
    certificates: [],
    squads: [],
  };

  const gradeHistory = await db.select().from(s.rankRecords)
    .where(eq(s.rankRecords.personId, person.id))
    .orderBy(desc(s.rankRecords.awardedOn), desc(s.rankRecords.id));

  const memberships = await db.select().from(s.memberships)
    .where(eq(s.memberships.personId, person.id));

  const gradings = await db
    .select({
      eventCode: s.gradingEvents.code,
      heldOn: s.gradingEvents.heldOn,
      grade: s.gradeDefinitions.label,
      outcome: s.gradingCandidates.outcome,
      status: s.gradingCandidates.status,
      feedback: s.gradingCandidates.candidateFeedback,
    })
    .from(s.gradingCandidates)
    .innerJoin(s.gradingEvents, eq(s.gradingCandidates.gradingEventId, s.gradingEvents.id))
    .innerJoin(s.gradeDefinitions, eq(s.gradingCandidates.gradeDefinitionId, s.gradeDefinitions.id))
    .where(eq(s.gradingCandidates.personId, person.id))
    .orderBy(desc(s.gradingEvents.heldOn));

  const licences: AthletePassport['licences'] = [];
  for (const [registry, table] of [
    ['instructor', s.instructorQuals],
    ['examiner', s.examinerQuals],
    ['official', s.officialQuals],
  ] as const) {
    const rows = await db.select().from(table).where(eq(table.personId, person.id));
    for (const q of rows) {
      licences.push({ registry, level: q.level ?? null, status: q.status, expiresOn: q.expiresOn ?? null });
    }
  }

  const provisional = await db
    .select({
      placing: s.competitionResults.placing,
      eventTitle: s.competitionEvents.title,
      category: s.eventCategories.label,
    })
    .from(s.competitionResults)
    .innerJoin(s.competitionEvents, eq(s.competitionResults.eventId, s.competitionEvents.id))
    .innerJoin(s.eventCategories, eq(s.competitionResults.categoryId, s.eventCategories.id))
    .where(and(
      eq(s.competitionResults.personId, person.id),
      eq(s.competitionResults.status, 'provisional')
    ));

  const attendance = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.sessionAttendance)
    .where(and(eq(s.sessionAttendance.personId, person.id), eq(s.sessionAttendance.present, true)));

  return {
    ...base,
    personId: person.id,
    dob: person.dob ?? null,
    gender: person.gender ?? null,
    email: person.email ?? null,
    phone: person.phone ?? null,
    memberships: memberships.map((m: any) => ({
      category: m.category, status: m.status, validFrom: m.validFrom, validTo: m.validTo ?? null,
    })),
    gradeHistory: gradeHistory.map((r: any) => ({
      label: r.gradeLabel,
      kind: r.kind,
      ordinal: r.gradeOrdinal,
      awardedOn: r.awardedOn,
      status: r.status,
      provenance: provenanceOf(r),
      syllabusVersion: r.syllabusVersion ?? null,
      revokedReason: r.revokedReason ?? null,
    })),
    gradings: gradings.map((g: any) => ({
      eventCode: g.eventCode,
      heldOn: g.heldOn ?? null,
      grade: g.grade,
      outcome: g.outcome ?? null,
      status: g.status,
      // Only the candidate-facing feedback. Examiner notes are internal and are
      // deliberately not selected.
      feedback: g.feedback ?? null,
    })),
    licences,
    provisionalResults: provisional.map((r: any) => ({
      eventTitle: r.eventTitle, category: r.category, placing: r.placing,
    })),
    attendanceCount: Number(attendance[0]?.n ?? 0),
  };
}

/** Does this user account belong to this person? */
async function isOwnRecord(db: DB, userId: number, personId: number): Promise<boolean> {
  const user = (await db.select({ personId: s.users.personId }).from(s.users)
    .where(eq(s.users.id, userId)).limit(1))[0];
  return Boolean(user && user.personId === personId);
}

// ─── Registry search ────────────────────────────────────────────────────────

export interface AthleteSearch {
  stateUnitId?: number;
  dojoId?: number;
  gradeKind?: 'kyu' | 'dan';
  minGradeOrdinal?: number;
  bornOnOrAfter?: string;
  bornOnOrBefore?: string;
  gender?: string;
}

/**
 * Search the athlete registry, scope-filtered in SQL.
 *
 * Returns the PUBLIC shape only. A search endpoint is exactly where a scope leak
 * turns into a bulk export, so the filter is applied in the query and the
 * projection carries no personal data regardless of who is asking.
 */
export async function searchAthletes(
  db: DB,
  principal: Principal,
  criteria: AthleteSearch = {},
  limit = 100
) {
  assertCanAnywhere(principal, 'person:read');

  const scopes = visibleScopes(principal, 'person:read');
  if (scopes.kind === 'none') return [];

  const conditions: any[] = [eq(s.persons.status, 'active')];

  if (scopes.kind === 'scoped') {
    const scoped: any[] = [];
    if (scopes.states.length) scoped.push(inArray(s.persons.stateUnitId, scopes.states));
    if (scopes.districts.length) scoped.push(inArray(s.persons.districtUnitId, scopes.districts));
    if (scopes.dojos.length) scoped.push(inArray(s.persons.dojoId, scopes.dojos));
    if (!scoped.length) return [];
    conditions.push(scoped.length === 1 ? scoped[0] : sql`(${sql.join(scoped, sql` OR `)})`);
  }

  if (criteria.stateUnitId) conditions.push(eq(s.persons.stateUnitId, criteria.stateUnitId));
  if (criteria.dojoId) conditions.push(eq(s.persons.dojoId, criteria.dojoId));
  if (criteria.gender) conditions.push(eq(s.persons.gender, criteria.gender));
  // Birth-year bounds, matching how karate age categories are actually defined.
  if (criteria.bornOnOrAfter) conditions.push(sql`${s.persons.dob} >= ${criteria.bornOnOrAfter}`);
  if (criteria.bornOnOrBefore) conditions.push(sql`${s.persons.dob} <= ${criteria.bornOnOrBefore}`);

  const rows = await db
    .select({
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
      city: s.persons.city,
      stateUnitId: s.persons.stateUnitId,
      dojoId: s.persons.dojoId,
      birthYear: sql<string>`substring(${s.persons.dob}::text from 1 for 4)`,
      gradeLabel: s.rankRecords.gradeLabel,
      gradeKind: s.rankRecords.kind,
      gradeOrdinal: s.rankRecords.gradeOrdinal,
      gradingEventId: s.rankRecords.gradingEventId,
    })
    .from(s.persons)
    .leftJoin(s.rankRecords, and(
      eq(s.rankRecords.personId, s.persons.id),
      eq(s.rankRecords.status, 'active'),
      criteria.gradeKind ? eq(s.rankRecords.kind, criteria.gradeKind) : sql`true`
    ))
    .where(and(...conditions))
    .limit(limit);

  return rows
    .filter((r: any) => {
      if (criteria.gradeKind && !r.gradeLabel) return false;
      // Lower ordinal is a HIGHER kyu grade (1st Kyu outranks 9th Kyu), so a
      // minimum grade filter is a maximum ordinal. Getting this backwards would
      // silently return the opposite cohort.
      if (criteria.minGradeOrdinal != null) {
        if (r.gradeOrdinal == null) return false;
        return r.gradeKind === 'dan'
          ? r.gradeOrdinal >= criteria.minGradeOrdinal
          : r.gradeOrdinal <= criteria.minGradeOrdinal;
      }
      return true;
    })
    .map((r: any) => ({
      federationId: r.federationId,
      fullName: r.fullName,
      city: r.city,
      stateUnitId: r.stateUnitId,
      dojoId: r.dojoId,
      birthYear: r.birthYear ? Number(r.birthYear) : null,
      currentGrade: r.gradeLabel
        ? { label: r.gradeLabel, kind: r.gradeKind, provenance: r.gradingEventId ? 'examined' : 'unverified_legacy' }
        : null,
    }));
}

// ─── Career statistics ──────────────────────────────────────────────────────

/**
 * Derived career statistics.
 *
 * Every number is computed from final results at request time. Nothing is
 * cached, because a cached medal count survives a corrected result and a
 * federation that publishes a medal tally contradicting its own results register
 * has a worse problem than a slow query.
 */
export async function careerStatistics(db: DB, principal: Principal, federationId: string) {
  const person = (await db.select().from(s.persons)
    .where(eq(s.persons.federationId, federationId.trim().toUpperCase())).limit(1))[0];
  if (!person) return null;

  assertCanAnywhere(principal, 'result:read');

  const results = await db
    .select({
      placing: s.competitionResults.placing,
      medal: s.competitionResults.medal,
      matchesWon: s.competitionResults.matchesWon,
      matchesLost: s.competitionResults.matchesLost,
      pointsFor: s.competitionResults.pointsFor,
      pointsAgainst: s.competitionResults.pointsAgainst,
      discipline: s.eventCategories.discipline,
      eventKind: s.competitionEvents.kind,
      season: s.competitionEvents.startsOn,
    })
    .from(s.competitionResults)
    .innerJoin(s.eventCategories, eq(s.competitionResults.categoryId, s.eventCategories.id))
    .innerJoin(s.competitionEvents, eq(s.competitionResults.eventId, s.competitionEvents.id))
    .where(and(
      eq(s.competitionResults.personId, person.id),
      eq(s.competitionResults.status, 'final')
    ));

  const byDiscipline: Record<string, { entries: number; won: number; lost: number; medals: number }> = {};
  let won = 0, lost = 0, pointsFor = 0, pointsAgainst = 0, podiums = 0;

  for (const r of results) {
    won += r.matchesWon ?? 0;
    lost += r.matchesLost ?? 0;
    pointsFor += r.pointsFor ?? 0;
    pointsAgainst += r.pointsAgainst ?? 0;
    if (r.medal && r.medal !== 'participation') podiums++;

    const d = byDiscipline[r.discipline] ?? { entries: 0, won: 0, lost: 0, medals: 0 };
    d.entries++;
    d.won += r.matchesWon ?? 0;
    d.lost += r.matchesLost ?? 0;
    if (r.medal && r.medal !== 'participation') d.medals++;
    byDiscipline[r.discipline] = d;
  }

  const contests = won + lost;
  return {
    federationId: person.federationId,
    entries: results.length,
    podiums,
    matchesWon: won,
    matchesLost: lost,
    // Null rather than 0 when nobody has competed: a 0% win rate and "has never
    // competed" are different facts, and showing the first for the second is a
    // small lie that a profile page will repeat forever.
    winRatePercent: contests > 0 ? Math.round((won / contests) * 100) : null,
    pointsFor,
    pointsAgainst,
    byDiscipline,
  };
}
