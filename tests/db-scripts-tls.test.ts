// A DATABASE SCRIPT THAT DIES ON TLS MUST SAY SO.
//
// scripts/db-tls.mjs has always exported tlsHint(): the written explanation that
// a certificate failure is not a credentials failure, that the handshake dies
// before authentication, and that the fix is to supply the provider's CA. It is
// the difference between an operator fixing this in a minute and re-checking a
// password that was never at fault.
//
// It was imported by scripts/create-user.ts and NEVER CALLED. An operator ran
// the create-user command, got a bare 'self-signed certificate in certificate
// chain', and none of that guidance reached them - it was sitting in the same
// repository, already written, one function call away. reset-password.ts had
// the identical defect.
//
// That is a CLASS rather than a bug: storageKeyFor() was written, documented and
// called by nothing in exactly the same way. An import is not a use, and nothing
// in TypeScript objects to a symbol brought in and left alone.
//
// SO THE ASSERTION IS ON THE CALL, NOT THE IMPORT. A script that imports tlsHint
// and does not call it FAILS here - that state is the bug, not a near-miss.
//
// Matching is done with plain string containment rather than regular
// expressions. The patterns wanted here are literal ('tlsHint(') and a regex
// would add escaping to a file whose whole job is to be read and trusted later.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tlsFor } from '../scripts/db-tls.mjs';

const DIR = 'scripts';
const SCRIPT_EXT = ['.ts', '.mjs', '.js'];

/** Scripts that talk to Postgres, found by what they do rather than by a list. */
function connectingScripts(): Array<{ file: string; src: string }> {
  return readdirSync(DIR)
    .filter((f) => SCRIPT_EXT.some((e) => f.endsWith(e)))
    // db-tls.mjs DEFINES the helpers; it is not a caller of them.
    .filter((f) => f !== 'db-tls.mjs')
    .map((f) => ({ file: join(DIR, f), src: readFileSync(join(DIR, f), 'utf8') }))
    .filter(({ src }) => src.includes('tlsFor(') || src.includes('postgres('));
}

describe('every database script explains a TLS failure', () => {
  it('finds the scripts that open a connection', () => {
    // A guard that silently matches nothing passes for ever. If a refactor moves
    // these scripts, this fails rather than going quiet.
    expect(connectingScripts().length).toBeGreaterThan(0);
  });

  it('calls tlsHint in its error path - importing it is not enough', () => {
    const silent = connectingScripts()
      .filter(({ src }) => !src.includes('tlsHint('))
      .map(({ file, src }) =>
        src.includes('tlsHint')
          ? file + ' (imports tlsHint and never calls it - this is the exact defect)'
          : file + ' (no tlsHint at all)'
      );

    expect(silent, 'a database script would report a TLS failure as an unexplained error').toEqual([]);
  });
});

describe('the TLS failure is never resolved by trusting less', () => {
  // The tempting fix for a certificate error is to stop verifying certificates.
  // It turns an outage into a channel anybody on the path can read, and it looks
  // like a fix because the connection then succeeds. These assertions make that
  // change fail a test rather than pass a smoke check.
  //
  // Fabricated hosts throughout. Nothing here is a real credential.
  it('verifies the certificate for a remote host', () => {
    const opts: any = tlsFor('postgres://u:p@db.example.com:5432/x');
    expect(opts.ssl).toBeTruthy();
    expect(opts.ssl.rejectUnauthorized).toBe(true);
  });

  it('leaves TLS off only for loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const opts: any = tlsFor('postgres://u:p@' + host + ':5432/x');
      expect(opts.ssl).toBe(false);
    }
  });

  it('fails closed on a URL it cannot parse', () => {
    const opts: any = tlsFor('not a url');
    expect(opts.ssl.rejectUnauthorized).toBe(true);
  });
});
