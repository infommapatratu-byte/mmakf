// Payment provider webhook.
//
// This is the ONLY authoritative confirmation that money was taken. The browser
// redirect after checkout is a convenience; the customer controls it and it
// proves nothing.
//
// Exempt from the middleware origin check (server-to-server requests carry no
// Origin) and authenticated by SIGNATURE instead. The raw body is read verbatim
// and never re-serialised — re-encoding JSON changes the bytes, so the
// signature stops matching. That is the usual reason webhooks begin "randomly"
// failing after a refactor.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { recordWebhook, markWebhookProcessed, confirmPayment } from '@/db/orders';
import { providerById } from '@/lib/payments';

export const prerender = false;

// 200 for anything we have durably recorded, so the provider stops retrying.
// Anything we could not record returns 5xx, where a retry is actually useful.
const OK = () =>
  new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Cheap non-cryptographic hash, only to key an invalid-signature record. */
function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

export const POST: APIRoute = async ({ request, url }) => {
  const providerId = url.searchParams.get('provider') || 'razorpay';
  const provider = providerById(providerId);
  if (!provider || !isConfigured()) {
    return new Response(JSON.stringify({ error: 'Not available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = provider.verifyWebhook(rawBody, headers);

  if (!result.valid) {
    // Recorded, not discarded: repeated bad signatures are worth seeing, and
    // silently dropping them hides a misconfigured secret.
    try {
      await recordWebhook(db(), {
        provider: providerId,
        eventId: `invalid:${Date.now()}:${Math.abs(hash(rawBody))}`,
        eventType: 'invalid_signature',
        signatureValid: false,
        payload: { bodyLength: rawBody.length },
      });
    } catch {
      // Recording a rejection must never mask the rejection itself.
    }
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const recorded = await recordWebhook(db(), {
    provider: providerId,
    eventId: result.eventId,
    eventType: result.eventType,
    signatureValid: true,
    payload: result.raw,
  });

  // Already seen: the provider is retrying. Acknowledge and do nothing —
  // fulfilling twice is worse than fulfilling late.
  if (!recorded.fresh) return OK();

  try {
    if (result.payment) {
      await confirmPayment(
        db(),
        {
          principal: { userId: null, label: `webhook:${providerId}`, bindings: [] },
          authority: providerId,
        },
        result.payment
      );
    }
    await markWebhookProcessed(db(), recorded.id!);
  } catch (err: any) {
    // The event is on record together with its error, so a human can reconcile
    // it. Still 200: a retry would hit the replay guard and change nothing.
    console.error('[webhook] processing failed', err?.message);
    await markWebhookProcessed(db(), recorded.id!, String(err?.message ?? err).slice(0, 500));
  }

  return OK();
};
