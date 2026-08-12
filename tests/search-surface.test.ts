// The /search page.
//
// The module it wraps is already tested hard (tests/search.test.ts). What is at
// risk HERE is the page throwing away the half of the answer that makes an
// empty result meaningful: `skipped` and `notices`. A search page that renders
// only `hits` turns "you may not see this" and "nobody has told this system
// what the rule is" both into "no results", which is the wrong answer twice.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { search, KIND_ORDER, PUBLIC_KINDS, MIN_QUERY_LENGTH, type SkipReason } from '../src/lib/search';
import type { Principal } from '../src/lib/rbac';

const page = readFileSync('src/pages/search.astro', 'utf8');

let db: any;

const anonymous = null;
const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand State Unit', status: 'active' })
    .returning({ id: s.stateUnits.id });
  await db.insert(s.dojos).values([
    { code: 'MMAKF-DOJO-JH-RMG-001', name: 'Hombu Dojo Patratu', stateUnitId: jh.id, status: 'active' },
    { code: 'MMAKF-DOJO-JH-RMG-002', name: 'Rasda Training Hall', stateUnitId: jh.id, status: 'active' },
  ]);
});

describe('the page renders the whole answer, not just the hits', () => {
  it('renders `skipped` under a heading that says what it is', () => {
    expect(page).toMatch(/What this search did not cover/);
    expect(page).toMatch(/result\?\.skipped/);
  });

  it('renders `notices` — an unset federation rule is not silently a narrow result', () => {
    expect(page).toMatch(/result\.notices\.map/);
    expect(page).toMatch(/Rule not set/);
  });

  it('gives every SkipReason plain English, with no code string falling through', () => {
    // Extract the page's own SKIP_TEXT keys and compare against the union.
    const block = page.match(/const SKIP_TEXT[^{]*\{([\s\S]*?)\n\};/);
    expect(block, 'SKIP_TEXT not found on the page').toBeTruthy();
    const covered = [...block![1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
    const REASONS: SkipReason[] = [
      'not_requested', 'not_public', 'not_authorised',
      'no_visible_scope', 'not_a_certificate_number', 'store_unavailable',
    ];
    for (const r of REASONS) expect(covered, `${r} has no plain-English text`).toContain(r);
  });

  it('labels every SearchKind, so no filter chip renders as a raw enum', () => {
    const block = page.match(/const KIND_LABEL[^{]*\{([\s\S]*?)\n\};/);
    expect(block).toBeTruthy();
    const covered = [...block![1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
    for (const k of KIND_ORDER) expect(covered, `${k} has no label`).toContain(k);
    // And nothing extra: a label for a kind the module dropped is a dead chip.
    expect(covered.sort()).toEqual([...KIND_ORDER].sort());
  });

  it('hides "not requested" — the caller\'s own filter is not a withholding', () => {
    expect(page).toMatch(/reason !== 'not_requested'/);
  });
});

describe('the page never widens what the module narrowed', () => {
  it('passes the caller through rather than substituting a principal', () => {
    expect(page).toMatch(/await search\(db\(\), principal,/);
    // No admin principal is fabricated on a public page to "make search useful".
    expect(page).not.toMatch(/SUPER_ADMIN|FEDERATION_ADMIN/);
  });

  it('drops an unrecognised `kind` instead of forwarding it', () => {
    // The module refuses an unknown domain outright; a stale bookmark should
    // search everything, not 400.
    expect(page).toMatch(/KIND_ORDER as readonly string\[\]\)\.includes\(rawKind\)/);
  });

  it('reads an empty kind filter as "everything", never as an empty array', () => {
    // kinds: [] means NOTHING to the module. Passing it for "no filter chosen"
    // would silently return zero results forever.
    expect(page).toMatch(/kinds: activeKind \? \[activeKind\] : undefined/);
  });

  it('does not pass an audit context from the public page', () => {
    // Public search-as-you-type would fill the audit table with keystrokes.
    expect(page).not.toMatch(/audit:/);
  });
});

describe('failure is reported as failure', () => {
  it('renders a thrown search as an error, not as "no results"', () => {
    expect(page).toMatch(/failure = err\?\.message/);
    expect(page).toMatch(/The search could not be completed/);
  });

  it('says the database is unconfigured rather than showing an empty list', () => {
    expect(page).toMatch(/database is not configured/i);
    expect(page).toMatch(/DATABASE_URL/);
  });
});

describe('against a real database, anonymously', () => {
  it('finds a published dojo', async () => {
    const r = await search(db, anonymous, 'Hombu');
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].kind).toBe('dojo');
    expect(r.hits[0].title).toBe('Hombu Dojo Patratu');
    // Every hit can say why it came back; the page prints this.
    expect(r.hits[0].matchedOn.field).toBeTruthy();
    expect(['exact', 'prefix', 'substring']).toContain(r.hits[0].matchedOn.how);
  });

  it('withholds every non-public domain AND says so', async () => {
    const r = await search(db, anonymous, 'Hombu');
    const withheld = r.skipped.filter((x) => x.reason === 'not_public').map((x) => x.kind);
    for (const k of KIND_ORDER) {
      if (!PUBLIC_KINDS.includes(k)) {
        expect(withheld, `${k} was neither searched nor reported as withheld`).toContain(k);
      }
    }
  });

  it('returns no person for a query that would name one', async () => {
    const r = await search(db, anonymous, 'Pathak');
    expect(r.hits.some((h) => h.kind === 'person')).toBe(false);
  });

  it('reports the unset document classification rule as a notice', async () => {
    const r = await search(db, anonymous, 'constitution');
    expect(r.notices.some((n) => n.code === 'document_classification_audience_not_configured')).toBe(true);
  });
});

describe('against a real database, as a national admin', () => {
  it('reaches the person domain that anonymous could not', async () => {
    const r = await search(db, national, 'Hombu');
    expect(r.skipped.some((x) => x.kind === 'person' && x.reason === 'not_public')).toBe(false);
  });

  it('still withholds documents whose audience the federation has not defined', async () => {
    // Authority does not substitute for a rule nobody has written down.
    const r = await search(db, national, 'constitution');
    expect(r.notices.some((n) => n.code === 'document_classification_audience_not_configured')).toBe(true);
  });
});

describe('query hygiene is surfaced, not swallowed', () => {
  it('the page refuses a query shorter than the module\'s minimum, and explains', () => {
    expect(page).toMatch(new RegExp(`query\\.length >= MIN_QUERY_LENGTH`));
    expect(page).toMatch(/Type at least \{MIN_QUERY_LENGTH\} characters/);
    expect(MIN_QUERY_LENGTH).toBeGreaterThan(1);
  });

  it('works without JavaScript — a GET form the server renders', () => {
    expect(page).toMatch(/<form[^>]*method="get"[^>]*action="\/search"/);
    // A client-side-only search box is invisible to a shared link and a crawler.
    expect(page).not.toMatch(/addEventListener\('input'/);
  });
});
