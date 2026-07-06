// Admin endpoint: write a single content key. Requires session cookie.

import type { APIRoute } from 'astro';
import { set } from '@/lib/storage';
import { isAuthenticated } from '@/lib/auth';
import { KEYS } from '@/data/seed';

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  if (!isAuthenticated(request.headers.get('cookie'))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Keys writable only through the authenticated admin panel and never
  // exposed via the public GET /api/data (they are not in KEYS).
  const ADMIN_ONLY_KEYS = ['unitAccess'];

  const key = params.key as string;
  if (!KEYS.includes(key as any) && !ADMIN_ONLY_KEYS.includes(key)) {
    return new Response(JSON.stringify({ error: 'Invalid key' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  await set(key, body);
  return new Response(JSON.stringify({ ok: true, key }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
