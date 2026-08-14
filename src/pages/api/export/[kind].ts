// Data export — the endpoint (§86, PART AU, PART AV).
//
//     GET /api/export/<kind>?format=csv|json&status=&from=&to=&limit=
//
// THIS FILE DECIDES NOTHING. Which kinds exist, who may take one, which rows
// they may take, which columns those rows carry and the audit record written on
// the way out all live in src/lib/export.ts. What is here is the shape of an
// HTTP request: a query string in, a file out, and the mapping from a refusal
// to a status code. A second copy of an authorisation rule is the copy that
// drifts, and on an export the drift is a disclosure.
//
// WHY THE ORIGIN IS CHECKED ON A GET.
// The middleware guards POST, PUT, PATCH and DELETE, which is right for a
// write. But this GET returns a file assembled with the caller's session
// cookie, so a page on another origin can cause the request to be made — it
// cannot READ the response, which the same-origin policy still prevents, but it
// can put a spurious export in the federation's audit log and make somebody
// spend an afternoon explaining it. The check costs nothing and keeps the
// record clean.
//
// NOT BUILT: XLSX and PDF. Both need a library and this codebase adds no
// dependencies. `format` accepts csv and json, and an unknown format is
// refused by name rather than silently falling back to CSV — a caller who
// asked for a spreadsheet should be told there isn't one, not handed something
// else and left to notice.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { isSameOrigin } from '@/lib/origin';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import {
  runExport, availableKinds, ExportError, FORMATS,
  MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT,
} from '@/lib/export';

export const prerender = false;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Refusal code → status.
 *
 * Listed rather than inferred. `national_only` and `out_of_scope` are both 403
 * because both are "not you", while `bad_filter` is 400 because the caller can
 * fix it by asking differently — and telling those apart is the difference
 * between an operator retrying and an operator raising a ticket.
 */
const STATUS_FOR: Record<string, number> = {
  unknown_kind: 404,
  unsupported_format: 400,
  bad_filter: 400,
  national_only: 403,
  out_of_scope: 403,
  bad_money_value: 500,
};

export const GET: APIRoute = async ({ request, params, url }) => {
  // An export is expensive at both ends — a count and a capped read per call,
  // and a file at the other. A lower ceiling than the write endpoints on
  // purpose: nobody legitimately takes thirty exports a minute.
  const rl = await rateLimit(request, 'export-run', 20, 300);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!isSameOrigin(request.headers, url.host)) {
    return json({ error: 'Request refused', code: 'cross_origin' }, 403);
  }

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to export data', code: 'unauthenticated' }, 401);

  // Every kind reads the federation database. Without one there is nothing to
  // export, and an empty file would read as "the federation has no members".
  if (!isConfigured()) {
    return json({
      error: 'The federation database is not configured on this deployment, so there is nothing to export. Set DATABASE_URL.',
      code: 'unavailable',
    }, 503);
  }

  const kind = String(params.kind ?? '').trim();
  const format = (url.searchParams.get('format') ?? 'csv').toLowerCase();

  // `status` is repeatable — ?status=new&status=qualifying — and is validated
  // against the column's own enum inside runExport(), not here.
  const status = url.searchParams.getAll('status').filter((v) => v.trim() !== '');

  const rawLimit = url.searchParams.get('limit');
  let limit = DEFAULT_ROW_LIMIT;
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n < 1) {
      return json({ error: '`limit` must be a whole number of rows.', code: 'bad_filter' }, 400);
    }
    // Clamped rather than refused: a caller asking for more than the cap wants
    // as much as they can have, and the response says what they actually got.
    limit = Math.min(MAX_ROW_LIMIT, Math.floor(n));
  }

  const ctx: AuditContext = {
    principal: identity.principal,
    ip: clientIp(request),
    reason: url.searchParams.get('reason')?.trim() || null,
    authority: identity.shared ? `shared:${identity.via}` : 'user',
  };

  try {
    const result = await runExport(db(), ctx, {
      kind,
      format: format as (typeof FORMATS)[number],
      filters: {
        status: status.length ? status : undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      },
      limit,
    });

    // The body is generated a chunk at a time, so the whole file is never held
    // as one string on top of the rows it was built from.
    const encoder = new TextEncoder();
    const iterator = result.body[Symbol.iterator]();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        // A CSV is a file a browser will happily sniff into something else.
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        // How much of the answer this file is. A CSV has nowhere else to say
        // it, and an operator who does not know a file was truncated will read
        // it as the whole register.
        'X-Export-Rows-Returned': String(result.rowsReturned),
        'X-Export-Rows-Matched': String(result.rowsMatched),
        'X-Export-Truncated': result.truncated ? 'true' : 'false',
        'X-Export-Row-Limit': String(result.limit),
      },
    });
  } catch (err: any) {
    if (err instanceof ForbiddenError) {
      return json({
        error: 'Your credential does not hold the authority this export requires, in this scope.',
        code: 'forbidden',
        // What they COULD export, filtered by their own authority — so this is
        // a menu they are entitled to see, not a catalogue of the database.
        available: availableKinds(identity.principal),
      }, 403);
    }

    if (err instanceof ExportError) {
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err.code === 'unknown_kind') body.available = availableKinds(identity.principal);
      return json(body, STATUS_FOR[err.code] ?? 400);
    }

    // Nothing was written and nothing is returned. The detail stays in the
    // server log: an export failure message can carry a column name or a query
    // fragment, and neither belongs in an HTTP body.
    console.error('[export] unexpected', kind, err);
    return json({ error: 'The export could not be produced.', code: 'error' }, 500);
  }
};
