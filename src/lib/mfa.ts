// Multi-factor authentication. Q-27.
//
// TOTP (RFC 6238), implemented on node:crypto with no dependency. A national
// admin account can approve a Dan grade, revoke a certificate and finalise a
// competition result — a password alone is not enough for that, and the accounts
// most worth attacking are the ones held by the fewest, busiest people.
//
// WHY TOTP AND NOT SMS: SMS is delivered by a network that can be
// SIM-swapped, and it costs money per message so it fails silently when a
// balance runs out. TOTP works offline, on a phone the holder already carries,
// with no third party in the loop.
//
// WHAT THIS FILE DOES NOT DO: it does not decide WHO must use MFA. That is
// federation policy. `mfaRequirement()` reports what is configured and says
// plainly when nothing is — enforcing a requirement nobody wrote would lock
// administrators out of their own federation.

import crypto from 'node:crypto';

export class MfaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MfaError';
    this.code = code;
  }
}

// ─── Base32, because authenticator apps speak it ────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  // Padding and spacing are stripped: apps display secrets in groups of four,
  // and a user who copies one with spaces should not be told it is invalid.
  const clean = input.toUpperCase().replace(/[=\s-]/g, '');
  if (!clean.length || /[^A-Z2-7]/.test(clean)) {
    throw new MfaError('bad_secret', 'That is not a valid authenticator secret.');
  }

  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | B32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── TOTP ───────────────────────────────────────────────────────────────────

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * The RFC 6238 code for one time step.
 *
 * SHA-1 is specified by the RFC and is what every authenticator app implements.
 * Its weakness is collision resistance, which is irrelevant to HMAC — and
 * choosing SHA-256 here would produce codes no app can generate.
 */
function totpAt(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for a moment. Exported so tests can be deterministic. */
export function totp(secretBase32: string, at: Date = new Date()): string {
  return totpAt(base32Decode(secretBase32), Math.floor(at.getTime() / 1000 / PERIOD_SECONDS));
}

/**
 * Verify a submitted code.
 *
 * A ±1 step window (90 seconds total) absorbs clock drift between the phone and
 * the server. Wider would be convenient and materially weaker: every extra step
 * is another valid code an attacker who observed one has time to replay.
 *
 * Comparison is constant-time. A timing side channel on a six-digit code is a
 * real attack, not a theoretical one — the search space is small enough that
 * leaking position-by-position agreement would collapse it.
 */
export function verifyTotp(
  secretBase32: string,
  submitted: string,
  at: Date = new Date(),
  windowSteps = 1
): boolean {
  const code = String(submitted ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;

  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }

  const counter = Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
  let matched = false;

  // Every candidate is evaluated — no early return — so the time taken does not
  // reveal WHICH step matched, or how near a wrong code was.
  for (let step = -windowSteps; step <= windowSteps; step++) {
    const candidate = totpAt(secret, counter + step);
    const a = Buffer.from(candidate);
    const b = Buffer.from(code);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) matched = true;
  }
  return matched;
}

// ─── Enrolment ──────────────────────────────────────────────────────────────

export interface MfaEnrolment {
  secret: string;
  /** For the QR code. Contains the secret — never log it, never store it. */
  otpauthUri: string;
  recoveryCodes: string[];
  /** Store these, not the plaintext codes. */
  recoveryCodeHashes: string[];
}

/**
 * Begin enrolment.
 *
 * 20 bytes of entropy, per RFC 4226. Recovery codes are generated at the same
 * time and shown ONCE: an authenticator lives on a phone, phones are lost, and
 * an MFA rollout without a recovery path produces locked-out administrators and
 * then a permanent break-glass exemption that defeats the whole exercise.
 */
export function beginEnrolment(accountEmail: string, issuer = 'MMAKF'): MfaEnrolment {
  const secret = base32Encode(crypto.randomBytes(20));

  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });

  const recoveryCodes = Array.from({ length: 10 }, () =>
    // Crockford-ish base32, grouped, ambiguous characters excluded: these get
    // written on paper and read back by someone who is already locked out.
    crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-')
  );

  return {
    secret,
    otpauthUri: `otpauth://totp/${label}?${params}`,
    recoveryCodes,
    recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
  };
}

/**
 * Hash a recovery code.
 *
 * SHA-256 rather than scrypt, deliberately: these are 40 bits of CSPRNG output,
 * not a human-chosen password, so there is no dictionary to attack and the cost
 * of a slow KDF buys nothing. Stored hashed so a database leak does not hand
 * over ten working bypasses.
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256')
    .update(code.toUpperCase().replace(/[\s-]/g, ''))
    .digest('base64url');
}

/**
 * Consume a recovery code. Returns the REMAINING hashes.
 *
 * Single-use by construction: the matched hash is removed from the returned
 * list, so a code cannot be replayed even if it was observed. The caller stores
 * what comes back.
 */
export function consumeRecoveryCode(
  submitted: string,
  storedHashes: string[]
): { ok: boolean; remaining: string[] } {
  const candidate = hashRecoveryCode(submitted);

  let ok = false;
  const remaining: string[] = [];
  for (const stored of storedHashes) {
    const a = Buffer.from(candidate);
    const b = Buffer.from(stored);
    if (!ok && a.length === b.length && crypto.timingSafeEqual(a, b)) {
      ok = true;             // consumed — deliberately not carried forward
      continue;
    }
    remaining.push(stored);
  }
  return { ok, remaining };
}

/**
 * Complete enrolment by proving the app is working.
 *
 * Requiring a code before MFA is switched on is not ceremony: it is what stops
 * an administrator who mis-scanned the QR from locking themselves out of the
 * federation on their next sign-in.
 */
export function confirmEnrolment(secret: string, submittedCode: string, at: Date = new Date()): void {
  if (!verifyTotp(secret, submittedCode, at)) {
    throw new MfaError(
      'code_rejected',
      'That code was not accepted. Check the time on your phone is correct, then try the next code.'
    );
  }
}

// ─── Policy ─────────────────────────────────────────────────────────────────

export type MfaScope = 'none' | 'national' | 'all_admins' | 'everyone';

export interface MfaRequirement {
  configured: boolean;
  scope: MfaScope;
  required: boolean;
  reason: string;
}

/**
 * Is MFA required for this principal?
 *
 * THE SCOPE IS FEDERATION POLICY, read from MFA_REQUIRED_SCOPE. Unset means
 * nothing is required and the answer SAYS so — enforcing a requirement nobody
 * wrote would lock administrators out of their own federation on the day it
 * shipped.
 *
 * The recommendation, stated once and not enforced: `national`. The accounts
 * that can approve a Dan grade or finalise a result are the ones worth
 * protecting, and they are few enough for enrolment to be manageable.
 */
export function mfaRequirement(roles: string[]): MfaRequirement {
  const configured = (process.env.MFA_REQUIRED_SCOPE ?? '').toLowerCase() as MfaScope;

  if (!configured || configured === 'none') {
    return {
      configured: false,
      scope: 'none',
      required: false,
      reason: 'MMAKF has not configured which accounts require multi-factor authentication, so none is required. Recommended: national-scope accounts.',
    };
  }

  const NATIONAL = ['SUPER_ADMIN', 'FEDERATION_ADMIN', 'PRESIDENT', 'GENERAL_SECRETARY', 'TECHNICAL_DIRECTOR', 'FINANCE_OFFICER', 'SAFEGUARDING_OFFICER'];
  const ADMIN = [...NATIONAL, 'STATE_ADMIN', 'DISTRICT_ADMIN', 'DOJO_ADMIN'];

  const matched =
    configured === 'everyone' ? true :
    configured === 'all_admins' ? roles.some((r) => ADMIN.includes(r)) :
    configured === 'national' ? roles.some((r) => NATIONAL.includes(r)) :
    false;

  return {
    configured: true,
    scope: configured,
    required: matched,
    reason: matched
      ? `Multi-factor authentication is required for ${configured.replace('_', ' ')} accounts.`
      : `Multi-factor authentication is configured for ${configured.replace('_', ' ')} accounts; this account is not in that group.`,
  };
}

/**
 * Report enrolment coverage against the configured policy.
 *
 * A federation that has switched MFA on but enrolled nobody is in a WORSE
 * position than one that has not switched it on, because it believes it is
 * protected. This is the number to watch during a rollout.
 */
export function enrolmentCoverage(
  accounts: Array<{ email: string; roles: string[]; mfaEnrolled: boolean }>
): { required: number; enrolled: number; outstanding: string[]; configured: boolean } {
  const requirement = mfaRequirement([]);
  const needed = accounts.filter((a) => mfaRequirement(a.roles).required);

  return {
    configured: requirement.configured,
    required: needed.length,
    enrolled: needed.filter((a) => a.mfaEnrolled).length,
    outstanding: needed.filter((a) => !a.mfaEnrolled).map((a) => a.email),
  };
}
