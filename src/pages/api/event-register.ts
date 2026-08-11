// Public endpoint: event/tournament entry registration.
//
// Issues an opaque entry reference; entries are stored privately (`eventRegs`,
// never in KEYS) and processed by the office in the admin panel.
//
// Hardened (Phase 2): rate limited, body-size capped, strict string typing,
// atomic append, unguessable reference, and server-side validation that the
// named event actually exists and is still open (P1: registration must never
// be validated frontend-only).

import type { APIRoute } from 'astro';
import { get, pushToList } from '@/lib/storage';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { reference, accessToken } from '@/lib/refs';
import { upcomingEvents } from '@/lib/events';

export const prerender = false;

const MAX_BODY = 16 * 1024;

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'event-register', 10, 60);
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

  const entry = {
    event: str(body.event, 160),
    name: str(body.name, 120),
    phone: str(body.phone, 32),
    unit: str(body.unit, 120),
  };
  if (!entry.event || !entry.name || !entry.phone) {
    return new Response(JSON.stringify({ error: 'Event, name and phone are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Server-side eligibility: the event must exist and still be upcoming.
  const open = upcomingEvents((await get<any[]>('events')) || []);
  if (!open.some((e: any) => String(e?.t) === entry.event)) {
    return new Response(
      JSON.stringify({ error: 'That event is not open for entries.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const ref = reference('E');
  const record = {
    id: Date.now(),
    ref,
    token: accessToken(),
    ...entry,
    ts: new Date().toISOString(),
    status: 'Received',
  };

  await pushToList('eventRegs', record, 1000);

  return new Response(JSON.stringify({ ok: true, ref }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
