// The caller's own practice marks, for hydrating the marking control.
//
// A GET, and a deliberately dull one: it takes no parameters, reads the caller's
// own rows and nobody else's, and answers 401 to a visitor with no session
// rather than an empty list — because "you are not signed in" and "you have
// marked nothing" are different sentences and the control needs to tell them
// apart.
//
// WHY THIS EXISTS AT ALL, rather than the technique page reading the marks in
// its frontmatter: those pages render entirely from static source and touch no
// database. Production currently receives no DATABASE_URL, and the technical
// library must stay readable regardless — so the current state of a control is
// fetched afterwards by whoever is signed in, and its absence costs a reader
// nothing.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { identify } from '@/lib/session';
import { myMarks } from '@/db/practice';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Never cached: it is one member's own record, and a shared cache holding
      // it would hand one member's practice notes to the next visitor.
      'Cache-Control': 'no-store, private',
    },
  });
}

export const GET: APIRoute = async ({ request }) => {
  if (!isConfigured()) return json({ marks: [], reason: 'not_configured' }, 200);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Not signed in' }, 401);

  try {
    const marks = await myMarks(db(), identity.principal, 500);
    return json({
      marks: marks.map((m: any) => ({
        subjectKind: m.subjectKind,
        subjectSlug: m.subjectSlug,
        mark: m.mark,
      })),
    }, 200);
  } catch {
    // A fact about the server is not repeated to the caller.
    return json({ error: 'Your marks could not be read.' }, 500);
  }
};
