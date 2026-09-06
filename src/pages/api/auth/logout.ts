// Sign out of the operations console.
//
// THIS ROUTE CLEARED ONE OF THE TWO COOKIES IT MINTS, AND THE WRONG ONE.
//
// /api/auth/login has two success paths and they set different cookies:
//   · the per-person path mints `mmakf_user` via createUserSessionCookie()
//   · the shared-password path mints `mmakf_admin` via createSessionCookie()
//
// This route cleared `mmakf_admin` alone. It has not been touched since May
// 2026; per-person accounts arrived afterwards and logout was never updated,
// so clearUserSessionCookie() sat in src/lib/auth.ts with no call site anywhere
// in the codebase.
//
// The failure is worse than "logout does nothing", because it does not look
// like a failure. identify() prefers the surviving `mmakf_user` cookie, so
// /admin re-renders THE FULL CONSOLE, SIGNED IN, and the operations bar
// redirects to the public homepage — which reads as a successful sign-out. On a
// shared office machine the next person is the previous person.
//
// "Close the browser" is not a workaround: the cookie carries Max-Age=604800,
// so it survives that for seven days. Nor is it enough to clear cookies when a
// session is known to be exposed — that needs the epoch bumped server-side,
// which a password change already does.
//
// BOTH ARE CLEARED HERE, AND THE THIRD IS NOT. `mmakf_unit` belongs to the unit
// portal, which is a separate surface with its own sign-in and its own
// /api/unit/logout. Clearing it from here would sign somebody out of a place
// they did not ask to leave. The rule this route follows is symmetry: it clears
// exactly what its own login mints, no more.

import type { APIRoute } from 'astro';
import { clearSessionCookie, clearUserSessionCookie } from '@/lib/auth';

export const prerender = false;

export const POST: APIRoute = async () => {
  // A Headers object, not an object literal. Two Set-Cookie values cannot be
  // expressed as two properties of the same key, and the version of this route
  // that tried would have silently kept only one of them — which is the defect
  // above, reintroduced in a new place.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', clearUserSessionCookie());
  headers.append('Set-Cookie', clearSessionCookie());

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
};
