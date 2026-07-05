// Public endpoint: returns all federation content.
// Used by static client-side updates and external tools.

import type { APIRoute } from 'astro';
import { getAll } from '@/lib/storage';

export const prerender = false;

export const GET: APIRoute = async () => {
  const data = await getAll();
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, s-maxage=300',
    },
  });
};
