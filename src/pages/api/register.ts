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
import {
  validateApplication, EMPTY_GEOGRAPHY, UNRESOLVED_CHOICE, normalisePostalCode,
  type RegistrationGeography,
} from '@/lib/registration';
import { isConfigured, db } from '@/db';
import * as geoSchema from '@/db/geography.schema';
import { childrenOf, resolveArea } from '@/db/geography';
import { eq } from 'drizzle-orm';

/**
 * The civil geography THIS submission is allowed to have chosen from.
 *
 * Re-derived on the server from the country and the areas the applicant says
 * they picked, and never taken from the request. The browser sends ids; whether
 * an id was on offer is decided here, because a select is a suggestion and the
 * list that was rendered is not evidence of anything by the time the POST
 * arrives.
 *
 * Returns EMPTY_GEOGRAPHY when the map has not been loaded, which is the state
 * every deployment is in today — and which makes the register-backed fields
 * unoffered, unvalidated and unrequired.
 */
async function geographyFor(input: Record<string, unknown>): Promise<RegistrationGeography> {
  if (!isConfigured()) return EMPTY_GEOGRAPHY;

  try {
    const d = db();
    const countries = await d
      .select({ id: geoSchema.countries.id, iso2: geoSchema.countries.iso2, name: geoSchema.countries.name })
      .from(geoSchema.countries)
      .where(eq(geoSchema.countries.status, 'active'));
    if (!countries.length) return EMPTY_GEOGRAPHY;

    // Exactly as the page does it: one country needs no choosing.
    const chosenIso = String(input.country ?? '').trim().toUpperCase();
    const country = countries.length === 1
      ? countries[0]
      : countries.find((c: any) => c.iso2 === chosenIso) ?? null;

    if (!country) {
      return { ...EMPTY_GEOGRAPHY, loaded: true, countries: countries.map((c: any) => ({ value: c.iso2, label: c.name })) };
    }

    const asChoice = (a: any) => ({ value: String(a.id), label: a.name });
    const active = (rows: any[]) => rows.filter((a: any) => a.status === 'active');

    const states = active(await childrenOf(d, null, country.id)).map(asChoice);

    // Districts only once a state on the offered list has been chosen. An id
    // the applicant did not choose from cannot narrow anything.
    let districts: Array<{ value: string; label: string }> = [];
    const stateId = Number(String(input.civilStateAreaId ?? '').trim());
    if (Number.isInteger(stateId) && stateId > 0 && states.some((s) => s.value === String(stateId))) {
      districts = active(await childrenOf(d, stateId)).map(asChoice);
    }

    // The ambiguity branch. resolveArea() returns 'ambiguous' when more than one
    // place answers to what was typed, and this is where that becomes a QUESTION
    // rather than a guess: the candidates are put on the field the form renders
    // as "Which of these did you mean?", and the submission is answered with
    // them rather than filed against whichever the index returned first.
    let localityCandidates: Array<{ value: string; label: string }> = [];
    const typed = String(input.city ?? '').trim();
    const postal = normalisePostalCode(String(input.postalCode ?? ''));
    if (typed || postal) {
      // `within` IS PARSED THE SAME WAY THE STATE IS, and it was not.
      //
      // The previous line was
      //     districts.length && Number.isInteger(Number(input.civilDistrictAreaId))
      // and Number('') is 0, as is Number(null) — both integers. So an EMPTY
      // district field set `within` to 0, resolveArea() looked up area id 0,
      // threw GeographyError('unknown_area'), and the bare catch below returned
      // EMPTY_GEOGRAPHY — which made isOffered() drop civilStateAreaId, so the
      // state the applicant had correctly chosen was silently discarded from the
      // stored application behind a 200. Nothing anywhere recorded that a
      // resolution had been attempted and failed.
      //
      // And membership is now checked, which the comment above the old line
      // already claimed: an id the applicant was never offered must not narrow
      // anybody's resolution.
      const rawDistrict = String(input.civilDistrictAreaId ?? '').trim();
      const districtId = rawDistrict ? Number(rawDistrict) : null;
      const districtOffered = districtId != null
        && Number.isInteger(districtId) && districtId > 0
        && districts.some((x) => x.value === String(districtId));

      const within = districtOffered
        ? districtId
        : (Number.isInteger(stateId) && stateId > 0 ? stateId : null);

      // Scoped to the resolve call alone. A geography fault here must not throw
      // away the states and districts already built above — losing the whole
      // object is what turned a bad district id into a dropped state.
      try {
        const r = await resolveArea(d, {
          countryId: country.id,
          text: typed || null,
          postalCode: postal || null,
          within,
        });
        if (r.status === 'ambiguous') {
          localityCandidates = r.candidates.map(asChoice);
        }
      } catch (err) {
        // Logged rather than swallowed. An unresolvable locality is an ordinary
        // outcome; a resolver that THREW is a fact about the register somebody
        // needs to see, and the registration continues regardless.
        console.error('[api/register] locality resolution failed', err);
      }
    }

    return {
      loaded: true,
      countries: countries.length > 1 ? countries.map((c: any) => ({ value: c.iso2, label: c.name })) : [],
      states,
      districts,
      localityCandidates,
    };
  } catch (err) {
    // A register that cannot be read must not refuse a registration. The
    // free-text location carries the applicant, as it does everywhere the map
    // has not been loaded.
    //
    // LOGGED, because this branch also catches a genuine database fault, and a
    // silent fallback made an outage indistinguishable from an unloaded map —
    // both produced a 200 with the civil location quietly missing.
    console.error('[api/register] geography unavailable; falling back to free text', err);
    return EMPTY_GEOGRAPHY;
  }
}

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

  const geo = await geographyFor(body);

  // THE AMBIGUITY IS ANSWERED BEFORE THE APPLICATION IS ACCEPTED, and it is not
  // an error the applicant did anything to cause — so it is reported as a
  // question, with the candidates, rather than as a rejected form.
  //
  // The alternative is the one the location engine exists to prevent: resolving
  // to whichever place the index returned first, filing the member one district
  // away from where they live, and showing nobody so much as a warning.
  const alreadyChosen = String(body.cityAreaId ?? '').trim();
  if (geo.localityCandidates.length > 0 && !alreadyChosen) {
    return json(
      {
        error: 'More than one place answers to what you typed. Which one did you mean?',
        code: 'locality_ambiguous',
        field: 'cityAreaId',
        candidates: geo.localityCandidates,
        // The way out for somebody whose village genuinely is not in the
        // register: their words are kept verbatim and the address is recorded
        // unresolved, which is a row the re-resolution backlog can find later.
        unresolvedValue: UNRESOLVED_CHOICE,
      },
      400
    );
  }

  const result = validateApplication(body, knownStates, new Date(), { geo });
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

  // THE APPLICATION NUMBER IS ISSUED ONLY IF THE RECORD WAS STORED.
  //
  // pushToList() used to swallow a store failure and fall through to an
  // in-memory list that dies with the lambda. This endpoint then returned an
  // appNo and a status URL for a submission that no longer existed anywhere —
  // a family told "Application received", holding a reference the office could
  // never find. A 503 they can act on is the honest answer.
  try {
    await pushToList('registrations', record, 2000);
  } catch (err) {
    console.error('[api/register] the application could not be stored', err);
    return json(
      {
        ok: false,
        error: 'not_stored',
        message:
          'Your application could NOT be recorded, and no reference has been issued — ' +
          'nothing was saved. Please try again in a few minutes, or contact the ' +
          'federation office so it can be taken by hand.',
      },
      503
    );
  }

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
