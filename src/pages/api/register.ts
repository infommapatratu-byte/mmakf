// Public endpoint: membership registration application.
//
// Issues an opaque application reference; the federation office reviews
// applications in the admin panel and, on approval, adds the member to the
// public register (which powers /api/verify). Applications are PRIVATE — the
// `registrations` key is not in KEYS and is never served by /api/data.
//
// Hardened (Phase 2): rate limited, body-size capped, strict string typing,
// atomic append (no read-modify-write race), unguessable reference.

import type { APIRoute } from 'astro';
import { pushToList } from '@/lib/storage';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { reference, accessToken } from '@/lib/refs';

export const prerender = false;

const TYPES = ['Athlete', 'Instructor', 'Dojo / Club', 'Official'];
const MAX_BODY = 16 * 1024;

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'register', 10, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) {
      return new Response(JSON.stringify({ error: 'Request too large' }), { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
  }

  const app = {
    name: str(body.name, 120),
    phone: str(body.phone, 32),
    type: str(body.type, 40),
    state: str(body.state, 60),
    district: str(body.district, 60),
    grade: str(body.grade, 60),
  };
  if (!app.name || !app.phone || !TYPES.includes(app.type)) {
    return new Response(
      JSON.stringify({ error: 'Name, phone and a valid membership type are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const appNo = reference('R');
  const record = {
    id: Date.now(),
    appNo,
    token: accessToken(),
    ...app,
    ts: new Date().toISOString(),
    status: 'Received',
  };

  await pushToList('registrations', record, 2000);

  return new Response(JSON.stringify({ ok: true, appNo }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
