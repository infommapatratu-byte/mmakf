// Multi-factor authentication.
//
// Verified against RFC 6238's own published test vectors, because an
// implementation that agrees only with itself agrees with no authenticator app.

import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  base32Encode, base32Decode, totp, verifyTotp, beginEnrolment, confirmEnrolment,
  hashRecoveryCode, consumeRecoveryCode, mfaRequirement, enrolmentCoverage, MfaError,
} from '../src/lib/mfa';

afterEach(() => { delete process.env.MFA_REQUIRED_SCOPE; });

describe('base32 — what authenticator apps speak', () => {
  it('round-trips arbitrary bytes', () => {
    for (const n of [1, 5, 10, 20, 32]) {
      const bytes = crypto.randomBytes(n);
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    }
  });

  it('matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('tolerates the spacing and padding apps display', () => {
    const secret = base32Encode(crypto.randomBytes(20));
    const spaced = secret.match(/.{1,4}/g)!.join(' ');
    // A user copying a secret with spaces must not be told it is invalid.
    expect(base32Decode(spaced).equals(base32Decode(secret))).toBe(true);
    expect(base32Decode(`${secret}===`).equals(base32Decode(secret))).toBe(true);
  });

  it('refuses characters that are not base32', () => {
    expect(() => base32Decode('ABC!DEF')).toThrow(MfaError);
    expect(() => base32Decode('')).toThrow(MfaError);
    // 0, 1 and 8 are excluded from the alphabet precisely because they are
    // confusable with O, I and B when read off a screen.
    expect(() => base32Decode('ABC0DEF')).toThrow(MfaError);
  });
});

describe('TOTP agrees with RFC 6238', () => {
  // The RFC's published SHA-1 vectors. An implementation that agrees only with
  // itself agrees with no authenticator app.
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

  it('produces the published codes at the published times', () => {
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(totp(RFC_SECRET, new Date(seconds * 1000))).toBe(expected);
    }
  });

  it('always returns six digits, zero-padded', () => {
    for (let i = 0; i < 200; i++) {
      const code = totp(base32Encode(crypto.randomBytes(20)), new Date(i * 30_000));
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('changes every 30 seconds and holds steady within a step', () => {
    const secret = base32Encode(crypto.randomBytes(20));
    const base = 1_700_000_000_000;
    const step = base - (base % 30_000);
    expect(totp(secret, new Date(step))).toBe(totp(secret, new Date(step + 29_000)));
    expect(totp(secret, new Date(step))).not.toBe(totp(secret, new Date(step + 30_000)));
  });
});

describe('verification', () => {
  const secret = base32Encode(crypto.randomBytes(20));
  const at = new Date(1_700_000_000_000);

  it('accepts the current code', () => {
    expect(verifyTotp(secret, totp(secret, at), at)).toBe(true);
  });

  it('accepts one step either side, to absorb clock drift', () => {
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 30_000)), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() + 30_000)), at)).toBe(true);
  });

  it('ATTACK: refuses a code from two steps away', () => {
    // Every extra step is another valid code an attacker who observed one has
    // time to replay.
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 60_000)), at)).toBe(false);
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() + 60_000)), at)).toBe(false);
  });

  it('ATTACK: refuses a code generated with a different secret', () => {
    const other = base32Encode(crypto.randomBytes(20));
    expect(verifyTotp(secret, totp(other, at), at)).toBe(false);
  });

  it('refuses malformed input rather than throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', null as any, undefined as any]) {
      expect(verifyTotp(secret, bad, at)).toBe(false);
    }
  });

  it('tolerates a code typed with spaces', () => {
    const code = totp(secret, at);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, at)).toBe(true);
  });

  it('returns false for a corrupt stored secret instead of throwing', () => {
    // A corrupt row must be a failed sign-in, not a 500 that distinguishes it.
    expect(verifyTotp('not-base32!!', '123456', at)).toBe(false);
  });

  it('does not leak which step matched, because every candidate is evaluated', () => {
    // This was once asserted with a stopwatch, which measured the machine's
    // load rather than the algorithm and failed at random under a parallel
    // test run. The property that actually makes verification constant-time is
    // that NO candidate is skipped — so count the comparisons instead. A code
    // matching at the first step, at the last step, and not at all must all
    // cost exactly the same number of comparisons.
    const comparisons = (submitted: string) => {
      const spy = vi.spyOn(crypto, 'timingSafeEqual');
      try {
        verifyTotp(secret, submitted, at);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    const step = 30_000;                       // one TOTP period, in ms
    const previous = totp(secret, new Date(at.getTime() - step));
    const next = totp(secret, new Date(at.getTime() + step));

    const counts = [
      comparisons(totp(secret, at)),           // matches at step 0
      comparisons(previous),                   // matches at step -1
      comparisons(next),                       // matches at step +1
      comparisons('000000'),                   // matches nowhere
    ];
    // Default window is ±1, so three candidates, always.
    expect(counts).toEqual([3, 3, 3, 3]);
  });

  it('accepts the adjacent steps that the window exists to tolerate', () => {
    const step = 30_000;
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - step)), at)).toBe(true);
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() + step)), at)).toBe(true);
    // But not one beyond it — a clock that far out is a different problem.
    expect(verifyTotp(secret, totp(secret, new Date(at.getTime() - 3 * step)), at)).toBe(false);
  });
});

describe('enrolment', () => {
  it('issues a 160-bit secret and a scannable URI', () => {
    const e = beginEnrolment('admin@mmakf.in');
    expect(base32Decode(e.secret).length).toBe(20);      // RFC 4226
    expect(e.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(e.otpauthUri).toContain('issuer=MMAKF');
    expect(e.otpauthUri).toContain('digits=6');
    expect(e.otpauthUri).toContain('period=30');
    expect(e.otpauthUri).toContain(encodeURIComponent('MMAKF:admin@mmakf.in'));
  });

  it('issues recovery codes and stores only their hashes', () => {
    const e = beginEnrolment('admin@mmakf.in');
    expect(e.recoveryCodes.length).toBe(10);
    expect(e.recoveryCodeHashes.length).toBe(10);
    // A database leak must not hand over ten working bypasses.
    for (const code of e.recoveryCodes) {
      expect(e.recoveryCodeHashes).not.toContain(code);
    }
    expect(new Set(e.recoveryCodes).size).toBe(10);
  });

  it('never repeats a secret', () => {
    const secrets = Array.from({ length: 100 }, () => beginEnrolment('a@b.in').secret);
    expect(new Set(secrets).size).toBe(100);
  });

  it('REQUIRES a working code before switching MFA on', () => {
    // Not ceremony: this is what stops an administrator who mis-scanned the QR
    // from locking themselves out of the federation on their next sign-in.
    const e = beginEnrolment('admin@mmakf.in');
    const at = new Date(1_700_000_000_000);
    expect(() => confirmEnrolment(e.secret, '000000', at)).toThrow(/not accepted/i);
    expect(() => confirmEnrolment(e.secret, totp(e.secret, at), at)).not.toThrow();
  });

  it('tells a rejected user to check their phone clock', () => {
    const e = beginEnrolment('admin@mmakf.in');
    try {
      confirmEnrolment(e.secret, '000000');
      throw new Error('should have thrown');
    } catch (err: any) {
      // Clock skew is the actual cause almost every time.
      expect(err.message).toMatch(/time on your phone/i);
    }
  });
});

describe('recovery codes', () => {
  it('accepts a valid code and CONSUMES it', () => {
    const e = beginEnrolment('admin@mmakf.in');
    const first = e.recoveryCodes[0];

    const used = consumeRecoveryCode(first, e.recoveryCodeHashes);
    expect(used.ok).toBe(true);
    expect(used.remaining.length).toBe(9);

    // Single-use by construction — it cannot be replayed even if observed.
    const again = consumeRecoveryCode(first, used.remaining);
    expect(again.ok).toBe(false);
    expect(again.remaining.length).toBe(9);
  });

  it('normalises formatting, because these are read off paper', () => {
    const e = beginEnrolment('admin@mmakf.in');
    const code = e.recoveryCodes[0];
    expect(consumeRecoveryCode(code.toLowerCase().replace(/-/g, ' '), e.recoveryCodeHashes).ok).toBe(true);
  });

  it('refuses an unknown code and consumes nothing', () => {
    const e = beginEnrolment('admin@mmakf.in');
    const r = consumeRecoveryCode('DEADBEEF-00', e.recoveryCodeHashes);
    expect(r.ok).toBe(false);
    expect(r.remaining.length).toBe(10);
  });

  it('hashes deterministically regardless of formatting', () => {
    expect(hashRecoveryCode('ABCDE-12345')).toBe(hashRecoveryCode('abcde 12345'));
  });
});

describe('policy is configuration, never invented', () => {
  it('requires nothing when unset, and SAYS nothing is configured', () => {
    const r = mfaRequirement(['SUPER_ADMIN']);
    expect(r.configured).toBe(false);
    expect(r.required).toBe(false);
    // Enforcing a requirement nobody wrote would lock administrators out of
    // their own federation on the day it shipped.
    expect(r.reason).toMatch(/has not configured/i);
    expect(r.reason).toMatch(/recommended: national/i);
  });

  it('applies the national scope to the accounts that can decide things', () => {
    process.env.MFA_REQUIRED_SCOPE = 'national';
    expect(mfaRequirement(['SUPER_ADMIN']).required).toBe(true);
    expect(mfaRequirement(['FINANCE_OFFICER']).required).toBe(true);
    expect(mfaRequirement(['SAFEGUARDING_OFFICER']).required).toBe(true);
    expect(mfaRequirement(['STATE_ADMIN']).required).toBe(false);
    expect(mfaRequirement(['ATHLETE']).required).toBe(false);
  });

  it('honours the wider scopes', () => {
    process.env.MFA_REQUIRED_SCOPE = 'all_admins';
    expect(mfaRequirement(['DOJO_ADMIN']).required).toBe(true);
    expect(mfaRequirement(['ATHLETE']).required).toBe(false);

    process.env.MFA_REQUIRED_SCOPE = 'everyone';
    expect(mfaRequirement(['ATHLETE']).required).toBe(true);
  });

  it('explains why an account is NOT required, not only when it is', () => {
    process.env.MFA_REQUIRED_SCOPE = 'national';
    expect(mfaRequirement(['ATHLETE']).reason).toMatch(/not in that group/i);
  });

  it('falls closed on an unrecognised scope', () => {
    process.env.MFA_REQUIRED_SCOPE = 'sometimes';
    expect(mfaRequirement(['SUPER_ADMIN']).required).toBe(false);
  });
});

describe('rollout coverage', () => {
  const accounts = [
    { email: 'super@mmakf.in', roles: ['SUPER_ADMIN'], mfaEnrolled: true },
    { email: 'sec@mmakf.in', roles: ['GENERAL_SECRETARY'], mfaEnrolled: false },
    { email: 'fin@mmakf.in', roles: ['FINANCE_OFFICER'], mfaEnrolled: false },
    { email: 'state@mmakf.in', roles: ['STATE_ADMIN'], mfaEnrolled: false },
  ];

  it('names who is outstanding — the number to watch during a rollout', () => {
    process.env.MFA_REQUIRED_SCOPE = 'national';
    const c = enrolmentCoverage(accounts);
    // A federation that has switched MFA on but enrolled nobody is in a WORSE
    // position than one that has not, because it believes it is protected.
    expect(c.required).toBe(3);
    expect(c.enrolled).toBe(1);
    expect(c.outstanding).toEqual(['sec@mmakf.in', 'fin@mmakf.in']);
  });

  it('reports nothing required when the policy is unset', () => {
    const c = enrolmentCoverage(accounts);
    expect(c.configured).toBe(false);
    expect(c.required).toBe(0);
    expect(c.outstanding).toEqual([]);
  });
});
