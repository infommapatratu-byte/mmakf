// Public endpoint: verify a federation member ID against the members register.
// Returns register data only (no contact details) — the bonafide check for
// employers, tournament organisers and parents.

import type { APIRoute } from 'astro';
import { get } from '@/lib/storage';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const q = (url.searchParams.get('id') || '').trim().toUpperCase();
  if (!q || q.length > 40) {
    return new Response(JSON.stringify({ found: false, error: 'Provide a member ID' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const members = (await get<any[]>('members')) || [];
  const m = members.find((x: any) => String(x.id || '').trim().toUpperCase() === q);

  return new Response(
    JSON.stringify(
      m
        ? { found: true, member: { id: m.id, name: m.name, type: m.type, grade: m.grade, state: m.state, unit: m.unit, status: m.status, validTill: m.validTill } }
        : { found: false }
    ),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
};
