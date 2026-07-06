// Unit portal: submit a report to the national office. Requires a unit
// session; the record is stamped with the unit's identity server-side so a
// unit can only ever submit as itself. Submissions are private (never in
// public KEYS) and reviewed in the national admin panel.

import type { APIRoute } from 'astro';
import { get, set } from '@/lib/storage';
import { getUnitSession } from '@/lib/auth';

export const prerender = false;

const KINDS = ['Result report', 'News report', 'Event proposal', 'Grading report'];

export const POST: APIRoute = async ({ request }) => {
  const session = getUnitSession(request.headers.get('cookie'));
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const kind = String(body?.kind || '');
  const title = String(body?.title || '').slice(0, 160);
  const detail = String(body?.detail || '').slice(0, 2000);
  if (!KINDS.includes(kind) || !title) {
    return new Response(JSON.stringify({ error: 'A valid kind and a title are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const record = {
    id: Date.now(),
    ts: new Date().toISOString(),
    unit: session.name,
    level: session.level,
    state: session.state,
    kind, title, detail,
    status: 'Pending',
  };

  const list = (await get<any[]>('submissions')) || [];
  list.unshift(record);
  await set('submissions', list.slice(0, 500));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
