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

  const key = params.key as string;
  if (!KEYS.includes(key as any)) {
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
