// /api/enroll — RETIRED. Answers 410 Gone and points at the real intake.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT DID
// ─────────────────────────────────────────────────────────────────────────────
//
// It appended {id, name, phone, program, ts} to a Redis list called `leads` and
// returned {ok:true}. Nothing read that list. No lead existed, nobody owned it,
// no task was raised and /admin/leads — which reads the `leads` TABLE through
// leadPipeline() — could never show it. An enquiry sent here reached nobody.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS RETIRED RATHER THAN WIRED TO captureLead()
// ─────────────────────────────────────────────────────────────────────────────
//
// Wiring it was the alternative, and the evidence went against it.
//
// 1. IT HAS NO CALLER. The only thing that ever posted here was the enquiry
//    form in src/components/EnrollCTA.astro, and that form is gone. A grep of
//    src, tests and scripts finds no other caller — the remaining hits are
//    stale build output under .vercel/, not source.
//
// 2. IT HAS NEVER SUCCEEDED, SO THERE IS NOTHING IN FLIGHT TO PRESERVE. The
//    handler required `phone`; the form collected name, email and programme and
//    had no phone field, so every scripted submission was answered 400. The
//    unscripted path posted application/x-www-form-urlencoded to a handler that
//    only called JSON.parse, and was answered 400 too. There are no bookmarks
//    or cached pages out there quietly producing successful enquiries, because
//    no request to this route has ever produced one.
//
// 3. WIRING IT WOULD BUILD A SECOND FRONT DOOR. An unauthenticated JSON
//    endpoint that inserts rows into `leads`, reachable by anyone, serving no
//    user interface, is an open tap into the pipeline — and engagement.ts is
//    explicit that an unreadable pipeline is one nobody works, which costs the
//    federation the enquiries that were real. Public intake belongs in
//    /learn/request → /learn/apply → submitApplication(), which validates
//    against WIZARD_STEPS and itself calls captureLead(). That path already
//    creates the lead this endpoint would have created, with the audience,
//    parameters and routing that make it answerable.
//
// The route is KEPT, rather than deleted, so that a cached page or a bookmark
// gets a deliberate, explained answer instead of a 404 that tells nobody
// anything. A cached copy of the old form will show its existing failure
// message, which already directs the visitor to the federation's email address.
//
// EVERY METHOD IS ANSWERED, not only POST: a bookmarked GET should meet the
// same explanation rather than a 405 that reads like a bug.

import type { APIRoute } from 'astro';

export const prerender = false;

/** Where intake actually happens. One definition, used by body and headers. */
const INTAKE_PATH = '/learn/request';

const BODY = {
  error: 'gone',
  message:
    'This endpoint has been retired. Requests for training are made at ' +
    `${INTAKE_PATH}, which records them against a reference you can follow. ` +
    'You can also write to admin@mmakf.in.',
  intake: INTAKE_PATH,
};

export const ALL: APIRoute = async () =>
  new Response(JSON.stringify(BODY), {
    status: 410,
    headers: {
      'Content-Type': 'application/json',
      // Points a client at the replacement without pretending this is a
      // redirect: the old contract took a body and the new one is a page, so
      // a 301 would send a POST somewhere that cannot answer it.
      'Link': `<${INTAKE_PATH}>; rel="alternate"`,
      // 410 is cacheable by default. If the federation ever wants this path
      // back, a response cached for a year would outlive the decision.
      'Cache-Control': 'no-store',
    },
  });
