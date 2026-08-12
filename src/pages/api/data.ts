// Public content endpoint — editorial content only.
//
// Deliberately does NOT return every stored key. `members` is the federation
// register; verification is a lookup of one identifier via /api/verify, which
// is rate-limited. Returning the whole register here made it a bulk export of
// the membership — unauthenticated, and cached at the CDN for five minutes.

import type { APIRoute } from 'astro';
import { getAll } from '@/lib/storage';
import { PRIVATE_KEYS } from '@/data/seed';

export const prerender = false;

export const GET: APIRoute = async () => {
  const data = await getAll();

  // Filter on the way out rather than fetching selectively, so a key added to
  // PRIVATE_KEYS is excluded here automatically and cannot be forgotten.
  const publicData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if ((PRIVATE_KEYS as readonly string[]).includes(key)) continue;
    publicData[key] = value;
  }

  return new Response(JSON.stringify(publicData), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, s-maxage=300',
    },
  });
};
