import type { APIRoute } from 'astro';
import { pushToList } from '@/lib/storage';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';

export const prerender = false;

const MAX_BODY = 8 * 1024; // 8 KB is ample for this form

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'enroll', 10, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) {
      return new Response(JSON.stringify({ error: 'Request too large' }), { status: 413 });
    }
    body = JSON.parse(raw);
  }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
  }

  const lead = {
    id: Date.now(),
    name: str(body?.name, 120),
    phone: str(body?.phone, 32),
    program: str(body?.program, 120),
    ts: new Date().toISOString(),
  };
  if (!lead.name || !lead.phone) {
    return new Response(JSON.stringify({ error: 'Name & phone required' }), { status: 400 });
  }

  await pushToList('leads', lead, 500);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

/** Accept only genuine strings; reject objects/arrays coerced to junk. */
function str(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}
