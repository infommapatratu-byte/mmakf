// Unit portal login: a state/district/club unit signs in with the access
// code issued by the national admin (Unit Access panel). Codes live in the
// admin-only `unitAccess` key; disabled codes cannot sign in.

import type { APIRoute } from 'astro';
import { get } from '@/lib/storage';
import { createUnitSessionCookie } from '@/lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 }); }

  const code = String(body?.code || '').trim();
  const units = (await get<any[]>('unitAccess')) || [];
  const unit = code && units.find((u: any) => String(u.code || '').trim() === code && u.status === 'Active');

  if (!unit) {
    await new Promise((r) => setTimeout(r, 400)); // brute-force damping
    return new Response(JSON.stringify({ error: 'Invalid or disabled access code' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, name: unit.name, level: unit.level, state: unit.state }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': createUnitSessionCookie({ name: unit.name, level: unit.level, state: unit.state }),
    },
  });
};
