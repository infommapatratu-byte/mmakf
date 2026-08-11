// Public endpoint: event/tournament entry registration. Issues an entry
// reference number; entries are stored privately (key `eventRegs`, never in
// public KEYS) and processed by the office in the admin panel.

import type { APIRoute } from 'astro';
import { get, set } from '@/lib/storage';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const entry = {
    event: String(body?.event || '').slice(0, 160),
    name:  String(body?.name || '').slice(0, 120),
    phone: String(body?.phone || '').slice(0, 32),
    unit:  String(body?.unit || '').slice(0, 120),   // dojo / club / unit (optional)
  };
  if (!entry.event || !entry.name || !entry.phone) {
    return new Response(JSON.stringify({ error: 'Event, name and phone are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ts = Date.now();
  const ref = `MMAKF-E-${new Date(ts).getFullYear()}-${String(ts).slice(-6)}`;
  const record = { id: ts, ref, ...entry, ts: new Date(ts).toISOString(), status: 'Received' };

  const list = (await get<any[]>('eventRegs')) || [];
  list.unshift(record);
  await set('eventRegs', list.slice(0, 1000));

  return new Response(JSON.stringify({ ok: true, ref }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
