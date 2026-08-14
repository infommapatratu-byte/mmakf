// The universal entity model (§16).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation has one shape of record repeated about twenty-five times: a
// thing with a name, a human-quotable identifier, a status, a module it is
// administered in, and — sometimes — a page of its own. Before this file, every
// surface that wanted to refer to a record re-derived all five. A quick view
// wrote its own icon, a search result wrote its own label, a breadcrumb wrote
// its own URL, and three of them disagreed about whether a `coach_profiles` row
// is called a "Coach" or a "Coach profile".
//
// This module is the single description of each kind. It is deliberately DATA,
// not behaviour: it says what a coach IS and where a coach LIVES, and leaves
// every surface to decide how to draw it. src/lib/status.ts already owns what a
// status means; this owns what a record is.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE RULES THIS FILE IS WRITTEN UNDER
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. EVERY PATH HERE IS A ROUTE THAT EXISTS TODAY. This codebase has already
//    shipped six navigation links to pages nobody built, and the fix was to
//    check the menu against the router. So `detailPath` is OPTIONAL and is
//    absent for most kinds — not because those records do not deserve a page,
//    but because they do not have one yet. A surface must render the
//    full-profile affordance only where `detailPath` answers. An entity model
//    that invented `/admin/coaches/12` would put a 404 behind a button on
//    twenty-five screens at once.
//
// 2. THE ACTION LIST CONTAINS ONLY NAVIGATIONS. `approve`, `assign a coach`,
//    `escalate` and the rest are the actions a command palette most wants, and
//    every one of them needs an endpoint that does not exist. A palette entry
//    that resolves to nothing is worse than a shorter palette, for the same
//    reason a menu item that 404s is worse than a shorter menu. The SHAPE is
//    here — `requires` is a real RBAC Action, so the palette can filter by
//    authority from the first day — and the mutating entries are added here,
//    once, when the handlers land.
//
// 3. CASEWORK IS NOT AN ENTITY KIND. Disciplinary cases, safeguarding cases and
//    medical records are absent, exactly as they are absent from SearchKind in
//    src/lib/search.ts. They have their own access path with its own
//    authorisation and lawful basis, and a hover-preview that surfaces "who a
//    case is about" into a list view — or into a command palette that ranks
//    recent records — is precisely the leak that access path exists to prevent.
//    Their absence makes the leak unrepresentable rather than merely avoided.

import type { Action } from '@/lib/rbac';

/**
 * Every kind of record the federation refers to by name.
 *
 * One entry per table that a person genuinely talks about — "that booking",
 * "that dojo". Join tables, event logs and revision histories are not kinds:
 * nobody says "open entry member 4104", they open the entry.
 */
export type EntityKind =
  | 'person'
  | 'dojo'
  | 'state_unit'
  | 'district_unit'
  | 'institution'
  | 'coach'
  | 'membership'
  | 'certificate'
  | 'application'
  | 'lead'
  | 'quote'
  | 'contract'
  | 'program'
  | 'booking'
  | 'venue'
  | 'task'
  | 'ticket'
  | 'competition_event'
  | 'grading_event'
  | 'listing'
  | 'workflow_run'
  | 'course'
  | 'document'
  | 'kata';

/**
 * Enough of a record to address it.
 *
 * `id` is the primary key and is what the deep link carries. `identifier` is
 * the string a person quotes down a telephone — the federation number, the
 * charter code, the reference — and several routes are keyed by it rather than
 * by the primary key, which is why both travel together.
 */
export interface EntityRef {
  kind: EntityKind;
  id: string | number;
  identifier?: string | null;
  /**
   * The record's raw status, where the caller holds it.
   *
   * A handful of the `detailPath` rules below lead to a page that answers for
   * some statuses and not others — the public register entry is the case that
   * forced this field. Leaving the rule to the caller ("do not offer this link
   * for a lapsed member") is how twenty-five surfaces come to disagree, which
   * is the failure this file exists to end. Absent means NOT STATED, and a rule
   * that needs a status withholds the link rather than assuming a good one.
   */
  status?: string | null;
}

/**
 * Something a surface can offer to do with a record.
 *
 * `requires` is the RBAC action, so a palette or a menu filters by authority
 * without re-deciding per kind what authority means. `to` returns a path; it
 * returns null when the record lacks the identifier that path is keyed by,
 * which is the honest answer and stops a caller rendering a broken link.
 */
export interface EntityAction {
  /** Stable across renames — a keyboard shortcut may be bound to it. */
  id: string;
  /** Imperative, sentence case. Never SCREAMING or title-cased. */
  label: string;
  requires: Action;
  to: (ref: EntityRef) => string | null;
  /**
   * True when following this changes something. Nothing sets it yet — see rule
   * 2 above — and it exists so the first mutating action cannot be added
   * without a surface being able to tell it apart from a navigation.
   */
  mutates?: boolean;
}

/** The icon names src/components/Icon.astro actually renders. */
export type EntityIcon =
  | 'karate-gi' | 'kata' | 'kumite' | 'shield' | 'star' | 'medal' | 'globe'
  | 'black-belt' | 'book' | 'school' | 'users' | 'pin' | 'mat' | 'target'
  | 'dumbbell' | 'first-aid' | 'locker' | 'clock' | 'monitor';

export interface EntityDescriptor {
  kind: EntityKind;
  /** Singular, for one record. */
  label: string;
  /** Plural, for a heading or a count. */
  plural: string;
  icon: EntityIcon;
  /** The table the record lives in. Printed as provenance, never guessed at. */
  table: string;
  /** The column carrying the identifier a person quotes. */
  identifierField: string;
  /** What that identifier is called out loud. "Federation ID", not "code". */
  identifierLabel: string;
  /**
   * The domain to pass to statusOf(), for the few words that mean different
   * things in different places — `active` on a coach is not `active` on a
   * membership. Absent where the record's vocabulary needs no disambiguation.
   */
  statusDomain?: string;
  /** The key into LIFECYCLES in src/lib/status.ts, where one is defined. */
  lifecycle?: string;
  /** The action needed to read one of these at all. */
  requires: Action;
  /** The module or register this kind is listed in. Always a real route. */
  listPath: string;
  /**
   * The record's own page, where one exists.
   *
   * ABSENT IS THE COMMON CASE and it is not an oversight. Twenty of the kinds
   * below are administered from a list and have no dedicated route, so a
   * surface must treat "no detail page" as normal and render nothing rather
   * than a disabled button apologising for it.
   */
  detailPath?: (ref: EntityRef) => string | null;
  actions: EntityAction[];
}

/**
 * The module link every kind carries.
 *
 * Deliberately labelled as going to the module, not as filtering it: none of
 * the admin lists reads a subject parameter today, and a link promising a
 * filtered view that arrives unfiltered is the same lie as a broken link, told
 * more quietly.
 */
function moduleAction(label: string, requires: Action, path: string): EntityAction {
  return { id: 'module', label, requires, to: () => path };
}

/** The quick view — the same address the side panel opens at. See §18. */
function quickViewAction(requires: Action, listPath: string): EntityAction {
  return {
    id: 'quick-view',
    label: 'Quick view',
    requires,
    to: (ref) => `${listPath}?${PANEL_PARAM}=${encodeURIComponent(token(ref))}`,
  };
}

/**
 * The querystring parameter that carries the open record (§79, §80).
 *
 * One name for the whole federation. Two surfaces choosing `view` and `entity`
 * would mean a URL pasted from one list does nothing in another, and the point
 * of a deep-linkable panel is that the address survives being sent to somebody.
 */
export const PANEL_PARAM = 'view';

/** `coach:12`. The whole address of a record in one token. */
export function token(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * Read a token back.
 *
 * Returns null for anything unrecognised rather than throwing. This value comes
 * off the querystring, which means it comes from whoever sent the link, and a
 * page must render whatever it is handed.
 */
export function parseToken(raw: string | null | undefined): { kind: EntityKind; id: string } | null {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  const at = v.indexOf(':');
  if (at < 1) return null;
  const kind = v.slice(0, at) as EntityKind;
  const id = v.slice(at + 1);
  if (!id || !(kind in ENTITIES)) return null;
  return { kind, id };
}

// ─── The kinds ──────────────────────────────────────────────────────────────

export const ENTITIES: Record<EntityKind, EntityDescriptor> = {
  person: {
    kind: 'person',
    label: 'Person',
    plural: 'People',
    icon: 'users',
    table: 'persons',
    identifierField: 'federationId',
    identifierLabel: 'Federation ID',
    requires: 'person:read',
    listPath: '/admin/membership',
    // The public register entry. It is keyed by federation id, not by the
    // primary key, and publicAthleteProfile() in src/db/athletes.ts returns null
    // for anybody whose status is not `active` — the page then renders "not
    // found". So the STATUS IS PART OF WHETHER THIS ADDRESS EXISTS, and the rule
    // is enforced here rather than asked of every caller. Both null returns are
    // the same answer: a person recorded without a federation id, and a person
    // whose standing is not current, have no public address to offer.
    detailPath: (ref) =>
      ref.identifier && ref.status === 'active'
        ? `/athlete/${encodeURIComponent(ref.identifier)}`
        : null,
    actions: [
      quickViewAction('person:read', '/admin/membership'),
      moduleAction('Go to Members', 'membership:read', '/admin/membership'),
    ],
  },

  dojo: {
    kind: 'dojo',
    label: 'Dojo',
    plural: 'Dojos',
    icon: 'mat',
    table: 'dojos',
    identifierField: 'code',
    identifierLabel: 'Dojo code',
    requires: 'dojo:read',
    listPath: '/dojos',
    actions: [
      quickViewAction('dojo:read', '/dojos'),
      moduleAction('Go to affiliated centres', 'dojo:read', '/dojos'),
    ],
  },

  state_unit: {
    kind: 'state_unit',
    label: 'State unit',
    plural: 'State units',
    icon: 'globe',
    table: 'state_units',
    identifierField: 'code',
    identifierLabel: 'Charter code',
    requires: 'unit:read',
    listPath: '/network',
    actions: [
      quickViewAction('unit:read', '/network'),
      moduleAction('Go to the network', 'unit:read', '/network'),
    ],
  },

  district_unit: {
    kind: 'district_unit',
    label: 'District unit',
    plural: 'District units',
    icon: 'pin',
    table: 'district_units',
    identifierField: 'code',
    identifierLabel: 'Charter code',
    requires: 'unit:read',
    listPath: '/network',
    actions: [
      quickViewAction('unit:read', '/network'),
      moduleAction('Go to the network', 'unit:read', '/network'),
    ],
  },

  institution: {
    kind: 'institution',
    label: 'Institution',
    plural: 'Institutions',
    icon: 'school',
    table: 'institutions',
    identifierField: 'code',
    identifierLabel: 'Institution code',
    // `active` on an institution means "has at least one programme running",
    // which is not what it means anywhere else.
    statusDomain: 'institution',
    requires: 'engagement:read',
    listPath: '/admin/leads',
    actions: [
      quickViewAction('engagement:read', '/admin/leads'),
      moduleAction('Go to Leads and CRM', 'engagement:read', '/admin/leads'),
    ],
  },

  coach: {
    kind: 'coach',
    label: 'Coach',
    plural: 'Coaches',
    icon: 'karate-gi',
    table: 'coach_profiles',
    // A coach profile has no reference of its own; the person it belongs to
    // carries the federation id, and that is what anyone quotes.
    identifierField: 'personId',
    identifierLabel: 'Federation ID',
    statusDomain: 'coach',
    lifecycle: 'coach',
    requires: 'coach:read',
    listPath: '/admin/coaches',
    actions: [
      quickViewAction('coach:read', '/admin/coaches'),
      moduleAction('Go to Coaches', 'coach:read', '/admin/coaches'),
    ],
  },

  membership: {
    kind: 'membership',
    label: 'Membership',
    plural: 'Memberships',
    icon: 'shield',
    table: 'memberships',
    identifierField: 'id',
    identifierLabel: 'Membership record',
    // `active` here means paid up and in good standing, and reads as "Current".
    statusDomain: 'membership',
    requires: 'membership:read',
    listPath: '/admin/membership',
    actions: [
      quickViewAction('membership:read', '/admin/membership'),
      moduleAction('Go to Members', 'membership:read', '/admin/membership'),
    ],
  },

  certificate: {
    kind: 'certificate',
    label: 'Certificate',
    plural: 'Certificates',
    icon: 'medal',
    table: 'certificates',
    identifierField: 'certificateNo',
    identifierLabel: 'Certificate number',
    requires: 'certificate:read',
    listPath: '/verify',
    // /verify prefills its box from `id`, so this is the certificate's own
    // public address — and it is the NUMBER that goes in it, never the primary
    // key and never the verify token, which is the one thing a QR code carries.
    detailPath: (ref) => (ref.identifier ? `/verify?id=${encodeURIComponent(ref.identifier)}` : null),
    actions: [
      quickViewAction('certificate:read', '/verify'),
      moduleAction('Go to verification', 'certificate:read', '/verify'),
    ],
  },

  application: {
    kind: 'application',
    label: 'Application',
    plural: 'Applications',
    icon: 'book',
    table: 'institution_applications',
    identifierField: 'ref',
    identifierLabel: 'Reference',
    lifecycle: 'application',
    requires: 'engagement:read',
    listPath: '/admin/applications',
    // The applicant's own tracker, keyed by the reference they were given.
    detailPath: (ref) => (ref.identifier ? `/learn/applications/${encodeURIComponent(ref.identifier)}` : null),
    actions: [
      quickViewAction('engagement:read', '/admin/applications'),
      moduleAction('Go to Applications', 'engagement:read', '/admin/applications'),
    ],
  },

  lead: {
    kind: 'lead',
    label: 'Lead',
    plural: 'Leads',
    icon: 'target',
    table: 'leads',
    identifierField: 'ref',
    identifierLabel: 'Reference',
    lifecycle: 'lead',
    requires: 'engagement:read',
    listPath: '/admin/leads',
    actions: [
      quickViewAction('engagement:read', '/admin/leads'),
      moduleAction('Go to Leads and CRM', 'engagement:read', '/admin/leads'),
    ],
  },

  quote: {
    kind: 'quote',
    label: 'Quote',
    plural: 'Quotes',
    icon: 'book',
    table: 'quotes',
    identifierField: 'ref',
    identifierLabel: 'Reference',
    lifecycle: 'quote',
    // Reading a quote is a different authority from reading the pricing rules
    // it was computed under. See the three feeframework:* actions.
    requires: 'quote:read',
    listPath: '/admin/quotes',
    actions: [
      quickViewAction('quote:read', '/admin/quotes'),
      moduleAction('Go to Quotes and proposals', 'quote:read', '/admin/quotes'),
    ],
  },

  contract: {
    kind: 'contract',
    label: 'Contract',
    plural: 'Contracts',
    icon: 'book',
    table: 'contracts',
    identifierField: 'ref',
    identifierLabel: 'Reference',
    lifecycle: 'contract',
    requires: 'contract:read',
    listPath: '/admin/quotes',
    actions: [
      quickViewAction('contract:read', '/admin/quotes'),
      moduleAction('Go to Quotes and proposals', 'quote:read', '/admin/quotes'),
    ],
  },

  program: {
    kind: 'program',
    label: 'Programme',
    plural: 'Programmes',
    icon: 'dumbbell',
    table: 'training_programs',
    identifierField: 'code',
    identifierLabel: 'Programme code',
    // A programme is PAUSED by agreement, not by a failure, and is toned as a
    // decision rather than a fault.
    statusDomain: 'program',
    requires: 'program:read',
    listPath: '/admin/programs',
    actions: [
      quickViewAction('program:read', '/admin/programs'),
      moduleAction('Go to Programmes', 'program:read', '/admin/programs'),
    ],
  },

  booking: {
    kind: 'booking',
    label: 'Booking',
    plural: 'Bookings',
    icon: 'clock',
    table: 'bookings',
    identifierField: 'ref',
    identifierLabel: 'Reference',
    lifecycle: 'booking',
    requires: 'booking:read',
    listPath: '/admin/bookings',
    actions: [
      quickViewAction('booking:read', '/admin/bookings'),
      moduleAction('Go to Bookings and calendar', 'booking:read', '/admin/bookings'),
    ],
  },

  venue: {
    kind: 'venue',
    label: 'Venue',
    plural: 'Venues',
    icon: 'pin',
    table: 'venues',
    identifierField: 'code',
    identifierLabel: 'Venue code',
    // `active` on a venue reads as "In use" — available to be booked.
    statusDomain: 'venue',
    requires: 'venue:read',
    listPath: '/admin/venues',
    actions: [
      quickViewAction('venue:read', '/admin/venues'),
      moduleAction('Go to Venues', 'venue:read', '/admin/venues'),
    ],
  },

  task: {
    kind: 'task',
    label: 'Task',
    plural: 'Tasks',
    icon: 'target',
    table: 'tasks',
    identifierField: 'ref',
    identifierLabel: 'Reference',
    lifecycle: 'task',
    requires: 'task:read',
    listPath: '/admin/tasks',
    actions: [
      quickViewAction('task:read', '/admin/tasks'),
      moduleAction('Go to Tasks', 'task:read', '/admin/tasks'),
    ],
  },

  ticket: {
    kind: 'ticket',
    label: 'Support ticket',
    plural: 'Support tickets',
    icon: 'first-aid',
    table: 'support_tickets',
    // `ticketNo`, not the primary key. The desk quotes the number the ticket was
    // given; the primary key is an implementation detail nobody outside this
    // codebase has ever been read down a telephone.
    identifierField: 'ticketNo',
    identifierLabel: 'Ticket number',
    lifecycle: 'ticket',
    requires: 'support:read',
    listPath: '/admin/support',
    actions: [
      quickViewAction('support:read', '/admin/support'),
      moduleAction('Go to the support desk', 'support:read', '/admin/support'),
    ],
  },

  competition_event: {
    kind: 'competition_event',
    label: 'Competition',
    plural: 'Competitions',
    icon: 'kumite',
    table: 'competition_events',
    identifierField: 'code',
    identifierLabel: 'Event code',
    requires: 'competition:read',
    listPath: '/admin/competition',
    actions: [
      quickViewAction('competition:read', '/admin/competition'),
      moduleAction('Go to Competitions', 'competition:read', '/admin/competition'),
    ],
  },

  grading_event: {
    kind: 'grading_event',
    label: 'Grading',
    plural: 'Gradings',
    icon: 'black-belt',
    table: 'grading_events',
    identifierField: 'code',
    identifierLabel: 'Grading code',
    requires: 'grading:read',
    listPath: '/admin/grading',
    actions: [
      quickViewAction('grading:read', '/admin/grading'),
      moduleAction('Go to Grading', 'grading:read', '/admin/grading'),
    ],
  },

  listing: {
    kind: 'listing',
    label: 'Listing',
    plural: 'Listings',
    icon: 'locker',
    table: 'listings',
    identifierField: 'ref',
    identifierLabel: 'Reference',
    requires: 'marketplace:read',
    listPath: '/admin/listings',
    // NO detailPath, and the omission is the point. /portal/listings/:id is the
    // SELLER'S own page: it picks the row out of myListings(), which resolves
    // the shop from the session inside its own SQL, so a listing belonging to
    // anybody else was never in the set and the page renders "not found". That
    // construction is right — it is why the id names which item and never whose
    // — but it means the address is NOT this record's page for the reader of
    // /admin/listings, who is the only reader this kind is modelled for. Rule 1
    // is about dead ends, not only about routes that 404: an "Open full record"
    // button that reliably lands a reviewer on "not found" is a dead end with a
    // route behind it. A seller-facing surface knows the page answers for its
    // own reader and can pass the address itself.
    actions: [
      quickViewAction('marketplace:read', '/admin/listings'),
      moduleAction('Go to the marketplace', 'marketplace:read', '/admin/listings'),
    ],
  },

  workflow_run: {
    kind: 'workflow_run',
    label: 'Automation run',
    plural: 'Automation runs',
    icon: 'monitor',
    table: 'workflow_runs',
    identifierField: 'id',
    identifierLabel: 'Run',
    lifecycle: 'workflow',
    requires: 'workflow:read',
    listPath: '/admin/workflows',
    actions: [
      quickViewAction('workflow:read', '/admin/workflows'),
      moduleAction('Go to Automations', 'workflow:read', '/admin/workflows'),
    ],
  },

  course: {
    kind: 'course',
    label: 'Course',
    plural: 'Courses',
    icon: 'book',
    table: 'courses',
    identifierField: 'id',
    identifierLabel: 'Course',
    requires: 'content:read',
    listPath: '/academy',
    actions: [
      quickViewAction('content:read', '/academy'),
      moduleAction('Go to Education and courses', 'content:read', '/academy'),
    ],
  },

  document: {
    kind: 'document',
    label: 'Document',
    plural: 'Documents',
    icon: 'book',
    table: 'official_documents',
    // The code is printed beside every document on /documents and is what a
    // circular is cited by. The primary key is not.
    identifierField: 'code',
    identifierLabel: 'Document code',
    requires: 'document:read',
    listPath: '/documents',
    actions: [
      quickViewAction('document:read', '/documents'),
      moduleAction('Go to Documents', 'document:read', '/documents'),
    ],
  },

  kata: {
    kind: 'kata',
    label: 'Kata',
    plural: 'Kata',
    icon: 'kata',
    table: 'kata',
    identifierField: 'slug',
    identifierLabel: 'Kata',
    requires: 'content:read',
    listPath: '/kata',
    detailPath: (ref) => (ref.identifier ? `/kata/${encodeURIComponent(ref.identifier)}` : null),
    actions: [
      quickViewAction('content:read', '/kata'),
      moduleAction('Go to the kata library', 'content:read', '/kata'),
    ],
  },
};

/** Every kind, in the order a reader should meet them. Never alphabetical. */
export const ENTITY_ORDER: readonly EntityKind[] = [
  'person', 'coach', 'membership', 'certificate',
  'institution', 'application', 'lead', 'quote', 'contract',
  'program', 'booking', 'venue', 'task', 'ticket',
  'competition_event', 'grading_event',
  'dojo', 'state_unit', 'district_unit',
  'listing', 'workflow_run', 'course', 'document', 'kata',
];

/**
 * Kinds that are deliberately not modelled, and why.
 *
 * Exported so a test can assert the list has not quietly grown a case register.
 * See rule 3 at the top of this file.
 */
export const NEVER_AN_ENTITY: readonly string[] = [
  'disciplinary_cases',
  'safeguarding_cases',
  'case_notes',
  'medical_records',
];

/** The descriptor for a kind. */
export function describe(kind: EntityKind): EntityDescriptor {
  return ENTITIES[kind];
}

/**
 * The contextual actions a principal may actually take on a record.
 *
 * Takes a `can` predicate rather than a Principal so the caller decides whether
 * authority is being tested anywhere or in this record's own scope — a coach
 * administrator for one state must not be offered a coach in another.
 *
 * Actions whose `to` returns null are dropped. That is the mechanism behind
 * rule 1: a record without the identifier a route is keyed by simply does not
 * offer that route, and no surface has to remember to check.
 */
export function actionsFor(
  ref: EntityRef,
  can: (action: Action) => boolean
): Array<{ id: string; label: string; href: string; mutates: boolean }> {
  return ENTITIES[ref.kind].actions
    .filter((a) => can(a.requires))
    .map((a) => ({ id: a.id, label: a.label, href: a.to(ref) ?? '', mutates: a.mutates === true }))
    .filter((a) => a.href !== '');
}

/**
 * The record's own page, or null.
 *
 * Null is a normal answer — see `detailPath` above — and callers must render
 * nothing rather than a disabled control when it comes back null.
 */
export function detailHref(ref: EntityRef): string | null {
  const d = ENTITIES[ref.kind].detailPath;
  return d ? d(ref) : null;
}

/**
 * The address that opens this record's quick view on the page you are on.
 *
 * Takes the CURRENT url and preserves everything already in it, because a data
 * table's filters, sorting and page number live in the querystring (they must
 * work with JavaScript off) and a quick-view link that dropped them would throw
 * the reader back to page one of an unfiltered list on the way in — and again
 * on the way out.
 */
export function quickViewHref(url: URL, ref: EntityRef, param: string = PANEL_PARAM): string {
  const next = new URL(url.toString());
  next.searchParams.set(param, token(ref));
  return `${next.pathname}${next.search}`;
}

/** The same address with the panel closed. The panel's Close is a real link. */
export function closeHref(url: URL, param: string = PANEL_PARAM): string {
  const next = new URL(url.toString());
  next.searchParams.delete(param);
  return `${next.pathname}${next.search}`;
}
