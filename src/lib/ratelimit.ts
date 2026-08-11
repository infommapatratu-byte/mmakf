// Fixed-window rate limiting for public endpoints (P1-2).
//
// Uses Redis INCR + EXPIRE, which is atomic per key, so it works correctly
// across concurrent Vercel lambda instances. Falls back to an in-process map
// when Redis is unavailable (local dev) — degraded but never fails a request.
//
// Client identity is the Vercel-provided client IP, hashed so raw addresses are
// never persisted (DPDP minimisation).

import crypto from 'node:crypto';

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const LOCAL = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: Request): string {
  const h = request.headers;
  const ip =
    h.get('x-vercel-forwarded-for') ||
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip') ||
    'unknown';
  return crypto.createHash('sha256').update(ip).digest('base64url').slice(0, 22);
}

async function redis(): Promise<any | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
  if (!url || !token) return null;
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

/**
 * Allow `limit` requests per `windowSeconds` for this bucket + client.
 * Never throws: on any infrastructure error the request is allowed through
 * (availability over strictness for a public federation site).
 */
export async function rateLimit(
  request: Request,
  bucket: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const id = clientKey(request);
  const window = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `mmakf:rl:${bucket}:${id}:${window}`;

  const r = await redis();
  if (r) {
    try {
      const count: number = await r.incr(key);
      if (count === 1) await r.expire(key, windowSeconds);
      const remaining = Math.max(0, limit - count);
      return {
        ok: count <= limit,
        remaining,
        retryAfterSeconds: windowSeconds - Math.floor((Date.now() / 1000) % windowSeconds),
      };
    } catch {
      return { ok: true, remaining: limit, retryAfterSeconds: 0 };
    }
  }

  // Local fallback
  const now = Date.now();
  const entry = LOCAL.get(key);
  if (!entry || entry.resetAt < now) {
    LOCAL.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    if (LOCAL.size > 5000) LOCAL.clear();
    return { ok: true, remaining: limit - 1, retryAfterSeconds: windowSeconds };
  }
  entry.count += 1;
  return {
    ok: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
  };
}

/** Standard 429 response. */
export function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error: 'Too many requests. Please try again shortly.' }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(1, retryAfterSeconds)),
      },
    }
  );
}
