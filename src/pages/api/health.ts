// Health probe (MASTER-SPEC §8.6). Used by uptime monitoring and deploy
// verification. Always returns 200 — monitors alert on the payload.

import type { APIRoute } from 'astro';
import { redisHealthy } from '@/lib/storage';
import { isConfigured, databaseHealthy } from '@/db';

export const prerender = false;

export const GET: APIRoute = async () => {
  const [redis, database] = await Promise.all([
    redisHealthy(),
    // Report the federation database honestly (§70): 'not_configured' is a real
    // state, not a failure, and must never be reported as healthy.
    isConfigured() ? databaseHealthy().then((h) => (h ? 'ok' : 'error')) : Promise.resolve('not_configured'),
  ]);

  return new Response(
    JSON.stringify({
      ok: true,
      redis,
      database,
      version: process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }
  );
};
