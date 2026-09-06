// Web push, exposed over HTTP.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WAS MISSING, AND WHY IT WAS NOT THE HARD PART
// ─────────────────────────────────────────────────────────────────────────────
//
// src/lib/push.ts is a complete implementation of RFC 8291 (message encryption)
// and RFC 8292 (VAPID), with subscribe(), unsubscribe(), myDevices(),
// myPreferences(), setPreference(), sendTestToSelf() and pushHealth() all
// written, tested, and authorised by construction — every one of them resolves
// the subject from the caller's own session and takes no user id.
//
// TWO THINGS IMPORTED FROM IT. `pushStatus()` on /admin/notifications, and
// `deliverQueuedPush()` on the reconcile cron. That is all. So the federation
// had a push transport that could deliver to nobody, because nothing anywhere
// let a member register a device.
//
// This route is the missing half, and it is deliberately thin: every action is
// ONE call into the module. No authorisation decision, no preference logic, no
// topic list is restated here — a second copy of any of those is the copy that
// goes stale the day a topic is added.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS ONE HAS NO no-JavaScript PATH, WHEN THE REST OF THE SITE DOES
// ─────────────────────────────────────────────────────────────────────────────
//
// Everywhere else in this codebase a form posts to its page so it works with
// scripting off — see the note at the top of /admin/guardianships. Push cannot
// follow that rule and it is not an oversight: a subscription is created by
// `navigator.serviceWorker` and `PushManager.subscribe()`, which produce the
// endpoint and the two keys this endpoint stores. There is no subscription to
// register without JavaScript, so a no-JS fallback would be a form that could
// only ever submit nothing.
//
// PREFERENCES ARE DIFFERENT and are NOT confined here. They govern the in-app
// and email channels too, which work with scripting off, so /my/devices posts
// them to itself as an ordinary form. This route carries them as well for the
// scripted path; both call the same setPreference().
//
// ─────────────────────────────────────────────────────────────────────────────
// CSRF AND CONTENT TYPE ARE THE MIDDLEWARE'S
// ─────────────────────────────────────────────────────────────────────────────
//
// src/middleware.ts refuses a cross-origin mutating request and refuses a JSON
// endpoint that was not sent `application/json`. Repeating either here would be
// a second copy of a rule that already holds.

import type { APIRoute } from 'astro';
import { identify } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import {
  subscribe, unsubscribe, myDevices, myPreferences, setPreference,
  sendTestToSelf, pushStatus, vapidPublicKey, isEssentialTopic,
  DEFAULT_CHANNEL_PUSH,
} from '@/lib/push';
import { NOTIFIABLE } from '@/lib/notifications';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    // Devices and preferences are personal. Never a shared-cache document.
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' },
  });
}

function notConfigured() {
  return json({
    error: 'The federation database is not configured on this deployment, so there is nowhere to record a device.',
    code: 'not_configured',
  }, 503);
}

/**
 * PushError.code -> HTTP status.
 *
 * `essential_topic` is 409 and not 403: the caller is permitted to change their
 * preferences, and it is the STATE of this particular topic that refuses — a
 * different thing for a client deciding whether to show "you may not" or "this
 * one cannot be switched off".
 */
const STATUS_BY_CODE: Record<string, number> = {
  no_user: 401,
  unknown_topic: 404,
  essential_topic: 409,
  bad_key: 400,
  bad_endpoint: 400,
  bad_hour: 400,
  not_configured: 503,
};

const READ_ACTIONS = ['config', 'devices', 'preferences'] as const;
const WRITE_ACTIONS = ['subscribe', 'unsubscribe', 'preference', 'test'] as const;

/**
 * The topics a member may express a preference about, with the two facts the
 * settings page needs and must not invent: the human title, and whether it can
 * be switched off at all.
 *
 * Derived from NOTIFIABLE rather than listed again. A hand-kept copy would
 * disagree with the engine the day a topic is added, and the disagreement shows
 * up as a member turning something off in a screen that has no effect.
 */
function topicCatalogue() {
  return Object.entries(NOTIFIABLE).map(([topic, spec]: [string, any]) => ({
    topic,
    title: spec.title as string,
    essential: isEssentialTopic(topic),
  }));
}

export const GET: APIRoute = async ({ request, params }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');

  const rl = await rateLimit(request, `push-read-${action || 'unknown'}`, 120, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!(READ_ACTIONS as readonly string[]).includes(action)) {
    return json({ error: 'Unknown push read', code: 'unknown_action', actions: READ_ACTIONS }, 404);
  }

  // `config` answers before the session is resolved, and before the database is
  // consulted, because it is what a page asks FIRST to decide whether to offer
  // the control at all. It contains nothing personal: the VAPID public key is
  // broadcast to every subscriber by design.
  if (action === 'config') {
    const status = pushStatus();
    return json({
      ok: true,
      configured: status.configured,
      // The reason is carried through verbatim. It names the unset variables,
      // which is what an operator reading a browser console needs.
      reason: status.reason,
      vapidPublicKey: vapidPublicKey(),
      defaultChannelPush: DEFAULT_CHANNEL_PUSH,
      topics: topicCatalogue(),
    }, 200);
  }

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to read your notification devices', code: 'unauthenticated' }, 401);
  if (!isConfigured()) return notConfigured();

  try {
    if (action === 'devices') {
      // Takes no id. Reading somebody else's devices is not expressible.
      return json({ ok: true, devices: await myDevices(db(), identity.principal) }, 200);
    }
    return json({ ok: true, preferences: await myPreferences(db(), identity.principal) }, 200);
  } catch (err: any) {
    const code = err?.code as string | undefined;
    if (code && STATUS_BY_CODE[code]) return json({ error: err.message, code }, STATUS_BY_CODE[code]);
    console.error('[api/push] read failed', err);
    return json({ error: 'That could not be read.', code: 'internal' }, 500);
  }
};

export const POST: APIRoute = async ({ request, params }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');

  // A subscription changes when a browser rotates its endpoint, which is rare;
  // a preference changes as fast as somebody can click a checkbox. One limit
  // covers both at the speed of the faster.
  const rl = await rateLimit(request, `push-${(WRITE_ACTIONS as readonly string[]).includes(action) ? action : 'unknown'}`, 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!(WRITE_ACTIONS as readonly string[]).includes(action)) {
    return json({ error: 'Unknown push action', code: 'unknown_action', actions: WRITE_ACTIONS }, 404);
  }

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to change your notification devices', code: 'unauthenticated' }, 401);
  if (!isConfigured()) return notConfigured();

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    // An endpoint plus two keys is well under a kilobyte. The cap is generous
    // and still bounds a request that could otherwise hold the connection open.
    if (raw.length > 8192) return json({ error: 'Request too large', code: 'too_large' }, 413);
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'Invalid request', code: 'bad_json' }, 400);
  }

  const text = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');

  try {
    switch (action) {
      case 'subscribe': {
        // Every field is validated inside subscribe() — the endpoint's shape,
        // the elliptic-curve point, the 16-byte auth secret. Checking any of
        // them here would be a second opinion about what a valid subscription
        // is, and the module's is the one the sender relies on.
        const device = await subscribe(db(), identity.principal, {
          endpoint: text('endpoint'),
          p256dh: text('p256dh'),
          auth: text('auth'),
          userAgent: text('userAgent') || request.headers.get('user-agent') || undefined,
          // Coarse placement, from the edge, never from the client. A browser
          // saying which country it is in is a browser, not evidence.
          regionCountry: request.headers.get('x-vercel-ip-country') ?? undefined,
          regionName: request.headers.get('x-vercel-ip-country-region') ?? undefined,
          timezone: text('timezone') || undefined,
        } as any);
        return json({ ok: true, device }, 200);
      }

      case 'unsubscribe': {
        // Answers the same whether the row is missing or belongs to somebody
        // else — see the note in unsubscribe(). This route must not turn that
        // into an oracle by reporting the difference.
        const result = await unsubscribe(db(), identity.principal, text('endpoint'));
        return json({ ok: true, ...result }, 200);
      }

      case 'preference': {
        const bool = (k: string) => (typeof body[k] === 'boolean' ? (body[k] as boolean) : undefined);
        const hour = (k: string) => (body[k] === null ? null : body[k] === undefined ? undefined : Number(body[k]));
        const pref = await setPreference(db(), identity.principal, {
          topic: text('topic'),
          channelInApp: bool('channelInApp'),
          channelEmail: bool('channelEmail'),
          channelPush: bool('channelPush'),
          channelSms: bool('channelSms'),
          quietFromHour: hour('quietFromHour'),
          quietToHour: hour('quietToHour'),
          timezone: body.timezone === null ? null : (text('timezone') || undefined),
        });
        return json({ ok: true, preference: pref }, 200);
      }

      default: {
        // A test the member fires at their own devices. sendTestToSelf()
        // resolves the recipient from the session, so it cannot be addressed to
        // anybody else, and it deliberately bypasses preferences and quiet
        // hours: a test that is silently suppressed looks exactly like a broken
        // one and the member switches the feature off.
        const report = await sendTestToSelf(db(), identity.principal);
        return json({ ok: true, report }, 200);
      }
    }
  } catch (err: any) {
    const code = err?.code as string | undefined;
    if (code && STATUS_BY_CODE[code]) return json({ error: err.message, code }, STATUS_BY_CODE[code]);
    // A PushError this file has no mapping for is still the module's own
    // sentence, written for this reader. Passing it through as a 400 beats
    // replacing it with "invalid".
    if (err?.name === 'PushError') return json({ error: err.message, code: code ?? 'push_error' }, 400);
    console.error('[api/push] action failed', err);
    return json({ error: 'Nothing was changed.', code: 'internal' }, 500);
  }
};
