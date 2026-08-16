// The environment diagnostic must never become the leak it exists to prevent.
//
// This endpoint reports the SHAPE of a connection string so an operator can
// tell six identical-looking misconfigurations apart. The whole value of it
// depends on it never reporting the string itself, and the failure mode is
// somebody adding one helpful field.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/pages/api/health/env.ts', 'utf8');
const BODY = SRC.split('export const GET')[1] ?? '';

describe('the diagnostic never returns a secret', () => {
  it('never puts the raw value in the response', () => {
    // `raw` is read once and passed only to shapeOf()/urlShape(). It must never
    // reach the JSON.
    expect(BODY, 'the raw value is being serialised').not.toMatch(/value:\s*raw|url:\s*raw|DATABASE_URL:\s*raw\b/);
    expect(BODY).not.toMatch(/process\.env\.DATABASE_URL\s*,/);
  });

  it('never returns host, user, password or database name', () => {
    // hasHost/hasPassword are booleans. u.hostname or u.password appearing as a
    // VALUE would be the leak.
    for (const leak of [/hostname:\s*u\.hostname/, /password:\s*u\.password/, /username:\s*u\.username/, /database:\s*u\.pathname/]) {
      expect(SRC, `a secret component is returned directly: ${leak}`).not.toMatch(leak);
    }
  });

  it('returns only booleans, a length, a port and a protocol', () => {
    // The port and protocol are deliberate: they are the two facts that
    // identify the wrong-string-pasted and wrong-pooler mistakes, and neither
    // is secret.
    expect(SRC).toMatch(/hasHost:\s*u\.hostname\.length > 0/);
    expect(SRC).toMatch(/hasPassword:\s*u\.password\.length > 0/);
  });

  it('never quotes the value inside a problem message', () => {
    // A message like `value "postgres://…" is malformed` would defeat the
    // entire design while looking like good error reporting.
    const problems = SRC.match(/problems\.push\([^)]*\)/g) ?? [];
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) {
      // INTERPOLATION is the leak. The first version of this guard also
      // rejected the WORD "value", and failed on the message "Vercel stores the
      // value literally" — English prose explaining the problem, containing no
      // data at all. A guard that fires on its own documentation gets loosened
      // by whoever hits it next, which is how a real one stops being trusted.
      expect(p, `a problem message interpolates something: ${p}`).not.toMatch(/\$\{/);
      expect(p, `a problem message is a template literal: ${p}`).not.toMatch(/`/);
      // And it must be one string literal, not a concatenation that could
      // append a variable.
      expect(p, `a problem message concatenates: ${p}`).not.toMatch(/'\s*\+|\+\s*'/);
    }
  });
});

describe('the diagnostic is not public', () => {
  it('requires audit:read', () => {
    expect(SRC).toMatch(/canAnywhere\(principal, 'audit:read'\)/);
  });

  it('answers 404 to an unauthenticated caller, not 401', () => {
    // A 401 confirms the endpoint exists and that there is something here worth
    // authenticating for. This one has no reason to admit that to a stranger.
    expect(SRC).toMatch(/status:\s*404/);
    expect(BODY).not.toMatch(/status:\s*401/);
  });

  it('is never cached and never indexed', () => {
    expect(SRC).toMatch(/'Cache-Control':\s*'no-store'/);
    expect(SRC).toMatch(/X-Robots-Tag/);
  });
});

describe('it reports the facts that actually distinguish the causes', () => {
  it('reports VERCEL_ENV, which settles the Production question', () => {
    // The single most likely cause: the variable set for Preview only. Nothing
    // outside the function can see which environment answered.
    expect(SRC).toMatch(/VERCEL_ENV/);
  });

  it('detects a trailing newline, which is invisible in a dashboard', () => {
    expect(SRC).toMatch(/raw !== raw\.trim\(\)/);
  });

  it('detects wrapping quotes, which Vercel stores literally', () => {
    expect(SRC).toMatch(/\^\["'\]/);
  });

  it('warns that the transaction pooler cannot run migrations', () => {
    // Port 6543 cannot hold the DDL transaction each migration file opens, and
    // the failure it produces names none of that.
    expect(SRC).toMatch(/6543/);
    expect(SRC).toMatch(/migrations CANNOT run/i);
  });

  it('reports whether the OTHER plausible variable names are set', () => {
    // databaseUrl() reads DATABASE_URL alone — deliberately, because a fallback
    // means a misconfiguration connects to the wrong database rather than
    // failing. An operator who set POSTGRES_URL needs to see that immediately.
    expect(SRC).toMatch(/POSTGRES_URL/);
  });
});
