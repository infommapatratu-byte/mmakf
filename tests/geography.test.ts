// The location engine.
//
// The spine of this suite is the refusal: `resolveArea()` must return AMBIGUOUS
// rather than a best guess, because a resolver that guesses fills a national
// register with wrong districts and leaves no signal that it did. Everything
// else here is either the invariant that keeps the tree a tree, or the attack
// that would flatten it.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  upsertCountry, upsertArea, addAlias, linkPostalCode, resolveArea,
  ancestry, childrenOf, descendants, currentArea, supersedeArea,
  recordAddress, unresolvedAddresses, normaliseName, segmentCode,
  countryByIso2, isGeographyError,
} from '../src/db/geography';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any;
let IN: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const clerk: Principal = {
  userId: 2, label: 'a dojo administrator',
  bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: 1 }],
};
const stateAdmin: Principal = {
  userId: 3, label: 'assam administrator',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: 1 }],
};

const ctx = (p: Principal = admin): AuditContext => ({
  principal: p, reason: 'test', authority: 'test',
});

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  const pg = new PGlite();
  for (const f of MIGRATIONS) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });
});

beforeEach(async () => {
  // Order matters: every referent before what it points at. `persons` is in
  // this list because `persons.residence_area_id` is a real foreign key onto
  // admin_areas — which is the point of the last test in this file, and which
  // made the first version of this cleanup fail with a constraint violation.
  await db.execute?.('DELETE FROM person_addresses');
  await db.execute?.('DELETE FROM persons');
  await db.execute?.('DELETE FROM addresses');
  await db.execute?.('DELETE FROM postal_codes');
  await db.execute?.('DELETE FROM geo_aliases');
  await db.execute?.('DELETE FROM admin_areas');
  await db.execute?.('DELETE FROM countries');
  const c = await upsertCountry(db, ctx(), {
    iso2: 'IN', iso3: 'IND', name: 'India',
    phoneCode: '+91', defaultTimezone: 'Asia/Kolkata',
    source: 'test:iso-3166',
  });
  IN = c.id;
});

// ─── Normalisation ──────────────────────────────────────────────────────────

describe('normalisation', () => {
  it('folds diacritics, case and punctuation to one comparable form', () => {
    expect(normaliseName('Guwahāti')).toBe('guwahati');
    expect(normaliseName('GUWAHATI')).toBe('guwahati');
    expect(normaliseName('  guwahati  ')).toBe('guwahati');
    expect(normaliseName('Kamrup (Metropolitan)')).toBe('kamrupmetropolitan');
  });

  it('is the SAME transformation on both sides of a lookup', () => {
    // The defect this guards: a normaliser applied on write and a different one
    // applied on read produces a lookup that silently never matches, and the
    // symptom reads as missing data rather than as a bug.
    const written = normaliseName('Bengalūru');
    const searched = normaliseName('bengaluru');
    expect(written).toBe(searched);
  });

  it('refuses a path segment that would break the dotted path', () => {
    expect(segmentCode('Kamrup Metropolitan')).toBe('KAMRUP-METROPOLITAN');
    expect(() => segmentCode('...')).toThrow(/cannot be empty/);
    expect(() => segmentCode('')).toThrow(/cannot be empty/);
  });
});

// ─── Authority ──────────────────────────────────────────────────────────────

describe('who may redraw the map', () => {
  it('refuses a dojo administrator writing geography', async () => {
    await expect(upsertCountry(db, ctx(clerk), {
      iso2: 'NP', name: 'Nepal', source: 'test',
    })).rejects.toThrow();
  });

  it('refuses a STATE administrator writing geography', async () => {
    // Deliberate: a state redrawing a district boundary changes what every
    // other state's addresses resolve to. The map is national reference data.
    await expect(upsertArea(db, ctx(stateAdmin), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    })).rejects.toThrow();
  });

  it('requires a source on every row', async () => {
    await expect(upsertCountry(db, ctx(), {
      iso2: 'LK', name: 'Sri Lanka', source: '',
    })).rejects.toThrow(/where it came from/);
  });
});

// ─── The ladder ─────────────────────────────────────────────────────────────

describe('the administrative ladder', () => {
  it('derives the path from the parent, never from the caller', async () => {
    const assam = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    });
    const kamrup = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam.id, level: 'district',
      name: 'Kamrup Metropolitan', source: 'test',
    });
    const ghy = await upsertArea(db, ctx(), {
      countryId: IN, parentId: kamrup.id, level: 'city',
      name: 'Guwahati', source: 'test',
    });

    expect(assam.path).toBe('ASSAM');
    expect(kamrup.path).toBe('ASSAM.KAMRUP-METROPOLITAN');
    expect(ghy.path).toBe('ASSAM.KAMRUP-METROPOLITAN.GUWAHATI');
  });

  it('refuses a level inversion — a district inside a city', async () => {
    const assam = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    });
    const city = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam.id, level: 'city', name: 'Guwahati', source: 'test',
    });

    await expect(upsertArea(db, ctx(), {
      countryId: IN, parentId: city.id, level: 'district',
      name: 'Impossible', source: 'test',
    })).rejects.toThrow(/cannot sit inside/);
  });

  it('allows a rung to be SKIPPED — not every country uses every level', async () => {
    // A city hanging directly off a district with no sub-district between is
    // ordinary Indian practice. Requiring the intermediate rung would force
    // importers to invent one.
    const assam = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    });
    const district = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam.id, level: 'district', name: 'Kamrup', source: 'test',
    });
    const locality = await upsertArea(db, ctx(), {
      countryId: IN, parentId: district.id, level: 'locality', name: 'Beltola', source: 'test',
    });
    expect(locality.path).toBe('ASSAM.KAMRUP.BELTOLA');
  });

  it('refuses a parent in another country', async () => {
    const np = await upsertCountry(db, ctx(), { iso2: 'NP', name: 'Nepal', source: 'test' });
    const bagmati = await upsertArea(db, ctx(), {
      countryId: np.id, level: 'state', name: 'Bagmati', source: 'test',
    });
    await expect(upsertArea(db, ctx(), {
      countryId: IN, parentId: bagmati.id, level: 'district', name: 'Wrong', source: 'test',
    })).rejects.toThrow(/different country/);
  });

  it('is idempotent — re-running an import returns the same row', async () => {
    const a = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test:run-1',
    });
    const b = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test:run-2',
    });
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);

    const rows = await db.select().from(s.adminAreas).where(eq(s.adminAreas.id, a.id));
    expect(rows[0].source).toBe('test:run-2');       // updated, not duplicated
  });

  it('inherits the timezone from the parent, then the country', async () => {
    const assam = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    });
    const rows = await db.select().from(s.adminAreas).where(eq(s.adminAreas.id, assam.id));
    expect(rows[0].timezone).toBe('Asia/Kolkata');
  });
});

// ─── Resolution — the heart of it ───────────────────────────────────────────

describe('resolving what somebody typed', () => {
  let assam: number, kamrupDistrict: number, kamrupCity: number, guwahati: number;

  beforeEach(async () => {
    const a = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    });
    assam = a.id;
    const kd = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam, level: 'district', name: 'Kamrup', source: 'test',
    });
    kamrupDistrict = kd.id;
    const kc = await upsertArea(db, ctx(), {
      countryId: IN, parentId: kamrupDistrict, level: 'city', name: 'Kamrup', source: 'test',
    });
    kamrupCity = kc.id;
    const g = await upsertArea(db, ctx(), {
      countryId: IN, parentId: kamrupDistrict, level: 'city', name: 'Guwahati', source: 'test',
    });
    guwahati = g.id;
  });

  it('resolves an unambiguous name', async () => {
    const r = await resolveArea(db, { countryId: IN, text: 'Guwahati' });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.area.id).toBe(guwahati);
  });

  it('resolves a historical alias to the canonical area', async () => {
    await addAlias(db, ctx(), { areaId: guwahati, alias: 'Gauhati', kind: 'historical', source: 'test' });
    const r = await resolveArea(db, { countryId: IN, text: 'gauhati' });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.area.id).toBe(guwahati);
  });

  it('RETURNS AMBIGUOUS rather than guessing — the whole point', async () => {
    // 'Kamrup' is both a district and a city inside it. A best-match resolver
    // picks whichever row the index happened to return, files the member one
    // level off, and emits no signal that anything went wrong.
    const r = await resolveArea(db, { countryId: IN, text: 'Kamrup' });
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates.map((c) => c.id).sort()).toEqual([kamrupDistrict, kamrupCity].sort());
    }
  });

  it('disambiguates by level when the caller knows the rung', async () => {
    const r = await resolveArea(db, { countryId: IN, text: 'Kamrup', level: 'district' });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.area.id).toBe(kamrupDistrict);
  });

  it('disambiguates by subtree — the state a form already collected', async () => {
    const r = await resolveArea(db, { countryId: IN, text: 'Guwahati', within: assam });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') expect(r.area.id).toBe(guwahati);
  });

  it('says UNKNOWN for a place nobody has loaded', async () => {
    const r = await resolveArea(db, { countryId: IN, text: 'Atlantis' });
    expect(r.status).toBe('unknown');
  });

  it('does not resolve to a dissolved area', async () => {
    const merged = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam, level: 'district', name: 'Old District', source: 'test',
    });
    await supersedeArea(db, ctx(), {
      areaId: merged.id, becameAreaId: kamrupDistrict,
      status: 'merged', reason: 'Reorganised in test',
    });
    const r = await resolveArea(db, { countryId: IN, text: 'Old District' });
    expect(r.status).toBe('unknown');
  });

  it('prefers a postal code over a typed name', async () => {
    await linkPostalCode(db, ctx(), {
      countryId: IN, code: '781001', areaId: guwahati, source: 'test',
    });
    const r = await resolveArea(db, { countryId: IN, text: 'Kamrup', postalCode: '781 001' });
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect(r.area.id).toBe(guwahati);
      expect(r.via).toBe('postal');
    }
  });

  it('treats a postal code spanning several areas as ambiguous, not as the first one', async () => {
    await linkPostalCode(db, ctx(), { countryId: IN, code: '781099', areaId: guwahati, source: 'test' });
    await linkPostalCode(db, ctx(), { countryId: IN, code: '781099', areaId: kamrupCity, source: 'test' });
    const r = await resolveArea(db, { countryId: IN, postalCode: '781099' });
    expect(r.status).toBe('ambiguous');
  });
});

// ─── Walking the tree ───────────────────────────────────────────────────────

describe('walking the tree', () => {
  let assam: number, kamrup: number, guwahati: number;

  beforeEach(async () => {
    assam = (await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    })).id;
    kamrup = (await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam, level: 'district', name: 'Kamrup', source: 'test',
    })).id;
    guwahati = (await upsertArea(db, ctx(), {
      countryId: IN, parentId: kamrup, level: 'city', name: 'Guwahati', source: 'test',
    })).id;
  });

  it('returns the ancestry root-first, in one query from the path', async () => {
    const chain = await ancestry(db, guwahati);
    expect(chain.map((a: any) => a.name)).toEqual(['Assam', 'Kamrup', 'Guwahati']);
  });

  it('lists immediate children only', async () => {
    const kids = await childrenOf(db, assam);
    expect(kids.map((k: any) => k.name)).toEqual(['Kamrup']);
  });

  it('lists everything beneath an area, keyset paginated', async () => {
    const all = await descendants(db, assam);
    expect(all.map((a: any) => a.name).sort()).toEqual(['Guwahati', 'Kamrup']);

    const firstPage = await descendants(db, assam, { limit: 1 });
    expect(firstPage).toHaveLength(1);
    const secondPage = await descendants(db, assam, { limit: 1, afterPath: firstPage[0].path });
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0].id).not.toBe(firstPage[0].id);
  });

  it('follows a superseded area to what it became', async () => {
    const old = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam, level: 'district', name: 'Undivided Kamrup', source: 'test',
    });
    await supersedeArea(db, ctx(), {
      areaId: old.id, becameAreaId: kamrup, status: 'renamed', reason: 'test',
    });
    const now = await currentArea(db, old.id);
    expect(now.id).toBe(kamrup);
  });

  it('refuses to hang on a supersession cycle', async () => {
    const a = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam, level: 'district', name: 'A', source: 'test',
    });
    const b = await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam, level: 'district', name: 'B', source: 'test',
    });
    await supersedeArea(db, ctx(), { areaId: a.id, becameAreaId: b.id, status: 'merged', reason: 't' });
    await supersedeArea(db, ctx(), { areaId: b.id, becameAreaId: a.id, status: 'merged', reason: 't' });

    // An import bug, not an impossibility — and it must fail rather than spin.
    await expect(currentArea(db, a.id)).rejects.toThrow(/cycle/);
  });

  it('refuses to let an area supersede itself', async () => {
    await expect(supersedeArea(db, ctx(), {
      areaId: kamrup, becameAreaId: kamrup, status: 'renamed', reason: 't',
    })).rejects.toThrow(/cannot supersede itself/);
  });
});

// ─── Addresses ──────────────────────────────────────────────────────────────

describe('addresses', () => {
  let assam: number, guwahati: number;

  beforeEach(async () => {
    assam = (await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Assam', source: 'test',
    })).id;
    guwahati = (await upsertArea(db, ctx(), {
      countryId: IN, parentId: assam, level: 'city', name: 'Guwahati', source: 'test',
    })).id;
  });

  it('resolves the area and derives the precision', async () => {
    const a = await recordAddress(db, {
      countryId: IN, line1: '12 GS Road', localityText: 'Guwahati', postalCode: '781005',
    });
    expect(a.areaId).toBe(guwahati);
    const rows = await db.select().from(s.addresses).where(eq(s.addresses.id, a.id));
    expect(rows[0].precision).toBe('locality');       // city-level match
    expect(rows[0].timezone).toBe('Asia/Kolkata');
  });

  it('STORES an unresolved address rather than refusing it', async () => {
    // Somebody living in a district nobody has imported still has an address.
    // Refusing it would make the completeness of a reference table a
    // precondition for registering a member.
    const a = await recordAddress(db, {
      countryId: IN, line1: '5 Main Road', localityText: 'Somewhere Unimported',
    });
    expect(a.areaId).toBeNull();
    expect(a.resolution?.status).toBe('unknown');

    const backlog = await unresolvedAddresses(db, { countryId: IN });
    expect(backlog.map((r: any) => r.id)).toContain(a.id);
  });

  it('keeps the words the applicant typed, so the row can be re-resolved later', async () => {
    const a = await recordAddress(db, {
      countryId: IN, localityText: 'Gauhati',       // no alias loaded yet
    });
    expect(a.areaId).toBeNull();

    const rows = await db.select().from(s.addresses).where(eq(s.addresses.id, a.id));
    expect(rows[0].localityText).toBe('Gauhati');

    // The day the alias is loaded, the same words resolve.
    await addAlias(db, ctx(), { areaId: guwahati, alias: 'Gauhati', source: 'test' });
    const retry = await resolveArea(db, { countryId: IN, text: rows[0].localityText });
    expect(retry.status).toBe('resolved');
  });

  it('normalises a postal code on the way in', async () => {
    const a = await recordAddress(db, { countryId: IN, postalCode: ' 781 005 ' });
    const rows = await db.select().from(s.addresses).where(eq(s.addresses.id, a.id));
    expect(rows[0].postalCode).toBe('781005');
  });

  it('refuses an unknown country', async () => {
    await expect(recordAddress(db, { countryId: 99999 })).rejects.toThrow(/Unknown country/);
  });

  it('reports a geography error by shape, not by instanceof', async () => {
    try {
      await recordAddress(db, { countryId: 99999 });
      expect.unreachable();
    } catch (err) {
      expect(isGeographyError(err)).toBe(true);
    }
  });
});

// ─── The separation from the federation ─────────────────────────────────────

describe('civil geography is not federation jurisdiction', () => {
  it('records a person living where MMAKF has chartered nothing', async () => {
    // The case the old schema could not express at all: `persons.state_unit_id`
    // is a CHARTERED unit, and Kerala has people in it whether or not MMAKF has
    // chartered Kerala. This is the whole reason the two ladders are separate.
    const kerala = await upsertArea(db, ctx(), {
      countryId: IN, level: 'state', name: 'Kerala', source: 'test',
    });

    const [p] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-900001',
      fullName: 'A Prospective Member',
      status: 'pending',
      residenceAreaId: kerala.id,
      stateUnitId: null,                            // no chartered unit — correct
    }).returning({ id: s.persons.id, residenceAreaId: s.persons.residenceAreaId });

    expect(p.residenceAreaId).toBe(kerala.id);

    const rows = await db.select().from(s.persons).where(eq(s.persons.id, p.id));
    expect(rows[0].stateUnitId).toBeNull();
  });

  it('has no foreign key from an area to a federation unit', async () => {
    // Structural, not behavioural: the day somebody adds one, the case above
    // becomes unrepresentable again and this test says so.
    const cols = await db.execute?.(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'admin_areas'
    `);
    const names = (cols?.rows ?? cols ?? []).map((r: any) => r.column_name);
    expect(names).not.toContain('state_unit_id');
    expect(names).not.toContain('district_unit_id');
  });
});

describe('country lookup', () => {
  it('finds by ISO code, case-insensitively', async () => {
    const c = await countryByIso2(db, 'in');
    expect(c?.id).toBe(IN);
    expect(c?.name).toBe('India');
  });

  it('refuses a code that is not ISO 3166-1 alpha-2', async () => {
    await expect(upsertCountry(db, ctx(), {
      iso2: 'IND', name: 'India', source: 'test',
    })).rejects.toThrow(/two letters/);
  });
});
