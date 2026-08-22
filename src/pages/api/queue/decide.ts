// Record a decision on a queued item.
//
// The endpoint that makes the application queue workable. Authority comes from
// identify() — the single place a request becomes an identity — rather than
// from a local cookie check, so there is one policy path and not one per page.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { decide, isQueue, QueueError } from '@/lib/queue';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { writeAudit } from '@/db/federation';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'queue-decide', 60, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to record a decision' }, 401);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const queue = String(body.queue ?? '');
  if (!isQueue(queue)) return json({ error: 'Unknown queue' }, 400);

  try {
    const decided = await decide(identity.principal, {
      queue,
      recordId: String(body.recordId ?? ''),
      toStatus: String(body.toStatus ?? ''),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      applicantNote: typeof body.applicantNote === 'string' ? body.applicantNote : undefined,
    });

    // ── THE RECORD NEVER REACHES A RESPONSE BODY ────────────────────────────
    //
    // decide() returns the decided row so this endpoint can provision from it,
    // and that row is the applicant's name, date of birth, email, telephone and
    // address. Three places below build a response by spreading `result`, so if
    // the record travelled on it, an approval would answer the browser with the
    // applicant's entire submission.
    //
    // Split at the point of arrival rather than remembered later: `result` is
    // what may be serialised, `sourceRecord` is what may not, and there is no
    // single object that is both.
    const { record: sourceRecord, ...result } = decided;

    // Audited when a database is available. The decision itself is already
    // durable in the record's own append-only history either way, so a missing
    // database delays the audit trail rather than losing the decision.
    if (isConfigured()) {
      try {
        await writeAudit(
          db(),
          {
            principal: identity.principal,
            ip: clientIp(request),
            reason: typeof body.reason === 'string' ? body.reason : null,
            // Records that a shared credential was used, so the trail never
            // implies an individual took the decision when it cannot know.
            authority: identity.shared ? `shared:${identity.via}` : 'user',
          },
          {
            entityType: `queue:${queue}`,
            entityId: result.recordId,
            action: /reject|return/i.test(result.to) ? 'reject' : 'approve',
            oldValue: { status: result.from },
            newValue: { status: result.to },
          }
        );
      } catch (err) {
        console.error('[queue] audit write failed', err);
      }
    }

    // ── APPROVAL MUST REACH THE REGISTER ────────────────────────────────────
    //
    // THE DEFECT THIS CLOSES. decide() moves a row between states in a Redis
    // list and stops there. issueMembership() exists in src/db/federation.ts
    // and NOTHING CALLED IT. So a membership application could be approved, the
    // queue would show "Approved", the applicant would be told they were a
    // member — and no row ever entered the Postgres register that /verify
    // reads. Their certificate would not verify.
    //
    // That is the worst class of defect in this system: it is invisible to
    // everyone who works the queue and obvious to the one person it is about.
    //
    // It runs AFTER decide() rather than inside it, because decide() is the
    // generic engine for three unrelated queues and has no database access by
    // design. The registration queue is the one whose decision has a
    // consequence in Postgres.
    let registerWarning: string | null = null;

    if (queue === 'registrations' && /^approved$/i.test(result.to)) {
      if (!isConfigured()) {
        // FAIL VISIBLY. Returning 200 here would tell the office the member was
        // admitted while no register existed to admit them to — which is the
        // exact failure being fixed, with a nicer status code.
        //
        // The queue row has already moved, so the decision is not lost; it is
        // reported as incomplete and can be re-run once the database is
        // reachable. Silently succeeding is the only unacceptable outcome.
        return json(
          {
            ...result,
            registered: false,
            error: 'decision_recorded_but_not_registered',
            message:
              'The decision was recorded in the queue, and no membership was issued: ' +
              'the federation database is not reachable from this deployment, so there ' +
              'is no register to write to. Re-run this approval once it is configured.',
          },
          503
        );
      }

      try {
        const { issueMembership } = await import('@/db/federation');
        const { provisionFromRegistration } = await import('@/db/provisioning');
        const ctx = {
          principal: identity.principal,
          ip: clientIp(request),
          reason: typeof body.reason === 'string' ? body.reason : null,
          authority: identity.shared ? `shared:${identity.via}` : 'user',
        };

        // The queue row carries what the applicant submitted. personId and
        // category are resolved from the RECORD, never from the request body —
        // a client that could name the person and the category of a membership
        // it is approving could admit anybody as anything.
        //
        // `result.record` IS NOW A REAL FIELD. It was read here from the first
        // version of this block and `DecisionResult` never declared one, so it
        // was `undefined` on every request and this whole path always fell into
        // its "carries no linked person record" branch — an instruction nobody
        // could follow, because nothing in the system linked an application to a
        // person. src/lib/queue.ts now returns the decided row.
        const record = sourceRecord ?? null;
        const category = String(record?.category ?? '').trim().toLowerCase();

        // ── THE APPROVAL CREATES THE PERSON ─────────────────────────────────
        //
        // This is the join that did not exist. Idempotent through
        // createPersonForSource(), so a retried approval finds the person it
        // already made rather than making a second one.
        //
        // It runs BEFORE the membership block and hands it the id, so the
        // register entry and the membership are one act from the office's point
        // of view rather than two, the second of which was impossible.
        let personId = Number(record?.personId ?? NaN);
        if (record) {
          try {
            const provisioned = await provisionFromRegistration(db(), ctx, record);
            personId = provisioned.personId;
            // The notes are the honest half. A provisioning run that placed the
            // person but could not record an address, or raised a duplicate, has
            // to say so — the office is about to tell somebody they are
            // registered.
            if (provisioned.notes.length) {
              registerWarning = 'Registered as '
                + `${provisioned.federationId}. ${provisioned.notes.join(' ')}`;
            }
          } catch (err: any) {
            // FAIL VISIBLY. The queue row has already moved.
            console.error('[queue] provisioning failed', err);
            return json(
              {
                ...result,
                registered: false,
                error: 'decision_recorded_but_not_registered',
                message:
                  'The decision was recorded in the queue and the applicant was NOT entered in the '
                  + 'register: ' + String(err?.message ?? err)
                  + ' This needs an administrator — the queue now shows Approved.',
              },
              500
            );
          }
        }

        // ── A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT ──
        //
        // AND DOES NOT HOLD ONE FOR FREE EITHER. This line used to read
        //
        //     const category = String(record?.category ?? 'athlete');
        //
        // with 'athlete' repeated again as the fallback for anything it did not
        // recognise — so approving a registration that named no category at all
        // minted an ATHLETE membership, the exact credential the federation
        // withdrew, through a live HTTP route, silently, as the DEFAULT. No
        // money changed hands, which is why no fee guard was ever going to see
        // it: registering is free, and registering is not the same as joining.
        //
        // The categories below are the three the register still admits: people
        // and bodies that act FOR the federation. A student is not among them
        // and is not missing from them — a student's access to training is
        // decided by a valid TRAINING ENTITLEMENT, which a membership row would
        // not grant and its absence does not withhold.
        //
        // NOTHING IS GUESSED. An application that does not say which register it
        // belongs in gets no membership and a warning that says so, for the same
        // reason src/db/student-rule.ts refuses a standing charge that never
        // names its payer: a category the federation cannot name is one this
        // system must not choose on its behalf.
        const ISSUABLE = ['instructor', 'dojo', 'official'] as const;
        const issuable = (ISSUABLE as readonly string[]).includes(category);

        if (!Number.isInteger(personId) || personId <= 0) {
          registerWarning =
            'The decision was recorded. No membership was issued because this application ' +
            'carries no linked person record — link it to a person and re-run the approval.';
        } else if (!issuable) {
          // The applicant IS registered: the person record stands, the approval
          // stands, and they can be enrolled and taught. What they do not get is
          // a membership, and that is the rule rather than a failure.
          registerWarning =
            'The decision was recorded and the person is registered. No membership was issued: ' +
            (category === 'athlete' || category === 'junior' || category === 'student'
              ? `this application is recorded as '${category}', and a student does not pay a membership fee ` +
                'for being a student. What a student buys is TRAINING, and access to it is decided by a ' +
                'valid training entitlement rather than by membership.'
              : category
                ? `this application is recorded as '${category}', which is not a register MMAKF admits to.`
                : 'this application names no membership category, and this system will not choose one ' +
                  'for the federation.') +
            ' The membership register admits an instructor, an official or a dojo — record that category ' +
            'and re-run the approval if this applicant is one.';
        } else {
          // renew() underneath supersedes rather than duplicating, so a replayed
          // approval does not stack two memberships on one person.
          await issueMembership(db(), ctx, {
            personId,
            category: category as 'instructor' | 'dojo' | 'official',
            validFrom: new Date().toISOString().slice(0, 10),
            // NULL, not a guessed expiry. MMAKF has published no membership
            // term, and inventing one would put a date on a member's standing
            // that the federation never set.
            validTo: null,
          });
        }
      } catch (err: any) {
        // Reported, never swallowed. The office needs to know the register did
        // not receive this, because the queue now says Approved.
        console.error('[queue] membership issue failed', err);
        registerWarning =
          'The decision was recorded and the membership could not be issued to the register. ' +
          'This needs an administrator: the queue now shows Approved and the member is not registered.';
      }
    }

    return json(registerWarning ? { ...result, registered: false, warning: registerWarning } : result, 200);
  } catch (err: any) {
    if (err instanceof QueueError) {
      const status =
        err.code === 'forbidden' ? 403 :
        err.code === 'not_found' ? 404 :
        err.code === 'already_decided' || err.code === 'no_change' ? 409 : 400;
      return json({ error: err.message, code: err.code }, status);
    }
    console.error('[queue] unexpected', err);
    return json({ error: 'Could not record the decision' }, 500);
  }
};
