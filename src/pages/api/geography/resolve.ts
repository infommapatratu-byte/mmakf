// Civil geography lookup — the endpoint a registration form asks "where is this?"
//
// ─────────────────────────────────────────────────────────────────────────────
// IT IS UNAUTHENTICATED, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT
// ─────────────────────────────────────────────────────────────────────────────
//
// There is deliberately no `geo:read` action in src/lib/rbac.ts. Resolving
// "which district is Guwahati in" happens on the PUBLIC intake path, where the
// caller is somebody filling in a membership form and holds nothing at all.
// Gating it would leave two options, both bad: a permission check that always
// passes for anonymous callers — which teaches the codebase that such things
// exist — or a registration form that cannot resolve an address.
//
// What it exposes is the published names of places: countries, states,
// districts, cities. It reads `countries`, `admin_areas`, `geo_aliases` and
// `postal_codes` and NOTHING ELSE. It touches no person, no address anybody has
// given, and no federation record. `addresses` is not readable through it —
// that table holds where people live, and it is not geography, it is data about
// a person that happens to be shaped like a place.
//
// Being unauthenticated, it is RATE LIMITED. An open endpoint over a table with
// hundreds of thousands of rows is a scraping target and an amplifier, and the
// limit is what stops one caller making the register everybody else's problem.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT NEVER GUESSES
// ─────────────────────────────────────────────────────────────────────────────
//
// resolveArea() returns resolved / AMBIGUOUS / unknown, and this endpoint
// forwards all three faithfully. When a name matches more than one place —
// 'Kamrup' is both a district and a city inside it — the answer is the list of
// candidates and the word "ambiguous". It does not pick one and it does not
// order them so as to imply a winner. A form that receives `ambiguous` must ask
// the person; a form that receives a silently chosen candidate files them one
// level off and shows nobody an error.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TABLES SHIP EMPTY
// ─────────────────────────────────────────────────────────────────────────────
//
// Migration 0025 seeds no country, state, district or postal code, for the
// reason the fee, tax and currency tables ship empty. So the ORDINARY answer
// from this endpoint today is an empty list, and that is reported as
// `loaded: false` rather than as an error — a caller has to be able to tell
// "the register has not been loaded" from "the register says there is nothing
// there", because the first means fall back to free text and the second means
// the place does not exist.

import type { APIRoute } from 'astro';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import {
  countryByIso2, childrenOf, resolveArea, areasForPostalCode,
  isGeographyError, type AreaLevel,
} from '@/db/geography';
import * as g from '@/db/geography.schema';
import { eq } from 'drizzle-orm';

export const prerender = false;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Civil geography changes when a state reorganises its districts, which
      // is rare — but this answer is shaped by query parameters and a shared
      // cache keyed on the path alone would serve one enquiry's answer to
      // another's question.
      'Cache-Control': 'no-store',
    },
  });
}

/** The shape every area is returned in. Ids and names — never a person. */
const shape = (a: any) => ({
  id: a.id,
  path: a.path,
  level: a.level,
  name: a.name,
  code: a.code ?? null,
});

const LEVELS: readonly string[] = [
  'region', 'state', 'division', 'district', 'subdistrict', 'city', 'ward', 'locality',
];

export const GET: APIRoute = async ({ request, url }) => {
  const rl = await rateLimit(request, 'geo-resolve', 120, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!isConfigured()) {
    // Not an error. A deployment with no DATABASE_URL has no register to read,
    // nothing failed, and retrying changes nothing — so the caller is told to
    // fall back rather than to try again.
    return json({
      loaded: false,
      reason: 'not_configured',
      message: 'No federation database is configured on this deployment, so the geography register cannot be read.',
      areas: [],
    });
  }

  const q = url.searchParams;
  const op = (q.get('op') ?? 'children').trim();

  try {
    const d = db();

    // ── Countries ───────────────────────────────────────────────────────────
    if (op === 'countries') {
      const rows = await d.select().from(g.countries).where(eq(g.countries.status, 'active'));
      return json({
        loaded: rows.length > 0,
        countries: rows.map((c: any) => ({ id: c.id, iso2: c.iso2, name: c.name })),
      });
    }

    // ── Children of an area, or the top rung of a country ───────────────────
    //
    // This is what drives a cascading select: no `parent` means "the top level
    // of this country", and each subsequent request passes the id the reader
    // just chose.
    if (op === 'children') {
      const iso2 = (q.get('country') ?? '').trim();
      const parentRaw = (q.get('parent') ?? '').trim();

      let countryId: number | null = null;
      if (iso2) {
        const c = await countryByIso2(d, iso2);
        if (!c) return json({ loaded: false, reason: 'unknown_country', areas: [] });
        countryId = c.id;
      }

      const parentId = parentRaw ? Number(parentRaw) : null;
      if (parentRaw && (!Number.isInteger(parentId) || parentId! <= 0)) {
        return json({ error: 'That is not an area id.' }, 400);
      }
      if (parentId == null && countryId == null) {
        return json({ error: 'Name a country, or an area to list beneath.' }, 400);
      }

      const rows = await childrenOf(d, parentId, countryId ?? undefined);
      const active = rows.filter((a: any) => a.status === 'active');

      // `loaded` DESCRIBES THE REGISTER, NOT THIS ANSWER.
      //
      // It used to be `active.length > 0`, which reported a perfectly loaded
      // LEAF area as loaded:false — and this file's own header tells callers to
      // fall back to free text on exactly that flag. So a form asking for the
      // children of a district that legitimately has none abandoned the register
      // at the one point the register had a correct answer for it.
      //
      // Emptiness is carried by `areas: []` alone, which is what it means.
      const anyAreas = await d
        .select({ id: g.adminAreas.id })
        .from(g.adminAreas)
        .limit(1);

      return json({ loaded: anyAreas.length > 0, areas: active.map(shape) });
    }

    // ── Resolution ──────────────────────────────────────────────────────────
    if (op === 'resolve') {
      const iso2 = (q.get('country') ?? '').trim();
      if (!iso2) return json({ error: 'Name a country.' }, 400);

      const c = await countryByIso2(d, iso2);
      if (!c) return json({ status: 'unknown', reason: 'unknown_country' });

      const text = (q.get('q') ?? '').trim();
      const postal = (q.get('postal') ?? '').trim();
      if (!text && !postal) {
        return json({ error: 'Give a place name or a postal code to resolve.' }, 400);
      }

      const withinRaw = (q.get('within') ?? '').trim();
      const within = withinRaw ? Number(withinRaw) : null;
      if (withinRaw && (!Number.isInteger(within) || within! <= 0)) {
        return json({ error: 'That is not an area id.' }, 400);
      }

      const levelRaw = (q.get('level') ?? '').trim();
      if (levelRaw && !LEVELS.includes(levelRaw)) {
        return json({ error: 'That is not an administrative level.' }, 400);
      }

      const r = await resolveArea(d, {
        countryId: c.id,
        text: text || null,
        postalCode: postal || null,
        within,
        level: (levelRaw || null) as AreaLevel | null,
      });

      // All three outcomes forwarded as they are. The ambiguous branch carries
      // every candidate and no ordering that would imply a preference.
      if (r.status === 'resolved') {
        return json({ status: 'resolved', via: r.via, area: shape(r.area) });
      }
      if (r.status === 'ambiguous') {
        return json({
          status: 'ambiguous',
          message: 'More than one place answers to that. Which one is meant?',
          candidates: r.candidates.map(shape),
        });
      }
      return json({ status: 'unknown' });
    }

    // ── Postal code ─────────────────────────────────────────────────────────
    if (op === 'postal') {
      const iso2 = (q.get('country') ?? '').trim();
      const code = (q.get('code') ?? '').trim();
      if (!iso2 || !code) return json({ error: 'Name a country and a postal code.' }, 400);

      const c = await countryByIso2(d, iso2);
      if (!c) return json({ loaded: false, reason: 'unknown_country', areas: [] });

      const areas = await areasForPostalCode(d, c.id, code);
      return json({ loaded: areas.length > 0, areas: areas.map(shape) });
    }

    return json({ error: 'Unknown operation.' }, 400);
  } catch (err: any) {
    if (isGeographyError(err)) return json({ error: err.message, code: err.code }, 400);
    // A driver fault is a fact about the server, not about the enquirer.
    console.error('[api/geography/resolve] failed', err);
    return json({ error: 'The geography register could not be read.' }, 500);
  }
};
