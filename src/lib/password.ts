// Password hashing (§53).
//
// scrypt from node:crypto, deliberately — not bcrypt or argon2.
//
// The deploy target is Vercel serverless: native addons must compile for the
// exact runtime, and a broken native build fails at deploy time, not test time.
// scrypt is memory-hard, in the standard library, and needs no addon. That
// tradeoff is worth more here than argon2's marginal advantage.
//
// Parameters: N=2^15 (32768), r=8, p=1, 64-byte key, 16-byte random salt.
// N=2^15 costs roughly 32 MB and ~100ms per hash on serverless hardware — heavy
// enough to make offline cracking expensive, light enough that a login does not
// time out. Node's default maxmem would reject N this high, so it is raised
// explicitly.
//
// The encoded form carries its own parameters:
//
//   scrypt$N$r$p$<salt base64url>$<hash base64url>
//
// so parameters can be raised later without invalidating existing hashes — an
// old hash still verifies under the parameters it was created with, and can be
// transparently re-hashed on next successful login.

import crypto from 'node:crypto';

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALTLEN = 16;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),   // same bytes regardless of Unicode form
      salt,
      KEYLEN,
      { N: n, r, p, maxmem: 256 * 1024 * 1024 },
      (err, derived) => (err ? reject(err) : resolve(derived))
    );
  });
}

/** Hash a password for storage. Never log or return the input. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALTLEN);
  const derived = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Comparison is constant-time. A malformed or absent hash returns false rather
 * than throwing, so a corrupt row cannot turn into a 500 that distinguishes it
 * from a wrong password.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!password || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row — they would be a memory DoS.
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  try {
    const derived = await scryptAsync(password, salt, n, r, p);
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than we now issue. */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}

/**
 * Minimum password policy for federation accounts.
 *
 * Length is the requirement that actually resists cracking; character-class
 * rules mostly produce "Password1!" and are not imposed. 12 characters follows
 * current NIST guidance for user-chosen secrets.
 */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 256) return 'Password must be 256 characters or fewer';
  if (!password.trim()) return 'Password cannot be only whitespace';
  return null;
}

/**
 * A dummy verification, run when no user matches, so a failed login costs the
 * same time whether or not the account exists. Without it, response timing
 * discloses which email addresses are registered (§53 enumeration).
 */
let dummyHash: string | null = null;
export async function equalizeTiming(password: string): Promise<void> {
  if (!dummyHash) dummyHash = await hashPassword('mmakf-timing-equalizer-not-a-real-password');
  await verifyPassword(password || 'x', dummyHash);
}
