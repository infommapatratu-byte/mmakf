// Storage layer for MMAKF.
// Production: Upstash Redis (via Vercel marketplace integration).
// Local dev: in-memory fallback — resets on restart.
// Used by both public pages (read) and admin (read/write).
//
// Env var compatibility: prefers UPSTASH_REDIS_REST_* (Upstash native names);
// falls back to KV_REST_API_* (legacy Vercel KV names — Upstash also provisions these).
//
// Architectural invariant (MASTER-SPEC §5.1): no other module talks to Redis.

import { SEED, KEYS, type DataKey } from '../data/seed';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN);

let redisClient: any = null;
async function getRedis() {
  if (!HAS_REDIS) return null;
  if (redisClient) return redisClient;
  try {
    const { Redis } = await import('@upstash/redis');
    redisClient = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
    return redisClient;
  } catch (e) {
    console.warn('Upstash Redis import failed — falling back to local storage', e);
    return null;
  }
}

// ─── Local dev fallback (in-memory) ───
const LOCAL = new Map<string, any>();
function localGet<T>(key: string, fallback: T): T {
  return LOCAL.has(key) ? LOCAL.get(key) : fallback;
}
function localSet(key: string, value: any) {
  LOCAL.set(key, value);
}

// MASTER-SPEC F1 defensive rendering: a stored value whose broad shape
// disagrees with the seed's (array vs object) falls back to seed so a
// malformed admin save can never crash a public page.
function guardShape<T>(key: string, value: T, fallback: T): T {
  if (value == null) return fallback;
  if (Array.isArray(fallback) && !Array.isArray(value)) {
    console.warn(`Stored value for ${key} is not an array — serving seed`);
    return fallback;
  }
  if (
    fallback !== null &&
    typeof fallback === 'object' &&
    !Array.isArray(fallback) &&
    (typeof value !== 'object' || Array.isArray(value))
  ) {
    console.warn(`Stored value for ${key} is not an object — serving seed`);
    return fallback;
  }
  return value;
}

// ─── Public API ───
export async function get<T = any>(key: DataKey | string): Promise<T> {
  const redis = await getRedis();
  const fallback = (SEED as any)[key];
  if (redis) {
    try {
      const v = await redis.get(`mmakf:${key}`);
      return guardShape(key as string, (v ?? fallback) as T, fallback as T);
    } catch (e) {
      console.warn('Redis read failed for', key, e);
      return fallback as T;
    }
  }
  return guardShape(key as string, localGet(`mmakf:${key}`, fallback) as T, fallback as T);
}

export async function set(key: DataKey | string, value: any): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      await redis.set(`mmakf:${key}`, value);
      return;
    } catch (e) {
      console.warn('Redis write failed for', key, e);
    }
  }
  localSet(`mmakf:${key}`, value);
}

// Fetch all public content keys in one round-trip (NFR-PERF-4: single MGET
// instead of 16 sequential GETs). Never includes `leads`.
export async function getAll(): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  const redis = await getRedis();

  if (redis) {
    try {
      const values: any[] = await redis.mget(...KEYS.map((k) => `mmakf:${k}`));
      KEYS.forEach((k, i) => {
        const fallback = (SEED as any)[k];
        result[k] = guardShape(k, values[i] ?? fallback, fallback);
      });
      return result;
    } catch (e) {
      console.warn('Redis MGET failed — falling back to per-key reads', e);
    }
  }

  for (const k of KEYS) {
    result[k] = await get(k);
  }
  return result;
}

// Health probe for /api/health: true only when Redis is configured AND
// answering. Never throws.
export async function redisHealthy(): Promise<boolean> {
  if (!HAS_REDIS) return false;
  try {
    const redis = await getRedis();
    if (!redis) return false;
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}
