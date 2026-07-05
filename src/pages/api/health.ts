// Health probe (MASTER-SPEC §8.6). Used by uptime monitoring and deploy
// verification. Always returns 200 — monitors alert on the payload.

import type { APIRoute } from 'astro';
import { redisHealthy } from '@/lib/storage';

export const prerender = false;

export const GET: APIRoute = async () => {
  const redis = await redisHealthy();
  return new Response(
    JSON.stringify({
      ok: true,
      redis,
      version: process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    }
  );
};
