// Global search, against real Postgres.
//
// The invariant these tests exist to protect: SEARCH CANNOT BECOME A BULK
// EXPORT. Every other assertion here supports that claim — the anonymous
// surface, the state administrator's boundary, certificates by number only, and
// the casework that is unreachable at every permission level including
// SUPER_ADMIN.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  search, SearchError, KIND_ORDER, PUBLIC_KINDS, NEVER_SEARCHABLE,
  PUBLIC_EVENT_STATUSES, MAX_QUERY_LENGTH,
  type SearchHit, type SearchKind, type NewsItem,
} from '../src/lib/search';
import type { Principal } from '../src/lib/rbac';

let db: any;
let JH: number, WB: number, RMG: number;
let HOMBU: number, DRAFT_DOJO: number, WB_DOJO: number;
let RAVI: number, ANITA: number;
let JH_CERT = '', WB_CERT = '';

const SEARCH_SOURCE = readFileSync('src/lib/search.ts', 'utf8');

// ─── Principals ─────────────────────────────────────────────────────────────

const anonymous = null;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const superAdmin: Principal = {
  userId: 2, label: 'super-admin',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
const safeguardingOfficer: Principal = {
  userId: 3, label: 'safeguarding-officer',
  bindings: [{ role: 'SAFEGUARDING_OFFICER', scopeType: 'national', scopeId: null }],
};
/** Bound to Jharkhand only — the boundary most of these tests probe. */
let stateAdminJH: Principal;
/** A signed-in member with no administrative authority anywhere. */
const member: Principal = {
  userId: 5, label: 'member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
};
/** Authority that has lapsed reduces to no authority at all. */
const expiredAdmin: Principal = {
  userId: 6, label: 'expired-admin',
  bindings: [{
    role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null,
    expiresAt: '2020-01-01T00:00:00Z',
  }],
};

const NEWS: NewsItem[] = [
  { id: 1, title: 'District Championship concluded at Ramgarh', date: '23 Jun 2026', type: 'Competition', body: 'Athletes from affiliated dojos competed across kata and kumite divisions.' },
  { id: 2, title: 'Women self-defence programme expands', date: '21 Apr 2026', type: 'Community', body: 'The programme has been adopted by schools across the district.' },
];
const newsProvider = async () => NEWS;

function kinds(hits: SearchHit[]): SearchKind[] {
  return [...new Set(hits.map((h) => h.kind))].sort();
}
function titles(hits: SearchHit[]): string[] {
  return hits.map((h) => h.title);
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // ── Federation hierarchy ──
  [{ id: JH }] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand State Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  [{ id: WB }] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-WB', state: 'West Bengal', name: 'West Bengal State Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  [{ id: RMG }] = await db.insert(s.districtUnits)
    .values({ code: 'MMAKF-DIST-JH-RMG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh District Unit', status: 'active' })
    .returning({ id: s.districtUnits.id });

  stateAdminJH = {
    userId: 4, label: 'jh-state-admin',
    bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
  };

  // ── Dojos: one active in each state, one still a draft ──
  [{ id: HOMBU }] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-RMG-001', name: 'Hombu Shotokan Dojo',
    stateUnitId: JH, districtUnitId: RMG, city: 'Patratu', status: 'active',
  }).returning({ id: s.dojos.id });
  [{ id: DRAFT_DOJO }] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-RMG-002', name: 'Hombu Annexe Dojo',
    stateUnitId: JH, districtUnitId: RMG, city: 'Patratu', status: 'draft',
  }).returning({ id: s.dojos.id });
  [{ id: WB_DOJO }] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-WB-KOL-001', name: 'Hombu Kolkata Dojo',
    stateUnitId: WB, city: 'Kolkata', status: 'active',
  }).returning({ id: s.dojos.id });

  // ── People: same surname in two states, so a scope leak is visible ──
  [{ id: RAVI }] = await db.insert(s.persons).values({
    federationId: 'MMAKF-MEM-2026-000001', fullName: 'Ravi Kumar',
    dob: '2005-04-01', email: 'ravi@example.test', phone: '+919999999999',
    city: 'Patratu', stateUnitId: JH, districtUnitId: RMG, dojoId: HOMBU, status: 'active',
  }).returning({ id: s.persons.id });
  [{ id: ANITA }] = await db.insert(s.persons).values({
    federationId: 'MMAKF-MEM-2026-000002', fullName: 'Anita Kumar',
    dob: '2004-02-02', email: 'anita@example.test',
    city: 'Kolkata', stateUnitId: WB, dojoId: WB_DOJO, status: 'active',
  }).returning({ id: s.persons.id });

  // ── Certificates, one per state ──
  JH_CERT = 'MMAKF-CERT-2026-000001';
  WB_CERT = 'MMAKF-CERT-2026-000002';
  await db.insert(s.certificates).values([
    {
      certificateNo: JH_CERT, kind: 'kyu_grade', personId: RAVI,
      title: 'Ravi Kumar — 9th Kyu', issuedOn: '2026-03-01',
      issuingAuthority: 'MMAKF', verifyToken: 'tok-jh-0001', snapshot: { holder: 'Ravi Kumar' },
    },
    {
      certificateNo: WB_CERT, kind: 'kyu_grade', personId: ANITA,
      title: 'Anita Kumar — 8th Kyu', issuedOn: '2026-03-02',
      issuingAuthority: 'MMAKF', verifyToken: 'tok-wb-0002', snapshot: { holder: 'Anita Kumar' },
    },
  ]);

  // ── Competition events ──
  await db.insert(s.competitionEvents).values([
    {
      code: 'MMAKF-EVT-2026-000001', title: 'National Shotokan Championship',
      kind: 'national_championship', status: 'published', city: 'Ranchi',
      description: 'Open to all affiliated units.',
    },
    {
      code: 'MMAKF-EVT-2026-000002', title: 'Jharkhand State Championship',
      kind: 'state_championship', status: 'draft', stateUnitId: JH, city: 'Ramgarh',
    },
    {
      code: 'MMAKF-EVT-2026-000003', title: 'West Bengal State Championship',
      kind: 'state_championship', status: 'draft', stateUnitId: WB, city: 'Kolkata',
    },
  ]);

  // ── Courses: one published, one draft ──
  await db.insert(s.courses).values([
    { slug: 'shotokan-foundations', title: 'Shotokan Foundations', summary: 'An introduction to kihon.', status: 'published', category: 'shotokan' },
    { slug: 'shotokan-unreleased', title: 'Shotokan Advanced Draft', summary: 'Not yet published.', status: 'draft', category: 'shotokan' },
  ]);

  // ── Documents: public/published, public/draft, confidential/published ──
  const [pubDoc] = await db.insert(s.officialDocuments).values({
    code: 'MMAKF-DOC-CONST', title: 'Constitution of the Federation',
    category: 'constitution', summary: 'The governing instrument.', classification: 'public',
  }).returning({ id: s.officialDocuments.id });
  const [pubV] = await db.insert(s.documentVersions)
    .values({ documentId: pubDoc.id, version: '1.0', status: 'published' })
    .returning({ id: s.documentVersions.id });
  await db.update(s.officialDocuments)
    .set({ currentVersionId: pubV.id }).where(eq(s.officialDocuments.id, pubDoc.id));

  const [draftDoc] = await db.insert(s.officialDocuments).values({
    code: 'MMAKF-DOC-BYELAW', title: 'Constitution Bye-laws (unadopted)',
    category: 'byelaw', classification: 'public',
  }).returning({ id: s.officialDocuments.id });
  const [draftV] = await db.insert(s.documentVersions)
    .values({ documentId: draftDoc.id, version: '0.1', status: 'draft' })
    .returning({ id: s.documentVersions.id });
  await db.update(s.officialDocuments)
    .set({ currentVersionId: draftV.id }).where(eq(s.officialDocuments.id, draftDoc.id));

  const [secretDoc] = await db.insert(s.officialDocuments).values({
    code: 'MMAKF-DOC-PANEL', title: 'Constitution Review Panel — confidential minutes',
    category: 'policy', classification: 'confidential',
  }).returning({ id: s.officialDocuments.id });
  const [secretV] = await db.insert(s.documentVersions)
    .values({ documentId: secretDoc.id, version: '1.0', status: 'published' })
    .returning({ id: s.documentVersions.id });
  await db.update(s.officialDocuments)
    .set({ currentVersionId: secretV.id }).where(eq(s.officialDocuments.id, secretDoc.id));

  // ── Technical reference, laid out so relevance tiers are distinguishable ──
  await db.insert(s.techniques).values([
    { slug: 'mae-geri', nameRomaji: 'Mae-geri', nameEn: 'Front kick', category: 'geri', published: true },
    { slug: 'mae-geri-keage', nameRomaji: 'Mae-geri keage', category: 'geri', published: true },
    { slug: 'ushiro-geri', nameRomaji: 'Ushiro-geri', category: 'geri', published: true, description: 'Often taught as a counter to mae-geri.' },
    { slug: 'unpublished-geri', nameRomaji: 'Mae-geri draft entry', category: 'geri', published: false },
  ]);
  await db.insert(s.kata).values([
    { slug: 'heian-shodan', nameRomaji: 'Heian Shodan', family: 'Heian', published: true },
    { slug: 'heian-nidan', nameRomaji: 'Heian Nidan', family: 'Heian', published: false },
  ]);

  // ── Casework. Present in the database, unreachable from search. ──
  await db.insert(s.safeguardingCases).values({
    caseNo: 'MMAKF-SG-2026-0001',
    concernSummary: 'Kumar concern reported at Hombu Shotokan Dojo',
    receivedOn: '2026-05-01', subjectPersonId: RAVI,
  });
  await db.insert(s.disciplinaryCases).values({
    caseNo: 'MMAKF-DC-2026-0001',
    summary: 'Kumar alleged breach at Hombu Shotokan Dojo',
    receivedOn: '2026-05-02', subjectPersonId: RAVI,
  });
  await db.insert(s.medicalRecords).values({
    personId: RAVI, kind: 'injury', summary: 'Kumar shoulder injury noted at Hombu',
    recordedOn: '2026-05-03',
  });
  await db.insert(s.caseNotes).values({
    caseKind: 'safeguarding', caseId: 1, note: 'Kumar interview note from Hombu',
  });
}, 120_000);

// ─── The anonymous surface ──────────────────────────────────────────────────

describe('an unauthenticated caller reaches only public data', () => {
  it('returns nothing from the member register, whatever the query', async () => {
    const r = await search(db, anonymous, 'Kumar', { newsProvider });
    expect(kinds(r.hits)).not.toContain('person');
    expect(r.skipped.find((x) => x.kind === 'person')?.reason).toBe('not_public');
  });

  it('cannot reach a person even by asking for that domain explicitly', async () => {
    const r = await search(db, anonymous, 'MMAKF-MEM-2026-000001', {
      kinds: ['person', 'certificate'], newsProvider,
    });
    expect(r.hits).toHaveLength(0);
    expect(r.kinds).toHaveLength(0);
  });

  it('confines every hit to the public domains', async () => {
    // A query broad enough to touch most fixtures in the database.
    for (const q of ['Kumar', 'Shotokan', 'MMAKF', 'Championship', 'Constitution']) {
      const r = await search(db, anonymous, q, { newsProvider, limit: 50 });
      for (const hit of r.hits) expect(PUBLIC_KINDS).toContain(hit.kind);
    }
  });

  it('sees the active dojo directory but not unaffiliated drafts', async () => {
    const r = await search(db, anonymous, 'Hombu', { kinds: ['dojo'], newsProvider });
    expect(titles(r.hits).sort()).toEqual(['Hombu Kolkata Dojo', 'Hombu Shotokan Dojo']);
    expect(r.hits.map((h) => h.id)).not.toContain(String(DRAFT_DOJO));
  });

  it('sees published courses only', async () => {
    const r = await search(db, anonymous, 'Shotokan', { kinds: ['course'], newsProvider });
    expect(titles(r.hits)).toEqual(['Shotokan Foundations']);
  });

  it('sees a published public document, not a draft and not a confidential one', async () => {
    const r = await search(db, anonymous, 'Constitution', { kinds: ['document'], newsProvider });
    expect(titles(r.hits)).toEqual(['Constitution of the Federation']);
  });

  it('sees news', async () => {
    const r = await search(db, anonymous, 'Ramgarh', { kinds: ['news'], newsProvider });
    expect(titles(r.hits)).toEqual(['District Championship concluded at Ramgarh']);
  });

  it('treats lapsed authority as no authority', async () => {
    const r = await search(db, expiredAdmin, 'Kumar', { kinds: ['person'], newsProvider });
    expect(r.hits).toHaveLength(0);
  });

  it('gives a signed-in member no certificate reach', async () => {
    // MEMBER holds person:read and content:read but not certificate:read, so
    // the register is searchable to them while the grading register is not.
    const r = await search(db, member, 'Kumar', { newsProvider, limit: 50 });
    expect(kinds(r.hits)).not.toContain('certificate');
    expect(r.skipped.find((x) => x.kind === 'certificate')?.reason).toBe('not_authorised');
  });

  it('gives a signed-in member no sight of unpublished content', async () => {
    // content:read is held by every member; drafts are gated on content:write,
    // which is not, so an unreleased course stays unreleased.
    const r = await search(db, member, 'Shotokan', { kinds: ['course'], newsProvider });
    expect(titles(r.hits)).toEqual(['Shotokan Foundations']);
  });
});

// ─── Scope ──────────────────────────────────────────────────────────────────

describe("a state administrator's results stay inside their state", () => {
  it('finds their own member and not the identically-named member elsewhere', async () => {
    const r = await search(db, stateAdminJH, 'Kumar', { kinds: ['person'], newsProvider });
    expect(titles(r.hits)).toEqual(['Ravi Kumar']);
  });

  it('cannot reach the out-of-state member by exact federation id either', async () => {
    const r = await search(db, stateAdminJH, 'MMAKF-MEM-2026-000002', {
      kinds: ['person'], newsProvider,
    });
    expect(r.hits).toHaveLength(0);
  });

  it('a national administrator sees both', async () => {
    const r = await search(db, national, 'Kumar', { kinds: ['person'], newsProvider });
    expect(titles(r.hits).sort()).toEqual(['Anita Kumar', 'Ravi Kumar']);
  });

  it('never exposes personal data in the projection', async () => {
    const r = await search(db, national, 'Kumar', { kinds: ['person'], newsProvider });
    const blob = JSON.stringify(r.hits);
    expect(blob).not.toContain('ravi@example.test');
    expect(blob).not.toContain('+919999999999');
    expect(blob).not.toContain('2005-04-01');
  });

  it('confines dojo results to their state, plus the public directory', async () => {
    const r = await search(db, stateAdminJH, 'Hombu', { kinds: ['dojo'], newsProvider });
    // Their own state including the draft, and the other state's ACTIVE dojo,
    // which is public information anyway.
    expect(titles(r.hits).sort())
      .toEqual(['Hombu Annexe Dojo', 'Hombu Kolkata Dojo', 'Hombu Shotokan Dojo']);
  });

  it('confines unpublished events to their state while keeping national ones', async () => {
    const r = await search(db, stateAdminJH, 'Championship', {
      kinds: ['competition_event'], newsProvider, limit: 50,
    });
    expect(titles(r.hits).sort())
      .toEqual(['Jharkhand State Championship', 'National Shotokan Championship']);
  });

  it('confines state units to their own', async () => {
    const r = await search(db, stateAdminJH, 'State Unit', { kinds: ['state_unit'], newsProvider });
    expect(titles(r.hits)).toEqual(['Jharkhand State Unit']);
  });

  it('sees national reference material but not its unpublished drafts', async () => {
    // Techniques carry no unit columns, so there is nothing for a state binding
    // to scope. The published/unpublished line does the work instead.
    const r = await search(db, stateAdminJH, 'Mae-geri', { kinds: ['technique'], newsProvider });
    expect(titles(r.hits)).not.toContain('Mae-geri draft entry');
    expect(titles(r.hits)).toContain('Mae-geri');
  });

  it('reports why a domain returned nothing rather than failing silently', async () => {
    // MEMBER holds neither unit:read nor competition:read, and is told so.
    const r = await search(db, member, 'Championship', { newsProvider, limit: 50 });
    expect(r.skipped.find((x) => x.kind === 'state_unit')?.reason).toBe('not_authorised');
    expect(r.skipped.find((x) => x.kind === 'competition_event')?.reason).toBe('not_authorised');
  });
});

// ─── Certificates ───────────────────────────────────────────────────────────

describe('certificates are findable by number and by nothing else', () => {
  it('is not searchable by holder name, even for a national administrator', async () => {
    const r = await search(db, national, 'Kumar', { newsProvider, limit: 50 });
    expect(kinds(r.hits)).not.toContain('certificate');
  });

  it('is not searchable by certificate title', async () => {
    const r = await search(db, national, '9th Kyu', { kinds: ['certificate'], newsProvider });
    expect(r.hits).toHaveLength(0);
  });

  it('is not searchable by a prefix of the number', async () => {
    // Certificate numbers are sequential; a prefix search walks the register.
    const r = await search(db, national, 'MMAKF-CERT-2026', { kinds: ['certificate'], newsProvider });
    expect(r.hits).toHaveLength(0);
  });

  it('is found by the exact number', async () => {
    const r = await search(db, national, JH_CERT, { kinds: ['certificate'], newsProvider });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.ref).toBe(JH_CERT);
    expect(r.hits[0]!.matchedOn).toEqual({
      field: 'certificateNo', value: JH_CERT, how: 'exact', rank: 0,
    });
  });

  it('matches the number case-insensitively', async () => {
    const r = await search(db, national, JH_CERT.toLowerCase(), {
      kinds: ['certificate'], newsProvider,
    });
    expect(r.hits).toHaveLength(1);
  });

  it('is scope-filtered through the holder even on an exact number', async () => {
    const own = await search(db, stateAdminJH, JH_CERT, { kinds: ['certificate'], newsProvider });
    expect(own.hits).toHaveLength(1);
    const other = await search(db, stateAdminJH, WB_CERT, { kinds: ['certificate'], newsProvider });
    expect(other.hits).toHaveLength(0);
  });

  it('never exposes the verify token, which is the QR secret', async () => {
    const byToken = await search(db, national, 'tok-jh-0001', { kinds: ['certificate'], newsProvider });
    expect(byToken.hits).toHaveLength(0);
    const byNumber = await search(db, national, JH_CERT, { kinds: ['certificate'], newsProvider });
    expect(JSON.stringify(byNumber.hits)).not.toContain('tok-jh-0001');
  });

  it('says a multi-word query is not a certificate number rather than returning []', async () => {
    const r = await search(db, national, 'Ravi Kumar', { kinds: ['certificate'], newsProvider });
    expect(r.skipped.find((x) => x.kind === 'certificate')?.reason)
      .toBe('not_a_certificate_number');
  });
});

// ─── Casework is unreachable, at every level ────────────────────────────────

describe('safeguarding, medical and disciplinary records are never searchable', () => {
  it('returns no casework hit for anyone, on any of its distinctive strings', async () => {
    // Deliberately includes the two principals that CAN read casework through
    // its own access path: a safeguarding officer and SUPER_ADMIN. Search is not
    // that path, and holding the authority does not open this door.
    const everyone: Array<[string, Principal | null]> = [
      ['anonymous', anonymous],
      ['member', member],
      ['state admin', stateAdminJH],
      ['national admin', national],
      ['safeguarding officer', safeguardingOfficer],
      ['SUPER_ADMIN', superAdmin],
    ];
    const probes = [
      'MMAKF-SG-2026-0001',       // safeguarding case number
      'MMAKF-DC-2026-0001',       // disciplinary case number
      'concern reported',         // safeguarding summary
      'alleged breach',           // disciplinary summary
      'shoulder injury',          // medical summary
      'interview note',           // case note
    ];
    for (const [who, principal] of everyone) {
      for (const probe of probes) {
        const r = await search(db, principal, probe, { newsProvider, limit: 50 });
        for (const hit of r.hits) {
          expect(hit.matchedOn.value, `${who} / ${probe}`).not.toContain('concern');
          expect(hit.matchedOn.value, `${who} / ${probe}`).not.toContain('injury');
          expect(hit.matchedOn.value, `${who} / ${probe}`).not.toContain('alleged');
        }
        expect(r.hits.map((h) => h.ref)).not.toContain('MMAKF-SG-2026-0001');
        expect(r.hits.map((h) => h.ref)).not.toContain('MMAKF-DC-2026-0001');
      }
    }
  });

  it('has no result kind that could carry casework', () => {
    for (const forbidden of ['safeguarding', 'medical', 'disciplinary', 'case', 'note']) {
      expect(KIND_ORDER.filter((k) => k.includes(forbidden))).toHaveLength(0);
    }
  });

  it('does not reference the casework tables at all', () => {
    // Structural, not aspirational: the module cannot query what it never names.
    for (const table of NEVER_SEARCHABLE) {
      expect(SEARCH_SOURCE).not.toContain(`s.${table}`);
    }
  });

  it('the casework rows really are in the database', async () => {
    // Otherwise the assertions above would pass against an empty table and
    // prove nothing at all.
    const sg = await db.select().from(s.safeguardingCases);
    const dc = await db.select().from(s.disciplinaryCases);
    const md = await db.select().from(s.medicalRecords);
    const cn = await db.select().from(s.caseNotes);
    expect(sg).toHaveLength(1);
    expect(dc).toHaveLength(1);
    expect(md).toHaveLength(1);
    expect(cn).toHaveLength(1);
  });
});

// ─── Query hygiene ──────────────────────────────────────────────────────────

describe('query hygiene', () => {
  it('refuses a query shorter than the minimum', async () => {
    await expect(search(db, national, 'a', { newsProvider })).rejects.toMatchObject({
      name: 'SearchError', code: 'query_too_short',
    });
  });

  it('refuses a query longer than the maximum', async () => {
    await expect(
      search(db, national, 'x'.repeat(MAX_QUERY_LENGTH + 1), { newsProvider })
    ).rejects.toMatchObject({ code: 'query_too_long' });
  });

  it('refuses a non-string query', async () => {
    await expect(search(db, national, 42 as any, { newsProvider })).rejects.toBeInstanceOf(SearchError);
  });

  it('normalises whitespace and reports the query it actually ran', async () => {
    const r = await search(db, national, '  Ravi   Kumar  ', { kinds: ['person'], newsProvider });
    expect(r.query).toBe('Ravi Kumar');
    expect(titles(r.hits)).toEqual(['Ravi Kumar']);
  });

  it('survives SQL metacharacters without executing anything', async () => {
    const hostile = [
      "'; DROP TABLE persons; --",
      "' OR '1'='1",
      'Kumar" UNION SELECT * FROM users --',
      '\\; select pg_sleep(1)',
      '${jndi:ldap://x}',
    ];
    for (const q of hostile) {
      const r = await search(db, national, q, { newsProvider, limit: 50 });
      expect(r.hits).toHaveLength(0);
    }
    // The register is intact — the point of the test.
    expect(await db.select().from(s.persons)).toHaveLength(2);
  });

  it('treats LIKE wildcards as literal characters, not as match-everything', async () => {
    // Unescaped, '%%' would match every person in the federation.
    const wild = await search(db, national, '%%', { kinds: ['person'], newsProvider, limit: 50 });
    expect(wild.hits).toHaveLength(0);

    const underscore = await search(db, national, '_umar', { kinds: ['person'], newsProvider });
    expect(underscore.hits).toHaveLength(0);

    const trailing = await search(db, national, 'Kumar%', { kinds: ['person'], newsProvider });
    expect(trailing.hits).toHaveLength(0);

    // A lone trailing backslash must not be left dangling as a LIKE escape.
    const backslash = await search(db, national, 'Kumar\\', { kinds: ['person'], newsProvider });
    expect(backslash.hits).toHaveLength(0);
  });

  it('strips control characters rather than storing them in the audit record', async () => {
    const r = await search(db, national, 'Ravi\u0000\u001fKumar', {
      kinds: ['person'], newsProvider,
    });
    expect(r.query).toBe('Ravi Kumar');
  });
});

// ─── Explanation and ranking ────────────────────────────────────────────────

describe('every hit explains itself', () => {
  it('populates matchedOn on every hit of every kind', async () => {
    const seen = new Set<SearchKind>();
    for (const q of ['Kumar', 'Hombu', 'Shotokan', 'Constitution', 'Championship',
      'Mae-geri', 'Heian', 'Ramgarh', 'State Unit', JH_CERT]) {
      const r = await search(db, superAdmin, q, { newsProvider, limit: 50 });
      for (const hit of r.hits) {
        seen.add(hit.kind);
        expect(hit.matchedOn).toBeTruthy();
        expect(typeof hit.matchedOn.field).toBe('string');
        expect(hit.matchedOn.field.length).toBeGreaterThan(0);
        expect(hit.matchedOn.value.length).toBeGreaterThan(0);
        expect(['exact', 'prefix', 'substring']).toContain(hit.matchedOn.how);
        expect(Number.isInteger(hit.matchedOn.rank)).toBe(true);
      }
    }
    // The assertion above is only meaningful if it actually saw most domains.
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });

  it('names the field that matched, not merely that something did', async () => {
    const byId = await search(db, national, 'MMAKF-MEM-2026-000001', {
      kinds: ['person'], newsProvider,
    });
    expect(byId.hits[0]!.matchedOn.field).toBe('federationId');

    const byName = await search(db, national, 'Ravi Kumar', { kinds: ['person'], newsProvider });
    expect(byName.hits[0]!.matchedOn.field).toBe('fullName');
  });

  it('ranks exact identifier, then prefix, then substring', async () => {
    // `member` rather than an editor, so the unpublished fixture stays out and
    // the three tiers are the only thing under test.
    const r = await search(db, member, 'mae-geri', { kinds: ['technique'], newsProvider });
    expect(titles(r.hits)).toEqual(['Mae-geri', 'Mae-geri keage', 'Ushiro-geri']);
    expect(r.hits.map((h) => h.matchedOn.how)).toEqual(['exact', 'prefix', 'substring']);
    expect(r.hits.map((h) => h.matchedOn.rank)).toEqual([0, 2, 5]);
    expect(r.hits.map((h) => h.matchedOn.field)).toEqual(['slug', 'slug', 'description']);
  });

  it('is deterministic: the same query twice gives the same list in the same order', async () => {
    const a = await search(db, superAdmin, 'Shotokan', { newsProvider, limit: 50 });
    const b = await search(db, superAdmin, 'Shotokan', { newsProvider, limit: 50 });
    expect(a.hits).toEqual(b.hits);
    // And ranks are non-decreasing, so relevance order is visible in the output.
    const ranks = a.hits.map((h) => h.matchedOn.rank);
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });

  it('windows a long prose match instead of returning the whole field', async () => {
    const long = 'x'.repeat(400);
    await db.insert(s.courses).values({
      slug: 'snippet-course', title: 'Snippet Course', status: 'published',
      summary: `${long} kihonwaza ${long}`,
    });
    const r = await search(db, anonymous, 'kihonwaza', { kinds: ['course'], newsProvider });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.matchedOn.value).toContain('kihonwaza');
    expect(r.hits[0]!.matchedOn.value.length).toBeLessThan(200);
  });
});

// ─── Shape, limits, links and audit ─────────────────────────────────────────

describe('response shape and controls', () => {
  it('returns a uniform hit shape for every kind', async () => {
    const r = await search(db, superAdmin, 'Shotokan', { newsProvider, limit: 50 });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const hit of r.hits) {
      expect(Object.keys(hit).sort())
        .toEqual(['id', 'kind', 'matchedOn', 'ref', 'subtitle', 'title', 'url']);
      expect(typeof hit.id).toBe('string');
      expect(typeof hit.title).toBe('string');
    }
  });

  it('honours the limit and flags truncation', async () => {
    const r = await search(db, superAdmin, 'Hombu', { newsProvider, limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.truncated).toBe(true);

    const all = await search(db, superAdmin, 'Hombu', { newsProvider, limit: 50 });
    expect(all.truncated).toBe(false);
    // The truncated page is the head of the full ordering, not a random slice.
    expect(r.hits[0]).toEqual(all.hits[0]);
  });

  it('clamps an absurd limit rather than honouring it', async () => {
    const r = await search(db, superAdmin, 'MMAKF', { newsProvider, limit: 10_000 });
    expect(r.hits.length).toBeLessThanOrEqual(50);
  });

  it('never returns the same record twice', async () => {
    const r = await search(db, superAdmin, 'Shotokan', { newsProvider, limit: 50 });
    const keys = r.hits.map((h) => `${h.kind}:${h.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses a non-public domain to an anonymous caller who asks for it by name', async () => {
    const r = await search(db, anonymous, 'Heian', {
      kinds: ['kata', 'technique', 'certificate', 'state_unit'], newsProvider,
    });
    expect(r.hits).toHaveLength(0);
    expect(r.skipped.map((x) => x.reason)).not.toContain('not_authorised');
    for (const k of ['kata', 'technique', 'certificate', 'state_unit'] as SearchKind[]) {
      expect(r.skipped.find((x) => x.kind === k)?.reason).toBe('not_public');
    }
  });

  it('lists which domains ran and why the others did not', async () => {
    const r = await search(db, anonymous, 'Shotokan', { kinds: ['dojo', 'person'], newsProvider });
    expect(r.kinds).toEqual(['dojo']);
    expect(r.skipped.find((x) => x.kind === 'person')?.reason).toBe('not_public');
    expect(r.skipped.find((x) => x.kind === 'kata')?.reason).toBe('not_requested');
    // Every kind is accounted for exactly once, either run or explained.
    expect(r.kinds.length + r.skipped.length).toBe(KIND_ORDER.length);
  });

  it('links a certificate to the verification service and invents no other route', async () => {
    const cert = await search(db, national, JH_CERT, { kinds: ['certificate'], newsProvider });
    expect(cert.hits[0]!.url).toBe(`/api/verify?id=${encodeURIComponent(JH_CERT)}`);

    // Per-record pages for other kinds do not exist in this repository, and a
    // link to a 404 would be a fake feature.
    const person = await search(db, national, 'Ravi Kumar', { kinds: ['person'], newsProvider });
    expect(person.hits[0]!.url).toBeNull();
  });

  it('lets a caller that has built record routes supply its own', async () => {
    const r = await search(db, national, 'Ravi Kumar', {
      kinds: ['person'], newsProvider,
      url: (h) => `/register/${h.kind}/${h.ref}`,
    });
    expect(r.hits[0]!.url).toBe('/register/person/MMAKF-MEM-2026-000001');
  });

  it('writes one audit row when the caller supplies an audit context', async () => {
    const before = await db.select().from(s.auditEvents);
    await search(db, national, 'Kumar', {
      kinds: ['person'], newsProvider,
      audit: { principal: national, reason: 'membership enquiry' },
    });
    const after = await db.select().from(s.auditEvents);
    expect(after.length).toBe(before.length + 1);

    const row = after[after.length - 1]!;
    expect(row.entityType).toBe('search');
    expect(row.action).toBe('export');
    expect(row.reason).toBe('membership enquiry');
    expect((row.newValue as any).query).toBe('Kumar');
    expect((row.newValue as any).returned).toBe(2);
  });

  it('writes no audit row when no context is supplied', async () => {
    const before = await db.select().from(s.auditEvents);
    await search(db, national, 'Kumar', { kinds: ['person'], newsProvider });
    const after = await db.select().from(s.auditEvents);
    expect(after.length).toBe(before.length);
  });

  it('survives an unreachable editorial store instead of failing the search', async () => {
    const r = await search(db, anonymous, 'Ramgarh', {
      newsProvider: async () => { throw new Error('redis down'); },
    });
    // "The store is down" and "there is no news" are different facts.
    expect(r.skipped.find((x) => x.kind === 'news')?.reason).toBe('store_unavailable');
    // The Postgres-backed domains still answered.
    expect(r.kinds).toContain('dojo');
  });
});

// ─── Unpublished technical reference ────────────────────────────────────────

describe('unpublished reference material', () => {
  it('is invisible to anyone without national content authority', async () => {
    const r = await search(db, member, 'Heian', { kinds: ['kata'], newsProvider });
    expect(titles(r.hits)).toEqual(['Heian Shodan']);
  });

  it('is visible to national content authority, which is who has to review it', async () => {
    const r = await search(db, national, 'Heian', { kinds: ['kata'], newsProvider });
    expect(titles(r.hits).sort()).toEqual(['Heian Nidan', 'Heian Shodan']);
  });

  it('reaches an unadopted document for an editor, never a confidential one', async () => {
    const r = await search(db, superAdmin, 'Constitution', { kinds: ['document'], newsProvider });
    expect(titles(r.hits).sort())
      .toEqual(['Constitution Bye-laws (unadopted)', 'Constitution of the Federation']);
    // Confidential classification is excluded by allow-list at every level, so a
    // classification added to the enum later is excluded by default.
    expect(titles(r.hits)).not.toContain('Constitution Review Panel — confidential minutes');
  });
});

// ─── Fail-closed: the inputs nobody types on purpose ────────────────────────
//
// Each of these was a live defect. They share a shape: a caller hands search
// something malformed, and the OLD code answered anyway — with everything, with
// nothing, or with a stack trace. A search that cannot be trusted to refuse is
// not trustworthy when it accepts.

describe('malformed input grants nothing and says so', () => {
  it('reads an EMPTY kinds array as no domains, not as every domain', async () => {
    // The attack is a caller that filters its domain list down to nothing —
    // "search only the domains this surface is allowed to show" — and gets a
    // full-federation search because [] was read as "unset".
    const r = await search(db, national, 'Kumar', { kinds: [], newsProvider, limit: 50 });
    expect(r.hits).toHaveLength(0);
    expect(r.kinds).toHaveLength(0);
    expect(r.skipped).toHaveLength(KIND_ORDER.length);
    for (const sk of r.skipped) expect(sk.reason).toBe('not_requested');

    // And the same query with kinds OMITTED does reach the register, so the
    // assertion above is about `[]` and not about an unrelated refusal.
    const unset = await search(db, national, 'Kumar', { newsProvider, limit: 50 });
    expect(kinds(unset.hits)).toContain('person');
  });

  it('refuses an unknown domain instead of silently dropping it', async () => {
    await expect(
      search(db, national, 'Kumar', { kinds: ['persons' as SearchKind], newsProvider })
    ).rejects.toMatchObject({ code: 'unknown_kind' });
  });

  it('refuses a non-finite limit rather than reporting a complete empty page', async () => {
    // The old failure: Math.min(Math.max(1, NaN), 50) is NaN, so slice(0, NaN)
    // returned [] and `truncated` was false — "no results, and that is all of
    // them" over a register that was full of matches.
    for (const bad of [Number.NaN, Infinity, -Infinity, '20' as unknown as number]) {
      await expect(
        search(db, national, 'Kumar', { limit: bad, newsProvider })
      ).rejects.toMatchObject({ code: 'limit_invalid' });
    }
    // A real limit over the same query does find rows, so the refusals above
    // are not masking an empty fixture.
    const ok = await search(db, national, 'Kumar', { kinds: ['person'], newsProvider });
    expect(ok.hits.length).toBeGreaterThan(0);
  });

  it('clamps a fractional or zero limit instead of refusing it', async () => {
    const r = await search(db, national, 'Kumar', { kinds: ['person'], newsProvider, limit: 0 });
    expect(r.hits).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('reduces a principal with unusable bindings to the anonymous surface', async () => {
    // rbac.visibleScopes() iterates `bindings` directly, so a principal whose
    // bindings are missing used to throw a TypeError out of the middle of a
    // search. An unresolvable caller must grant nothing, not crash.
    const broken = { userId: 99, label: 'broken', bindings: undefined as any };
    const r = await search(db, broken, 'Kumar', { newsProvider, limit: 50 });
    for (const hit of r.hits) expect(PUBLIC_KINDS).toContain(hit.kind);
    expect(kinds(r.hits)).not.toContain('person');
    expect(r.skipped.find((x) => x.kind === 'person')?.reason).toBe('not_public');
  });

  it('reduces a principal whose bindings are the wrong type to the anonymous surface', async () => {
    const broken = { userId: 98, label: 'broken', bindings: 'SUPER_ADMIN' as any };
    const r = await search(db, broken, 'MMAKF-MEM-2026-000001', {
      kinds: ['person', 'certificate'], newsProvider,
    });
    expect(r.hits).toHaveLength(0);
    expect(r.kinds).toHaveLength(0);
  });
});

// ─── The audit row must name the reader ─────────────────────────────────────

describe('an audit of a register search names the caller who made it', () => {
  it('refuses an audit context naming a different principal', async () => {
    const before = await db.select().from(s.auditEvents);
    await expect(
      search(db, stateAdminJH, 'Kumar', {
        kinds: ['person'], newsProvider,
        // The JH admin searches, but the row would have been filed against the
        // national administrator. A false record of who read the register is
        // worse than no record at all.
        audit: { principal: national, reason: 'membership enquiry' },
      })
    ).rejects.toMatchObject({ code: 'audit_actor_mismatch' });
    const after = await db.select().from(s.auditEvents);
    expect(after.length).toBe(before.length);
  });

  it('refuses to file an audit row for a search nobody was signed in for', async () => {
    await expect(
      search(db, anonymous, 'Shotokan', {
        kinds: ['dojo'], newsProvider,
        audit: { principal: national },
      })
    ).rejects.toMatchObject({ code: 'audit_actor_mismatch' });
  });
});

// ─── Document classification is CONFIGURATION, not this module's guess ──────

describe('document classification comes from the federation, not from search', () => {
  beforeAll(async () => {
    const [doc] = await db.insert(s.officialDocuments).values({
      code: 'MMAKF-DOC-OFFH', title: 'Officials Handbook',
      category: 'policy', summary: 'Handbook issued to officials.',
      classification: 'member',
    }).returning({ id: s.officialDocuments.id });
    const [v] = await db.insert(s.documentVersions)
      .values({ documentId: doc.id, version: '1.0', status: 'published' })
      .returning({ id: s.documentVersions.id });
    await db.update(s.officialDocuments)
      .set({ currentVersionId: v.id }).where(eq(s.officialDocuments.id, doc.id));
  });

  it('searches only `public` when no audience is configured, at every level', async () => {
    for (const who of [anonymous, member, stateAdminJH, national, superAdmin]) {
      const r = await search(db, who, 'Handbook', { kinds: ['document'], newsProvider });
      expect(titles(r.hits)).toEqual([]);
    }
  });

  it('says the rule was never set rather than looking like an empty register', async () => {
    const r = await search(db, superAdmin, 'Handbook', { kinds: ['document'], newsProvider });
    const notice = r.notices.find(
      (n) => n.code === 'document_classification_audience_not_configured'
    );
    expect(notice).toBeDefined();
    // The notice has to name what was NOT searched, or it is decoration.
    expect(notice!.detail).toContain('member');
    expect(notice!.detail).toContain('confidential');
    expect(notice!.detail).toContain('public');
  });

  it('applies the audience the federation configures, and only to who holds it', async () => {
    const policy = { documentClassificationRequires: { member: 'content:read' as const } };

    const editor = await search(db, national, 'Handbook', {
      kinds: ['document'], newsProvider, policy,
    });
    expect(titles(editor.hits)).toEqual(['Officials Handbook']);
    // The rule is configured now, so nothing is being withheld unexplained.
    expect(editor.notices).toHaveLength(0);

    // An anonymous caller holds no action at all, so the same configuration
    // gives them nothing — the map names a requirement, not a switch.
    const guest = await search(db, anonymous, 'Handbook', {
      kinds: ['document'], newsProvider, policy,
    });
    expect(guest.hits).toHaveLength(0);
  });

  it('opening one classification does not open the others', async () => {
    const r = await search(db, superAdmin, 'Constitution', {
      kinds: ['document'], newsProvider,
      policy: { documentClassificationRequires: { member: 'content:read' as const } },
    });
    // `confidential` is still unconfigured, so the confidential minutes stay out
    // even for SUPER_ADMIN with a policy in hand.
    expect(titles(r.hits)).not.toContain('Constitution Review Panel — confidential minutes');
  });

  it('cannot be used to hand a classification to someone who lacks the action', async () => {
    // MEMBER holds content:read but not content:write. A configuration keyed on
    // content:write must not reach them.
    const r = await search(db, member, 'Handbook', {
      kinds: ['document'], newsProvider,
      policy: { documentClassificationRequires: { member: 'content:write' as const } },
    });
    expect(r.hits).toHaveLength(0);

    const editor = await search(db, national, 'Handbook', {
      kinds: ['document'], newsProvider,
      policy: { documentClassificationRequires: { member: 'content:write' as const } },
    });
    expect(titles(editor.hits)).toEqual(['Officials Handbook']);
  });
});

// ─── The scope filter is in the query, not in the result set ────────────────

describe('scope is applied in SQL, provably', () => {
  beforeAll(async () => {
    // Thirty out-of-state people whose names sort BEFORE the in-state one. If
    // the scope filter ran after the fetch, a small limit would be consumed
    // entirely by these and the Jharkhand admin would be shown an empty page
    // for a member who is plainly theirs.
    const bulk: any[] = [];
    for (let i = 1; i <= 30; i++) {
      bulk.push({
        federationId: `MMAKF-MEM-2026-1000${String(i).padStart(2, '0')}`,
        fullName: `Aabir Banerjee ${String(i).padStart(2, '0')}`,
        city: 'Kolkata', stateUnitId: WB, dojoId: WB_DOJO, status: 'active',
      });
    }
    bulk.push({
      federationId: 'MMAKF-MEM-2026-100099',
      fullName: 'Zubin Banerjee', city: 'Patratu',
      stateUnitId: JH, districtUnitId: RMG, dojoId: HOMBU, status: 'active',
    });
    await db.insert(s.persons).values(bulk);
  });

  it('a one-row page for a state admin is their row, not a page spent on other states', async () => {
    const r = await search(db, stateAdminJH, 'Banerjee', {
      kinds: ['person'], newsProvider, limit: 1,
    });
    expect(titles(r.hits)).toEqual(['Zubin Banerjee']);
    // One row is all there is inside their state, so nothing was withheld.
    expect(r.truncated).toBe(false);
  });

  it('raising the limit past the whole out-of-state cohort still shows none of it', async () => {
    const r = await search(db, stateAdminJH, 'Banerjee', {
      kinds: ['person'], newsProvider, limit: 50,
    });
    expect(titles(r.hits)).toEqual(['Zubin Banerjee']);

    const nat = await search(db, national, 'Banerjee', {
      kinds: ['person'], newsProvider, limit: 50,
    });
    expect(nat.hits.length).toBeGreaterThan(30);
  });

  it('an identifier PREFIX cannot walk the register outside the caller state', async () => {
    // Federation ids are sequential, so a prefix is the cheapest enumeration
    // there is. It has to be scoped exactly as a name search is.
    const r = await search(db, stateAdminJH, 'MMAKF-MEM-2026-', {
      kinds: ['person'], newsProvider, limit: 50,
    });
    expect(r.hits.length).toBeGreaterThan(0);
    for (const hit of r.hits) {
      const row = (await db.select().from(s.persons).where(eq(s.persons.id, Number(hit.id))))[0];
      expect(row.stateUnitId).toBe(JH);
    }
  });

  it('a dojo-bound principal reaches their dojo and no further', async () => {
    const dojoAdmin: Principal = {
      userId: 7, label: 'wb-dojo-admin',
      bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: WB_DOJO }],
    };
    const r = await search(db, dojoAdmin, 'Banerjee', {
      kinds: ['person'], newsProvider, limit: 50,
    });
    expect(r.hits.length).toBe(30);
    expect(titles(r.hits)).not.toContain('Zubin Banerjee');
  });

  it('a binding at a scope the table cannot express reaches nothing at all', async () => {
    // districtUnits carries no dojo column, so a dojo-scoped unit:read has
    // nothing to resolve against. An unresolvable scope grants nothing and says
    // which — it must not fall through to unfiltered.
    const dojoBound: Principal = {
      userId: 8, label: 'dojo-instructor',
      bindings: [{ role: 'DISTRICT_ADMIN', scopeType: 'dojo', scopeId: HOMBU }],
    };
    const r = await search(db, dojoBound, 'Ramgarh', {
      kinds: ['district_unit'], newsProvider,
    });
    expect(r.hits).toHaveLength(0);
    expect(r.skipped.find((x) => x.kind === 'district_unit')?.reason).toBe('no_visible_scope');
  });
});

// ─── Constants restated from another module must not drift ──────────────────

describe('the duplicated event status list', () => {
  it('still matches PUBLIC_STATUSES in src/db/competition.ts', () => {
    // search.ts may not import from competition.ts (owned by another workflow),
    // so the two lists are duplicated. A comment asking for them to be kept in
    // step is not an enforcement mechanism; this is. If competition.ts changes
    // which statuses are public and search.ts does not, unpublished events
    // become visible — so the drift is a leak, not an inconsistency.
    const competitionSource = readFileSync('src/db/competition.ts', 'utf8');
    const block = competitionSource.match(
      /const PUBLIC_STATUSES: readonly EventStatus\[\] = \[([\s\S]*?)\];/
    );
    expect(block).not.toBeNull();
    const theirs = [...block![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(theirs.length).toBeGreaterThan(0);
    expect([...PUBLIC_EVENT_STATUSES].sort()).toEqual(theirs);
  });
});

// ─── Every response accounts for itself ─────────────────────────────────────

describe('the response is self-describing', () => {
  it('carries notices, kinds and skipped on every path', async () => {
    const r = await search(db, anonymous, 'Shotokan', { newsProvider, limit: 50 });
    expect(Object.keys(r).sort())
      .toEqual(['hits', 'kinds', 'notices', 'query', 'skipped', 'truncated']);
    expect(Array.isArray(r.notices)).toBe(true);
    expect(r.kinds.length + r.skipped.length).toBe(KIND_ORDER.length);
  });

  it('records the notices in the audit row, so a narrow result is explainable later', async () => {
    const before = await db.select().from(s.auditEvents);
    await search(db, national, 'Handbook', {
      kinds: ['document'], newsProvider,
      audit: { principal: national, reason: 'governance review' },
    });
    const after = await db.select().from(s.auditEvents);
    expect(after.length).toBe(before.length + 1);
    const row = after[after.length - 1]!;
    expect((row.newValue as any).returned).toBe(0);
    expect((row.newValue as any).notices.map((n: any) => n.code))
      .toContain('document_classification_audience_not_configured');
  });
});
