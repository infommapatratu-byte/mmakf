// The go-live runbook must not aim a command at a host that does not resolve.
//
// docs/DEPLOYMENT.md §3 told the operator to collect TWO connection strings and
// to run the two commands that create the entire federation system — the
// migration (step 2) and the first SUPER_ADMIN (step 6) — over the one it
// labelled "Direct, port 5432". For the Supabase project the federation
// supplied, that host publishes AAAA only. Measured here, DNS only, no
// connection attempted because no database password has been supplied:
//
//   $ nslookup db.srmlqtdntkizxwnkttvz.supabase.co
//   Address:  2406:da1a:314:7102:cb52:44a4:70e5:bc13   <- AAAA; -type=A returns none
//   $ nslookup aws-0-ap-south-1.pooler.supabase.com
//   Addresses:  3.111.105.85, 65.0.195.55              <- IPv4, reachable
//
// So go-live stopped at step 2 on a connection error, and the runbook's own
// troubleshooting line ("check the pooler string and that the password is
// URL-encoded") described a different failure and sent the operator looking in
// the wrong place. The improvisation the document invited — retry against the
// port-6543 transaction pooler — is the one path the same paragraph calls
// unreliable for DDL.
//
// Prose alone did not hold this: the identical instruction had already been
// copy-pasted into three other documents. A comment is not an enforcement
// mechanism. This file is, for the one document it can reach.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const DOC = readFileSync('docs/DEPLOYMENT.md', 'utf8');
const LINES = DOC.split(/\r?\n/);

/** Lines an operator will actually paste into a shell. */
const COMMANDS = LINES.filter((l) => l.includes('DATABASE_URL="'));

/** The body of one numbered section, so a claim is asserted where it is read. */
function section(n: number): string {
  const start = DOC.indexOf(`## ${n}.`);
  const end = DOC.indexOf(`## ${n + 1}.`);
  expect(start, `§${n} is missing from DEPLOYMENT.md`).toBeGreaterThan(-1);
  return DOC.slice(start, end === -1 ? undefined : end);
}

describe('DEPLOYMENT.md sends the operator at a connection that resolves', () => {
  it('every pasteable command names the pooler host and its port', () => {
    // The original commands elided the host entirely — `postgresql://…:5432/…`
    // — which is precisely how an operator ends up pasting the direct string
    // out of the dashboard. The host is the part that decides whether the
    // command can run at all, so it is the part that must be shown.
    expect(COMMANDS.length, 'no DATABASE_URL commands found at all').toBeGreaterThan(0);
    const elided = COMMANDS.filter((l) => !/pooler\.supabase\.com:(5432|6543)/.test(l));
    expect(elided, 'a command hides the host it connects to').toEqual([]);
  });

  it('no command is aimed at the direct db.<ref> host', () => {
    // Not a style rule. On this project that host has no A record, so any
    // command carrying it fails before a single statement runs.
    const direct = COMMANDS.filter((l) => /@db\.[^./"\s]+\.supabase\.co/.test(l));
    expect(direct, 'a command targets the IPv6-only direct host').toEqual([]);
  });

  it('names the session pooler as the operator path, beside the transaction pooler', () => {
    // Before this fix the word "pooler" appeared in the whole repository only
    // as "transaction pooler", so the reader had two options where three exist
    // and the only workable one was unnamed.
    expect(section(3)).toMatch(/session pooler/i);
    expect(section(3)).toMatch(/transaction pooler/i);
    // Both live on the same host and differ only in the port. That single
    // digit is the mistake to expect, so both ports must be visible together.
    expect(section(3)).toMatch(/6543/);
    expect(section(3)).toMatch(/5432/);
  });

  it('records the failure in the words the operator will actually see', () => {
    // A name-resolution or route error is not a credentials error. The runbook
    // has to say so, or the next hour goes into re-checking the password.
    expect(DOC).toMatch(/ENOTFOUND/);
    expect(DOC).toMatch(/ENETUNREACH/);
    expect(DOC).toMatch(/no A record|AAAA/);
  });

  it('offers the IPv4 add-on as the stated alternative, not a surprise', () => {
    // The direct host is IPv6-only BY DESIGN without Supabase's paid IPv4
    // add-on. Buying it is a legitimate route and belongs in the document as a
    // choice the federation makes deliberately.
    // \s+ because the phrase wraps across a line in the rendered table.
    expect(section(3)).toMatch(/IPv4\*{0,2}\s+\*{0,2}add-on/i);
  });

  it('warns against the improvisation that follows the DNS wall', () => {
    // An operator who reads "AAAA only" and pastes the literal address hits a
    // second, more confusing failure — see the parsing test below.
    expect(DOC).toMatch(/ERR_SOCKET_BAD_PORT/);
  });

  it('tells the operator to run the migration from the repository root', () => {
    // scripts/migrate.mjs:81 does readdirSync('drizzle'), relative to the
    // working directory: from anywhere else the runner reports no migrations
    // rather than a wrong path.
    expect(section(3)).toMatch(/repository root|repo root/i);
  });

  it('repeats the trap in §7, where someone looks after losing the afternoon', () => {
    expect(section(7)).toMatch(/IPv6/);
  });
});

describe('why the runbook forbids pasting the IPv6 literal', () => {
  // No connection is opened by either test: postgres() parses the URL and
  // nothing more, and 2001:db8::1 is the RFC 3849 documentation prefix, not a
  // host. These assertions exist so the sentence in DEPLOYMENT.md stays true —
  // if a future postgres.js parses brackets correctly, this fails and the
  // warning should be rewritten rather than left as folklore.

  it('keeps half the address as the host and turns the port into NaN', async () => {
    const sql = postgres('postgresql://u:p@[2001:db8::1]:5432/postgres', {
      max: 1, prepare: false,
    });
    try {
      expect(sql.options.host).toEqual(['[2001']);
      // NaN is what node:net reports back as "Received type number (NaN)".
      expect(sql.options.port).toEqual([NaN]);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it('parses the pooler hostname exactly, which is what the runbook now uses', async () => {
    const sql = postgres('postgresql://u:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres', {
      max: 1, prepare: false,
    });
    try {
      expect(sql.options.host).toEqual(['aws-0-ap-south-1.pooler.supabase.com']);
      expect(sql.options.port).toEqual([5432]);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
