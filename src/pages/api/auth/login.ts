// Admin login endpoint.

import type { APIRoute } from 'astro';
import { checkPassword, createSessionCookie } from '@/lib/auth';

import { rateLimit, tooManyRequests } from '@/lib/ratelimit';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'admin-login', 5, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  // NFR-SEC-2: dev defaults must not function in production.
  if (import.meta.env.PROD && (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_SESSION_SECRET)) {
    console.error('ADMIN_PASSWORD / ADMIN_SESSION_SECRET not configured — refusing logins');
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
  }
  if (!checkPassword(body?.password || '')) {
    // simple rate-limit: artificial delay
    await new Promise((r) => setTimeout(r, 400));
    return new Response(JSON.stringify({ error: 'Invalid password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': createSessionCookie(),
    },
  });
};
