// Storage layer for MMAKF.
// Production: Upstash Redis (via Vercel marketplace integration).
// Local dev: in-memory fallback — resets on restart.
// Used by both public pages (read) and admin (read/write).
//
// Env var compatibility: prefers UPSTASH_REDIS_REST_* (Upstash native names);
// falls back to KV_REST_API_* (legacy Vercel KV names — Upstash also provisions these).

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

// ─── Public API ───
export async function get<T = any>(key: DataKey | string): Promise<T> {
  const redis = await getRedis();
  const fallback = (SEED as any)[key];
  if (redis) {
    try {
      const v = await redis.get(`mmakf:${key}`);
      return (v ?? fallback) as T;
    } catch (e) {
      console.warn('Redis read failed for', key, e);
      return fallback as T;
    }
  }
  return localGet(`mmakf:${key}`, fallback) as T;
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

// Fetch all content keys at once
export async function getAll(): Promise<Record<string, any>> {
  const result: Record<string, any> = {};
  for (const k of KEYS) {
    result[k] = await get(k);
  }
  return result;
}
