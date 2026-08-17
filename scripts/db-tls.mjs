// Transport security for the operator scripts, in ONE place.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Every script in scripts/ that opens a database connection needs the same
// answer to "is this connection encrypted, and is the peer verified". They did
// not have the same answer. `postgres.js` ships `ssl: false`, so a script that
// simply omits the option is not taking a neutral default — it is deciding to
// send everything in plaintext. Measured across this directory, that decision
// had been made silently by:
//
//   · backup.mjs              — which reads the ENTIRE register into a file
//   · create-user.ts          — which writes a new password hash
//   · reset-password.ts       — which writes a freshly minted password
//   · seed-demo-schedules.mjs
//   · migrate.mjs             — until it was fixed, having shipped every
//                               migration in drizzle/ over the open internet
//
// and correctly by exactly one caller, which had solved it by COPYING the
// function. Three identical copies of a security rule is not three times the
// safety; it is three places for one of them to quietly stop matching. This
// module is the single definition, so a change to the policy is a change to the
// policy rather than a change to whichever copy someone happened to find.
//
// src/db/index.ts holds the application's copy and cannot import this one: it is
// TypeScript compiled by Astro, while these runners are deliberately plain node
// with no build step. Those two must be kept in step BY HAND. If you change the
// rules here, change them there, and tests/db-connection.test.ts pins the app's
// side so the drift is at least loud on one of the two.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULES
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. A remote host gets TLS with the certificate ACTUALLY VERIFIED. Not
//      `sslmode=require`: postgres.js maps require/allow/prefer to
//      rejectUnauthorized:false, which is libpq-standard and encrypts while
//      authenticating nobody. An active intermediary presents any certificate
//      at all and reads and rewrites the traffic.
//   2. An sslmode the operator wrote INTO THE URL WINS. postgres.js resolves an
//      `ssl` passed in options ahead of the one parsed from the query string, so
//      setting ours unconditionally would override somebody who deliberately
//      asked for verify-full — a "fix" that makes the careful person worse off.
//      Returning no `ssl` key hands the decision back to the string they wrote.
//   3. Loopback is exempt. scripts/dev-db.mjs serves PGlite over the wire
//      protocol on 127.0.0.1 and cannot negotiate TLS at all; demanding it there
//      would break local development to protect bytes that never reach a
//      network.
//
// A URL that cannot be parsed FAILS CLOSED, with TLS on and verified. Such a
// string will not connect anyway; what matters is that the fallback direction is
// never "send it in the clear".
//
// DATABASE_CA_CERT supplies a provider's PRIVATE root, in PEM. Supabase's pooler
// serves `*.pooler.supabase.com` under `Supabase Root 2021 CA`, which is in no
// trust store Node ships — so without it rule 1 fails closed with
// SELF_SIGNED_CERT_IN_CHAIN, correctly, and the remedy is to supply the root
// rather than to stop verifying. Named for the job and not for the vendor: any
// provider with a private root works, which is the neutrality DATABASE_URL buys
// everywhere else here.

/**
 * The `ssl` fragment to spread into a postgres.js options object.
 *
 * Returns `{}` — no `ssl` key at all — when the URL carries an sslmode, which is
 * rule 2 and is NOT the same as returning `{ ssl: false }`.
 *
 * @param {string} u the connection string
 * @returns {{ssl?: false | {rejectUnauthorized: true, ca?: string}}}
 */
export function tlsFor(u) {
  if (/[?&]sslmode=/i.test(u)) return {};

  const ca = process.env.DATABASE_CA_CERT?.trim();
  const verified = ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };

  let host = '';
  try {
    host = new URL(u).hostname.toLowerCase();
  } catch {
    return { ssl: verified }; // Fail closed.
  }

  // `new URL()` keeps IPv6 literals in their brackets; strip them so the
  // loopback comparison sees ::1 rather than [::1].
  const bare = host.replace(/^\[|\]$/g, '');
  const loopback = bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
  return loopback ? { ssl: false } : { ssl: verified };
}

/**
 * The hint to print when a connection dies on certificate verification.
 *
 * A TLS failure reads nothing like what it is — the handshake dies before
 * authentication, so the operator's instinct is to go back and re-check a
 * password that was never at fault. Said once, here, so every runner says it the
 * same way.
 *
 * @param {unknown} err
 * @returns {string|null} the explanation, or null if this is a different fault
 */
export function tlsHint(err) {
  const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : null;
  if (code !== 'SELF_SIGNED_CERT_IN_CHAIN' && code !== 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return null;
  return (
    '\nThat is a TLS verification failure, not a credentials failure. The server\n' +
    'presented a certificate chaining to a root this Node does not trust, so the\n' +
    'connection fails before authentication. Re-checking the password finds nothing.\n\n' +
    "Set DATABASE_CA_CERT to the provider's CA in PEM and re-run — for Supabase that\n" +
    'is the "Download certificate" link under Settings -> Database.'
  );
}
