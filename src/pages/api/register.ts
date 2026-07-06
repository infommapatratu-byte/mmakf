// Public endpoint: membership registration application.
// Issues an application number; the federation office reviews applications in
// the admin panel and, on approval, adds the member to the public register
// (which then powers /api/verify). Applications are private — never exposed
// through /api/data (the `registrations` key is not in KEYS).

import type { APIRoute } from 'astro';
import { get, set } from '@/lib/storage';

export const prerender = false;

const TYPES = ['Athlete', 'Instructor', 'Dojo / Club', 'Official'];

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const app = {
    name:     String(body?.name || '').slice(0, 120),
    phone:    String(body?.phone || '').slice(0, 32),
    type:     String(body?.type || '').slice(0, 40),
    state:    String(body?.state || '').slice(0, 60),
    district: String(body?.district || '').slice(0, 60),
    grade:    String(body?.grade || '').slice(0, 60),
  };
  if (!app.name || !app.phone || !TYPES.includes(app.type)) {
    return new Response(JSON.stringify({ error: 'Name, phone and a valid membership type are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ts = Date.now();
  const appNo = `MMAKF-R-${new Date(ts).getFullYear()}-${String(ts).slice(-6)}`;
  const record = { id: ts, appNo, ...app, ts: new Date(ts).toISOString(), status: 'Received' };

  const list = (await get<any[]>('registrations')) || [];
  list.unshift(record);
  await set('registrations', list.slice(0, 2000));

  return new Response(JSON.stringify({ ok: true, appNo }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
