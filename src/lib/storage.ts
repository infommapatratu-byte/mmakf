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

/**
 * Atomically prepend a record to a capped private list (P1-3).
 *
 * The previous pattern — get() → unshift() → set() — is a read-modify-write
 * that loses records when concurrent lambda instances interleave. Redis LPUSH
 * + LTRIM is atomic, so every submission survives.
 *
 * Lists written this way are stored as native Redis lists under
 * `mmakf:list:{key}`. `getList()` reads them and transparently falls back to a
 * legacy JSON blob at `mmakf:{key}` (records written before this change), so no
 * existing data is stranded.
 */
export async function pushToList(key: string, record: any, cap: number): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try {
      const listKey = `mmakf:list:${key}`;
      await redis.lpush(listKey, JSON.stringify(record));
      await redis.ltrim(listKey, 0, cap - 1);
      return;
    } catch (e) {
      console.warn('Redis list push failed for', key, e);
    }
  }
  // Local dev / degraded: fall back to the JSON blob path.
  const list = (localGet<any[]>(`mmakf:${key}`, []) as any[]) || [];
  list.unshift(record);
  localSet(`mmakf:${key}`, list.slice(0, cap));
}

/** Read a capped private list written by pushToList, newest first. */
export async function getList<T = any>(key: string, limit = 500): Promise<T[]> {
  const redis = await getRedis();
  if (redis) {
    try {
      const raw: any[] = await redis.lrange(`mmakf:list:${key}`, 0, limit - 1);
      const rows = (raw || []).map((r) => (typeof r === 'string' ? safeParse(r) : r)).filter(Boolean);
      // Merge any legacy JSON-blob records written before the list migration.
      const legacy = (await redis.get(`mmakf:${key}`)) as any[] | null;
      if (Array.isArray(legacy) && legacy.length) {
        return [...rows, ...legacy].slice(0, limit) as T[];
      }
      return rows as T[];
    } catch (e) {
      console.warn('Redis list read failed for', key, e);
      return [] as T[];
    }
  }
  return (localGet<any[]>(`mmakf:${key}`, []) as T[]) || ([] as T[]);
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
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
