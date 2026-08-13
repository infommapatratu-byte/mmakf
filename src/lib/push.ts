// Web push. Q-25.
//
// Push is a CHANNEL under the rules src/lib/notifications.ts already sets, not a
// second notification system. That file owns the allow-list of what a member may
// be told about, which of those are essential, how a message is deduplicated on
// its domain event, and the principle that a message with no transport is
// QUEUED rather than dropped. This file carries such a message to a device and
// obeys every one of those rules. It invents no reason to contact anybody: the
// only things it sends are notification rows that notifications.ts already
// decided to create.
//
// ─── WHAT IS ACTUALLY IMPLEMENTED HERE, AND WHY IT IS NOT A DEPENDENCY ──────
//
// Real web push needs two pieces of cryptography and node:crypto has both:
//
//   RFC 8292  VAPID — an ES256 JWT that identifies this application server to
//             the push service, so a stolen endpoint cannot be pushed to by
//             anyone else.
//   RFC 8291  Message encryption — ECDH on P-256 to a key the BROWSER generated,
//             HKDF-SHA256, then AES-128-GCM in the RFC 8188 aes128gcm content
//             encoding. The push service (Google, Mozilla, Apple) relays a blob
//             it cannot read. That is the whole point: the federation's messages
//             about children do not pass legible through a third party.
//
// Both are verified in tests/push.test.ts against the RFCs' OWN published test
// vectors — RFC 8291 §5 and RFC 8188 §3.1 — in exactly the way src/lib/mfa.ts
// verifies TOTP. A push system that silently fails to encrypt is worse than no
// push system at all, because the federation would believe members were told.
//
// ─── WHAT IS DELIBERATELY NOT STORED ────────────────────────────────────────
//
// No coordinate. No IP address. The only location this file will persist is the
// COARSE region the edge already attached to the request — a country, and a
// region name where the platform supplies one. There is no parameter here that
// accepts a latitude, and there must never be: a martial arts federation
// holding the home locations of children is a safeguarding liability with no
// operational benefit whatever.
//
// ─── AND ONE THING THAT IS A SECRET EVEN THOUGH IT LOOKS LIKE A URL ─────────
//
// A push `endpoint` is a bearer capability. Anyone holding it can ask the push
// service to wake that device. So it is the natural key in the database and it
// is NEVER returned to a browser, never logged, and never put in an operator
// report — those surfaces get the push service's HOST and the row id, which is
// enough to answer "which device" and useless to anyone who intercepts it.

import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { assertCanAnywhere, type Principal } from '@/lib/rbac';
import { log } from '@/lib/observability';
import { NOTIFIABLE, isNotifiable, type TransportStatus } from '@/lib/notifications';

type DB = any;

export class PushError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PushError';
    this.code = code;
  }
}

// ─── base64url ──────────────────────────────────────────────────────────────
//
// Everything in web push travels as base64url: the browser hands the page a
// subscription whose keys are already in it, and the JWT is defined in it.

export function b64u(input: Buffer | Uint8Array | string): string {
  return Buffer.from(input as any).toString('base64url');
}

export function unb64u(input: string): Buffer {
  // Accept standard base64 too. Browsers emit base64url, but a key pasted into
  // an environment variable by a human has usually been through something that
  // changed - and _ back into + and /, and rejecting it would look like a
  // broken deployment rather than a mangled paste.
  const clean = String(input ?? '').trim().replace(/\s/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (clean && !/^[A-Za-z0-9\-_]+$/.test(clean)) {
    throw new PushError('bad_base64', 'That value is not base64url.');
  }
  return Buffer.from(clean, 'base64url');
}

// ─── RFC 8291 / RFC 8188: message encryption ────────────────────────────────

/** HKDF-SHA256, extract then one 32-byte expand block. Web push never needs a second. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): { prk: Buffer; okm: Buffer } {
  if (length > 32) throw new PushError('hkdf_length', 'This HKDF does one block; web push never needs more.');
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const okm = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
  return { prk, okm };
}

/** The uncompressed P-256 point a browser gives as `p256dh`, checked properly. */
function assertPublicPoint(raw: Buffer, what: string): Buffer {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new PushError('bad_key', `${what} must be a 65-byte uncompressed P-256 point.`);
  }
  // A length check is NOT a validity check. An invalid-curve point is a real
  // attack on ECDH, and the cheap way to refuse one is to let node's own key
  // parser do the on-curve test — it throws for a point that is not on P-256.
  try {
    crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) },
      format: 'jwk',
    });
  } catch {
    throw new PushError('bad_key', `${what} is not a point on the P-256 curve.`);
  }
  return raw;
}

/**
 * RFC 8188 `aes128gcm`: one record, sealed under a key derived from a salt and
 * some input keying material.
 *
 * Separated from the web push key agreement above it because they are two
 * different RFCs solving two different problems, and because keeping this layer
 * reachable on its own is what lets tests/push.test.ts check it against RFC 8188
 * §3.1 — a vector with no ECDH in it at all, which the web push vector cannot
 * exercise in isolation.
 *
 * ONE RECORD ONLY. The format supports many; web push messages are capped well
 * below a single record and every implementation on the receiving side handles
 * the single-record case, so emitting more would add a code path nothing tests.
 */
export function contentEncode(salt: Buffer, ikm: Buffer, plaintext: Buffer, keyid: Buffer, recordSize: number): Buffer {
  if (salt.length !== 16) throw new PushError('bad_salt', 'The salt must be 16 bytes.');
  if (keyid.length > 255) throw new PushError('bad_keyid', 'The key id must fit in one byte of length.');

  const { okm: cek } = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const { okm: nonce } = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // 0x02 is the LAST-RECORD delimiter. 0x01 there, or no delimiter at all,
  // produces a body that decrypts to bytes the browser then discards in
  // silence — which is exactly the failure mode this whole file exists to avoid.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(keyid.length, 20);

  return Buffer.concat([header, keyid, ciphertext]);
}

export interface Subscription {
  endpoint: string;
  /** The device's public key, base64url, as the browser produced it. */
  p256dh: string;
  /** The device's 16-byte shared auth secret, base64url. */
  auth: string;
}

export interface EncryptOptions {
  /** Fixed salt. Tests only — production must use fresh randomness per message. */
  salt?: Buffer;
  /** Fixed sender private key. Tests only, for the same reason. */
  senderPrivateKey?: Buffer;
  /** Record size. 4096 is what every push service accepts and what the RFC's example uses. */
  recordSize?: number;
}

/**
 * Encrypt one push message into an RFC 8188 `aes128gcm` body.
 *
 * The sender key pair is EPHEMERAL AND PER MESSAGE. Reusing one across messages
 * to the same device would reuse the content encryption key with a fresh salt,
 * which is not immediately fatal but throws away forward secrecy for nothing —
 * generating a P-256 key costs microseconds and a push is a network round trip.
 *
 * The layout, which is where implementations of this usually go wrong:
 *
 *   salt(16) | rs(4, big-endian) | idlen(1) | sender public key(65) | ciphertext
 *
 * and the plaintext gets a single 0x02 delimiter byte appended before
 * encryption — 0x02 means "this is the last record". Emitting 0x01 there, or
 * omitting the delimiter, produces a body every browser silently discards.
 */
export function encryptPayload(plaintext: Buffer | string, sub: Pick<Subscription, 'p256dh' | 'auth'>, opts: EncryptOptions = {}): Buffer {
  const uaPublic = assertPublicPoint(unb64u(sub.p256dh), 'The device key (p256dh)');
  const authSecret = unb64u(sub.auth);
  if (authSecret.length !== 16) {
    throw new PushError('bad_key', 'The device auth secret must be 16 bytes.');
  }

  const recordSize = opts.recordSize ?? 4096;
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  // 16 bytes of GCM tag and 1 delimiter byte have to fit inside the record.
  const maxPlaintext = recordSize - 17;
  if (body.length > maxPlaintext) {
    throw new PushError('payload_too_large', `A push payload may not exceed ${maxPlaintext} bytes; this one is ${body.length}.`);
  }

  const salt = opts.salt ?? crypto.randomBytes(16);
  if (salt.length !== 16) throw new PushError('bad_salt', 'The salt must be 16 bytes.');

  const ecdh = crypto.createECDH('prime256v1');
  if (opts.senderPrivateKey) ecdh.setPrivateKey(opts.senderPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();

  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3. The auth secret is the HKDF SALT here and the ECDH output is
  // the input keying material — the opposite way round from the step below, and
  // swapping them is the single most common way to get a body that decrypts
  // nowhere. The info string binds BOTH public keys into the derivation, so a
  // message encrypted for one device cannot be replayed at another.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const { okm: ikm } = hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // The sender's public key travels as the RFC 8188 `keyid`. That is how the
  // browser knows which ephemeral key to run its own ECDH against.
  return contentEncode(salt, ikm, body, asPublic, recordSize);
}

/**
 * The inverse, which exists so the tests can prove the forward direction.
 *
 * This is what a BROWSER does, and nothing in the federation's servers calls
 * it. It is here because "the ciphertext has the right length" is not evidence
 * that anything was encrypted correctly, and a round trip against the RFC's own
 * recorded body is.
 */
export function decryptPayload(body: Buffer, uaPrivateKey: Buffer, authSecret: Buffer): Buffer {
  if (body.length < 21) throw new PushError('bad_body', 'Too short to be an aes128gcm body.');
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  if (ciphertext.length < 17) throw new PushError('bad_body', 'No room for a tag and a delimiter.');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateKey);
  const ecdhSecret = ecdh.computeSecret(asPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ecdh.getPublicKey(), asPublic]);
  const { okm: ikm } = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const { okm: cek } = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const { okm: nonce } = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);

  // Strip the trailing delimiter and any zero padding before it.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 2) throw new PushError('bad_body', 'Missing the last-record delimiter.');
  return padded.subarray(0, end);
}

// ─── RFC 8292: VAPID ────────────────────────────────────────────────────────

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Generate a VAPID key pair, for an operator to run ONCE and put in the
 * environment.
 *
 * NOTHING IN THIS FILE CALLS IT AUTOMATICALLY, and that is the important part.
 * Filling in a missing key with a fresh one at startup would make push appear
 * to work while every subscription taken under the previous key silently
 * stopped being pushable — a serverless deployment would mint a new identity
 * per cold start. Absence is reported by pushStatus(), never papered over.
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk: any = publicKey.export({ format: 'jwk' });
  const priv: any = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])),
    privateKey: String(priv.d),
  };
}

/** The signing key, rebuilt from the raw 32-byte scalar the environment holds. */
function vapidSigningKey(privateKeyRaw: Buffer, publicKeyRaw: Buffer): crypto.KeyObject {
  assertPublicPoint(publicKeyRaw, 'VAPID_PUBLIC_KEY');
  if (privateKeyRaw.length !== 32) {
    throw new PushError('bad_vapid', 'VAPID_PRIVATE_KEY must be a 32-byte P-256 scalar in base64url.');
  }
  // Consistency is checked, not assumed. A public and private key from two
  // different pairs produce a JWT the push service rejects with a 403 that says
  // nothing useful, and finding that out in production costs an afternoon.
  const derived = crypto.createECDH('prime256v1');
  derived.setPrivateKey(privateKeyRaw);
  if (!derived.getPublicKey().equals(publicKeyRaw)) {
    throw new PushError('bad_vapid', 'VAPID_PUBLIC_KEY is not the public key of VAPID_PRIVATE_KEY.');
  }
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64u(privateKeyRaw),
      x: b64u(publicKeyRaw.subarray(1, 33)),
      y: b64u(publicKeyRaw.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

export interface VapidOptions {
  publicKey: string;
  privateKey: string;
  subject: string;
  now?: Date;
  /** Seconds. RFC 8292 §2 caps this at 24 hours; 12 leaves room for clock skew. */
  expiresIn?: number;
}

/**
 * The `Authorization` header for one push, signed for one push service.
 *
 * `aud` is the ORIGIN of the endpoint and nothing else. Signing a token for the
 * whole endpoint URL, or for a fixed audience, hands whoever receives it a token
 * usable at a different service — the audience restriction is the only thing
 * stopping a relayed JWT being reused.
 */
export function vapidAuthorization(endpoint: string, opts: VapidOptions): string {
  let audience: string;
  try {
    audience = new URL(endpoint).origin;
  } catch {
    throw new PushError('bad_endpoint', 'That endpoint is not a URL.');
  }

  if (!/^(mailto:|https:)/.test(opts.subject)) {
    throw new PushError('bad_vapid', 'The VAPID subject must be a mailto: or https: URI so a push service can reach the operator.');
  }

  const key = vapidSigningKey(unb64u(opts.privateKey), unb64u(opts.publicKey));
  const now = opts.now ?? new Date();
  const exp = Math.floor(now.getTime() / 1000) + (opts.expiresIn ?? 12 * 3600);

  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp, sub: opts.subject }));
  const signingInput = `${header}.${claims}`;

  // ieee-p1363 is the flat r||s form JWS requires. Node's default is DER, which
  // is what an implementation that "works locally but 401s in production" is
  // usually sending.
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });

  return `vapid t=${signingInput}.${b64u(signature)}, k=${b64u(unb64u(opts.publicKey))}`;
}

/** Verify a VAPID header. Not used in production; the tests need it to prove signing. */
export function verifyVapidAuthorization(header: string, publicKey: string): boolean {
  const m = /^vapid t=([^,\s]+)/.exec(String(header ?? ''));
  if (!m) return false;
  const parts = m[1].split('.');
  if (parts.length !== 3) return false;
  const raw = unb64u(publicKey);
  if (raw.length !== 65 || raw[0] !== 0x04) return false;
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) },
    format: 'jwk',
  });
  return crypto.verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
    { key, dsaEncoding: 'ieee-p1363' },
    unb64u(parts[2])
  );
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * The federation's published contact, used as the VAPID subject when the
 * deployment has not set one.
 *
 * Not invented: it is MMAKF's own address, in docs/PROJECT-CONTEXT.md §1. A
 * push service uses `sub` to contact whoever is responsible for the traffic, so
 * a wrong one is worse than a default that reaches the office.
 */
const DEFAULT_VAPID_SUBJECT = 'mailto:admin@mmakf.in';

function vapidConfig(): VapidOptions | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject: process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT };
}

/**
 * Whether push can be delivered right now, in the same shape and the same
 * spirit as transportStatus() in notifications.ts.
 *
 * Keys that are present but malformed report NOT CONFIGURED with the reason,
 * rather than being discovered one message at a time at send time.
 */
export function pushStatus(): TransportStatus {
  const cfg = vapidConfig();
  if (!cfg) {
    return {
      channel: 'push',
      configured: false,
      reason:
        'Web push is not configured (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY unset). Push notifications are QUEUED, not sent. Run generateVapidKeys() once and set both.',
    };
  }
  try {
    vapidSigningKey(unb64u(cfg.privateKey), unb64u(cfg.publicKey));
  } catch (err: any) {
    return { channel: 'push', configured: false, reason: `Web push is not configured: ${err?.message ?? err} Push notifications are QUEUED, not sent.` };
  }
  return { channel: 'push', configured: true, reason: 'Configured.' };
}

/**
 * The application server key a browser needs to call `pushManager.subscribe()`.
 *
 * Public by design — it is broadcast to every subscriber — and null when push
 * is not configured, so a page can render "push is not available" instead of a
 * button that cannot work.
 */
export function vapidPublicKey(): string | null {
  return pushStatus().configured ? (process.env.VAPID_PUBLIC_KEY ?? null) : null;
}

// ─── Topics, preferences and quiet hours ────────────────────────────────────

export type PushOutcome =
  | 'queued' | 'sent' | 'failed' | 'expired'
  | 'suppressed_quiet_hours' | 'suppressed_preference' | 'suppressed_duplicate';

/**
 * The one topic that is not a federation event: a test the member fires at
 * their own device from their own settings page.
 *
 * It bypasses the preference check and quiet hours BECAUSE the member asked for
 * it in that second — a test push that is silently suppressed looks exactly
 * like a broken one, and the member turns the feature off. It cannot be
 * addressed to anyone else; sendTestToSelf() resolves the recipient from the
 * caller's own session.
 */
export const DIAGNOSTIC_TOPIC = 'PUSH_TEST';

export function isPushableTopic(topic: string): boolean {
  return isNotifiable(topic) || topic === DIAGNOSTIC_TOPIC;
}

/**
 * Essential topics cannot be suppressed. By anything.
 *
 * Read straight out of notifications.ts rather than restated here — a second
 * copy of this list would disagree with the first the day somebody adds a topic,
 * and the disagreement would show up as a member not being told their
 * certificate was withdrawn.
 */
export function isEssentialTopic(topic: string): boolean {
  return isNotifiable(topic) ? NOTIFIABLE[topic].essential : false;
}

/**
 * Whether push is on for a topic when the member has expressed no preference.
 *
 * `false`, because that is the default on `notification_preferences.channel_push`
 * in drizzle/0007_engagement_and_fees.sql, and the schema is where the
 * federation's default lives. tests/push.test.ts asserts this constant still
 * agrees with the DDL, so the two cannot drift apart quietly.
 *
 * The consequence is deliberate: granting a browser permission subscribes the
 * DEVICE, it does not opt the member into every topic. Essential messages are
 * unaffected — they are never subject to a preference at all.
 */
export const DEFAULT_CHANNEL_PUSH = false;

/** The hour of day, 0-23, at a moment, in a named zone. `null` if the zone is not one. */
export function localHour(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: 'numeric', hour12: false }).formatToParts(now);
    const n = Number(parts.find((p) => p.type === 'hour')?.value);
    // Some ICU builds render midnight as "24" under hour12:false.
    return Number.isInteger(n) && n >= 0 && n <= 24 ? n % 24 : null;
  } catch {
    return null;
  }
}

/**
 * Is this moment inside the member's quiet hours?
 *
 * `null` means UNDETERMINABLE — no window is set, or no timezone is known — and
 * every caller treats null as "do not suppress". Evaluating quiet hours in the
 * SERVER's timezone would be worse than not evaluating them: it would silence a
 * message at two in the afternoon and deliver one at three in the morning, which
 * is precisely the failure quiet hours exist to prevent.
 *
 * The window is inclusive of `from` and exclusive of `to`, and wraps midnight,
 * because 22:00-07:00 is the window somebody actually wants. from === to is not
 * a 24-hour silence — it is no window at all; reading it the other way would
 * mute a member permanently through a single mis-set field.
 */
export function inQuietHours(now: Date, timezone: string | null | undefined, fromHour: number | null | undefined, toHour: number | null | undefined): boolean | null {
  if (fromHour == null || toHour == null) return null;
  if (!Number.isInteger(fromHour) || !Number.isInteger(toHour)) return null;
  if (fromHour < 0 || fromHour > 23 || toHour < 0 || toHour > 23) return null;
  if (fromHour === toHour) return false;
  if (!timezone) return null;

  const hour = localHour(now, timezone);
  if (hour == null) return null;

  return fromHour < toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour;
}

// ─── Devices ────────────────────────────────────────────────────────────────

export interface SubscribeInput extends Subscription {
  userAgent?: string | null;
  /** IANA zone name reported by the browser. Used only to evaluate quiet hours. */
  timezone?: string | null;
  /** ISO-3166 alpha-2, from the EDGE. Never from the request body — see the route. */
  regionCountry?: string | null;
  /** Coarse region name where the platform supplies one. Never a coordinate. */
  regionName?: string | null;
}

const ENDPOINT_MAX = 2048;

function assertEndpoint(endpoint: string): string {
  const value = String(endpoint ?? '').trim();
  if (!value || value.length > ENDPOINT_MAX) {
    throw new PushError('bad_endpoint', 'That push endpoint is missing or implausibly long.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PushError('bad_endpoint', 'That push endpoint is not a URL.');
  }
  // https only. A push endpoint is a bearer capability and every real push
  // service issues one over TLS; accepting http would let a misconfigured or
  // hostile client have the federation post member notifications in clear.
  if (url.protocol !== 'https:') {
    throw new PushError('bad_endpoint', 'A push endpoint must be https.');
  }
  return value;
}

function normaliseTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const value = String(tz).slice(0, 64);
  // Validated now rather than at send time: an unparseable zone discovered
  // during delivery means quiet hours cannot be applied to the one message that
  // needed them.
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/**
 * Record a browser's subscription.
 *
 * THE ENDPOINT IS THE NATURAL KEY. One person on a phone and a laptop is two
 * rows, correctly: they are two devices, either can be revoked alone, and
 * either can be reported GONE by the push service independently.
 *
 * Re-subscribing an endpoint that already exists REPOINTS the row at the caller
 * rather than creating a second one or refusing. A shared or family device is
 * ordinary in this federation — a parent and a child on one tablet — and the
 * failure to prevent is the previous account continuing to receive that child's
 * notifications on a device someone else is now signed in on. The unique index
 * on `endpoint` makes any other reading impossible anyway.
 */
export async function subscribe(db: DB, principal: Principal, input: SubscribeInput) {
  if (principal.userId == null) {
    throw new PushError('no_user', 'Sign in with your own account to receive push notifications.');
  }

  const endpoint = assertEndpoint(input.endpoint);
  // Both keys are validated HERE, at subscribe time. Storing a malformed key
  // and discovering it during a grading-result send means the one message that
  // mattered is the one that failed.
  const p256dh = assertPublicPoint(unb64u(input.p256dh), 'The device key (p256dh)');
  const auth = unb64u(input.auth);
  if (auth.length !== 16) throw new PushError('bad_key', 'The device auth secret must be 16 bytes.');

  const user = (await db.select({ personId: s.users.personId }).from(s.users).where(eq(s.users.id, principal.userId)).limit(1))[0];

  const values = {
    userId: principal.userId,
    personId: user?.personId ?? null,
    endpoint,
    p256dh: b64u(p256dh),
    auth: b64u(auth),
    status: 'active' as const,
    userAgent: input.userAgent ? String(input.userAgent).slice(0, 400) : null,
    regionCountry: input.regionCountry ? String(input.regionCountry).toUpperCase().slice(0, 2) : null,
    regionName: input.regionName ? String(input.regionName).slice(0, 80) : null,
    timezone: normaliseTimezone(input.timezone),
    lastSeenAt: new Date(),
    failureCount: 0,
    lastError: null,
  };

  const [row] = await db
    .insert(s.pushDevices)
    .values(values)
    .onConflictDoUpdate({ target: s.pushDevices.endpoint, set: values })
    .returning();

  return safeDevice(row);
}

/**
 * Withdraw one device.
 *
 * Marked `unsubscribed`, not deleted. An operator asked "why did this member
 * stop being notified" needs to see that they turned it off, and a deleted row
 * answers nothing. The keys are cleared to the empty string because a
 * subscription that has been withdrawn has no business leaving usable
 * encryption material in the database.
 */
export async function unsubscribe(db: DB, principal: Principal, endpoint: string) {
  if (principal.userId == null) throw new PushError('no_user', 'Sign in to change your notification devices.');

  const existing = (await db.select().from(s.pushDevices).where(eq(s.pushDevices.endpoint, String(endpoint ?? ''))).limit(1))[0];
  // The same answer whether the row is missing or belongs to somebody else.
  // Distinguishing them turns this endpoint into an oracle for whether a given
  // push endpoint is registered to this federation.
  if (!existing || existing.userId !== principal.userId) return { unsubscribed: false };

  await db
    .update(s.pushDevices)
    .set({ status: 'unsubscribed', p256dh: '', auth: '', lastSeenAt: new Date() })
    .where(eq(s.pushDevices.id, existing.id));

  return { unsubscribed: true, deviceId: existing.id };
}

/**
 * A device as it may be shown to anyone.
 *
 * The endpoint and both keys are dropped. The push service HOST is kept because
 * "Google" or "Mozilla" is what makes a row recognisable as "my phone" in a
 * settings list, and it leaks nothing — everyone using that browser has it.
 */
function safeDevice(row: any) {
  let host: string | null = null;
  try {
    host = new URL(row.endpoint).host;
  } catch {
    host = null;
  }
  return {
    id: row.id,
    service: host,
    status: row.status,
    userAgent: row.userAgent ?? null,
    regionCountry: row.regionCountry ?? null,
    regionName: row.regionName ?? null,
    timezone: row.timezone ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    failureCount: row.failureCount ?? 0,
    createdAt: row.createdAt ?? null,
  };
}

/** The caller's own devices. Takes no id, so reading somebody else's is not expressible. */
export async function myDevices(db: DB, principal: Principal) {
  if (principal.userId == null) return [];
  const rows = await db
    .select()
    .from(s.pushDevices)
    .where(eq(s.pushDevices.userId, principal.userId))
    .orderBy(desc(s.pushDevices.id));
  return rows.map(safeDevice);
}

// ─── Preferences ────────────────────────────────────────────────────────────

export interface PreferenceInput {
  topic: string;
  channelInApp?: boolean;
  channelEmail?: boolean;
  channelPush?: boolean;
  channelSms?: boolean;
  quietFromHour?: number | null;
  quietToHour?: number | null;
  timezone?: string | null;
}

/** The caller's own preferences, one row per topic they have expressed one for. */
export async function myPreferences(db: DB, principal: Principal) {
  if (principal.userId == null) return [];
  return db
    .select()
    .from(s.notificationPreferences)
    .where(eq(s.notificationPreferences.userId, principal.userId))
    .orderBy(asc(s.notificationPreferences.topic));
}

/**
 * Set one preference.
 *
 * AN ESSENTIAL TOPIC CANNOT BE SWITCHED OFF, and the refusal happens here, at
 * the write, rather than only at the send. A stored `channelPush: false` on
 * CERTIFICATE_REVOKED would be a lie the member could read back in their own
 * settings — they would believe they had turned it off, and be notified anyway.
 * Refusing the write is the only version where the screen and the behaviour
 * agree.
 */
export async function setPreference(db: DB, principal: Principal, input: PreferenceInput) {
  if (principal.userId == null) throw new PushError('no_user', 'Sign in to change your notification preferences.');

  const topic = String(input.topic ?? '');
  if (!isNotifiable(topic)) {
    throw new PushError('unknown_topic', 'There is no such notification topic.');
  }
  if (isEssentialTopic(topic) && (input.channelInApp === false || input.channelPush === false || input.channelEmail === false)) {
    throw new PushError(
      'essential_topic',
      'That message is a consequence of a federation decision about you and cannot be switched off. You can still choose which devices are subscribed.'
    );
  }

  const hour = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 23) throw new PushError('bad_hour', 'Quiet hours are whole hours from 0 to 23.');
    return n;
  };

  const values: any = {
    userId: principal.userId,
    topic,
    updatedAt: new Date(),
  };
  if (input.channelInApp !== undefined) values.channelInApp = Boolean(input.channelInApp);
  if (input.channelEmail !== undefined) values.channelEmail = Boolean(input.channelEmail);
  if (input.channelPush !== undefined) values.channelPush = Boolean(input.channelPush);
  if (input.channelSms !== undefined) values.channelSms = Boolean(input.channelSms);
  if (input.quietFromHour !== undefined) values.quietFromHour = hour(input.quietFromHour);
  if (input.quietToHour !== undefined) values.quietToHour = hour(input.quietToHour);
  if (input.timezone !== undefined) values.timezone = normaliseTimezone(input.timezone);

  const [row] = await db
    .insert(s.notificationPreferences)
    .values(values)
    .onConflictDoUpdate({ target: [s.notificationPreferences.userId, s.notificationPreferences.topic], set: values })
    .returning();

  return row;
}

// ─── Sending ────────────────────────────────────────────────────────────────

export interface PushMessage {
  title: string;
  body: string;
  url?: string | null;
}

export interface SendInput extends PushMessage {
  userId: number;
  topic: string;
  /** The notifications row this carries, if any. Deduplication keys on it. */
  notificationId?: number | null;
  /** Injected so the tests are deterministic — see observability.probe(). */
  now?: Date;
  /** Injected so the tests never touch the network. */
  fetchImpl?: typeof fetch;
}

export interface PushAttempt {
  deviceId: number | null;
  /** The push service host. Never the endpoint — it is a bearer capability. */
  service: string | null;
  outcome: PushOutcome;
  detail: string | null;
}

export interface PushSendReport {
  topic: string;
  essential: boolean;
  devices: number;
  sent: number;
  queued: number;
  failed: number;
  expired: number;
  suppressed: number;
  attempts: PushAttempt[];
}

function emptyReport(topic: string): PushSendReport {
  return { topic, essential: isEssentialTopic(topic), devices: 0, sent: 0, queued: 0, failed: 0, expired: 0, suppressed: 0, attempts: [] };
}

async function recordDelivery(
  db: DB,
  row: { notificationId?: number | null; pushDeviceId?: number | null; userId?: number | null; topic: string; outcome: PushOutcome; detail?: string | null; at?: Date }
) {
  await db.insert(s.notificationDeliveries).values({
    notificationId: row.notificationId ?? null,
    pushDeviceId: row.pushDeviceId ?? null,
    userId: row.userId ?? null,
    topic: row.topic,
    channel: 'push',
    outcome: row.outcome,
    detail: row.detail ? String(row.detail).slice(0, 400) : null,
    attemptedAt: row.at ?? new Date(),
  });
}

/** How long a push service should hold an undelivered message, in seconds. */
function ttlFor(topic: string): number {
  // Seven days for an essential message: a phone that was off for a week must
  // still learn that a certificate was withdrawn. A day for everything else —
  // "the draw has been published" is worthless a week late and holding it is
  // just a notification that arrives with no context.
  return isEssentialTopic(topic) ? 7 * 24 * 3600 : 24 * 3600;
}

export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * The exact HTTP request a push service is about to receive.
 *
 * Split out from the sending so a test can assert on the wire format without a
 * network, and so the encryption can be verified by decrypting the body this
 * returns rather than by trusting that the send path called the right function.
 *
 * NO `Topic` HEADER IS SET, deliberately. RFC 8030 lets a Topic replace an
 * earlier undelivered message with the same one, and a phone that was off for a
 * day would then receive one grading notice instead of two. This project's first
 * rule for notifications is do not lose a message; collapsing is a feature that
 * loses them.
 */
export function buildPushRequest(sub: Subscription, message: PushMessage, opts: { topic: string; vapid?: VapidOptions | null; now?: Date; encrypt?: EncryptOptions }): PushRequest {
  // The payload carries a POINTER, never the substance of a decision — the same
  // rule describe() follows in notifications.ts. A push notification is rendered
  // on a lock screen, in front of whoever is holding the phone, and travels
  // through a service the federation does not control.
  const payload = Buffer.from(
    JSON.stringify({
      title: String(message.title ?? '').slice(0, 120),
      body: String(message.body ?? '').slice(0, 400),
      url: message.url ? String(message.url).slice(0, 300) : '/my',
      topic: opts.topic,
    }),
    'utf8'
  );

  const body = encryptPayload(payload, sub, opts.encrypt ?? {});
  const headers: Record<string, string> = {
    TTL: String(ttlFor(opts.topic)),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    // An essential message is worth waking a device for; a ranking update is not.
    Urgency: isEssentialTopic(opts.topic) ? 'high' : 'normal',
  };
  if (opts.vapid) {
    headers.Authorization = vapidAuthorization(sub.endpoint, { ...opts.vapid, now: opts.now });
  }

  return { url: sub.endpoint, headers, body };
}

/**
 * Send one message to every active device a member has.
 *
 * THE ORDER OF THE CHECKS IS THE POLICY, and it is this:
 *
 *   1. topic on the allow-list          — anything else sends to nobody
 *   2. essential?                       — if so, checks 3 and 4 do not apply
 *   3. the member's channel preference
 *   4. the member's quiet hours, in THEIR timezone
 *   5. already delivered for this notification and device?
 *   6. is push configured at all?       — if not, QUEUED, never dropped
 *
 * Every one of those that stops a message WRITES A ROW saying so. "We chose not
 * to send" and "we tried and it failed" are different facts, and an operator
 * asked why somebody was not told needs to see which one happened. A row that
 * simply does not exist answers neither question.
 */
export async function sendToUser(db: DB, input: SendInput): Promise<PushSendReport> {
  const topic = String(input.topic ?? '');
  const report = emptyReport(topic);
  const now = input.now ?? new Date();

  // 1. Fail closed. An unrecognised topic reaches nobody, exactly as an event
  //    outside NOTIFIABLE produces no notification.
  if (!isPushableTopic(topic)) {
    throw new PushError('unknown_topic', 'There is no such notification topic, so nothing was sent.');
  }

  const diagnostic = topic === DIAGNOSTIC_TOPIC;
  const essential = isEssentialTopic(topic);
  report.essential = essential;

  const pref = (
    await db
      .select()
      .from(s.notificationPreferences)
      .where(and(eq(s.notificationPreferences.userId, input.userId), eq(s.notificationPreferences.topic, topic)))
      .limit(1)
  )[0];

  const devices = await db
    .select()
    .from(s.pushDevices)
    .where(and(eq(s.pushDevices.userId, input.userId), eq(s.pushDevices.status, 'active')))
    .orderBy(asc(s.pushDevices.id));

  report.devices = devices.length;

  // 3. Preference. Never for an essential topic — somebody must not be able to
  //    opt out of being told their own credential was withdrawn — and never for
  //    the diagnostic, which the member requested a second ago.
  if (!essential && !diagnostic) {
    const wantsPush = pref ? Boolean(pref.channelPush) : DEFAULT_CHANNEL_PUSH;
    if (!wantsPush) {
      await recordDelivery(db, {
        notificationId: input.notificationId, userId: input.userId, topic,
        outcome: 'suppressed_preference', at: now,
        detail: pref ? 'The member has push switched off for this topic.' : 'The member has not switched push on for this topic; the default is off.',
      });
      report.suppressed++;
      report.attempts.push({ deviceId: null, service: null, outcome: 'suppressed_preference', detail: 'preference' });
      return report;
    }
  }

  // 4. Quiet hours, in the member's own timezone — theirs, taken from the
  //    preference first and the device second, never the server's.
  if (!essential && !diagnostic) {
    const timezone = pref?.timezone ?? devices.find((d: any) => d.timezone)?.timezone ?? null;
    const quiet = inQuietHours(now, timezone, pref?.quietFromHour, pref?.quietToHour);
    if (quiet === true) {
      await recordDelivery(db, {
        notificationId: input.notificationId, userId: input.userId, topic,
        outcome: 'suppressed_quiet_hours', at: now,
        detail: `Inside the member's quiet hours (${pref?.quietFromHour}:00-${pref?.quietToHour}:00 ${timezone}).`,
      });
      report.suppressed++;
      report.attempts.push({ deviceId: null, service: null, outcome: 'suppressed_quiet_hours', detail: timezone });
      return report;
    }
    if (quiet === null && pref?.quietFromHour != null && pref?.quietToHour != null) {
      // A window is set and cannot be evaluated. Sending is the lesser error:
      // suppressing on a GUESSED timezone silences a message at two in the
      // afternoon. The reason is logged so the gap is fixable — subscribe()
      // captures the browser's zone, so this means an older device row.
      log.warn('push.quiet_hours_unknown_timezone', {
        userId: input.userId, topic,
        detail: 'Quiet hours are set but no timezone is known for this member, so they were not applied. The message was sent.',
      });
    }
  }

  if (devices.length === 0) {
    // No row is written. "This member has no push device" is already visible in
    // push_devices, and a delivery row per topic per member with no device
    // would fill the table with a fact that is answered better elsewhere.
    return report;
  }

  const status = pushStatus();
  const vapid = status.configured ? vapidConfig() : null;

  for (const device of devices) {
    const service = (() => {
      try { return new URL(device.endpoint).host; } catch { return null; }
    })();

    // 5. Deduplicate on the notification and the device. queue() already
    //    deduplicates on the domain event so the same event cannot make two
    //    notification rows; this stops a RETRY of the delivery loop pushing the
    //    same notification to the same device twice.
    if (input.notificationId != null) {
      const already = (
        await db
          .select({ id: s.notificationDeliveries.id })
          .from(s.notificationDeliveries)
          .where(and(
            eq(s.notificationDeliveries.notificationId, input.notificationId),
            eq(s.notificationDeliveries.pushDeviceId, device.id),
            eq(s.notificationDeliveries.channel, 'push'),
            inArray(s.notificationDeliveries.outcome, ['sent', 'queued'])
          ))
          .limit(1)
      )[0];
      if (already) {
        await recordDelivery(db, {
          notificationId: input.notificationId, pushDeviceId: device.id, userId: input.userId, topic,
          outcome: 'suppressed_duplicate', at: now,
          detail: 'This notification has already been delivered to this device.',
        });
        report.suppressed++;
        report.attempts.push({ deviceId: device.id, service, outcome: 'suppressed_duplicate', detail: null });
        continue;
      }
    }

    // 6. Not configured means QUEUED, never dropped and never claimed as sent —
    //    the same contract transportStatus() gives email and SMS today.
    //    deliverQueuedPush() picks these up the moment keys appear.
    if (!vapid) {
      await recordDelivery(db, {
        notificationId: input.notificationId, pushDeviceId: device.id, userId: input.userId, topic,
        outcome: 'queued', at: now, detail: status.reason,
      });
      report.queued++;
      report.attempts.push({ deviceId: device.id, service, outcome: 'queued', detail: status.reason });
      continue;
    }

    const attempt = await deliverToDevice(db, device, { title: input.title, body: input.body, url: input.url }, {
      topic, vapid, now, fetchImpl: input.fetchImpl,
    });

    await recordDelivery(db, {
      notificationId: input.notificationId, pushDeviceId: device.id, userId: input.userId, topic,
      outcome: attempt.outcome, detail: attempt.detail, at: now,
    });

    report.attempts.push({ ...attempt, deviceId: device.id, service });
    if (attempt.outcome === 'sent') report.sent++;
    else if (attempt.outcome === 'expired') report.expired++;
    else report.failed++;
  }

  return report;
}

/** How many consecutive failures before a device is parked as broken. */
const FAILURE_LIMIT = 5;

/**
 * One HTTP request to one push service, and what its answer means.
 *
 * 404 and 410 are the push service saying THE SUBSCRIPTION IS GONE — the
 * browser was uninstalled, the profile wiped, the permission revoked. Retrying
 * one of those forever is how a push queue turns into a permanent error rate
 * nobody reads, so the device is marked expired immediately and stops being
 * selected. That is pruning, and it is a normal event rather than a fault.
 */
async function deliverToDevice(
  db: DB,
  device: any,
  message: PushMessage,
  opts: { topic: string; vapid: VapidOptions; now: Date; fetchImpl?: typeof fetch }
): Promise<{ outcome: PushOutcome; detail: string | null }> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  let request: PushRequest;

  try {
    request = buildPushRequest(
      { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
      message,
      { topic: opts.topic, vapid: opts.vapid, now: opts.now }
    );
  } catch (err: any) {
    // The stored keys will not encrypt. That device can never be pushed to
    // again, so it is parked rather than retried on a schedule for ever.
    const detail = `Could not encrypt for this device: ${String(err?.message ?? err)}`;
    await db.update(s.pushDevices).set({ status: 'failed', lastError: detail.slice(0, 400) }).where(eq(s.pushDevices.id, device.id));
    return { outcome: 'failed', detail };
  }

  let response: Response;
  try {
    response = await doFetch(request.url, { method: 'POST', headers: request.headers, body: request.body as any });
  } catch (err: any) {
    const detail = `The push service could not be reached: ${String(err?.message ?? err)}`.slice(0, 400);
    await db
      .update(s.pushDevices)
      .set({ failureCount: (device.failureCount ?? 0) + 1, lastError: detail, ...((device.failureCount ?? 0) + 1 >= FAILURE_LIMIT ? { status: 'failed' as const } : {}) })
      .where(eq(s.pushDevices.id, device.id));
    return { outcome: 'failed', detail };
  }

  if (response.status === 404 || response.status === 410) {
    await db
      .update(s.pushDevices)
      .set({ status: 'expired', lastSeenAt: opts.now, lastError: `The push service reported this subscription gone (HTTP ${response.status}).` })
      .where(eq(s.pushDevices.id, device.id));
    return { outcome: 'expired', detail: `The push service reported this subscription gone (HTTP ${response.status}). The device has been pruned.` };
  }

  if (response.ok) {
    await db
      .update(s.pushDevices)
      .set({ lastSeenAt: opts.now, failureCount: 0, lastError: null })
      .where(eq(s.pushDevices.id, device.id));
    return { outcome: 'sent', detail: `HTTP ${response.status}` };
  }

  const failures = (device.failureCount ?? 0) + 1;
  const detail = `The push service returned HTTP ${response.status}.`;
  await db
    .update(s.pushDevices)
    .set({ failureCount: failures, lastError: detail, ...(failures >= FAILURE_LIMIT ? { status: 'failed' as const } : {}) })
    .where(eq(s.pushDevices.id, device.id));
  return { outcome: 'failed', detail };
}

/**
 * A test push to the caller's OWN devices.
 *
 * The recipient is the session, never a parameter. An endpoint that accepts a
 * recipient is an endpoint that will one day be sent somebody else's — and one
 * that sends a push on request is exactly the shape of thing worth pointing at
 * the whole membership.
 */
export async function sendTestToSelf(db: DB, principal: Principal, opts: { now?: Date; fetchImpl?: typeof fetch } = {}) {
  if (principal.userId == null) throw new PushError('no_user', 'Sign in to send a test notification.');
  return sendToUser(db, {
    userId: principal.userId,
    topic: DIAGNOSTIC_TOPIC,
    title: 'MMAKF notifications are working',
    body: 'This is a test you asked for from your notification settings. No federation message was sent.',
    url: '/my/notifications',
    now: opts.now,
    fetchImpl: opts.fetchImpl,
  });
}

// ─── The bridge from notifications.ts ───────────────────────────────────────

export interface PushFanOutReport {
  considered: number;
  sent: number;
  queued: number;
  failed: number;
  expired: number;
  suppressed: number;
  noDevice: number;
}

/**
 * Carry queued notifications to devices.
 *
 * THIS IS THE WHOLE INTEGRATION, and it is deliberately downstream of
 * notifications.ts rather than beside it. Every row it reads has ALREADY passed
 * that module's allow-list, its audience resolution and its deduplication on
 * the domain event. This function resolves no recipients of its own — a
 * fan-out that resolves its own audience is a second, unaudited copy of the
 * rule about who may be told what, and the two would disagree the first time
 * either changed.
 *
 * Only notifications carrying a `domainEventId` are considered, because the
 * event's type IS the topic, and a topic is what a preference and an
 * essential-ness are attached to. A notification with no domain event is an
 * in-app message by construction and stays one — guessing a topic for it would
 * mean guessing whether the member consented to it.
 */
export async function deliverPushForNotifications(
  db: DB,
  opts: { limit?: number; now?: Date; fetchImpl?: typeof fetch } = {}
): Promise<PushFanOutReport> {
  const limit = opts.limit ?? 100;
  const report: PushFanOutReport = { considered: 0, sent: 0, queued: 0, failed: 0, expired: 0, suppressed: 0, noDevice: 0 };

  const rows = await db
    .select({
      id: s.notifications.id,
      personId: s.notifications.personId,
      userId: s.notifications.userId,
      title: s.notifications.title,
      body: s.notifications.body,
      linkUrl: s.notifications.linkUrl,
      eventType: s.domainEvents.eventType,
    })
    .from(s.notifications)
    .innerJoin(s.domainEvents, eq(s.notifications.domainEventId, s.domainEvents.id))
    .where(and(
      eq(s.notifications.channel, 'in_app'),
      isNotNull(s.notifications.domainEventId),
      // Nothing already handled on the push channel is reconsidered. This is
      // what makes the function safe to run on a schedule and safe to rerun
      // after a crash: a row with any push outcome, including a suppression, is
      // a decision that has been made and recorded.
      sql`not exists (
        select 1 from notification_deliveries d
        where d.notification_id = ${s.notifications.id} and d.channel = 'push'
      )`
    ))
    .orderBy(asc(s.notifications.id))
    .limit(limit);

  for (const row of rows) {
    if (!isNotifiable(row.eventType)) continue;
    report.considered++;

    let userId: number | null = row.userId ?? null;
    if (userId == null && row.personId != null) {
      const user = (await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.personId, row.personId)).limit(1))[0];
      userId = user?.id ?? null;
    }
    if (userId == null) {
      // No account, so no devices and no preferences. The in-app notification
      // still exists and is still the record — this channel simply has nowhere
      // to go, and says so rather than inventing a recipient.
      report.noDevice++;
      continue;
    }

    const result = await sendToUser(db, {
      userId,
      topic: row.eventType,
      notificationId: row.id,
      title: row.title,
      body: row.body,
      url: row.linkUrl,
      now: opts.now,
      fetchImpl: opts.fetchImpl,
    });

    if (result.devices === 0 && result.suppressed === 0) report.noDevice++;
    report.sent += result.sent;
    report.queued += result.queued;
    report.failed += result.failed;
    report.expired += result.expired;
    report.suppressed += result.suppressed;
  }

  if (report.queued > 0) {
    log.warn('push.no_transport', {
      count: report.queued,
      detail: 'Push notifications are queued because VAPID keys are not configured. They are not lost, and will send once they are.',
    });
  }

  return report;
}

/**
 * Retry everything that queued while push was unconfigured.
 *
 * This is the half of "queue rather than drop" that makes the promise true. A
 * backlog that is never retried is a backlog that was dropped slowly.
 */
export async function deliverQueuedPush(
  db: DB,
  opts: { limit?: number; now?: Date; fetchImpl?: typeof fetch } = {}
): Promise<PushFanOutReport> {
  const limit = opts.limit ?? 100;
  const report: PushFanOutReport = { considered: 0, sent: 0, queued: 0, failed: 0, expired: 0, suppressed: 0, noDevice: 0 };

  const status = pushStatus();
  if (!status.configured) {
    // Nothing is retried and nothing is marked failed. The backlog is intact
    // and the reason is reported, which is the only honest answer here.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.notificationDeliveries)
      .where(and(eq(s.notificationDeliveries.channel, 'push'), eq(s.notificationDeliveries.outcome, 'queued')));
    report.queued = n;
    return report;
  }

  const pending = await db
    .select()
    .from(s.notificationDeliveries)
    .where(and(eq(s.notificationDeliveries.channel, 'push'), eq(s.notificationDeliveries.outcome, 'queued')))
    .orderBy(asc(s.notificationDeliveries.id))
    .limit(limit);

  const vapid = vapidConfig()!;
  const now = opts.now ?? new Date();

  for (const pendingRow of pending) {
    report.considered++;

    const device = pendingRow.pushDeviceId
      ? (await db.select().from(s.pushDevices).where(eq(s.pushDevices.id, pendingRow.pushDeviceId)).limit(1))[0]
      : null;

    if (!device || device.status !== 'active') {
      await db
        .update(s.notificationDeliveries)
        .set({ outcome: 'expired', detail: 'The device was withdrawn or pruned before the backlog could be delivered.', attemptedAt: now })
        .where(eq(s.notificationDeliveries.id, pendingRow.id));
      report.expired++;
      continue;
    }

    const notification = pendingRow.notificationId
      ? (await db.select().from(s.notifications).where(eq(s.notifications.id, pendingRow.notificationId)).limit(1))[0]
      : null;
    if (!notification) {
      await db
        .update(s.notificationDeliveries)
        .set({ outcome: 'expired', detail: 'The notification this delivery belonged to no longer exists.', attemptedAt: now })
        .where(eq(s.notificationDeliveries.id, pendingRow.id));
      report.expired++;
      continue;
    }

    const attempt = await deliverToDevice(
      db, device,
      { title: notification.title, body: notification.body, url: notification.linkUrl },
      { topic: pendingRow.topic ?? 'MEMBERSHIP_EXPIRING', vapid, now, fetchImpl: opts.fetchImpl }
    );

    await db
      .update(s.notificationDeliveries)
      .set({ outcome: attempt.outcome, detail: attempt.detail, attemptedAt: now })
      .where(eq(s.notificationDeliveries.id, pendingRow.id));

    if (attempt.outcome === 'sent') report.sent++;
    else if (attempt.outcome === 'expired') report.expired++;
    else report.failed++;
  }

  return report;
}

// ─── The operator's view ────────────────────────────────────────────────────

/**
 * What the push channel is doing, for somebody who has to answer "why was this
 * member not told?".
 *
 * The suppression counts are the point. A healthy system with a large
 * `suppressed_preference` count is members exercising a choice; a large
 * `queued` count is a provider nobody configured; a large `expired` count is
 * normal churn. Those three look identical if suppression is not recorded.
 */
export async function pushHealth(db: DB, principal: Principal) {
  assertCanAnywhere(principal, 'content:read');

  const outcomes = await db
    .select({ outcome: s.notificationDeliveries.outcome, n: sql<number>`count(*)::int` })
    .from(s.notificationDeliveries)
    .where(eq(s.notificationDeliveries.channel, 'push'))
    .groupBy(s.notificationDeliveries.outcome);

  const devices = await db
    .select({ status: s.pushDevices.status, n: sql<number>`count(*)::int` })
    .from(s.pushDevices)
    .groupBy(s.pushDevices.status);

  // Coarse only, and it is the whole of what this system knows about where its
  // members are. There is nothing finer to report because there is nothing
  // finer stored.
  const regions = await db
    .select({ country: s.pushDevices.regionCountry, n: sql<number>`count(*)::int` })
    .from(s.pushDevices)
    .groupBy(s.pushDevices.regionCountry);

  const oldestQueued = (
    await db
      .select({ at: s.notificationDeliveries.attemptedAt })
      .from(s.notificationDeliveries)
      .where(and(eq(s.notificationDeliveries.channel, 'push'), eq(s.notificationDeliveries.outcome, 'queued')))
      .orderBy(asc(s.notificationDeliveries.id))
      .limit(1)
  )[0];

  return {
    transport: pushStatus(),
    outcomes,
    devices,
    regions,
    oldestQueued: oldestQueued?.at ?? null,
  };
}
