/**
 * /live must not publish the database's own words.
 *
 * THE SCENARIO IS THE DEPLOYMENT ONE, not a hypothetical. docs/DEPLOYMENT.md
 * step 2 applies the migrations with the DIRECT connection string and step 4
 * sets DATABASE_URL in Vercel. If step 4 lands and step 2 has not — or lands
 * against a different schema — then the database is CONFIGURED and REACHABLE
 * and the tables are absent. /live is public: it builds an ANONYMOUS principal
 * for a caller with no cookie, so the first stranger to open the federation's
 * homepage-linked classroom page is the one who reads whatever the catch block
 * decided to render.
 *
 * What that used to be, measured by this file rather than asserted from memory:
 * postgres.js's `err.message` names the relation, and drizzle prepends the
 * whole generated statement and its bound parameters. Neither is a fact about
 * the visitor and neither is actionable by them.
 *
 * The project already writes this rule down twice — src/pages/my/index.astro:41
 * ("putting err.message on the page is how a connection string reaches a
 * stranger") and src/lib/realtime.ts ("this endpoint answers the
 * unauthenticated public"). A rule stated and not enforced is a rule that gets
 * re-broken, so this file enforces it for the one page that answers strangers.
 *
 * HOW IT PROVES ANYTHING: a real Postgres (PGlite over the wire protocol) is
 * started with NO migrations applied, a real `astro dev` is pointed at it, and
 * /live is fetched over HTTP. The driver's real error text is captured in
 * beforeAll from the same database, so the assertions below compare the page
 * against what actually failed — not against a guess at what might have.
 *
 * If either server does not come up these tests FAIL. They do not skip. A green
 * run that quietly verified nothing is the failure mode this project is
 * organised against.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import postgres from 'postgres';

/** A port derived from the pid, so parallel runs on one machine do not collide. */
const DB_PORT = 6800 + (process.pid % 700);
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;
/** Fixed so the test process and the dev server sign session cookies alike. */
const SECRET = 'live-error-disclosure-suite-secret';

let dbServer: ChildProcess | null = null;
let astro: ChildProcess | null = null;
let sql: ReturnType<typeof postgres> | null = null;
let base = '';
let astroLog = '';

/** The driver's real words for the failure the page is about to hit. */
let rawFailure = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  // ── A real Postgres with an EMPTY schema ────────────────────────────────
  dbServer = spawn(process.execPath, ['scripts/pg-testserver.mjs', String(DB_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dbUp = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    dbServer!.stdout!.on('data', (d) => {
      if (String(d).includes('ready on')) { clearTimeout(timer); resolve(true); }
    });
    dbServer!.on('error', () => { clearTimeout(timer); resolve(false); });
    dbServer!.on('exit', () => { clearTimeout(timer); resolve(false); });
  });
  if (!dbUp) throw new Error(`no Postgres on 127.0.0.1:${DB_PORT}`);

  // Same driver and same settings the app uses, so the error text captured
  // here is the error text the page would have rendered.
  sql = postgres(DB_URL, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, onnotice: () => {} });
  await sql`select 1`;
  try {
    await sql`select "code" from "live_classes" limit 1`;
  } catch (err: any) {
    rawFailure = String(err?.message ?? err);
  }

  // ── A real astro dev pointed at it ──────────────────────────────────────
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // `astro preview` crashes with the Vercel adapter (docs/PROJECT-CONTEXT.md
  // §8), and `npx` resolution differs on Windows — so the CLI entry is invoked
  // through the same node binary vitest is running under.
  astro = spawn(process.execPath, ['node_modules/astro/astro.js', 'dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      POSTGRES_URL: '',
      ADMIN_SESSION_SECRET: SECRET,
      // The classroom's own "not configured" notice is a different state with a
      // different card; leaving these unset is what /live already expects.
      NODE_ENV: 'development',
    },
  });
  astro.stdout?.on('data', (d) => (astroLog += d));
  astro.stderr?.on('data', (d) => (astroLog += d));

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`astro dev never answered on ${base}.\n${astroLog}`);
    if (astro.exitCode !== null) throw new Error(`astro dev exited with ${astro.exitCode}.\n${astroLog}`);
    try {
      const r = await fetch(`${base}/live`);
      // Any answer at all means the server is listening. A 500 here is the
      // defect under test, not a boot failure.
      if (r.status) { await r.text(); break; }
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
}, 180_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  astro?.kill();
  dbServer?.kill();
});

/**
 * A session cookie for a user that does not exist, because the users table does
 * not exist either. That is the point: the caller HOLDS a cookie, so identify()
 * queries the database and fails, which is the branch a signed-in member hits
 * during exactly this outage.
 */
function userCookie(): string {
  const payload = Buffer.from(JSON.stringify({ k: 'user', t: Date.now(), u: 1, e: 0 })).toString('base64url');
  // The same per-audience derivation src/lib/auth.ts uses: HMAC(secret,
  // "mmakf:session:<audience>:v2") is the key the payload is signed with.
  const key = crypto.createHmac('sha256', SECRET).update('mmakf:session:user:v2').digest();
  const mac = crypto.createHmac('sha256', key).update(payload).digest('base64url');
  return `mmakf_user=${payload}.${mac}`;
}

describe('the harness is exercising a real failure', () => {
  // A checker that has never failed proves nothing (docs/TESTING-STRATEGY.md §1).
  it('the empty database really does refuse the query /live makes', () => {
    expect(rawFailure, 'the empty database answered the query — the suite is not testing an outage').not.toBe('');
    expect(rawFailure).toMatch(/live_classes/);
    expect(rawFailure).toMatch(/does not exist/i);
  });
});

describe('/live during a database outage tells a stranger nothing about the server', () => {
  it('answers an anonymous visitor with a page, not a stack of SQL', async () => {
    const response = await fetch(`${base}/live`);
    const body = await response.text();

    expect(response.status, 'an anonymous visitor must still get the page').toBe(200);

    // The driver's own sentence, verbatim, must not appear.
    expect(body, 'the raw driver message reached the page').not.toContain(rawFailure);

    // …nor any of its parts. Each of these was measured on this page before the
    // fix: drizzle prepends the generated statement, and postgres.js names the
    // relation that was missing.
    expect(body, 'the generated SQL reached the page').not.toContain('Failed query');
    expect(body, 'a table name reached the page').not.toContain('live_classes');
    expect(body, 'a table name reached the page').not.toContain('broadcasts"');
    expect(body, 'the Postgres sentence reached the page').not.toMatch(/relation "/);
    expect(body, 'the Postgres sentence reached the page').not.toMatch(/does not exist/i);

    // The connection is infrastructure too. Neither host nor role belongs here;
    // on a Supabase pooler the role embeds the project ref.
    expect(body, 'the database host reached the page').not.toContain(`127.0.0.1:${DB_PORT}`);
    expect(body, 'the database role reached the page').not.toContain('postgres@');
  });

  it('says the list could not be read, rather than showing an empty schedule', async () => {
    const body = await (await fetch(`${base}/live`)).text();
    // §70: a failure is never dressed as "no classes are running".
    expect(body).toContain('The class list could not be read');
    expect(body).not.toContain('No class is live right now');
  });

  it('makes no claim about who the caller is while it cannot tell', async () => {
    const body = await (await fetch(`${base}/live`)).text();
    // identify() is one of the reads that failed, so the page does not know
    // whether this caller is signed in. "You are not signed in" would be a
    // guess, and it is exactly the wrong guess for the member whose cookie the
    // page could not resolve.
    expect(body).not.toContain('You are not signed in');
  });
});

describe('/live during a database outage does not 500 on a signed-in member', () => {
  /**
   * identify() and the users lookup both hit the database and both used to sit
   * OUTSIDE the try, so a member holding a cookie got a blank 500 while a
   * stranger got the card. Fixing the card without fixing these leaves the
   * signed-in experience of the same outage a crash.
   */
  it('renders the same honest card for a member as for a stranger', async () => {
    const response = await fetch(`${base}/live`, { headers: { cookie: userCookie() } });
    const body = await response.text();

    expect(response.status, 'a signed-in member got a 500 instead of the page').toBe(200);
    expect(body).toContain('The class list could not be read');
    expect(body, 'the raw driver message reached a signed-in member').not.toContain(rawFailure);
    expect(body).not.toContain('Failed query');
    expect(body).not.toContain('live_classes');
  });
});

describe('the source itself carries the rule', () => {
  // The HTTP tests above prove the behaviour for one failure. This one holds
  // the shape, so the next edit cannot reintroduce the pattern for a failure
  // nobody thought to boot a server for.
  const src = readFileSync('src/pages/live.astro', 'utf8');
  /** Frontmatter only — the client script's own error handling is separate. */
  const frontmatter = src.slice(3, src.indexOf('\n---', 3));

  it('never assigns a caught error message to anything the template renders', () => {
    expect(frontmatter).not.toMatch(/loadError\s*=\s*String\(\s*err/);
    expect(frontmatter).not.toMatch(/loadError\s*=\s*err[?.]*\.message/);
  });

  it('reads the caller and the class list inside one guarded block', () => {
    // identify() is a database call. Outside a try it is a 500 for every
    // signed-in caller during an outage.
    const guarded = /try\s*\{[\s\S]*await identify\(/.test(frontmatter);
    expect(guarded, 'identify() is called outside a try — a signed-in caller gets a 500').toBe(true);
  });

  it('logs the fault where the office can see it', () => {
    expect(frontmatter).toMatch(/console\.error\(/);
  });
});
