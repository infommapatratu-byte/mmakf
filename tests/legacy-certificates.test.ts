// Historical certificates: imported into the one register, matched to the right
// person without duplicating anyone, and verified honestly as legacy records.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { parseCsv, parseDate, kindOf, readLegacyCsv, planLegacyImport, importLegacyCertificates } from '../src/db/legacy-certificates';
import { verifyCredential } from '../src/db/grading';
import { legacyAdminPrincipal, ForbiddenError } from '../src/lib/rbac';

const ctx = { principal: legacyAdminPrincipal(), reason: 'test', authority: 'test' } as any;
const nobody = { principal: null, reason: 'test', authority: 'test' } as any;

describe('reading the office spreadsheet', () => {
  it('parses quoted fields, commas inside quotes, CRLF and a BOM', () => {
    const t = '﻿a,b,c\r\n"x, y","say ""hi""",z\r\n\r\n1,2,3';
    expect(parseCsv(t)).toEqual([['a', 'b', 'c'], ['x, y', 'say "hi"', 'z'], ['1', '2', '3']]);
  });
  it('reads Indian and ISO date formats, and refuses impossible dates', () => {
    expect(parseDate('15-08-2014')).toBe('2014-08-15');
    expect(parseDate('15/08/2014')).toBe('2014-08-15');
    expect(parseDate('2014-08-15')).toBe('2014-08-15');
    expect(parseDate('31-02-2014')).toBeNull();
    expect(parseDate('August 2014')).toBeNull();
  });
  it('works out the kind from the column or, failing that, the title', () => {
    expect(kindOf('Dan', '')).toBe('dan_grade');
    expect(kindOf('', 'Shodan (1st Dan)')).toBe('dan_grade');
    expect(kindOf('', 'Green belt (6th Kyu)')).toBe('kyu_grade');
    expect(kindOf('Referee', 'National referee')).toBe('official');
    expect(kindOf('', 'Summer camp 2016')).toBe('other');
  });
  it('accepts the headers people actually type, and names missing ones', () => {
    const ok = readLegacyCsv('Certificate No,Name,DOB,Grade,Issue Date\nBB/2015/0007,Ravi Kumar,02-03-1990,Shodan,15-08-2015');
    expect(ok.errors).toEqual([]);
    expect(ok.rows[0]).toMatchObject({ certificateNo: 'BB/2015/0007', holderName: 'Ravi Kumar', dob: '1990-03-02', kind: 'dan_grade', issuedOn: '2015-08-15', issuingAuthority: 'MMAKF' });
    expect(readLegacyCsv('Name,Grade\nX,Y').errors[0]).toMatch(/certificate_no.*issued_on/);
  });
});

describe('importing against a real schema', () => {
  let db: any;
  const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema: s });
    for (const f of MIGRATIONS) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
    await db.insert(s.persons).values([
      { federationId: 'MMAKF-MEM-2015-000100', fullName: 'Priya Singh', dob: '1992-04-10', status: 'active' },
      { federationId: 'MMAKF-MEM-2016-000200', fullName: 'Amit Verma', dob: '1988-12-01', status: 'active' },
    ]);
  }, 120_000);

  const CSV = [
    'certificate_no,holder_name,date_of_birth,member_id,kind,title,issued_on,issuing_authority',
    'OLD/DAN/2015/001,Priya Singh,,MMAKF-MEM-2015-000100,dan,Shodan (1st Dan),15-08-2015,MMAKF',
    'OLD/KYU/2012/044,amit  verma,01-12-1988,,kyu,Brown belt (1st Kyu),10-01-2012,MMAKF',
    'OLD/DAN/2010/009,Suresh Rao,05-06-1975,,dan,Nidan (2nd Dan),20-11-2010,MMAKF',
    'OLD/DAN/2005/003,Suresh Rao,05-06-1975,,dan,Shodan (1st Dan),02-02-2005,MMAKF',
    'OLD/DAN/2005/003,Suresh Rao,05-06-1975,,dan,Duplicate line,02-02-2005,MMAKF',
    'OLD/KYU/2011/777,Priya Singh,,,kyu,Green belt,01-01-2011,MMAKF',
    'OLD/X/1,No Date,,,,Seminar,not-a-date,MMAKF',
  ].join('\n');

  it('the preview shows exactly what would happen, and writes nothing', async () => {
    const { rows } = readLegacyCsv(CSV);
    const plan = await planLegacyImport(db, rows);
    expect(plan.map((p) => [p.certificateNo, p.outcome, p.holder])).toEqual([
      ['OLD/DAN/2015/001', 'import', 'member_id'],
      ['OLD/KYU/2012/044', 'import', 'name_and_dob'],
      ['OLD/DAN/2010/009', 'import', 'new_record'],
      ['OLD/DAN/2005/003', 'import', 'new_record'],
      ['OLD/DAN/2005/003', 'error', null],                 // the same number twice in one file
      ['OLD/KYU/2011/777', 'error', null],                 // a same-named member exists, no ID or DOB to tell
      ['OLD/X/1', 'error', null],                          // bad date
    ]);
    expect(await db.select().from(s.certificates)).toHaveLength(0);
  });

  it('needs certificate:issue', async () => {
    await expect(importLegacyCertificates(db, nobody, readLegacyCsv(CSV).rows, { sourceLabel: 't' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('imports into the one register; one holder with two old certificates becomes ONE person', async () => {
    const r = await importLegacyCertificates(db, ctx, readLegacyCsv(CSV).rows, { sourceLabel: 'office spreadsheet 2026-11' });
    expect(r).toMatchObject({ imported: 4, existing: 0, errors: 3 });
    const suresh = await db.select().from(s.persons).where(sql`lower(${s.persons.fullName}) = 'suresh rao'`);
    expect(suresh).toHaveLength(1);
    expect(suresh[0].status).toBe('inactive');
    const theirs = await db.select().from(s.certificates).where(eq(s.certificates.personId, suresh[0].id));
    expect(theirs.map((c: any) => c.certificateNo).sort()).toEqual(['OLD/DAN/2005/003', 'OLD/DAN/2010/009']);
    const priya = (await db.select().from(s.persons).where(eq(s.persons.federationId, 'MMAKF-MEM-2015-000100')))[0];
    const [dan] = await db.select().from(s.certificates).where(eq(s.certificates.certificateNo, 'OLD/DAN/2015/001'));
    expect(dan).toMatchObject({ personId: priya.id, kind: 'dan_grade', title: 'Shodan (1st Dan)', issuedOn: '2015-08-15', status: 'issued' });
    expect(dan.snapshot).toMatchObject({ provenance: 'unverified_legacy', legacy: true, source: 'office spreadsheet 2026-11' });
  });

  it('a second import of the same file changes nothing', async () => {
    const before = (await db.select().from(s.certificates)).length;
    const r = await importLegacyCertificates(db, ctx, readLegacyCsv(CSV).rows, { sourceLabel: 'again' });
    expect(r.imported).toBe(0);
    expect(r.existing).toBe(4);
    expect((await db.select().from(s.certificates)).length).toBe(before);
  });

  it('/verify finds an old number exactly as printed, and says it is a legacy record', async () => {
    const v = await verifyCredential(db, { certificateNo: 'OLD/DAN/2015/001' }, { ipHash: null } as any);
    expect(v.status).toBe('valid');
    expect(v.provenance).toBe('unverified_legacy');
    expect(v).toMatchObject({ certificateNo: 'OLD/DAN/2015/001', holderName: 'Priya Singh' });
  });
});
