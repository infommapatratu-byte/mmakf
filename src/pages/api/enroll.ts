import type { APIRoute } from 'astro';
import { get, set } from '@/lib/storage';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const lead = {
    id: Date.now(),
    name: String(body?.name || '').slice(0, 120),
    phone: String(body?.phone || '').slice(0, 32),
    program: String(body?.program || '').slice(0, 120),
    ts: new Date().toISOString(),
  };
  if (!lead.name || !lead.phone) {
    return new Response(JSON.stringify({ error: 'Name & phone required' }), { status: 400 });
  }

  const list = (await get<any[]>('leads')) || [];
  list.unshift(lead);
  await set('leads', list.slice(0, 500));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
