// Web push, proved against the RFCs' own published test vectors.
//
// WHY THIS FILE HAD TO EXIST BEFORE THE FEATURE COULD BE WIRED TO ANYTHING.
//
// src/lib/push.ts says, in three separate places, that its cryptography is
// checked here against RFC 8291 §5 and RFC 8188 §3.1. Until this file was
// written those sentences were false, and a false claim of verification is
// worse than no claim: it is the sentence a reviewer reads instead of looking.
//
// The substance matters as much as the honesty. Push encryption fails SILENTLY.
// A body with the wrong delimiter byte, a nonce derived with the salt and the
// keying material the wrong way round, a DER signature where JWS wants the flat
// r||s form — every one of those produces something a push service accepts and
// a browser discards without a word. The federation would believe members had
// been told their certificate was withdrawn. "The ciphertext came out the right
// length" is not evidence of anything; a byte-for-byte match against a vector
// somebody else computed is.
//
// So the two vectors below are the load-bearing tests, and they are quoted from
// the RFCs rather than recorded from this implementation. A vector captured
// from the code under test proves only that the code has not changed.
//
// RFC 8188 §3.2 (multiple records) is deliberately NOT here: contentEncode
// emits one record by design, and the reasoning is above the function.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import {
  b64u, unb64u, contentEncode, encryptPayload, decryptPayload,
  generateVapidKeys, vapidAuthorization, verifyVapidAuthorization,
  isPushableTopic, isEssentialTopic, DIAGNOSTIC_TOPIC, DEFAULT_CHANNEL_PUSH,
  localHour, inQuietHours, PushError,
} from '@/lib/push';
import { NOTIFIABLE } from '@/lib/notifications';

// ─── RFC 8188 §3.1, "Encryption of a Response" ──────────────────────────────
//
// A single record with an EMPTY key id and no ECDH anywhere in it. That is why
// it is worth having alongside the web push vector: it exercises the content
// encoding on its own, so a fault in the HKDF/AES layer cannot hide behind a
// correct key agreement or vice versa.
const RFC8188 = {
  plaintext: 'I am the walrus',
  ikm: 'yqdlZ-tYemfogSmv7Ws5PQ',
  salt: 'I1BsxtFttlv3u_Oo94xnmw',
  recordSize: 4096,
  body: 'I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg',
};

// ─── RFC 8291 §5, "Push Message Encryption Example" ─────────────────────────
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  recordSize: 4096,
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** A device key pair in the shape a browser hands to the application. */
function device() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: b64u(ecdh.getPublicKey()),
    auth: b64u(crypto.randomBytes(16)),
    privateKey: ecdh.getPrivateKey(),
  };
}

describe('RFC 8188 aes128gcm content encoding', () => {
  it("reproduces the RFC's single-record example byte for byte", () => {
    const body = contentEncode(
      unb64u(RFC8188.salt),
      unb64u(RFC8188.ikm),
      Buffer.from(RFC8188.plaintext, 'utf8'),
      Buffer.alloc(0),
      RFC8188.recordSize,
    );
    expect(b64u(body)).toBe(RFC8188.body);
  });

  it('lays the header out as salt(16) | rs(4 big-endian) | idlen(1)', () => {
    const body = contentEncode(
      unb64u(RFC8188.salt), unb64u(RFC8188.ikm),
      Buffer.from(RFC8188.plaintext, 'utf8'), Buffer.alloc(0), RFC8188.recordSize,
    );
    expect(b64u(body.subarray(0, 16))).toBe(RFC8188.salt);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(0);
  });

  it('appends exactly one delimiter byte and one tag, and no padding', () => {
    // 21 header + 0 keyid + plaintext + 1 delimiter + 16 GCM tag. A record
    // padded up to recordSize would be 4096 bytes and would still decrypt —
    // which is how a padding bug survives every test that only round-trips.
    const body = contentEncode(
      unb64u(RFC8188.salt), unb64u(RFC8188.ikm),
      Buffer.from(RFC8188.plaintext, 'utf8'), Buffer.alloc(0), RFC8188.recordSize,
    );
    expect(body.length).toBe(21 + RFC8188.plaintext.length + 1 + 16);
  });

  it('refuses a salt that is not 16 bytes rather than deriving from a short one', () => {
    expect(() => contentEncode(
      Buffer.alloc(15), unb64u(RFC8188.ikm), Buffer.from('x'), Buffer.alloc(0), 4096,
    )).toThrow(PushError);
  });

  it('refuses a key id that will not fit in the one byte the format gives it', () => {
    expect(() => contentEncode(
      unb64u(RFC8188.salt), unb64u(RFC8188.ikm), Buffer.from('x'), Buffer.alloc(256), 4096,
    )).toThrow(PushError);
  });
});

describe('RFC 8291 web push message encryption', () => {
  it("reproduces the RFC's example body byte for byte", () => {
    const body = encryptPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret },
      {
        salt: unb64u(RFC8291.salt),
        senderPrivateKey: unb64u(RFC8291.asPrivate),
        recordSize: RFC8291.recordSize,
      },
    );
    expect(b64u(body)).toBe(RFC8291.body);
  });

  it("carries the sender's public key as the key id, which is how the browser finds it", () => {
    const body = unb64u(RFC8291.body);
    expect(body.readUInt8(20)).toBe(65);
    expect(b64u(body.subarray(21, 86))).toBe(RFC8291.asPublic);
  });

  it("a browser holding the RFC's own private key recovers the RFC's own plaintext", () => {
    // The forward direction proved above is only half of it. This runs the
    // RECEIVER's side of RFC 8291 against the RFC's recorded body, so the two
    // halves cannot be wrong in the same direction and agree with each other.
    const recovered = decryptPayload(
      unb64u(RFC8291.body),
      unb64u(RFC8291.uaPrivate),
      unb64u(RFC8291.authSecret),
    );
    expect(recovered.toString('utf8')).toBe(RFC8291.plaintext);
  });

  it('round-trips a message this implementation encrypted with its own fresh keys', () => {
    const d = device();
    const body = encryptPayload('Your certificate has been withdrawn.', d);
    expect(decryptPayload(body, d.privateKey, unb64u(d.auth)).toString('utf8'))
      .toBe('Your certificate has been withdrawn.');
  });

  it('uses a fresh sender key AND a fresh salt for every message', () => {
    // The docstring promises forward secrecy per message. Two encryptions of
    // the same text to the same device must share nothing: not the salt, not
    // the ephemeral key, not a byte of ciphertext.
    const d = device();
    const a = encryptPayload('same words', d);
    const b = encryptPayload('same words', d);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);   // salt
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false); // sender key
    expect(a.equals(b)).toBe(false);
  });

  it('cannot be replayed at a different device, because both keys are bound into the derivation', () => {
    // This is what the `WebPush: info` string is FOR. If the info block bound
    // only the sender's key, a body captured on the wire would decrypt on any
    // device that had ever spoken to this server.
    const intended = device();
    const other = device();
    const body = encryptPayload('for one member only', intended);
    expect(() => decryptPayload(body, other.privateKey, unb64u(other.auth))).toThrow();
  });

  it('refuses a device key that is not a point on P-256 instead of encrypting to nothing', () => {
    const bogus = Buffer.alloc(65);
    bogus[0] = 4;
    expect(() => encryptPayload('x', { p256dh: b64u(bogus), auth: b64u(crypto.randomBytes(16)) }))
      .toThrow(PushError);
  });

  it('refuses an auth secret that is not the 16 bytes RFC 8291 requires', () => {
    const d = device();
    expect(() => encryptPayload('x', { p256dh: d.p256dh, auth: b64u(crypto.randomBytes(12)) }))
      .toThrow(PushError);
  });

  it('refuses a payload one byte past what the record can hold, and accepts the byte before it', () => {
    // The boundary, not a comfortable number either side of it: the tag and the
    // delimiter have to fit inside recordSize too, and an off-by-17 here is a
    // message that encrypts happily and is dropped by the push service.
    const d = device();
    const limit = 4096 - 17;
    expect(() => encryptPayload(Buffer.alloc(limit, 0x61), d)).not.toThrow();
    expect(() => encryptPayload(Buffer.alloc(limit + 1, 0x61), d)).toThrow(PushError);
  });

  it('rejects a truncated body rather than returning whatever decrypted', () => {
    const d = device();
    const body = encryptPayload('a real message', d);
    expect(() => decryptPayload(body.subarray(0, body.length - 1), d.privateKey, unb64u(d.auth)))
      .toThrow();
  });
});

describe('RFC 8292 VAPID', () => {
  const keys = generateVapidKeys();

  it('signs a token the corresponding public key verifies', () => {
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', {
      ...keys, subject: 'mailto:admin@mmakf.in',
    });
    expect(verifyVapidAuthorization(header, keys.publicKey)).toBe(true);
  });

  it('a token does not verify under a different key pair', () => {
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', {
      ...keys, subject: 'mailto:admin@mmakf.in',
    });
    expect(verifyVapidAuthorization(header, generateVapidKeys().publicKey)).toBe(false);
  });

  it('scopes the audience to the endpoint ORIGIN, not the endpoint', () => {
    // The whole point of `aud`. A token minted for the full URL — or worse, a
    // fixed audience — is reusable by whoever receives it against a different
    // push service. The path must not appear anywhere in the claims.
    const header = vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/SECRET-PATH', {
      ...keys, subject: 'mailto:admin@mmakf.in',
    });
    const claims = JSON.parse(unb64u(/^vapid t=([^,\s]+)/.exec(header)![1].split('.')[1]).toString('utf8'));
    expect(claims.aud).toBe('https://updates.push.services.mozilla.com');
    expect(header).not.toContain('SECRET-PATH');
  });

  it('signs in the flat r||s form JWS requires, not DER', () => {
    // A DER signature is the "works against my test double, 401s against a real
    // push service" bug. It is 70-72 bytes and variable; P-1363 is always 64.
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {
      ...keys, subject: 'mailto:admin@mmakf.in',
    });
    const sig = unb64u(/^vapid t=([^,\s]+)/.exec(header)![1].split('.')[2]);
    expect(sig.length).toBe(64);
  });

  it('sets an expiry inside the 24 hours RFC 8292 allows', () => {
    const now = new Date('2026-08-13T09:00:00Z');
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {
      ...keys, subject: 'mailto:admin@mmakf.in', now,
    });
    const claims = JSON.parse(unb64u(/^vapid t=([^,\s]+)/.exec(header)![1].split('.')[1]).toString('utf8'));
    const seconds = claims.exp - Math.floor(now.getTime() / 1000);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(24 * 3600);
  });

  it('refuses a subject a push service cannot contact the operator through', () => {
    expect(() => vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {
      ...keys, subject: 'admin@mmakf.in',
    })).toThrow(PushError);
  });

  it('refuses an endpoint that is not a URL', () => {
    expect(() => vapidAuthorization('not-a-url', { ...keys, subject: 'mailto:admin@mmakf.in' }))
      .toThrow(PushError);
  });

  it('generates a 65-byte uncompressed public point and a 32-byte scalar', () => {
    const k = generateVapidKeys();
    expect(unb64u(k.publicKey).length).toBe(65);
    expect(unb64u(k.publicKey)[0]).toBe(4);
    expect(unb64u(k.privateKey).length).toBe(32);
  });
});

describe('topics', () => {
  it('never keeps its own opinion of which messages are essential', () => {
    // A second copy of this list is the bug: it disagrees with notifications.ts
    // the day somebody adds a topic, and the disagreement shows up as a member
    // not being told their certificate was withdrawn.
    for (const [topic, def] of Object.entries(NOTIFIABLE)) {
      expect(isEssentialTopic(topic)).toBe(def.essential);
      expect(isPushableTopic(topic)).toBe(true);
    }
  });

  it('will not push a topic notifications.ts has never heard of', () => {
    expect(isPushableTopic('MARKETING_BLAST')).toBe(false);
    expect(isEssentialTopic('MARKETING_BLAST')).toBe(false);
  });

  it('allows the self-test topic, and does not let it claim to be essential', () => {
    expect(isPushableTopic(DIAGNOSTIC_TOPIC)).toBe(true);
    expect(isEssentialTopic(DIAGNOSTIC_TOPIC)).toBe(false);
  });
});

describe('the default that lives in the schema', () => {
  it('agrees with the DDL, so the constant and the column cannot drift apart', () => {
    // The claim above DEFAULT_CHANNEL_PUSH is that the schema is where the
    // federation's default lives and this constant merely repeats it. That is
    // only true while something checks.
    const ddl = readFileSync('drizzle/0007_engagement_and_fees.sql', 'utf8');
    const m = /"channel_push"\s+boolean\s+DEFAULT\s+(true|false)/i.exec(ddl);
    expect(m).not.toBeNull();
    expect(m![1].toLowerCase() === 'true').toBe(DEFAULT_CHANNEL_PUSH);
  });
});

describe('quiet hours', () => {
  // 09:00 UTC is 14:30 in Kolkata and 09:00 in London. Every case below is
  // stated as an instant plus a zone, never as "now", so none of it can pass
  // or fail according to where the machine running it happens to be.
  const at = (iso: string) => new Date(iso);

  it('reads the hour in the MEMBER\'s zone, not the server\'s', () => {
    expect(localHour(at('2026-08-13T20:00:00Z'), 'Asia/Kolkata')).toBe(1);
    expect(localHour(at('2026-08-13T20:00:00Z'), 'UTC')).toBe(20);
  });

  it('returns null for a zone that is not one, rather than guessing UTC', () => {
    expect(localHour(at('2026-08-13T20:00:00Z'), 'Mars/Olympus_Mons')).toBeNull();
  });

  it('is undeterminable — not "no" — when no window or no zone is known', () => {
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), 'Asia/Kolkata', null, null)).toBeNull();
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), null, 22, 7)).toBeNull();
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), 'Mars/Olympus_Mons', 22, 7)).toBeNull();
  });

  it('wraps midnight, because 22:00-07:00 is the window somebody actually wants', () => {
    // 20:00 UTC is 01:30 in Kolkata: inside. 09:00 UTC is 14:30: outside.
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), 'Asia/Kolkata', 22, 7)).toBe(true);
    expect(inQuietHours(at('2026-08-13T09:00:00Z'), 'Asia/Kolkata', 22, 7)).toBe(false);
  });

  it('treats from === to as NO window, never as a 24-hour silence', () => {
    // Reading it the other way mutes a member permanently through one mis-set
    // field, and the member never finds out why.
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), 'Asia/Kolkata', 9, 9)).toBe(false);
    expect(inQuietHours(at('2026-08-13T09:00:00Z'), 'Asia/Kolkata', 9, 9)).toBe(false);
  });

  it('is inclusive of `from` and exclusive of `to`', () => {
    // 03:30 UTC is 09:00 in Kolkata; 07:30 UTC is 13:00.
    expect(inQuietHours(at('2026-08-13T03:30:00Z'), 'Asia/Kolkata', 9, 13)).toBe(true);
    expect(inQuietHours(at('2026-08-13T07:30:00Z'), 'Asia/Kolkata', 9, 13)).toBe(false);
  });

  it('refuses an hour outside 0-23 rather than silencing on a nonsense window', () => {
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), 'Asia/Kolkata', 24, 7)).toBeNull();
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), 'Asia/Kolkata', -1, 7)).toBeNull();
    expect(inQuietHours(at('2026-08-13T20:00:00Z'), 'Asia/Kolkata', 22.5 as number, 7)).toBeNull();
  });
});
