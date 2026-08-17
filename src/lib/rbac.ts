// MMAKF authorisation — the single policy choke point (§65, §38, §75).
//
// Every federation endpoint and page loader asks this module the same question:
//
//     can(principal, action, resource) -> boolean
//
// Rules:
//  · DENY BY DEFAULT. An action not explicitly granted to a role is refused.
//  · SCOPE IS ALWAYS CHECKED. A state admin may only touch rows inside their
//    own state; a dojo admin only their own dojo. This is what prevents IDOR:
//    knowing an id is never sufficient, the id must fall inside the caller's
//    scope.
//  · Bindings must be active and unexpired.
//  · No page or endpoint may re-implement these checks locally.

// ─── Roles (§65) ────────────────────────────────────────────────────────────

export const ROLES = [
  'SUPER_ADMIN',
  'FEDERATION_ADMIN',
  'PRESIDENT',
  'GENERAL_SECRETARY',
  'TECHNICAL_DIRECTOR',
  'STATE_ADMIN',
  'DISTRICT_ADMIN',
  'DOJO_ADMIN',
  'INSTRUCTOR',
  'EXAMINER',
  'REFEREE',
  'JUDGE',
  'ATHLETE',
  'MEMBER',
  'FINANCE_OFFICER',
  'SAFEGUARDING_OFFICER',

  // ── Operations roles ──────────────────────────────────────────────────────
  // The federation runs a training and engagement operation alongside the
  // sport. These roles exist because the alternative is "give them
  // FEDERATION_ADMIN", and that hands someone who schedules school programmes
  // the authority to revoke ranks and finalise competition results.
  'TRAINING_DIRECTOR',
  'TRAINING_OPERATIONS',
  'SCHOOL_PROGRAM_MANAGER',
  'CORPORATE_PROGRAM_MANAGER',
  'UNIVERSITY_PROGRAM_MANAGER',
  'COACH_MANAGER',
  'COMPETITION_ADMIN',
  'EDUCATION_OFFICER',
  'MEDIA_OFFICER',
  'SUPPORT_AGENT',
  'HR_OFFICER',
  'MEDICAL_OFFICER',
  'AUDITOR',

  // ── Institution-side roles ────────────────────────────────────────────────
  // Held by people at a client school, corporate or university — never by
  // federation staff. They are bound at 'institution' scope, which contains no
  // federation resource at all, so they cannot reach federation data whatever
  // id they guess.
  'INSTITUTION_ADMIN',
  'INSTITUTION_COORDINATOR',
  'PARENT',
] as const;

export type Role = (typeof ROLES)[number];

// 'institution' is a TENANT scope, not another rung of the federation
// hierarchy. A school is a client, not a unit: it sits outside
// national/state/district/dojo entirely, and that is exactly what makes it
// safe. scopeContains() gives an institution binding no federation resource.
export type ScopeType = 'national' | 'state' | 'district' | 'dojo' | 'institution';

/** Actions are `domain:verb`. Keep them coarse enough to reason about. */
export type Action =
  | 'unit:read' | 'unit:write' | 'unit:charter'
  | 'dojo:read' | 'dojo:write' | 'dojo:approve'
  | 'person:read' | 'person:read_pii' | 'person:write'
  | 'membership:read' | 'membership:issue' | 'membership:revoke'
  | 'rank:read' | 'rank:award' | 'rank:revoke'
  | 'grading:read' | 'grading:score' | 'grading:approve'
  | 'certificate:read' | 'certificate:issue' | 'certificate:revoke'
  | 'competition:read' | 'competition:write' | 'competition:sanction'
  | 'result:read' | 'result:enter' | 'result:finalize'
  | 'content:read' | 'content:write'
  // The technical knowledge library — sources, movement-level kata, bunkai,
  // terminology and the media↔technique graph. NOT folded into 'content:*',
  // and the distinction is the point: 'content:write' is editorial authority
  // over what the federation SAYS, while 'technical:review' is the authority to
  // declare that a technique, an application or a third party's video meets the
  // federation's technical standard. A communications officer holds the first
  // and must not hold the second. Rights clearance is reviewed under
  // 'technical:review' too, because approving a video MMAKF may not lawfully
  // publish is the same class of mistake as approving one that is technically
  // wrong — both put the federation's name to something it should not.
  | 'technical:read' | 'technical:review'
  | 'finance:read' | 'finance:write'
  | 'safeguarding:read' | 'safeguarding:write'
  | 'audit:read'
  | 'user:read' | 'user:write' | 'role:grant'
  // Training and engagement: the lead pipeline, institutional clients and
  // training requests. NOT folded into 'unit:*' — a state unit is part of the
  // federation and a school that buys a term of karate is a client, and giving
  // one action authority over both puts a customer inside the hierarchy.
  | 'engagement:read' | 'engagement:write'
  // The marketplace review queues: seller applications and item listings.
  // NOT folded into 'content:write' — content authority is national in this
  // model, and folding review into it would mean no scoped administrator could
  // ever approve a seller in their own state. NOT folded into 'finance:*'
  // either: approving what may be offered for sale is an editorial and
  // standing decision, and a finance officer reconciling settlements has no
  // business deciding whether a gi may be advertised.
  | 'marketplace:read' | 'marketplace:review' | 'marketplace:suspend'
  // ── Added with the marketplace platform (migration 0029) ──────────────────
  //
  // Five more, and each is here because folding it into one of the three above
  // would hand somebody an authority nobody meant them to have.
  //
  // 'marketplace:verify' is the identity, GST, PAN and BANK evidence. NOT
  // 'marketplace:review', because reviewing whether a gi may be advertised is
  // an editorial judgement and this is reading somebody's tax registration and
  // the last four digits of their bank account. A state officer who vets local
  // traders needs it; a content reviewer does not.
  //
  // 'marketplace:brand' decides who may claim to be an authorised distributor.
  // NATIONAL ONLY, because a brand relationship is national by nature — a
  // letter from Adidas is not a Jharkhand fact — and because the counterfeit
  // regime is worth nothing if twelve state offices can each recognise a
  // different set of authorisations.
  //
  // 'marketplace:commission' SETS WHAT SELLERS ARE CHARGED. Emphatically not
  // 'finance:write', which is reconciliation and reporting: whoever reconciles
  // the money must not also be able to change the rate that produced it. It is
  // also not 'feeframework:*' — that prices what MMAKF sells to its own
  // members, and this prices what MMAKF takes from other people's sales.
  //
  // 'marketplace:settle' releases money to sellers. Separate from
  // 'marketplace:commission' so that the person who sets the rate and the
  // person who pays out against it can be two people, which is the whole of
  // segregation of duties in a marketplace.
  //
  // 'marketplace:dispute' decides between a buyer and a seller and can order a
  // refund. Not 'support:*', because a support agent resolving a delivery query
  // should not be able to award ₹40,000 against a trader.
  | 'marketplace:verify' | 'marketplace:brand'
  | 'marketplace:commission' | 'marketplace:settle' | 'marketplace:dispute'

  // ── Operations ────────────────────────────────────────────────────────────
  // Coach management is separate from 'person:*'. Every coach is a person, but
  // reading a person record is not the same authority as reading someone's
  // interview notes, references and performance history.
  | 'coach:read' | 'coach:write' | 'coach:review' | 'coach:assign'
  // A programme is the configured thing a client receives. Distinct from
  // 'content:*', which is editorial copy.
  | 'program:read' | 'program:write' | 'program:approve' | 'program:publish'
  // Quoting is split three ways deliberately. Reading a quote, issuing one and
  // approving one are three different jobs, and one person holding all three is
  // how a discount gets granted with nobody else in the room.
  | 'quote:read' | 'quote:issue' | 'quote:approve'
  // The pricing RULES, as opposed to the quotes produced from them. PART AC:
  // institution users must never reach these. Nor may most federation staff —
  // whoever edits a rule changes every future quote silently.
  | 'feeframework:read' | 'feeframework:write' | 'feeframework:publish'
  // Concessions — a reduction granted because of a PERSON'S CIRCUMSTANCES.
  //
  // NOT folded into 'quote:approve', and that is the whole point. A commercial
  // discount is approved by whoever approves pricing; a hardship award is a
  // welfare judgement, it is decided against a statement somebody wrote about
  // their own life, and the two must be holdable by different people. Reusing
  // 'quote:approve' for both would have made "different approval authority"
  // literally the same authority, and would have put a family's circumstances
  // in front of everybody who signs off a volume discount.
  //
  // NOR folded into 'safeguarding:*', which is child protection casework and a
  // graver thing again. Commercial discounts stay on 'feeframework:*' and
  // 'quote:approve' — see src/db/discounts.ts, where each function names the
  // action it asserts.
  | 'concession:read' | 'concession:decide'
  // What OTHER organisations charge. NOT folded into 'feeframework:*', because
  // they are opposite kinds of thing: a fee rule is MMAKF's own commercial
  // policy, and a benchmark is a recorded claim about a third party's. Somebody
  // may reasonably compile market evidence without any authority to price
  // anything, and — the direction that matters more — holding the market
  // evidence must never imply the authority to turn it into a price. Both
  // remain absent from every institution role: PART AC keeps a client away from
  // MMAKF's pricing preparation as firmly as from its pricing rules.
  | 'benchmark:read' | 'benchmark:write'
  | 'contract:read' | 'contract:write'
  | 'booking:read' | 'booking:write'
  | 'venue:read' | 'venue:write'
  | 'attendance:read' | 'attendance:write'
  | 'task:read' | 'task:write'
  | 'support:read' | 'support:write' | 'support:escalate'
  | 'document:read' | 'document:write'
  | 'report:read' | 'export:run'
  | 'workflow:read' | 'workflow:write'
  | 'notification:read' | 'notification:send'
  | 'seo:read' | 'seo:write'

  // ── The identity foundation (migration 0025) ──────────────────────────────
  //
  // Note there is no 'geo:read'. Civil geography is a MAP, and resolving "which
  // district is Guwahati in" happens on the public intake path where the caller
  // holds nothing at all. Gating that read would mean either an unauthenticated
  // permission check that always passes — which teaches the codebase that such
  // things exist — or a registration form that cannot resolve an address.
  // Writing the map is national reference-data maintenance, and is gated.
  | 'geo:write'

  // Verifying that somebody really is a child's guardian, and granting what
  // that guardian may then see. NOT folded into 'person:write': that action is
  // held by every dojo administrator so they can correct a member's telephone
  // number, and the ability to attach an adult to a child's record is not the
  // same kind of act. Held by SAFEGUARDING_OFFICER, who otherwise holds almost
  // nothing, precisely because this is the office that answers for it.
  | 'guardian:verify'

  // Deciding that two records are one human being, and deciding a change to a
  // governed field. Both are separated from 'person:write' for the same reason:
  // a merge and a date-of-birth change alter competition eligibility and what a
  // certificate already in somebody's hands means, and neither should be within
  // reach of the routine authority to edit a profile.
  | 'duplicate:review'
  | 'profilechange:decide'

  // ── The regulatory engine (migration 0027) ────────────────────────────────
  //
  // SOURCE MATERIAL AND FEDERATION POLICY ARE DIFFERENT AUTHORITIES, and that
  // is the whole reason there are two families here rather than one.
  //
  // 'source:*' is research: recording that karateacademy.in publishes a 4th Kyu
  // requirement, with the URL, the excerpt and the date it was read. It asserts
  // nothing about MMAKF. Somebody may reasonably compile the register without
  // any authority to make a rule — and, the direction that matters more,
  // holding the evidence must never imply the authority to turn it into policy.
  // The same asymmetry 'benchmark:*' has against 'feeframework:*', for the same
  // reason: a recorded claim about a third party is not a decision.
  //
  // 'policy:write' drafts an instrument. 'policy:approve' is the governance act
  // that makes a version binding, and 'policy:publish' is the separate act of
  // putting it in front of members. Three actions rather than one because a
  // person who can draft a regulation, approve it and publish it in the same
  // afternoon is a person who can make a rule with nobody else in the room —
  // and every determination this engine produces cites the rule that person
  // wrote. src/db/policy.ts additionally refuses to publish a version that
  // carries no approver and no approval date, so the separation survives even
  // where one principal happens to hold all three.
  //
  // All five are inside NATIONAL_FULL. That is not a widening: canGrantRole()
  // refuses to confer an action the granter does not already hold, so omitting
  // 'policy:approve' there would leave FEDERATION_ADMIN unable to grant
  // PRESIDENT or GENERAL_SECRETARY at all — the exact defect
  // tests/tenant-isolation.test.ts found for HR_OFFICER.
  //
  // Note there is no 'policy:evaluate'. Asking which rule is in force is a READ
  // of published policy and runs on the public intake path where the caller
  // holds nothing; gating it would mean a registration form that cannot tell an
  // applicant why they are ineligible. Reading DRAFT material is 'policy:read',
  // and recording a DETERMINATION against a named person is 'policy:write'.
  | 'source:read' | 'source:write'
  | 'policy:read' | 'policy:write' | 'policy:approve' | 'policy:publish'

  // ── The scheduling engine (migration 0032) ────────────────────────────────
  //
  // A CLUB'S HOURS ARE THE CLUB'S TO SET. That is the whole reason these three
  // exist rather than reusing 'venue:write': a venue is a room in the estate and
  // 'venue:write' is national and district administration, whereas the timetable
  // is the thing a DOJO_ADMIN must be able to change on a Tuesday without asking
  // anybody — otherwise the federation is back to a developer editing a seed
  // file, which is the defect the engine was built to end.
  //
  // 'schedule:read' gates only the PRIVATE half — the reason an administrator
  // typed for a closure, which is routinely a bereavement or a safeguarding
  // matter. The hours themselves are public and are read through
  // publicTimetable(), which takes no principal at all, so gating the read is
  // not a door in front of a public timetable.
  //
  // 'schedule:publish' is separated from 'schedule:write' for the reason
  // 'policy:approve' is separated from 'policy:write': drafting next term's
  // timetable and putting it in front of two hundred families are different
  // acts, and the second one changes when a child is expected at a dojo. A
  // DISTRICT_ADMIN drafts; the club and the state publish.
  | 'schedule:read' | 'schedule:write' | 'schedule:publish'

  // HR and medical sit deliberately outside NATIONAL_FULL. PART X says HR data
  // must not be exposed to ordinary administrators, and for this purpose a
  // federation administrator is an ordinary administrator.
  | 'hr:read' | 'hr:write'
  | 'medical:read' | 'medical:write';

export interface Binding {
  role: Role;
  scopeType: ScopeType;
  scopeId: number | null;   // null == national
  status?: string;          // 'active' unless stated
  expiresAt?: Date | string | null;
}

export interface Principal {
  userId: number | null;
  label: string;            // for audit records
  bindings: Binding[];
}

/** Where a resource sits in the federation hierarchy. */
export interface Resource {
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  dojoId?: number | null;
  /** For self-service: the person this resource belongs to. */
  personId?: number | null;
  /**
   * The client institution this resource belongs to, if any.
   *
   * A federation resource leaves this undefined, and that is what keeps an
   * institution binding away from it: `undefined === 7` is false, so the check
   * fails closed without needing a rule written per resource type.
   */
  institutionId?: number | null;
}

// ─── Role → permitted actions ───────────────────────────────────────────────

const NATIONAL_FULL: Action[] = [
  'unit:read', 'unit:write', 'unit:charter',
  'dojo:read', 'dojo:write', 'dojo:approve',
  'person:read', 'person:read_pii', 'person:write',
  'membership:read', 'membership:issue', 'membership:revoke',
  'rank:read', 'rank:award', 'rank:revoke',
  'grading:read', 'grading:score', 'grading:approve',
  'certificate:read', 'certificate:issue', 'certificate:revoke',
  'competition:read', 'competition:write', 'competition:sanction',
  'result:read', 'result:enter', 'result:finalize',
  'content:read', 'content:write',
  'technical:read', 'technical:review',
  'finance:read', 'finance:write',
  'audit:read',
  'user:read', 'user:write', 'role:grant',
  'engagement:read', 'engagement:write',
  'marketplace:read', 'marketplace:review', 'marketplace:suspend',
  // The national office holds all five of the marketplace platform actions —
  // and holding them here is also what lets a FEDERATION_ADMIN grant them to
  // anybody else, because canGrantRole() refuses to confer an action the
  // granter does not have. Without these lines a federation administrator
  // could not appoint a finance officer at all.
  'marketplace:verify', 'marketplace:brand',
  'marketplace:commission', 'marketplace:settle', 'marketplace:dispute',
  'coach:read', 'coach:write', 'coach:review', 'coach:assign',
  'program:read', 'program:write', 'program:approve', 'program:publish',
  'quote:read', 'quote:issue', 'quote:approve',
  'feeframework:read', 'feeframework:write', 'feeframework:publish',
  // Held nationally because a concession is a federation-level welfare
  // decision, and because canGrantRole() refuses to confer an action the
  // granter does not hold: without it here, a FEDERATION_ADMIN could not grant
  // FINANCE_OFFICER or AUDITOR at all once either gained 'concession:read'.
  'concession:read', 'concession:decide',
  'benchmark:read', 'benchmark:write',
  'contract:read', 'contract:write',
  'booking:read', 'booking:write',
  'venue:read', 'venue:write',
  'attendance:read', 'attendance:write',
  'task:read', 'task:write',
  'support:read', 'support:write', 'support:escalate',
  'document:read', 'document:write',
  'report:read', 'export:run',
  'workflow:read', 'workflow:write',
  'notification:read', 'notification:send',
  'seo:read', 'seo:write',
  // The identity foundation. 'geo:write' is reference-data maintenance and is
  // national by nature — a district boundary is not a state unit's to redraw.
  // The other three are here rather than only on SUPER_ADMIN because a national
  // administrator has to be able to work the duplicate and change queues, and
  // because canGrantRole() refuses to confer an action the granter lacks:
  // without them here, a FEDERATION_ADMIN could not grant STATE_ADMIN at all
  // once that role gained them.
  'geo:write', 'guardian:verify', 'duplicate:review', 'profilechange:decide',
  // The regulatory engine. All five sit here for the canGrantRole() reason
  // given at the Action union: PRESIDENT and GENERAL_SECRETARY hold
  // 'policy:approve', and a FEDERATION_ADMIN who did not hold it could not
  // grant either role. The separation of duties this subsystem needs is
  // enforced on the RECORD — a version cannot be published without a named
  // approver and an approval date — rather than by making an office
  // unassignable.
  'source:read', 'source:write',
  'policy:read', 'policy:write', 'policy:approve', 'policy:publish',
  // The scheduling engine. All three, for the canGrantRole() reason given above
  // and given at the Action union: a DOJO_ADMIN holds all three so a club can
  // run its own timetable, and a FEDERATION_ADMIN who did not hold them could
  // not appoint a club administrator at all.
  'schedule:read', 'schedule:write', 'schedule:publish',
  // Note the two that are ABSENT: 'hr:*' and 'medical:*'. Their absence is why
  // HR_OFFICER and MEDICAL_OFFICER appear in RESTRICTED_ROLES below — the
  // no-amplification rule in canGrantRole() then stops a FEDERATION_ADMIN from
  // minting one of those roles and reading the data through it.
];

const GRANTS: Record<Role, Action[]> = {
  /**
   * The root of the authority tree. Holds everything, including the three
   * action families NATIONAL_FULL deliberately withholds.
   *
   * 'hr:*' and 'medical:*' were originally omitted here as well as from
   * NATIONAL_FULL, on the reasoning that nobody should hold HR data casually.
   * The effect was that NOBODY COULD GRANT HR_OFFICER OR MEDICAL_OFFICER AT
   * ALL: canGrantRole() refuses to confer an action the granter does not
   * already hold, so both roles existed, conferred real authority, and were
   * unassignable. tests/tenant-isolation.test.ts found it by asking whether a
   * SUPER_ADMIN could grant one.
   *
   * Restoring them here does not widen ordinary administration by one action.
   * FEDERATION_ADMIN still holds neither, and both roles remain in
   * RESTRICTED_ROLES, so conferring them stays a SUPER_ADMIN act — which is the
   * separation PART X actually asked for. The root of a tree holding everything
   * beneath it is the point of having a root; SUPER_ADMIN already holds
   * safeguarding, which is more sensitive than either.
   */
  SUPER_ADMIN: [
    ...NATIONAL_FULL,
    'safeguarding:read', 'safeguarding:write',
    'hr:read', 'hr:write',
    'medical:read', 'medical:write',
  ],

  // Operational national administration — no safeguarding case access.
  FEDERATION_ADMIN: NATIONAL_FULL,

  PRESIDENT: [
    'unit:read', 'dojo:read', 'dojo:approve', 'person:read',
    'membership:read', 'rank:read', 'grading:read', 'grading:approve',
    'certificate:read', 'certificate:issue',
    'competition:read', 'competition:sanction', 'result:read',
    'content:read', 'finance:read', 'audit:read',
    // Approves regulations; does NOT draft or publish them. The office that
    // signs a rule off should not also be the office that wrote it, and
    // 'policy:write' is absent here deliberately rather than by oversight.
    'source:read', 'policy:read', 'policy:approve',
  ],

  GENERAL_SECRETARY: [
    'unit:read', 'unit:write', 'dojo:read', 'dojo:write', 'dojo:approve',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'membership:issue', 'membership:revoke',
    'rank:read', 'certificate:read', 'certificate:issue',
    'competition:read', 'competition:write', 'result:read',
    'content:read', 'content:write', 'audit:read', 'user:read',
    // Held the help desk through 'person:read_pii' before it was re-gated on
    // 'support:*'. Granted explicitly so the change narrowed nobody's reach.
    'support:read', 'support:write',
    // The secretariat drafts and issues the federation's instruments, and
    // maintains the source register behind them. It holds 'policy:approve' too
    // — a general secretary is a signing officer — but publication of a version
    // it drafted still requires a recorded approver and approval date, which is
    // where the second pair of eyes is actually enforced.
    'source:read', 'source:write',
    'policy:read', 'policy:write', 'policy:approve', 'policy:publish',
  ],

  // Technical authority: syllabus, gradings, ranks — not finance or users.
  TECHNICAL_DIRECTOR: [
    'unit:read', 'dojo:read', 'person:read',
    'rank:read', 'rank:award', 'rank:revoke',
    'grading:read', 'grading:score', 'grading:approve',
    'certificate:read', 'certificate:issue',
    'content:read', 'content:write', 'audit:read',
    // The technical library is this role's own domain: the technical committee
    // decides what counts as a correct application, which sources the
    // federation stands behind, and which third-party video may be shown as
    // instruction. 'technical:review' is what the CHECK constraints in
    // migration 0031 demand a name for — an approval row must record the person
    // who made it, and this is the role that can be that person.
    'technical:read', 'technical:review',
    // Drafts the technical instruments — grading, examination, competition,
    // uniform — and maintains the source register they are traced to. NOT
    // 'policy:approve' and NOT 'policy:publish': a technical authority that
    // could approve its own syllabus regulation is the arrangement a grading
    // appeal exists to challenge.
    'source:read', 'source:write', 'policy:read', 'policy:write',
  ],

  // Scoped administrators — same verbs, but their bindings are state/district/
  // dojo-scoped so `can()` restricts them to their own rows.
  STATE_ADMIN: [
    'unit:read', 'unit:write',
    'dojo:read', 'dojo:write',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'membership:issue',
    'rank:read', 'grading:read', 'certificate:read',
    'competition:read', 'competition:write', 'result:read', 'result:enter',
    'content:read',
    'engagement:read', 'engagement:write',
    // As GENERAL_SECRETARY above: preserved across the support desk re-gating.
    'support:read', 'support:write',
    // Scoped by their binding, so a state administrator reviews the sellers and
    // listings of their own state and no other. Note this does NOT include
    // 'role:grant': a state administrator still cannot confer a role, so the
    // role-application queue is empty for them. That is the existing authority
    // model, not a decision taken here — see reviewApplication() in
    // src/db/onboarding.ts, which says so out loud rather than widening it.
    'marketplace:read', 'marketplace:review', 'marketplace:suspend',
    // Vets the traders in their own state, which is the office that actually
    // meets them. NOT 'marketplace:brand' — a letter of authorisation from a
    // manufacturer is a national fact, and a counterfeit regime in which twelve
    // state offices each recognise a different set of authorisations is not a
    // regime. NOT 'marketplace:commission' or 'marketplace:settle' either:
    // what MMAKF charges and what MMAKF pays out are national decisions, and a
    // state administrator who could set a commission could set their own.
    'marketplace:verify',
    // The identity queues, scoped by their binding: a state administrator works
    // the duplicates and the profile-change requests of people placed in their
    // own state, because the queue functions in src/db/identity.ts join
    // `persons` and filter on visibleScopes(). NOT 'geo:write' — the map is
    // national reference data, and a state redrawing a district boundary would
    // change what every other state's addresses resolve to.
    'guardian:verify', 'duplicate:review', 'profilechange:decide',
    // Sets the state's own hours and may publish for the clubs beneath it — the
    // scope check does the containing, so this reaches the state's dojos and no
    // others.
    'schedule:read', 'schedule:write', 'schedule:publish',
  ],

  DISTRICT_ADMIN: [
    'unit:read', 'dojo:read', 'dojo:write',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'rank:read', 'grading:read',
    'competition:read', 'result:read', 'result:enter', 'content:read',
    'support:read', 'support:write',
    // Drafts, and does NOT publish. A district may prepare a district-wide
    // timetable and set its own office hours; putting a club's new hours in
    // front of its families is the club's act or the state's, not an
    // intermediate tier's — see the note at the Action union.
    'schedule:read', 'schedule:write',
  ],

  DOJO_ADMIN: [
    'dojo:read', 'dojo:write',
    'person:read', 'person:read_pii', 'person:write',
    'membership:read', 'rank:read', 'grading:read',
    'competition:read', 'result:read', 'content:read',
    'support:read', 'support:write',
    // ALL THREE, and this is the point of the whole scheduling wave: a club sets
    // its own hours, its own seasons, its own class times and its own holidays,
    // and publishes them, without the federation and without a developer. The
    // binding is dojo-scoped, so it reaches exactly one club's rows.
    'schedule:read', 'schedule:write', 'schedule:publish',
    // A club takes bookings for its own classes.
    'booking:read', 'booking:write',
  ],

  INSTRUCTOR: [
    'dojo:read', 'person:read', 'membership:read',
    'rank:read', 'grading:read', 'competition:read', 'result:read', 'content:read',
    // Reads the timetable in full, including why a day is closed — an
    // instructor turning up to a shut dojo is the failure this prevents. NOT
    // 'schedule:write': who teaches when is the club's decision, not the
    // individual instructor's.
    'schedule:read',
  ],

  // An examiner scores; only the approving authority finalises (§30).
  EXAMINER: [
    'person:read', 'rank:read', 'grading:read', 'grading:score', 'content:read',
  ],

  REFEREE: ['competition:read', 'result:read', 'result:enter', 'content:read'],
  JUDGE: ['competition:read', 'result:read', 'result:enter', 'content:read'],

  ATHLETE: ['person:read', 'rank:read', 'certificate:read', 'competition:read', 'result:read', 'content:read'],
  MEMBER: ['person:read', 'content:read'],

  FINANCE_OFFICER: [
    'finance:read', 'finance:write', 'person:read', 'membership:read', 'audit:read',
    'content:read', 'engagement:read',
    // Finance reconciles against quotes and contracts, so it reads both — and
    // issues neither. Reading the money a programme will bring in is a
    // different authority from setting it.
    'quote:read', 'contract:read', 'report:read', 'export:run', 'document:read',
    // Restored explicitly when src/db/fees.ts stopped gating the fee framework
    // on 'finance:write'. Finance could author and publish a framework through
    // that action, so it keeps both — and now holds them by name, where the
    // grant can be argued with, rather than as a side effect of a payments
    // permission.
    'feeframework:read', 'feeframework:write', 'feeframework:publish',
    // Compiles and curates the market evidence. Holding both halves here is
    // defensible only because 'benchmark:write' confers nothing about MMAKF's
    // own prices: src/db/fee-recommendation.ts cannot write a fee rule from any
    // amount of benchmark authority, so a finance officer who added a
    // convenient benchmark would still have to author a rule and find a second
    // person to publish it.
    'benchmark:read', 'benchmark:write',
    // READ, and deliberately NOT 'concession:decide'. Finance has to reconcile
    // a reduced invoice against the award that reduced it, and has no business
    // deciding whether a family's circumstances qualify.
    'concession:read',
    // ── The marketplace money (migration 0029) ──────────────────────────────
    //
    // 'marketplace:read' so the treasurer can see the seller orders behind the
    // settlements; 'marketplace:commission' and 'marketplace:settle' because
    // setting what the federation charges and releasing what it owes are
    // finance work.
    //
    // AND NOT 'marketplace:review' OR 'marketplace:suspend'. Finance must not
    // be able to approve a seller or take one off the marketplace: whoever
    // decides who may trade should not also be the office that pays them, and
    // a finance officer who could suspend a seller could suspend the one whose
    // settlement they had got wrong.
    //
    // Whether one person should hold BOTH 'marketplace:commission' and
    // 'marketplace:settle' is MMAKF's call, not this file's. They are separate
    // actions precisely so the federation can split them by appointing a second
    // officer; granting both to FINANCE_OFFICER by default matches how the
    // federation is actually staffed today, and the split is available the day
    // it is not.
    'marketplace:read', 'marketplace:commission', 'marketplace:settle',
  ],
  // Gains both halves of the concession authority. A hardship award is the
  // closest thing in this system to welfare casework, and this is the office
  // that already holds the judgement and the confidentiality for it. The role
  // is in RESTRICTED_ROLES, so only a SUPER_ADMIN may confer it.
  SAFEGUARDING_OFFICER: [
    'safeguarding:read', 'safeguarding:write', 'person:read', 'person:read_pii', 'audit:read',
    'concession:read', 'concession:decide',
    // Who may act for a child is this office's question before it is anybody
    // else's. Note what holding 'guardian:verify' does NOT by itself allow:
    // grantGuardianCapability() in src/db/identity.ts additionally demands
    // 'safeguarding:write' before it will grant a guardian sight of a
    // safeguarding record — so the sensitive capabilities are gated twice, and
    // an operational administrator who holds the first check fails the second.
    'guardian:verify',
  ],

  // ── Operations ────────────────────────────────────────────────────────────

  // Owns the training and engagement operation end to end. Reads the fee
  // framework, and cannot write it: changing a pricing rule alters every future
  // quote at once, which is a federation-level act rather than an operational
  // one.
  TRAINING_DIRECTOR: [
    'person:read', 'content:read', 'unit:read', 'dojo:read',
    'engagement:read', 'engagement:write',
    'program:read', 'program:write', 'program:approve', 'program:publish',
    'quote:read', 'quote:issue', 'quote:approve',
    'feeframework:read',
    // Reads the market evidence and cannot add to it. Whoever decides which
    // figures count as evidence should not also be the person the evidence is
    // used to persuade.
    'benchmark:read',
    'contract:read', 'contract:write',
    'booking:read', 'booking:write',
    'venue:read', 'attendance:read',
    'coach:read', 'coach:assign',
    'task:read', 'task:write',
    'document:read', 'document:write',
    'support:read',
    'report:read', 'export:run',
    'workflow:read',
    'notification:read', 'notification:send',
    // Owns the federation's own training calendar, so all three. Bound
    // nationally in practice, which is what makes it reach every unit —
    // deliberately, because a national training director rescheduling a national
    // camp is exactly the case the inheritance chain exists for.
    'schedule:read', 'schedule:write', 'schedule:publish',
  ],

  // Runs the day to day: intake, programme configuration, scheduling,
  // attendance. Issues quotes and cannot approve them — the one separation in
  // this file that exists to stop a single person discounting unobserved.
  TRAINING_OPERATIONS: [
    'person:read', 'content:read',
    'engagement:read', 'engagement:write',
    'program:read', 'program:write',
    'quote:read', 'quote:issue',
    'booking:read', 'booking:write',
    'venue:read', 'attendance:read', 'attendance:write',
    'coach:read',
    'task:read', 'task:write',
    'document:read',
    'support:read', 'support:write',
    'report:read',
    'notification:read', 'notification:send',
    // Builds the timetable and does not put it in force. The one separation in
    // this role's grants already exists for quotes — issues, cannot approve —
    // and it is the same reasoning: the person who prepares a change should not
    // be the only person who makes it real.
    'schedule:read', 'schedule:write',
  ],

  // The three sector managers hold an identical action set. They are separate
  // ROLES because the lead router needs to know who handles schools and who
  // handles corporates, and role identity carries that meaning where the action
  // set cannot. See routeLead() in src/db/applications.ts.
  SCHOOL_PROGRAM_MANAGER: [
    'person:read', 'content:read', 'engagement:read', 'engagement:write',
    'program:read', 'program:write', 'quote:read', 'quote:issue',
    'booking:read', 'booking:write', 'venue:read',
    'attendance:read', 'attendance:write', 'coach:read',
    'task:read', 'task:write', 'document:read',
    'support:read', 'support:write', 'report:read',
    'notification:read', 'notification:send',
  ],
  CORPORATE_PROGRAM_MANAGER: [
    'person:read', 'content:read', 'engagement:read', 'engagement:write',
    'program:read', 'program:write', 'quote:read', 'quote:issue',
    'booking:read', 'booking:write', 'venue:read',
    'attendance:read', 'attendance:write', 'coach:read',
    'task:read', 'task:write', 'document:read',
    'support:read', 'support:write', 'report:read',
    'notification:read', 'notification:send',
  ],
  UNIVERSITY_PROGRAM_MANAGER: [
    'person:read', 'content:read', 'engagement:read', 'engagement:write',
    'program:read', 'program:write', 'quote:read', 'quote:issue',
    'booking:read', 'booking:write', 'venue:read',
    'attendance:read', 'attendance:write', 'coach:read',
    'task:read', 'task:write', 'document:read',
    'support:read', 'support:write', 'report:read',
    'notification:read', 'notification:send',
  ],

  // Runs the coach pipeline and assignment. Holds person:read_pii because
  // screening a candidate means reading their documents. Holds no 'hr:*' — pay,
  // leave and grievance sit with HR_OFFICER and are not visible from here.
  COACH_MANAGER: [
    'person:read', 'person:read_pii', 'content:read',
    'coach:read', 'coach:write', 'coach:review', 'coach:assign',
    'booking:read', 'attendance:read', 'venue:read',
    'engagement:read', 'program:read',
    'task:read', 'task:write',
    'document:read', 'document:write',
    'report:read',
    'notification:read', 'notification:send',
  ],

  COMPETITION_ADMIN: [
    'person:read', 'content:read', 'unit:read', 'dojo:read',
    'competition:read', 'competition:write',
    'result:read', 'result:enter', 'result:finalize',
    'venue:read', 'venue:write', 'booking:read',
    'task:read', 'task:write', 'document:read',
    'report:read', 'notification:read', 'notification:send',
  ],

  EDUCATION_OFFICER: [
    'person:read', 'content:read', 'content:write',
    'program:read', 'program:write',
    'certificate:read', 'grading:read',
    'document:read', 'document:write',
    'task:read', 'report:read', 'notification:read',
  ],

  MEDIA_OFFICER: [
    'content:read', 'content:write', 'document:read',
    'seo:read', 'seo:write', 'person:read', 'notification:read',
  ],

  // Answers tickets. Deliberately has no person:read_pii: a support agent needs
  // to find the account that raised a ticket, not to read its identity
  // documents.
  SUPPORT_AGENT: [
    'person:read', 'content:read',
    'support:read', 'support:write', 'support:escalate',
    'task:read', 'task:write',
    'engagement:read', 'booking:read', 'program:read', 'document:read',
    'notification:read', 'notification:send',
  ],

  // PART X. Restricted at grant time — see RESTRICTED_ROLES.
  HR_OFFICER: [
    'hr:read', 'hr:write',
    'person:read', 'person:read_pii',
    'coach:read',
    'task:read', 'task:write',
    'document:read', 'document:write',
    'report:read', 'audit:read',
  ],

  MEDICAL_OFFICER: [
    'medical:read', 'medical:write',
    'person:read', 'person:read_pii', 'audit:read',
  ],

  // Read-only by construction. There is no writing verb anywhere in this list,
  // which is the whole point: an auditor who can change a record is not an
  // auditor.
  AUDITOR: [
    'audit:read',
    'unit:read', 'dojo:read', 'person:read',
    'membership:read', 'rank:read', 'grading:read', 'certificate:read',
    'competition:read', 'result:read',
    'content:read', 'finance:read',
    'engagement:read', 'program:read', 'quote:read', 'feeframework:read',
    // An auditor asked "what was this price based on?" needs to see the
    // evidence and the rows somebody excluded from it.
    'benchmark:read',
    // An auditor must be able to see that concessions were decided by somebody
    // other than the person who took the application, which is exactly the
    // control that would otherwise be unverifiable. Read only, like everything
    // else in this list.
    'concession:read',
    'contract:read', 'booking:read', 'venue:read', 'attendance:read',
    'coach:read', 'task:read', 'support:read', 'document:read',
    'workflow:read', 'report:read', 'export:run', 'notification:read',
    // "Under which rule, approved by whom, effective from when?" is the audit
    // question this whole subsystem exists to answer, and an auditor who could
    // not read the draft chain could only ever confirm the published story.
    // Read only, like everything else in this list.
    'source:read', 'policy:read',
  ],

  // ── Institution side ──────────────────────────────────────────────────────
  // Bound at 'institution' scope. Note what is missing from all three:
  // 'feeframework:*' (PART AC — a client must never see the pricing rules),
  // 'quote:issue', 'quote:approve', 'finance:*' and 'certificate:issue'.

  INSTITUTION_ADMIN: [
    'person:read', 'content:read',
    'program:read',
    'quote:read', 'contract:read',
    'booking:read', 'booking:write',
    'attendance:read',
    'document:read',
    'support:read', 'support:write',
    'report:read',
    'task:read',
    'notification:read',
  ],

  INSTITUTION_COORDINATOR: [
    'person:read', 'content:read',
    'program:read', 'booking:read',
    'attendance:read', 'attendance:write',
    'document:read',
    'support:read', 'support:write',
    'notification:read',
  ],

  // A parent sees their own child and nothing else. The narrowing to "their own
  // child" is not done here — it is a row-level predicate applied where the
  // query is built, because this module answers about scopes, not about
  // families.
  PARENT: [
    'person:read', 'content:read',
    'attendance:read', 'certificate:read', 'grading:read',
    'support:read', 'support:write',
    'notification:read',
  ],
};

// ─── Scope logic ────────────────────────────────────────────────────────────

function bindingActive(b: Binding): boolean {
  if (b.status && b.status !== 'active') return false;
  if (b.expiresAt) {
    const exp = b.expiresAt instanceof Date ? b.expiresAt : new Date(b.expiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= Date.now()) return false;
  }
  return true;
}

/**
 * Does a binding's scope contain the resource?
 * National contains everything. A state binding contains resources in that
 * state. District and dojo bindings must match exactly.
 *
 * A resource with NO location (e.g. site-wide content) is only reachable from
 * a national binding — a state admin cannot edit national content.
 */
function scopeContains(b: Binding, r: Resource): boolean {
  switch (b.scopeType) {
    case 'national':
      return true;
    case 'state':
      return b.scopeId != null && r.stateUnitId === b.scopeId;
    case 'district':
      return b.scopeId != null && r.districtUnitId === b.scopeId;
    case 'dojo':
      return b.scopeId != null && r.dojoId === b.scopeId;
    case 'institution':
      // Both sides must be present. A federation resource carries no
      // institutionId, so this is false for every one of them — which is how a
      // client's administrator is kept out of federation data without a rule
      // having to be written per resource type.
      return b.scopeId != null && r.institutionId != null && r.institutionId === b.scopeId;
    default:
      return false;
  }
}

/** The authorisation decision. Deny by default. */
export function can(
  principal: Principal | null | undefined,
  action: Action,
  resource: Resource = {}
): boolean {
  if (!principal || !Array.isArray(principal.bindings)) return false;

  for (const b of principal.bindings) {
    if (!ROLES.includes(b.role)) continue;          // unknown role → ignore
    if (!bindingActive(b)) continue;
    const grants = GRANTS[b.role];
    if (!grants || !grants.includes(action)) continue;
    if (!scopeContains(b, resource)) continue;
    return true;
  }
  return false;
}

/**
 * Does the principal hold this action in ANY scope?
 *
 * Use for LIST gates: `can()` answers about one resource, so passing an empty
 * resource would wrongly refuse every scoped administrator (a state admin has
 * no national binding). List endpoints gate with this, then apply
 * `visibleScopes()` as a SQL filter so rows are still restricted.
 */
export function canAnywhere(
  principal: Principal | null | undefined,
  action: Action
): boolean {
  if (!principal || !Array.isArray(principal.bindings)) return false;
  return principal.bindings.some(
    (b) => ROLES.includes(b.role) && bindingActive(b) && GRANTS[b.role]?.includes(action)
  );
}

/** Throwing variant for endpoints: returns void or throws ForbiddenError. */
export class ForbiddenError extends Error {
  // Declared as a field rather than a constructor parameter property, so this
  // module can be run directly by Node's type-stripping (used by the operator
  // scripts in scripts/) without a build step.
  readonly action: Action;

  constructor(action: Action) {
    super(`Forbidden: ${action}`);
    this.name = 'ForbiddenError';
    this.action = action;
  }
}

export function assertCan(
  principal: Principal | null | undefined,
  action: Action,
  resource: Resource = {}
): void {
  if (!can(principal, action, resource)) throw new ForbiddenError(action);
}

/** Throwing list gate — pairs with visibleScopes() for the SQL filter. */
export function assertCanAnywhere(
  principal: Principal | null | undefined,
  action: Action
): void {
  if (!canAnywhere(principal, action)) throw new ForbiddenError(action);
}

// ─── Role granting (§53 privilege escalation) ───────────────────────────────

/**
 * Roles that only a SUPER_ADMIN may confer. Safeguarding sees child-protection
 * casework, and SUPER_ADMIN is the root of the authority tree — neither may be
 * minted by ordinary national administration (§41, §53).
 */
const RESTRICTED_ROLES: Role[] = [
  'SUPER_ADMIN',
  'SAFEGUARDING_OFFICER',
  // PART X: HR data must not reach ordinary administrators. Listing these here
  // is belt to the no-amplification braces — NATIONAL_FULL omits 'hr:*' and
  // 'medical:*', so a FEDERATION_ADMIN already fails that check. Both stay,
  // because the day someone adds 'hr:read' to NATIONAL_FULL to make a report
  // work, this line is what still refuses.
  'HR_OFFICER',
  'MEDICAL_OFFICER',
];

/** Does a binding's scope contain the scope a new binding is being made in? */
function bindingScopeCovers(b: Binding, target: { scopeType: ScopeType; scopeId: number | null }): boolean {
  if (b.scopeType === 'national') return true;
  // Conservative: a scoped granter may only grant at their exact scope. Granting
  // downward (state -> dojo inside it) needs a hierarchy lookup, so callers that
  // want it must resolve the parent scope and pass it explicitly.
  return b.scopeType === target.scopeType && b.scopeId != null && b.scopeId === target.scopeId;
}

/**
 * May this principal bind `role` at `target` scope?
 *
 * Three independent conditions, all required:
 *  1. the granter holds `role:grant` in a scope covering the target scope;
 *  2. the role is not SUPER_ADMIN/SAFEGUARDING_OFFICER unless they are SUPER_ADMIN;
 *  3. no amplification — every action the new role would hold must already be
 *     held by the granter. Without this, a granter could mint a role more
 *     powerful than themselves and then act through it.
 */
export function canGrantRole(
  principal: Principal | null | undefined,
  role: Role,
  target: { scopeType: ScopeType; scopeId: number | null }
): boolean {
  if (!principal || !Array.isArray(principal.bindings)) return false;
  if (!ROLES.includes(role)) return false;

  const granting = principal.bindings.filter(
    (b) => ROLES.includes(b.role) && bindingActive(b) && GRANTS[b.role]?.includes('role:grant')
  );
  if (!granting.length) return false;
  if (!granting.some((b) => bindingScopeCovers(b, target))) return false;

  if (RESTRICTED_ROLES.includes(role)) {
    const isSuper = granting.some((b) => b.role === 'SUPER_ADMIN');
    if (!isSuper) return false;
  }

  // No amplification: the target role's actions must be a subset of the actions
  // the granter holds across all their active bindings.
  const held = new Set<Action>();
  for (const b of principal.bindings) {
    if (!ROLES.includes(b.role) || !bindingActive(b)) continue;
    for (const a of GRANTS[b.role] ?? []) held.add(a);
  }
  return (GRANTS[role] ?? []).every((a) => held.has(a));
}

/** The action set a role confers — exported for grant-time review screens. */
export function actionsForRole(role: Role): Action[] {
  return [...(GRANTS[role] ?? [])];
}

/**
 * SQL-level scope filter for list queries: returns the state/district/dojo ids
 * a principal may see for an action, or 'all' for national reach, or 'none'.
 * Endpoints must apply this to WHERE clauses so scoping is enforced in the
 * query, not by filtering after the fact.
 */
export function visibleScopes(
  principal: Principal | null | undefined,
  action: Action
): { kind: 'all' } | { kind: 'none' } | { kind: 'scoped'; states: number[]; districts: number[]; dojos: number[]; institutions: number[] } {
  if (!principal) return { kind: 'none' };
  const states: number[] = [], districts: number[] = [], dojos: number[] = [], institutions: number[] = [];
  let national = false;

  for (const b of principal.bindings) {
    if (!ROLES.includes(b.role) || !bindingActive(b)) continue;
    if (!GRANTS[b.role]?.includes(action)) continue;
    if (b.scopeType === 'national') national = true;
    else if (b.scopeType === 'state' && b.scopeId != null) states.push(b.scopeId);
    else if (b.scopeType === 'district' && b.scopeId != null) districts.push(b.scopeId);
    else if (b.scopeType === 'dojo' && b.scopeId != null) dojos.push(b.scopeId);
    else if (b.scopeType === 'institution' && b.scopeId != null) institutions.push(b.scopeId);
  }

  if (national) return { kind: 'all' };
  if (!states.length && !districts.length && !dojos.length && !institutions.length) return { kind: 'none' };
  return { kind: 'scoped', states, districts, dojos, institutions };
}

/** Convenience for building principals from the legacy session types. */
export function legacyAdminPrincipal(): Principal {
  return {
    userId: null,
    label: 'legacy-admin',
    bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
  };
}

export function legacyUnitPrincipal(unit: {
  name: string;
  level: string;
  stateUnitId: number | null;
}): Principal {
  const role: Role =
    unit.level === 'State' ? 'STATE_ADMIN' :
    unit.level === 'District' ? 'DISTRICT_ADMIN' : 'DOJO_ADMIN';
  return {
    userId: null,
    label: unit.name,
    // Legacy unit codes only carry a state, so district/club codes are bound at
    // state scope with the narrower role's action set.
    bindings: [{ role, scopeType: 'state', scopeId: unit.stateUnitId }],
  };
}
