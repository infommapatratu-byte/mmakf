// Public credential verification — the bonafide check for employers,
// tournament organisers and parents.
//
// Q-04. This endpoint used to read a hand-typed list of seven rows in Redis and
// report whatever it said as though the federation had verified it. It now
// prefers the authoritative chain — an examination, a scorecard, a decision, a
// certificate — and, crucially, TELLS THE ENQUIRER WHICH IT USED.
//
// Three provenances, and the difference is the whole point:
//
//   examined            traced to a grading with examiner scores behind it
//   programme           a course-completion certificate resting on an attendance
//                       register. NOT a grade, and no examination was ever held
//   unverified_legacy   a real grade predating digital records; the federation
//                       holds evidence, but no examination record exists
//   legacy_register     the old hand-typed list, used only while no database is
//                       configured; the weakest claim the service can make
//
// A verification service that cannot say how it knows is not a verification
// service. Reporting all three identically is what made the old endpoint
// misleading, and it is the specific thing fixed here.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { get } from '@/lib/storage';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { verifyCredential } from '@/db/grading';
import { clientIp } from '@/lib/session';
import { and, eq } from 'drizzle-orm';
import * as s from '@/db/schema';

export const prerender = false;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Hashed, never stored raw — an audit of who checked, not of who they are. */
function hashIp(ip: string | null): string | null {
  return ip ? crypto.createHash('sha256').update(ip).digest('base64url').slice(0, 22) : null;
}

const NOTE = {
  examined:
    'This credential is traced to a recorded examination held by the federation.',
  programme:
    'This is a record of ATTENDANCE at a federation training programme. It is not an examination result and it confers no rank or grade — the attendance figures it was issued on are printed on the certificate itself.',
  unverified_legacy:
    'This grade predates the federation’s digital examination records. The federation holds evidence for it, but it is not backed by an examination scorecard in this system.',
  legacy_register:
    'This result comes from the federation’s legacy register, which is maintained by hand and is not backed by an examination record in this system.',
} as const;

export const GET: APIRoute = async ({ url, request }) => {
  const rl = await rateLimit(request, 'verify', 30, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const q = (url.searchParams.get('id') || '').trim().toUpperCase();
  if (!q || q.length > 60) {
    return json({ found: false, error: 'Provide a member ID or certificate number' }, 400);
  }

  const ipHash = hashIp(clientIp(request));

  // ── 1. Authoritative records, when a database is configured ───────────────
  if (isConfigured()) {
    try {
      const database = db();

      // A certificate number is the strongest thing anyone can present.
      if (/^MMAKF-CERT-/i.test(q)) {
        const result = await verifyCredential(database, { certificateNo: q }, { ipHash });
        if (result.status === 'not_found') return json({ found: false });
        return json({
          found: true,
          kind: 'certificate',
          provenance: result.provenance,
          note: result.provenance ? NOTE[result.provenance] : undefined,
          credential: {
            certificateNo: result.certificateNo,
            name: result.holderName,
            federationId: result.federationId,
            // WHAT THE DOCUMENT IS. A programme certificate carries no grade,
            // so without this the card named a holder and a number and never
            // said what had been certified.
            title: result.title,
            grade: result.grade,
            awardedOn: result.awardedOn,
            issuingAuthority: result.issuingAuthority,
            syllabusVersion: result.syllabusVersion,
            status: result.status,
            revokedReason: result.revokedReason,
          },
        });
      }

      // Otherwise a federation member id, resolved to its active grade.
      const rows = await database
        .select({
          federationId: s.persons.federationId,
          fullName: s.persons.fullName,
          personStatus: s.persons.status,
          city: s.persons.city,
          stateUnitId: s.persons.stateUnitId,
          gradeLabel: s.rankRecords.gradeLabel,
          gradeKind: s.rankRecords.kind,
          awardedOn: s.rankRecords.awardedOn,
          gradingEventId: s.rankRecords.gradingEventId,
          syllabusVersion: s.rankRecords.syllabusVersion,
        })
        .from(s.persons)
        .leftJoin(
          s.rankRecords,
          and(eq(s.rankRecords.personId, s.persons.id), eq(s.rankRecords.status, 'active'))
        )
        .where(eq(s.persons.federationId, q))
        .limit(1);

      const row = rows[0];

      await database
        .insert(s.verificationLog)
        .values({
          lookupKind: 'member',
          lookupValue: q.slice(0, 80),
          found: Boolean(row),
          resultStatus: row?.personStatus ?? 'not_found',
          ipHash,
        })
        .catch(() => { /* logging must never break verification */ });

      if (row) {
        // A grade with a grading event behind it was examined; one without is a
        // legacy record, and the enquirer is told which.
        const provenance = row.gradeLabel
          ? (row.gradingEventId ? 'examined' : 'unverified_legacy')
          : undefined;

        return json({
          found: true,
          kind: 'member',
          provenance,
          note: provenance ? NOTE[provenance] : undefined,
          member: {
            id: row.federationId,
            name: row.fullName,
            grade: row.gradeLabel ?? null,
            gradeKind: row.gradeKind ?? null,
            awardedOn: row.awardedOn ?? null,
            syllabusVersion: row.syllabusVersion ?? null,
            state: row.stateUnitId ?? null,
            city: row.city ?? null,
            status: row.personStatus,
          },
        });
      }

      // Configured and searched, but nothing matched. Do NOT silently fall back
      // to the legacy list — that would let a superseded hand-typed row override
      // the authoritative answer.
      return json({ found: false });
    } catch (err) {
      // A database fault must not be reported as "no such member". Saying the
      // service is unavailable is the honest answer, and the enquirer can retry.
      console.error('[verify] database lookup failed', err);
      return json(
        {
          found: false,
          error: 'The verification service is temporarily unavailable. This is not a result about that ID.',
          unavailable: true,
        },
        503
      );
    }
  }

  // ── 2. Legacy register, only while no database is configured ──────────────
  //
  // Labelled as such. This is the weakest claim the service can make, and it is
  // the one the old endpoint made silently for everything.
  const members = (await get<any[]>('members')) || [];
  const m = members.find((x: any) => String(x.id || '').trim().toUpperCase() === q);

  if (!m) return json({ found: false });

  return json({
    found: true,
    kind: 'member',
    provenance: 'legacy_register',
    note: NOTE.legacy_register,
    member: {
      id: m.id,
      name: m.name,
      type: m.type,
      grade: m.grade,
      state: m.state,
      unit: m.unit,
      status: m.status,
      validTill: m.validTill,
    },
  });
};
