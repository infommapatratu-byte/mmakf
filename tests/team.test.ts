// The operational federation team — migration 0056 and src/db/team.ts.
//
// Four of these tests assert ABSENCES rather than behaviour, and those are the
// ones worth keeping when the rest go stale:
//
//   · `publicTeam()` selects no private column from `persons`, checked by name.
//   · No foreign key joins `team_appointments` to `committees` in either
//     direction — governance is not a job.
//   · `team_appointments` has no salary/private-contact/HR column to leak.
//   · `src/db/team.ts` issues no UPDATE and no DELETE against the history table.
//
// A behavioural test proves the code does what it does today. These prove the
// code CANNOT do the thing the design forbids, which is what survives somebody
// adding a column for an admin screen and publishing it to the internet in the
// same commit.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as t from '../src/db/team.schema';
import {
  createDepartment, setDepartmentParent, listDepartments,
  createAppointment, updateAppointment, activateAppointment,
  publishAppointment, unpublishAppointment, suspendAppointment, endAppointment,
  publicTeam, adminAppointments, appointmentHistory, personRelationships,
  sanitiseLinks, isTeamError,
} from '../src/db/team';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let ASSAM: number, KERALA: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
/** Holds team:read and team:write for Assam, and NOT team:publish. */
const assamAdmin = (): Principal => ({
  userId: 2, label: 'assam admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: ASSAM }],
});
const keralaAdmin = (): Principal => ({
  userId: 3, label: 'kerala admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: KERALA }],
});
/** Reads the register, may not touch it. */
const press: Principal = {
  userId: 4, label: 'media officer',
  bindings: [{ role: 'MEDIA_OFFICER', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = admin): AuditContext => ({
  principal: p, reason: 'test', authority: 'test',
});

let seq = 810000;
async function person(name: string, over: Record<string, unknown> = {}) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(seq++)}`,
    fullName: name,
    status: 'active',
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

  for (const id of [1, 2, 3, 4]) {
    await db.insert(s.users).values({ id, email: `u${id}@test.invalid`, status: 'active' }).onConflictDoNothing();
  }
  const [a] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-AS', state: 'Assam', name: 'Assam', status: 'active',
  }).returning({ id: s.stateUnits.id });
  ASSAM = a.id;
  const [k] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-KL', state: 'Kerala', name: 'Kerala', status: 'active',
  }).returning({ id: s.stateUnits.id });
  KERALA = k.id;
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM team_appointment_history');
  await db.execute?.('DELETE FROM team_appointments');
  await db.execute?.('DELETE FROM departments');
  await db.execute?.('DELETE FROM domain_events');
  await db.execute?.('DELETE FROM audit_events');
  await db.execute?.('DELETE FROM memberships');
  await db.execute?.('DELETE FROM instructor_quals');
  await db.execute?.('DELETE FROM rank_records');
  await db.execute?.('DELETE FROM persons');
});

// ─── The structural guarantees ──────────────────────────────────────────────

describe('the schema cannot hold what the design forbids', () => {
  it('team_appointments has no column for salary, private contact or HR notes', async () => {
    const cols = await db.execute?.(
      `select column_name from information_schema.columns where table_name = 'team_appointments'`
    );
    const names: string[] = (cols?.rows ?? cols ?? []).map((r: any) => String(r.column_name));
    expect(names.length).toBeGreaterThan(0);

    for (const forbidden of ['salary', 'pay', 'bank', 'account_number', 'ifsc', 'pan', 'aadhaar',
      'national_id', 'passport', 'hr_note', 'disciplinary', 'private_email', 'private_phone']) {
      expect(names.some((n) => n.includes(forbidden)), `team_appointments has a '${forbidden}' column`).toBe(false);
    }
    // `public_contact` is deliberately present and deliberately named: an office
    // route the federation publishes, never an employee's own number.
    expect(names).toContain('public_contact');
  });

  it('no foreign key joins the team register to governance, in either direction', async () => {
    const fks = await db.execute?.(`
      select tc.table_name as src, ccu.table_name as dest
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
        and (tc.table_name in ('team_appointments','departments','team_appointment_history','committees','committee_appointments')
          or ccu.table_name in ('team_appointments','departments','team_appointment_history','committees','committee_appointments'))
    `);
    const rows: any[] = (fks?.rows ?? fks ?? []);
    const team = new Set(['team_appointments', 'departments', 'team_appointment_history']);
    const gov = new Set(['committees', 'committee_appointments']);
    for (const r of rows) {
      const crosses = (team.has(r.src) && gov.has(r.dest)) || (gov.has(r.src) && team.has(r.dest));
      expect(crosses, `${r.src} -> ${r.dest} joins the team register to governance`).toBe(false);
    }
  });

  it('src/db/team.ts never updates or deletes the history table', () => {
    const src = readFileSync('src/db/team.ts', 'utf8');
    expect(src).not.toMatch(/update\(\s*s\.teamAppointmentHistory/);
    expect(src).not.toMatch(/delete\(\s*s\.teamAppointmentHistory/);
  });

  it('publicTeam selects no private column from persons', () => {
    const src = readFileSync('src/db/team.ts', 'utf8');
    // BASE_COLUMNS is the single list publicTeam() reads through.
    const block = src.slice(src.indexOf('const BASE_COLUMNS'), src.indexOf('export async function publicTeam'));
    for (const priv of ['persons.email', 'persons.phone', 'persons.dob', 'persons.gender',
      'persons.matchKey', 'persons.givenName', 'persons.familyName', 'persons.nationality']) {
      expect(block, `BASE_COLUMNS exposes ${priv}`).not.toContain(priv);
    }
  });

  it('publicTeam takes no principal and no filter that could widen it', () => {
    const src = readFileSync('src/db/team.ts', 'utf8');
    const sig = src.slice(src.indexOf('export async function publicTeam'), src.indexOf('/** The admin register'));
    expect(sig).toContain('publicTeam(db: DB)');
    expect(sig).not.toContain('principal');
    expect(sig).not.toContain('includeDrafts');
  });
});

// ─── Publication is a separate act ──────────────────────────────────────────

describe('publication', () => {
  it('a new appointment is a draft and is not public', async () => {
    const p = await person('Anita Bose');
    const a = await createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' });
    expect(a.status).toBe('draft');
    expect(a.published).toBe(false);
    expect(await publicTeam(db)).toEqual([]);
  });

  it('a draft cannot be published — it must be active first', async () => {
    const p = await person('Anita Bose');
    const a = await createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' });
    await expect(publishAppointment(db, ctx(), a.id)).rejects.toMatchObject({ code: 'not_publishable' });
  });

  it('an active, published appointment reaches the public page', async () => {
    const p = await person('Anita Bose', { photoUrl: 'https://example.invalid/a.jpg' });
    const d = await createDepartment(db, ctx(), { code: 'MEDIA', name: 'Media and Communications' });
    const a = await createAppointment(db, ctx(), {
      personId: p, title: 'Head of Media', orgLevel: 'head', departmentId: d.id,
      publicBio: 'Runs the press desk.', publicContact: 'media@mmakf.invalid',
    });
    await activateAppointment(db, ctx(), a.id);
    await publishAppointment(db, ctx(), a.id);

    const team = await publicTeam(db);
    expect(team).toHaveLength(1);
    expect(team[0].fullName).toBe('Anita Bose');
    expect(team[0].title).toBe('Head of Media');
    expect(team[0].department).toBe('Media and Communications');
    expect(team[0].contact).toBe('media@mmakf.invalid');
    // The internal key is not on the public card; the federation id is.
    expect(team[0]).not.toHaveProperty('personId');
    expect(team[0]).not.toHaveProperty('status');
    expect(team[0].federationId).toMatch(/^MMAKF-MEM-/);
  });

  it('a state administrator may write in their state but may not publish', async () => {
    const p = await person('Ravi Das');
    const a = await createAppointment(db, ctx(assamAdmin()), {
      personId: p, title: 'Assam State Coordinator', orgLevel: 'coordinator',
      scopeType: 'state', scopeStateUnitId: ASSAM,
    });
    await activateAppointment(db, ctx(assamAdmin()), a.id);
    await expect(publishAppointment(db, ctx(assamAdmin()), a.id)).rejects.toBeInstanceOf(ForbiddenError);
    // The national secretariat can.
    await publishAppointment(db, ctx(), a.id);
    expect(await publicTeam(db)).toHaveLength(1);
  });

  it('a state administrator cannot create a national appointment', async () => {
    const p = await person('Ravi Das');
    await expect(createAppointment(db, ctx(assamAdmin()), {
      personId: p, title: 'National Director', orgLevel: 'director',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a state administrator cannot write into another state', async () => {
    const p = await person('Ravi Das');
    await expect(createAppointment(db, ctx(keralaAdmin()), {
      personId: p, title: 'Assam State Coordinator', orgLevel: 'coordinator',
      scopeType: 'state', scopeStateUnitId: ASSAM,
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a media officer may read the register and not change it', async () => {
    const p = await person('Anita Bose');
    await createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' });
    expect(await adminAppointments(db, press)).toHaveLength(1);
    await expect(createAppointment(db, ctx(press), {
      personId: p, title: 'Something else', orgLevel: 'staff',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── Suspension and ending ──────────────────────────────────────────────────

describe('suspension and ending', () => {
  async function published(name = 'Anita Bose') {
    const p = await person(name);
    const a = await createAppointment(db, ctx(), { personId: p, title: 'Finance Officer', orgLevel: 'officer', startedOn: '2026-01-01' });
    await activateAppointment(db, ctx(), a.id);
    await publishAppointment(db, ctx(), a.id);
    return { personId: p, id: a.id };
  }

  it('suspending takes the person off the public page in the same act', async () => {
    const { id } = await published();
    expect(await publicTeam(db)).toHaveLength(1);
    await suspendAppointment(db, ctx(), id, 'under review');
    expect(await publicTeam(db)).toEqual([]);
  });

  it('a suspension without a reason is refused', async () => {
    const { id } = await published();
    await expect(suspendAppointment(db, ctx(), id, '   ')).rejects.toMatchObject({ code: 'bad_scope' });
  });

  it('the suspension reason never reaches the domain-event feed', async () => {
    const { id } = await published();
    await suspendAppointment(db, ctx(), id, 'allegation of misconduct');
    const rows = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'TEAM_APPOINTMENT_SUSPENDED'));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].payload)).not.toContain('misconduct');
    // 'restricted' — national audit:read only. At 'official' this would tell
    // every dojo administrator in India that a named officer is under review.
    expect(rows[0].classification).toBe('restricted');
  });

  it('ending an appointment leaves the membership, the rank and the person alone', async () => {
    const { personId, id } = await published('Pramod Pathak');
    await db.insert(s.rankRecords).values({
      personId, kind: 'dan', gradeLabel: 'Yondan', gradeOrdinal: 4,
      awardedOn: '2019-04-01', status: 'active',
    });
    await db.insert(s.memberships).values({
      personId, category: 'instructor', validFrom: '2026-01-01', status: 'active',
    });

    await endAppointment(db, ctx(), id, { endedOn: '2026-09-01', reason: 'moved on' });

    const [pRow] = await db.select().from(s.persons).where(eq(s.persons.id, personId));
    expect(pRow.status).toBe('active');
    const ranks = await db.select().from(s.rankRecords).where(eq(s.rankRecords.personId, personId));
    expect(ranks[0].status).toBe('active');
    const mem = await db.select().from(s.memberships).where(eq(s.memberships.personId, personId));
    expect(mem[0].status).toBe('active');
    expect(await publicTeam(db)).toEqual([]);
  });

  it('an appointment cannot end before it started', async () => {
    const p = await person('Anita Bose');
    const a = await createAppointment(db, ctx(), {
      personId: p, title: 'Officer', orgLevel: 'officer', startedOn: '2026-05-01',
    });
    await expect(endAppointment(db, ctx(), a.id, { endedOn: '2026-01-01' }))
      .rejects.toMatchObject({ code: 'bad_period' });
  });

  it('an ended appointment is not reopened', async () => {
    const { id } = await published();
    await endAppointment(db, ctx(), id, {});
    await expect(activateAppointment(db, ctx(), id)).rejects.toMatchObject({ code: 'already_ended' });
  });

  it('unpublishing withdraws from the site without ending the post', async () => {
    const { id } = await published();
    await unpublishAppointment(db, ctx(), id, 'asked not to appear');
    expect(await publicTeam(db)).toEqual([]);
    const [row] = await db.select().from(t.teamAppointments).where(eq(t.teamAppointments.id, id));
    expect(row.status).toBe('active');
  });
});

// ─── The database refuses what the code forgets ─────────────────────────────

describe('the CHECK constraints', () => {
  it('refuse a direct UPDATE that publishes a suspended appointment', async () => {
    const p = await person('Anita Bose');
    const a = await createAppointment(db, ctx(), { personId: p, title: 'Officer', orgLevel: 'officer' });
    await activateAppointment(db, ctx(), a.id);
    await suspendAppointment(db, ctx(), a.id, 'under review');
    // Bypassing the module entirely — this is the path a future bug takes.
    await expect(
      db.execute?.(`update team_appointments set published = true where id = ${a.id}`)
    ).rejects.toThrow();
  });

  it('refuse a state-scoped appointment with no state', async () => {
    const p = await person('Anita Bose');
    await expect(
      db.execute?.(`insert into team_appointments (person_id, title, org_level, scope_type, started_on)
                    values (${p}, 'X', 'staff', 'state', '2026-01-01')`)
    ).rejects.toThrow();
  });

  it('refuse an ended appointment with no end date', async () => {
    const p = await person('Anita Bose');
    await expect(
      db.execute?.(`insert into team_appointments (person_id, title, org_level, status, started_on)
                    values (${p}, 'X', 'staff', 'ended', '2026-01-01')`)
    ).rejects.toThrow();
  });
});

// ─── Links ──────────────────────────────────────────────────────────────────

describe('public links', () => {
  it('accept https and refuse everything else', () => {
    expect(sanitiseLinks([{ label: 'Profile', url: 'https://example.invalid/x' }]))
      .toEqual([{ label: 'Profile', url: 'https://example.invalid/x' }]);
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'http://example.invalid']) {
      expect(() => sanitiseLinks([{ label: 'X', url: bad }])).toThrow();
    }
  });

  it('refuse a malformed entry rather than silently dropping it', () => {
    expect(() => sanitiseLinks([{ label: 'ok', url: 'https://a.invalid' }, { label: '', url: 'https://b.invalid' }]))
      .toThrow();
  });
});

// ─── Departments ────────────────────────────────────────────────────────────

describe('departments', () => {
  it('ship empty — nothing is seeded', async () => {
    expect(await listDepartments(db)).toEqual([]);
  });

  it('refuse a cycle deeper than self-parenting', async () => {
    const a = await createDepartment(db, ctx(), { code: 'A', name: 'A' });
    const b = await createDepartment(db, ctx(), { code: 'B', name: 'B', parentId: a.id });
    await expect(setDepartmentParent(db, ctx(), a.id, b.id))
      .rejects.toMatchObject({ code: 'department_cycle' });
  });
});

// ─── One person, many relationships ─────────────────────────────────────────

describe('one canonical person', () => {
  it('an appointment attaches to an existing person and never creates one', async () => {
    await expect(createAppointment(db, ctx(), {
      personId: 999999, title: 'Ghost', orgLevel: 'staff',
    })).rejects.toMatchObject({ code: 'no_such_person' });
    const count = await db.select().from(s.persons);
    expect(count).toHaveLength(0);
  });

  it('gathers every relationship one person holds under one record', async () => {
    const p = await person('Pramod Pathak');
    await db.insert(s.rankRecords).values({
      personId: p, kind: 'dan', gradeLabel: 'Yondan', gradeOrdinal: 4,
      awardedOn: '2019-04-01', status: 'active',
    });
    await db.insert(s.instructorQuals).values({
      personId: p, level: 'senior', grantedOn: '2020-01-01', status: 'active',
    });
    await db.insert(s.memberships).values({
      personId: p, category: 'instructor', validFrom: '2026-01-01', status: 'active',
    });
    await createAppointment(db, ctx(), { personId: p, title: 'Technical Director', orgLevel: 'director' });

    const rel = await personRelationships(db, admin, p);
    expect(rel.person.fullName).toBe('Pramod Pathak');
    expect(rel.appointments).toHaveLength(1);
    expect(rel.ranks).toHaveLength(1);
    expect(rel.instructor).toHaveLength(1);
    expect(rel.memberships).toHaveLength(1);
  });

  it('refuses the same open title twice, including with no department', async () => {
    const p = await person('Anita Bose');
    await createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' });
    await expect(createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' }))
      .rejects.toMatchObject({ code: 'duplicate_appointment' });
  });
});

// ─── The version trail ──────────────────────────────────────────────────────

describe('the version trail', () => {
  it('records what the row said before each change', async () => {
    const p = await person('Anita Bose');
    const a = await createAppointment(db, ctx(), { personId: p, title: 'Officer', orgLevel: 'officer' });
    await updateAppointment(db, ctx(), a.id, { title: 'Senior Officer' });
    await activateAppointment(db, ctx(), a.id);
    await publishAppointment(db, ctx(), a.id);

    const hist = await appointmentHistory(db, admin, a.id);
    const changes = hist.map((h: any) => h.change);
    expect(changes).toContain('created');
    expect(changes).toContain('updated');
    expect(changes).toContain('published');

    const upd = hist.find((h: any) => h.change === 'updated');
    expect((upd.before as any).title).toBe('Officer');
    expect((upd.after as any).title).toBe('Senior Officer');
    expect(upd.actorLabel).toBe('federation admin');
  });

  it('refuses to show another state the trail of an appointment by id', async () => {
    const p = await person('Ravi Das');
    const a = await createAppointment(db, ctx(assamAdmin()), {
      personId: p, title: 'Assam State Coordinator', orgLevel: 'coordinator',
      scopeType: 'state', scopeStateUnitId: ASSAM,
    });
    await expect(appointmentHistory(db, keralaAdmin(), a.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('scopes the admin register so one state does not see another', async () => {
    const p1 = await person('Ravi Das');
    const p2 = await person('Meera Nair');
    await createAppointment(db, ctx(assamAdmin()), {
      personId: p1, title: 'Assam Coordinator', orgLevel: 'coordinator',
      scopeType: 'state', scopeStateUnitId: ASSAM,
    });
    await createAppointment(db, ctx(keralaAdmin()), {
      personId: p2, title: 'Kerala Coordinator', orgLevel: 'coordinator',
      scopeType: 'state', scopeStateUnitId: KERALA,
    });
    const seen = await adminAppointments(db, assamAdmin());
    expect(seen.map((r) => r.title)).toEqual(['Assam Coordinator']);
  });
});

// ─── Two defects found by reviewing this module against itself ──────────────
//
// Both were in code that read as correct, and both are the same class of
// mistake the sixth-wave review found in `decideDuplicate()`: a gate that asks
// "does this caller hold the action SOMEWHERE" standing in for one that should
// ask "may they do it HERE".
//
// Neither was reachable through the GRANTS table as it stands today, and that is
// exactly why they are worth pinning: the code was safe because of who happens
// to hold what, not because of what it checks. One role binding at a different
// scope, or one action added to a role, and both open.

describe('publishing is a NATIONAL act, not merely an act held somewhere', () => {
  /**
   * GENERAL_SECRETARY carries `team:publish`. Bound at a STATE, the old
   * `assertCanAnywhere('team:publish')` passed — after which the holder could
   * publish or withdraw ANY appointment in the country by id, the national
   * secretariat's included.
   */
  const stateSecretary = (): Principal => ({
    userId: 5, label: 'state secretary',
    bindings: [{ role: 'GENERAL_SECRETARY', scopeType: 'state', scopeId: ASSAM }],
  });

  it('refuses a team:publish holder whose reach is not national', async () => {
    const p = await person('Anita Bose');
    const a = await createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' });
    await activateAppointment(db, ctx(), a.id);

    await expect(publishAppointment(db, ctx(stateSecretary()), a.id))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(await publicTeam(db)).toEqual([]);
  });

  it('refuses the same holder WITHDRAWING a national appointment', async () => {
    const p = await person('Anita Bose');
    const a = await createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' });
    await activateAppointment(db, ctx(), a.id);
    await publishAppointment(db, ctx(), a.id);

    await expect(unpublishAppointment(db, ctx(stateSecretary()), a.id, 'because'))
      .rejects.toBeInstanceOf(ForbiddenError);
    // Still on the site — the refusal changed nothing.
    expect(await publicTeam(db)).toHaveLength(1);
  });
});

describe('personRelationships gates each section on the action that governs it', () => {
  /**
   * A MEDIA_OFFICER holds `team:read` and neither `rank:read` nor
   * `membership:read`. The first version of `personRelationships()` gated the
   * whole function on `team:read` and returned all four sections, which handed
   * the press office the rank and membership history of anybody in the
   * federation by walking person ids.
   */
  it('withholds ranks and memberships from a team:read holder who lacks them', async () => {
    const p = await person('Pramod Pathak');
    await db.insert(s.rankRecords).values({
      personId: p, kind: 'dan', gradeLabel: 'Yondan', gradeOrdinal: 4,
      awardedOn: '2019-04-01', status: 'active',
    });
    await db.insert(s.memberships).values({
      personId: p, category: 'instructor', validFrom: '2026-01-01', status: 'active',
    });
    await createAppointment(db, ctx(), { personId: p, title: 'Head of Media', orgLevel: 'head' });

    const asPress = await personRelationships(db, press, p);
    // null, NOT [] — "not yours to see" and "the register holds none" are
    // different answers and a surface must be able to tell them apart.
    expect(asPress.ranks).toBeNull();
    expect(asPress.memberships).toBeNull();
    expect(asPress.instructor).toBeNull();
    // What they DO hold still works.
    expect(asPress.appointments).toHaveLength(1);
    expect(asPress.person.fullName).toBe('Pramod Pathak');

    // And a national administrator, who holds all three, sees all three.
    const asAdmin = await personRelationships(db, admin, p);
    expect(asAdmin.ranks).toHaveLength(1);
    expect(asAdmin.memberships).toHaveLength(1);
  });

  it('returns [] rather than null when the caller may look and there is nothing', async () => {
    const p = await person('New Person');
    const rel = await personRelationships(db, admin, p);
    expect(rel.ranks).toEqual([]);
    expect(rel.memberships).toEqual([]);
  });
});
