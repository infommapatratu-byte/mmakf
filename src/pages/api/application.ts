// Application status lookup.
//
// Closes a dead mechanism: every application minted a 24-byte access token,
// stored it, and nothing ever read it. Applicants received a reference number
// they could do nothing with, and the only way to learn an outcome was to
// telephone the office.
//
// Authorisation is the pair (reference, token). The reference alone is not
// enough — references are sequential-looking and get quoted in messages — so a
// leaked reference discloses nothing without the token that came with it.

import type { APIRoute } from 'astro';
import { getList } from '@/lib/storage';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import crypto from 'node:crypto';

export const prerender = false;

/** Constant-time compare, so timing cannot be used to guess a token. */
function tokenMatches(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const NOT_FOUND = JSON.stringify({
  error: 'No application matches that reference and access code.',
});

export const GET: APIRoute = async ({ request, url }) => {
  const rl = await rateLimit(request, 'application-status', 20, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const ref = (url.searchParams.get('ref') || '').trim().toUpperCase();
  const token = (url.searchParams.get('token') || '').trim();

  if (!ref || !token) {
    return new Response(JSON.stringify({ error: 'A reference and access code are both required.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  // Both application kinds share the reference format, so look in each.
  for (const key of ['registrations', 'eventEntries'] as const) {
    const list = (await getList<any>(key, 5000)) || [];
    const found = list.find((r: any) => String(r?.appNo || '').toUpperCase() === ref);
    if (!found) continue;
    if (!tokenMatches(found.token, token)) break;   // wrong code — same answer

    // Only what the applicant themselves submitted, plus the outcome. No
    // internal notes, no reviewer identity, no other applicant's data.
    return new Response(
      JSON.stringify({
        ok: true,
        reference: found.appNo,
        submittedOn: found.ts ?? null,
        status: found.status ?? 'Received',
        decidedOn: found.decidedOn ?? null,
        // Shown only when the office has recorded a reason to share.
        note: found.applicantNote ?? null,
        type: found.type ?? found.event ?? null,
        name: found.name ?? null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    );
  }

  // Identical response for "no such reference" and "wrong code", so the
  // endpoint cannot be used to discover which references exist.
  return new Response(NOT_FOUND, {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
