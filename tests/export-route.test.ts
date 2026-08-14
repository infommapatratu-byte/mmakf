// GET /api/export/[kind] — the HTTP surface.
//
// The module tests (tests/export.test.ts) prove the authorisation, scoping and
// audit. These prove the things only the endpoint can get wrong: an
// unauthenticated caller is refused before the database is touched, a
// cross-origin GET is refused even though the middleware only guards writes,
// the counts reach a CSV client (which has nowhere in the file to put them),
// and an unconfigured deployment says so instead of returning an empty file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import { __setTestClient } from '../src/db';
import { createSessionCookie } from '../src/lib/auth';

let db: any;

// The route reads DATABASE_URL through isConfigured() on every call, so setting
// it before the import is enough and a static import stays safe.
process.env.DATABASE_URL = 'postgresql://export-route-test/pglite';
const route = await import('../src/pages/api/export/[kind]');

/** Cookie header form: the name=value pair without the Set-Cookie attributes. */
const ADMIN_COOKIE = createSessionCookie().split(';')[0];

interface Called {
  status: number;
  /**
   * The body decoded WITHOUT stripping a leading byte order mark.
   *
   * `Response.text()` removes one, per the encoding standard. A test that read
   * the body that way would pass whether or not the BOM was ever written —
   * which is the whole thing being asserted, and the file a browser saves
   * keeps the bytes.
   */
  text: string;
  headers: Headers;
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

async function call(
  kind: string,
  query = '',
  opts: { cookie?: string | null; origin?: string | null } = {}
): Promise<Called> {
  const url = new URL(`https://admin.mmakf.in/api/export/${kind}${query}`);
  const headers = new Headers();
  const cookie = opts.cookie === undefined ? ADMIN_COOKIE : opts.cookie;
  if (cookie) headers.set('cookie', cookie);
  // A same-origin navigation is what a download link produces. The tests that
  // want the cross-origin case set it explicitly.
  if (opts.origin === undefined) headers.set('sec-fetch-site', 'same-origin');
  else if (opts.origin) headers.set('origin', opts.origin);

  const request = new Request(url.toString(), { method: 'GET', headers });
  const res: Response = await (route.GET as any)({ params: { kind }, request, url });
  return {
    status: res.status,
    text: decoder.decode(new Uint8Array(await res.arrayBuffer())),
    headers: res.headers,
  };
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  __setTestClient(db);

  const [st1] = await db.insert(s.stateUnits)
    .values({ code: 'ST-R', state: 'State R', name: 'Unit R', status: 'active' })
    .returning({ id: s.stateUnits.id });

  await db.insert(s.persons).values([
    { federationId: 'ROUTE-0001', fullName: 'Row One', stateUnitId: st1.id, status: 'active' },
    // A name chosen to prove the byte order mark does its job.
    { federationId: 'ROUTE-0002', fullName: 'नाम', stateUnitId: st1.id, status: 'active' },
  ]);
});

afterAll(() => {
  delete process.env.DATABASE_URL;
});

describe('the endpoint refuses before it reads', () => {
  it('401s an unauthenticated caller', async () => {
    const r = await call('persons', '', { cookie: null });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).code).toBe('unauthenticated');
  });

  it('403s a cross-origin GET', async () => {
    // The middleware guards POST, PUT, PATCH and DELETE. This response is
    // assembled with the caller's cookie, so the check has to be here.
    const r = await call('persons', '', { origin: 'https://attacker.example' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).code).toBe('cross_origin');
  });

  it('403s a request carrying no origin evidence at all', async () => {
    const r = await call('persons', '', { origin: null });
    expect(r.status).toBe(403);
  });

  it('404s an unknown kind and offers the ones the caller may have', async () => {
    const r = await call('everything');
    expect(r.status).toBe(404);
    const body = JSON.parse(r.text);
    expect(body.code).toBe('unknown_kind');
    expect(body.available.map((k: any) => k.id)).toContain('persons');
  });

  it('400s a limit that is not a number of rows', async () => {
    for (const q of ['?limit=all', '?limit=0', '?limit=-5']) {
      const r = await call('persons', q);
      expect(r.status, q).toBe(400);
    }
  });

  it('503s when no federation database is configured, rather than returning an empty file', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const r = await call('persons');
      expect(r.status).toBe(503);
      expect(JSON.parse(r.text).code).toBe('unavailable');
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});

describe('the file', () => {
  it('is served as a download, with the counts in the headers', async () => {
    const r = await call('persons', '?limit=1');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="mmakf-persons-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('no-store');

    // A CSV has nowhere inside it to say the file is partial. Without these an
    // operator reads a capped export as the whole register.
    expect(r.headers.get('x-export-rows-returned')).toBe('1');
    expect(r.headers.get('x-export-rows-matched')).toBe('2');
    expect(r.headers.get('x-export-truncated')).toBe('true');
  });

  it('starts with the byte order mark and carries the name intact', async () => {
    const r = await call('persons');
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    expect(r.text).toContain('नाम');
    expect(r.headers.get('x-export-truncated')).toBe('false');
  });

  it('serves JSON when asked, with the same counts inside the envelope', async () => {
    const r = await call('persons', '?format=json');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = JSON.parse(r.text);
    expect(body.kind).toBe('persons');
    expect(body.rowsReturned).toBe(2);
    expect(body.rowsMatched).toBe(2);
    expect(body.rows).toHaveLength(2);
  });

  it('refuses a format that is not built, by name', async () => {
    // XLSX and PDF need a library. A caller asking for one is told there is no
    // such format rather than handed a CSV named .xlsx.
    for (const format of ['xlsx', 'pdf']) {
      const r = await call('persons', `?format=${format}`);
      expect(r.status, format).toBe(400);
      expect(JSON.parse(r.text).code).toBe('unsupported_format');
    }
  });

  it('leaves an audit row for every file served', async () => {
    const before = await db.select().from(s.auditEvents);
    await call('persons', '?format=json');
    const after = await db.select().from(s.auditEvents);
    expect(after.length).toBe(before.length + 1);

    const entry = after[after.length - 1];
    expect(entry.action).toBe('export');
    expect(entry.entityType).toBe('export');
    // The shared office password cannot name an individual, so the record says
    // so rather than implying somebody in particular took the file.
    expect(entry.authority).toBe('shared:shared-admin-password');
    expect(entry.newValue.kind).toBe('persons');
  });
});
