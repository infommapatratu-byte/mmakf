// Governance, casework and the confidential consoles — the write path.
//
// ONE ROUTE, MANY ACTS, NO LOCAL POLICY. Every branch below is a thin dispatch
// onto an exported function in src/db/governance-ops.ts or src/db/cases.ts.
// Those modules hold the authorisation, the validation, the scoping and the
// audit writes; nothing here re-decides any of it. A second copy of a gate is
// the copy that drifts, and in a safeguarding file a drifted gate is a harm.
//
// WHY CASEWORK LIVES UNDER /api/governance:
// This surface owns two API routes — this one and /api/approvals — and the case
// consoles need a write path. Rather than invent a third route this workflow
// does not own, case acts are dispatched here under the `case/` prefix. The
// authority for each is still cases.ts's own, unchanged.
//
// WHAT THIS ROUTE DELIBERATELY DOES NOT EXPOSE:
//  · reportConcern — raising a safeguarding concern is UNGATED by design and
//    belongs on a public form, not behind an admin session.
//  · anything medical — recordClearance, recordInjury, fitnessToCompete,
//    medicalHistory. Clinical data has no place on a governance or case console
//    and is not reachable from this route at all.
//  · editing or deleting a case note. There is no such function in cases.ts and
//    there must never be one here either.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import * as gov from '@/db/governance-ops';
import * as cases from '@/db/cases';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ─── Status mapping ─────────────────────────────────────────────────────────
//
// Listed explicitly rather than pattern-matched. `conflict_of_interest` is a
// refusal to accept bad input (400), not a state conflict (409), and a substring
// rule on "conflict" would have got it wrong — which is the whole argument
// against inferring a status code from the spelling of a code.

const NOT_FOUND = new Set([
  'unknown_committee', 'unknown_appointment', 'unknown_document', 'unknown_version',
  'unknown_meeting', 'unknown_resolution', 'unknown_action_item', 'unknown_person',
  'unknown_declaration', 'unknown_case', 'unknown_ticket',
]);

const CONFLICT = new Set([
  'duplicate_committee', 'duplicate_meeting', 'duplicate_version',
  'already_ended', 'already_completed', 'already_referred', 'already_closed',
  'already_decided', 'already_resolved', 'appeal_already_decided',
  'appointment_void', 'case_closed', 'case_no_conflict', 'ticket_no_conflict',
  'overlapping_appointment', 'version_exists',
]);

function statusFor(code: string): number {
  if (NOT_FOUND.has(code)) return 404;
  if (CONFLICT.has(code)) return 409;
  return 400;
}

// ─── Body coercion ──────────────────────────────────────────────────────────
//
// Coercion only. Every rule about what a value MEANS — a date is a calendar
// date, a quorum is a positive whole number, a reason is mandatory — is the
// module's, and its refusal message is what the operator is shown.

type Body = Record<string, unknown>;

const str = (b: Body, k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '');

const optStr = (b: Body, k: string): string | null => {
  const v = b[k];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};

/** Optional id. An unparseable value becomes NaN so the module refuses it
 *  rather than this route silently turning it into "not supplied". */
const optInt = (b: Body, k: string): number | null => {
  const v = b[k];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
};

const bool = (b: Body, k: string): boolean => b[k] === true;

/** A required numeric id. NaN is passed through so the module refuses it. */
function reqInt(b: Body, k: string): number {
  const n = Number(b[k]);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

function intList(b: Body, k: string): number[] {
  const v = b[k];
  if (!Array.isArray(v)) return [];
  return v.map((x) => Math.trunc(Number(x))).filter((n) => Number.isFinite(n));
}

// ─── The dispatch table ─────────────────────────────────────────────────────

type Handler = (ctx: AuditContext, b: Body) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  // Committees and office
  'committee/constitute': (ctx, b) => gov.constituteCommittee(db(), ctx, {
    code: str(b, 'code'),
    name: str(b, 'name'),
    kind: str(b, 'kind'),
    remit: optStr(b, 'remit'),
    constitutedUnder: optStr(b, 'constitutedUnder'),
    scopeType: (optStr(b, 'scopeType') ?? 'national') as any,
    scopeId: optInt(b, 'scopeId'),
    parentCommitteeId: optInt(b, 'parentCommitteeId'),
    quorum: optInt(b, 'quorum'),
  }),

  'committee/quorum': async (ctx, b) => {
    await gov.setCommitteeQuorum(db(), ctx, {
      committeeId: reqInt(b, 'committeeId'),
      quorum: optInt(b, 'quorum'),
      authority: str(b, 'authority'),
    });
    return { ok: true };
  },

  'committee/appoint': (ctx, b) => gov.appointToOffice(db(), ctx, {
    committeeId: reqInt(b, 'committeeId'),
    personId: reqInt(b, 'personId'),
    office: str(b, 'office'),
    termFrom: str(b, 'termFrom'),
    termTo: optStr(b, 'termTo'),
    appointedUnder: optStr(b, 'appointedUnder'),
  }),

  'committee/end-appointment': async (ctx, b) => {
    await gov.endAppointment(db(), ctx, {
      appointmentId: reqInt(b, 'appointmentId'),
      endedOn: str(b, 'endedOn'),
      reason: str(b, 'reason'),
    });
    return { ok: true };
  },

  'committee/void-appointment': async (ctx, b) => {
    await gov.voidAppointment(db(), ctx, {
      appointmentId: reqInt(b, 'appointmentId'),
      reason: str(b, 'reason'),
    });
    return { ok: true };
  },

  // Documents
  'document/register': (ctx, b) => gov.registerDocument(db(), ctx, {
    code: str(b, 'code'),
    title: str(b, 'title'),
    category: str(b, 'category'),
    summary: optStr(b, 'summary'),
    issuingBody: optStr(b, 'issuingBody') ?? 'MMAKF',
    classification: (optStr(b, 'classification') ?? undefined) as any,
  }),

  // The checksum is computed by publishVersion over exactly what is stored.
  // Only the text form is offered here: a binary upload would have to travel as
  // base64 through a JSON body, and a transcoding step between the operator's
  // file and the bytes that get hashed defeats the point of hashing them.
  'document/publish': (ctx, b) => gov.publishVersion(db(), ctx, {
    documentCode: str(b, 'documentCode'),
    version: str(b, 'version'),
    content: {
      bodyMarkdown: str(b, 'bodyMarkdown'),
      fileUrl: optStr(b, 'fileUrl'),
      fileContentType: optStr(b, 'fileContentType'),
    },
    effectiveFrom: str(b, 'effectiveFrom'),
    effectiveTo: optStr(b, 'effectiveTo'),
    approvedByCommitteeId: optInt(b, 'approvedByCommitteeId'),
    approvedByPersonId: optInt(b, 'approvedByPersonId'),
    approvedOn: optStr(b, 'approvedOn'),
    approvedUnder: optStr(b, 'approvedUnder'),
  }),

  // Meetings
  'meeting/open': (ctx, b) => gov.openMeeting(db(), ctx, {
    code: str(b, 'code'),
    committeeId: optInt(b, 'committeeId'),
    title: str(b, 'title'),
    kind: str(b, 'kind'),
    heldOn: str(b, 'heldOn'),
    venue: optStr(b, 'venue'),
    chairPersonId: optInt(b, 'chairPersonId'),
    noticeIssuedOn: optStr(b, 'noticeIssuedOn'),
  }),

  'meeting/attendance': (ctx, b) => gov.recordAttendance(db(), ctx, {
    meetingId: reqInt(b, 'meetingId'),
    personId: reqInt(b, 'personId'),
    role: optStr(b, 'role'),
    present: b.present === undefined ? true : bool(b, 'present'),
    apologies: bool(b, 'apologies'),
    proxyForPersonId: optInt(b, 'proxyForPersonId'),
  }),

  'meeting/quorum': (ctx, b) => gov.recordQuorum(db(), ctx, reqInt(b, 'meetingId')),

  'meeting/resolution': (ctx, b) => gov.moveResolution(db(), ctx, {
    meetingId: reqInt(b, 'meetingId'),
    number: str(b, 'number'),
    text: str(b, 'text'),
    outcome: str(b, 'outcome') as any,
    movedByPersonId: optInt(b, 'movedByPersonId'),
    secondedByPersonId: optInt(b, 'secondedByPersonId'),
    votesFor: optInt(b, 'votesFor'),
    votesAgainst: optInt(b, 'votesAgainst'),
    abstentions: optInt(b, 'abstentions'),
    effectiveFrom: optStr(b, 'effectiveFrom'),
  }),

  // Action items
  'action/raise': (ctx, b) => gov.raiseActionItem(db(), ctx, {
    meetingId: optInt(b, 'meetingId'),
    resolutionId: optInt(b, 'resolutionId'),
    description: str(b, 'description'),
    ownerPersonId: optInt(b, 'ownerPersonId'),
    dueOn: optStr(b, 'dueOn'),
    note: optStr(b, 'note'),
  }),

  'action/complete': async (ctx, b) => {
    await gov.completeActionItem(db(), ctx, {
      actionItemId: reqInt(b, 'actionItemId'),
      completedOn: str(b, 'completedOn'),
      note: optStr(b, 'note'),
    });
    return { ok: true };
  },

  // Conflicts of interest
  'interest/declare': (ctx, b) => gov.declareInterest(db(), ctx, {
    personId: reqInt(b, 'personId'),
    kind: str(b, 'kind'),
    description: str(b, 'description'),
    relatedPersonId: optInt(b, 'relatedPersonId'),
    relatedDojoId: optInt(b, 'relatedDojoId'),
    declaredOn: str(b, 'declaredOn'),
    validTo: optStr(b, 'validTo'),
  }),

  'interest/withdraw': async (ctx, b) => {
    await gov.withdrawInterest(db(), ctx, {
      declarationId: reqInt(b, 'declarationId'),
      endedOn: str(b, 'endedOn'),
      reason: str(b, 'reason'),
    });
    return { ok: true };
  },

  // A conflict check is a READ, but it takes a decision context — the people and
  // dojos involved — that does not belong in a URL query string beside a
  // person's id. It is dispatched here and writes nothing.
  'interest/check': (ctx, b) => gov.checkConflict(db(), ctx.principal, reqInt(b, 'personId'), {
    personIds: intList(b, 'personIds'),
    dojoIds: intList(b, 'dojoIds'),
    asAt: optStr(b, 'asAt') ?? undefined,
    purpose: optStr(b, 'purpose') ?? undefined,
  }),

  // ─── Casework ─────────────────────────────────────────────────────────────
  //
  // APPEND-ONLY. `case/note` adds; there is no edit and no delete, here or in
  // cases.ts. The classification decides whether the subject may ever be shown
  // the note, so it is an explicit choice and defaults to `confidential`.
  'case/note': (ctx, b) => cases.addCaseNote(db(), ctx, {
    caseKind: str(b, 'caseKind') as any,
    caseId: reqInt(b, 'caseId'),
    note: str(b, 'note'),
    classification: (optStr(b, 'classification') ?? undefined) as any,
    authorPersonId: optInt(b, 'authorPersonId'),
  }),

  'case/safeguarding/assign': (ctx, b) => cases.assignOfficer(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    officerPersonId: reqInt(b, 'officerPersonId'),
  }),

  'case/safeguarding/action': (ctx, b) => cases.recordAction(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    action: str(b, 'action'),
    noteClassification: (optStr(b, 'noteClassification') ?? undefined) as any,
    authorPersonId: optInt(b, 'authorPersonId'),
    on: optStr(b, 'on') ?? undefined,
  }),

  'case/safeguarding/refer': (ctx, b) => cases.referToAuthority(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    referredTo: str(b, 'referredTo'),
    referredOn: optStr(b, 'referredOn') ?? undefined,
    note: optStr(b, 'note'),
  }),

  'case/safeguarding/close': (ctx, b) => cases.closeCase(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    outcome: str(b, 'outcome'),
    reviewDueOn: optStr(b, 'reviewDueOn'),
    closedOn: optStr(b, 'closedOn') ?? undefined,
  }),

  'case/disciplinary/raise': (ctx, b) => cases.raiseCase(db(), ctx, {
    summary: str(b, 'summary'),
    allegedBreachOf: optStr(b, 'allegedBreachOf'),
    subjectPersonId: optInt(b, 'subjectPersonId'),
    subjectDojoId: optInt(b, 'subjectDojoId'),
    complainantPersonId: optInt(b, 'complainantPersonId'),
    anonymousComplainant: bool(b, 'anonymousComplainant'),
    receivedOn: optStr(b, 'receivedOn') ?? undefined,
  }),

  'case/disciplinary/investigate': (ctx, b) => cases.investigate(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    investigatorPersonId: reqInt(b, 'investigatorPersonId'),
    note: optStr(b, 'note'),
  }),

  'case/disciplinary/hearing': (ctx, b) => cases.scheduleHearing(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    hearingOn: str(b, 'hearingOn'),
    panelCommitteeId: optInt(b, 'panelCommitteeId'),
  }),

  'case/disciplinary/decide': (ctx, b) => cases.decide(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    decision: str(b, 'decision'),
    sanction: optStr(b, 'sanction'),
    sanctionFrom: optStr(b, 'sanctionFrom'),
    sanctionTo: optStr(b, 'sanctionTo'),
    decidedByCommitteeId: optInt(b, 'decidedByCommitteeId'),
    decidedOn: optStr(b, 'decidedOn') ?? undefined,
  }),

  'case/disciplinary/appeal': (ctx, b) => cases.appeal(db(), ctx, {
    caseId: reqInt(b, 'caseId'),
    lodgedOn: optStr(b, 'lodgedOn') ?? undefined,
    outcome: optStr(b, 'outcome'),
    decidedOn: optStr(b, 'decidedOn') ?? undefined,
  }),

  // Support desk
  'ticket/assign': (ctx, b) => cases.assignTicket(db(), ctx, {
    ticketId: reqInt(b, 'ticketId'),
    assignedToUserId: reqInt(b, 'assignedToUserId'),
    department: optStr(b, 'department'),
  }),

  'ticket/respond': (ctx, b) => cases.respondToTicket(db(), ctx, {
    ticketId: reqInt(b, 'ticketId'),
    response: str(b, 'response'),
    awaitingMember: bool(b, 'awaitingMember'),
  }),

  'ticket/resolve': (ctx, b) => cases.resolveTicket(db(), ctx, {
    ticketId: reqInt(b, 'ticketId'),
    resolution: str(b, 'resolution'),
  }),
};

// ─── The route ──────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request, params }) => {
  const rl = await rateLimit(request, 'governance-write', 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, action)
    ? HANDLERS[action]
    : undefined;
  if (!handler) return json({ error: 'Unknown governance action' }, 404);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to record this' }, 401);

  // Every function below reads or writes the federation database. Without one
  // there is nothing to write to, and a control that silently does nothing is a
  // defect — so this is reported as unavailable, with the reason.
  if (!isConfigured()) {
    return json({
      error: 'The federation database is not configured on this deployment, so nothing can be recorded. Set DATABASE_URL.',
      code: 'unavailable',
    }, 503);
  }

  let body: Body;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  // The reason travels on the audit context, which is where several of these
  // functions REQUIRE it — every disciplinary step refuses without one.
  const ctx: AuditContext = {
    principal: identity.principal,
    ip: clientIp(request),
    reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null,
    authority: identity.shared ? `shared:${identity.via}` : 'user',
  };

  try {
    const result = await handler(ctx, body);
    return json({ ok: true, result }, 200);
  } catch (err: any) {
    if (err instanceof ForbiddenError) {
      return json({
        error: 'Your credential does not hold the authority this action requires, in this scope.',
        code: 'forbidden',
      }, 403);
    }
    // The module's own message, verbatim — it was written to be read by a human.
    if (err instanceof gov.GovernanceError || err instanceof cases.CaseError) {
      return json({ error: err.message, code: err.code }, statusFor(err.code));
    }
    console.error('[governance] unexpected', action, err);
    return json({ error: 'Could not record this. Nothing was changed.' }, 500);
  }
};
