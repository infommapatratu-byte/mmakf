// Public endpoint: membership registration application.
//
// Rebuilt around src/lib/registration.ts, which asks the questions a federation
// actually needs — different ones per membership type — instead of the same six
// for athletes, instructors, dojos and officials.
//
// What changed and why it mattered:
//  · An email address is now collected, so the office can actually reply.
//  · Date of birth is collected, so an age category can be determined and
//    minors can be identified. Applicants under 18 must supply guardian
//    details and guardian consent.
//  · State is validated against the federation's own list. It used to be any
//    60-character string, and the unit portal matches on exact equality — so a
//    typo made an application permanently invisible to the unit meant to verify
//    it.
//  · Over-length input is REJECTED, not silently truncated. The old endpoint
//    stored a sliced value and told the applicant nothing.
//  · The applicant receives a reference AND an access code, and can check their
//    own application at /application.
//
// Applications remain PRIVATE: `registrations` is not in PUBLIC_KEYS and is
// never served by /api/data.

import type { APIRoute } from 'astro';
import { pushToList, get } from '@/lib/storage';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { reference, accessToken, recordId } from '@/lib/refs';
import { validateApplication } from '@/lib/registration';

export const prerender = false;

const MAX_BODY = 32 * 1024;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'register', 10, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  // The states the federation actually recognises, so a free-text value cannot
  // orphan an application beyond any unit's view.
  const stateUnits = (await get<any[]>('stateUnits')) || [];
  const knownStates = stateUnits.map((u: any) => String(u?.state ?? '')).filter(Boolean);

  const result = validateApplication(body, knownStates);
  if (!result.ok) {
    // Field-level errors, so the applicant can fix exactly what is wrong.
    return json({ error: 'Please correct the highlighted fields.', fields: result.errors }, 400);
  }

  const appNo = reference('R');
  // Returned to the applicant so they can check their own application later.
  // Before this it was minted, stored, and read by nothing.
  const token = accessToken();

  const record = {
    // A random id, not Date.now(): a dojo submitting a batch of students
    // produces several records in the same millisecond, and those collided.
    id: recordId(),
    appNo,
    token,
    ...result.cleaned,
    ts: new Date().toISOString(),
    status: 'Received',
    history: [] as unknown[],
  };

  await pushToList('registrations', record, 2000);

  return json(
    {
      ok: true,
      appNo,
      isMinor: result.isMinor,
      // Both halves are required to look the application up: the reference
      // alone is not enough, so a guessed or overheard reference discloses
      // nothing.
      statusUrl: `/application?ref=${encodeURIComponent(appNo)}&token=${encodeURIComponent(token)}`,
    },
    200
  );
};
