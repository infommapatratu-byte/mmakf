// Federation reference-number generation (P2: predictable/colliding refs).
//
// The previous scheme used the last 6 digits of Date.now(), which repeats every
// 16m40s and is trivially guessable from the submission time. References are
// quoted by applicants in correspondence, so they must be unique and opaque.
//
// Format: MMAKF-{TYPE}-{YEAR}-{8 crockford-base32 chars from CSPRNG}
// e.g. MMAKF-E-2026-J7QK2M4P
//
// This is an interim scheme. The federation architecture (docs/FEDERATION-
// ARCHITECTURE.md §2) specifies sequence-allocated IDs once Postgres lands;
// those become the public register keys, while these remain the private
// applicant-facing receipt references.

import crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

export function reference(type: 'E' | 'R' | 'ORD' | 'GRD'): string {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `MMAKF-${type}-${new Date().getFullYear()}-${out}`;
}

/** Unguessable token for private receipt URLs. */
export function accessToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}
