// The command registry (§8, §9, §64, §81).
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS DATA
// ─────────────────────────────────────────────────────────────────────────────
//
// Every command is a row: a label, the section it belongs in, the words a
// person might reach for, where it goes, and — the part that matters — the RBAC
// action it needs. No markup, no DOM, no strings that only make sense inside one
// component. CommandPalette.astro renders whatever survives the filtering below
// and knows nothing about what the federation can do.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FILTERING IS NOT COSMETIC
// ─────────────────────────────────────────────────────────────────────────────
//
// An accelerator that lists actions the caller will be refused is worse than no
// accelerator: it teaches an administrator that the system is unreliable, and it
// tells them which verbs exist so they can go and ask why the button did
// nothing. So buildCommands() takes the caller's actions and drops everything
// they do not hold, and the component receives only the survivors — the list is
// never shipped whole to the browser and hidden with CSS.
//
// This is still not an authorisation control. The page behind every href
// repeats its own check, because a filtered list is markup and markup is not an
// authorisation system.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY REACHABILITY IS CHECKED AS WELL AS AUTHORITY
// ─────────────────────────────────────────────────────────────────────────────
//
// Three hosts, one application (see surface.ts). On learn.mmakf.in the
// middleware rewrites every unprefixed path into /learn/…, so a link to
// /admin/queue from that host resolves to /learn/admin/queue, which is a 404 —
// the caller may hold the action and still cannot get there. Authority and
// reachability are different questions and both have to be asked.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY ABSENT
// ─────────────────────────────────────────────────────────────────────────────
//
// No command points at a route that does not exist, and no command claims a
// filter a page does not implement. /admin/quotes accepts ?ref=, for instance,
// and it is a post-submission confirmation banner rather than a lookup — so
// there is no "open this quote" command, only "Quotes and proposals". A palette
// that offers a destination the federation has not built is the six dead
// navigation links this codebase has already had to remove, one accelerator
// over.
//
// There is also no "Sign out": /api/auth/logout is POST-only and clears the
// per-person session alone, and a fuzzy match away from an accidental sign-out
// is not a trade worth making for two saved clicks.

import type { Action, Principal, Role } from './rbac';
import { canAnywhere, actionsForRole } from './rbac';
import { ADMIN_GROUPS, SURFACE_PREFIX, href as surfaceHref, type Surface } from './surface';

// ─── Who the operations modules are for ─────────────────────────────────────
//
// A MODULE'S OWN ACTION IS NOT ENOUGH TO DECIDE WHO IS OFFERED IT, and the
// palette is the first surface where that matters.
//
// ADMIN_GROUPS gates /admin/command, /admin/queue and /admin/governance on
// 'content:read'. Every MEMBER holds 'content:read'. In the sidebar that has
// never shown, because AdminShell only renders once somebody is already on
// /admin and every page repeats its own check — the weak gate is masked by
// where the menu lives. The palette has no such shelter: it opens on the public
// federation, for a member reading the kata library, and generating its
// operations entries from ADMIN_GROUPS alone offered exactly those three
// modules to every member and athlete on the site.
//
// It is not only 'content:read'. The read half of operations is shared widely
// by design: a PARENT holds 'attendance:read', 'grading:read' and
// 'support:read'; an ATHLETE holds 'competition:read'; an INSTITUTION_ADMIN
// holds 'program:read', 'booking:read', 'quote:read', 'task:read' and
// 'report:read'. Gating on the module's action alone would offer a parent the
// attendance module and a client's administrator half the operations menu.
//
// So an operations module needs TWO things: the module's action, and a caller
// who is operations staff at all. The second is decided here, and it is derived
// from rbac.ts rather than restated: a principal is operations staff when they
// hold at least one action that lies outside everything a member, a family and
// a client's own staff hold between them. That set is computed from the five
// roles below through actionsForRole(), so a grant changed in rbac.ts changes
// this test too, and nobody has to remember this file.
//
// It fails closed in the useful direction. An EDUCATION_OFFICER holds
// 'content:write', a MEDIA_OFFICER holds 'seo:write', an INSTRUCTOR holds
// 'dojo:read', a FINANCE_OFFICER holds 'finance:read' — all outside the set, so
// all keep their modules. An INSTITUTION_ADMIN's authority is, by construction,
// entirely inside it.
const CLIENT_AND_MEMBER_ROLES: Role[] = [
  'MEMBER',
  'ATHLETE',
  'PARENT',
  'INSTITUTION_ADMIN',
  'INSTITUTION_COORDINATOR',
];

// Built on first use rather than at module load. The set is the only thing in
// this file that calls into rbac.ts at the top level, and doing so pulled the
// whole grant table — all 32 roles — into the palette's browser bundle, which
// grew it from 26 kB to 35 kB for a function no browser ever calls. Behind a
// function it is reachable only from isOperations(), which the client does not
// use, so the bundler drops rbac.ts again.
let clientAndMemberActions: ReadonlySet<Action> | null = null;

function clientAndMemberFloor(): ReadonlySet<Action> {
  if (!clientAndMemberActions) {
    clientAndMemberActions = new Set<Action>(
      CLIENT_AND_MEMBER_ROLES.flatMap((role) => actionsForRole(role))
    );
  }
  return clientAndMemberActions;
}

/**
 * Is this caller federation operations staff?
 *
 * Asked of the principal's WHOLE grant set, not of the actions the palette
 * happens to gate on: what distinguishes an education officer from a client's
 * administrator is 'content:write', and the palette gates nothing on it.
 */
export function isOperations(principal: Principal | null | undefined): boolean {
  if (!principal || !Array.isArray(principal.bindings)) return false;
  const floor = clientAndMemberFloor();
  for (const b of principal.bindings) {
    for (const action of actionsForRole(b.role)) {
      if (floor.has(action)) continue;
      // Back through canAnywhere() rather than trusting the binding we are
      // standing on: it is what knows about expiry, revocation and roles that
      // no longer exist. A withdrawn binding must not confer operations
      // standing any more than it confers its actions.
      if (canAnywhere(principal, action)) return true;
    }
  }
  return false;
}

// ─── Shape ──────────────────────────────────────────────────────────────────

/**
 * Recent is not here. It is assembled in the browser from localStorage against
 * the commands that survived filtering, so it can never resurrect a command the
 * caller has since lost the authority to run.
 */
export type Section = 'contextual' | 'action' | 'navigation';

/** The four things a command can do that is not "go to a page". */
export type ClientVerb = 'search' | 'copy-link' | 'print' | 'shortcuts';

/**
 * The entities a page may declare.
 *
 * Only kinds with at least one real destination appear here. Adding a kind
 * without adding a command for it produces an empty contextual section, which
 * reads as a bug.
 */
export type EntityKind =
  | 'competition' | 'athlete' | 'member' | 'person' | 'coach'
  | 'lead' | 'application' | 'quote' | 'program' | 'grading'
  | 'booking' | 'venue' | 'task' | 'ticket' | 'workflow'
  | 'approval' | 'listing' | 'kata'
  | 'state' | 'district' | 'dojo';

/**
 * THE CONTEXTUAL CONTRACT.
 *
 * A page says what it is looking at:
 *
 *   <CommandPalette entity={{ kind: 'competition', id: comp.id, label: comp.name }} />
 *
 * and gets the verbs for that kind. `id` is whatever the routes for that kind
 * take — a numeric id for a competition, a membership number for a member, a
 * slug for a kata — and a command whose href needs an id it was not given is
 * DROPPED rather than rendered pointing at a literal ":id". `label` is only the
 * heading the reader sees; nothing is derived from it.
 */
export interface EntityContext {
  kind: EntityKind;
  id?: string | number | null;
  label?: string | null;
}

export interface Command {
  id: string;
  /** Sentence case. What the reader is choosing, not what the code does. */
  label: string;
  section: Section;
  /** Extra words a person might type. Matched at a discount to the label. */
  keywords?: string;
  /** An INTERNAL path. Resolved through surface.href() at build time. */
  href?: string;
  /** Runs in the browser instead of navigating. */
  verb?: ClientVerb;
  /** The action this needs. Absent means anybody may run it. */
  requires?: Action;
  /** Contextual commands only: the entity kinds this verb applies to. */
  context?: readonly EntityKind[];
  /**
   * Override the section's default heading.
   *
   * Used for the operations modules, which are navigation but must not sit in
   * the same list as the public site: the federation has a Competitions page
   * and a Competitions module, and two adjacent rows reading "Competitions"
   * make the reader guess. Under separate headings they are two obvious things.
   */
  group?: string;
}

/** The heading a contextual section gets when the page supplied no label. */
const ENTITY_HEADING: Record<EntityKind, string> = {
  competition: 'This competition',
  athlete: 'This athlete',
  member: 'This member',
  person: 'This person',
  coach: 'This coach',
  lead: 'This lead',
  application: 'This application',
  quote: 'This quotation',
  program: 'This programme',
  grading: 'This grading',
  booking: 'This booking',
  venue: 'This venue',
  task: 'This task',
  ticket: 'This ticket',
  workflow: 'This automation',
  approval: 'This approval request',
  listing: 'This listing',
  kata: 'This kata',
  state: 'This state',
  district: 'This district',
  dojo: 'This dojo',
};

// ─── The registry ───────────────────────────────────────────────────────────

/**
 * The registry, minus the admin modules, which are generated below.
 *
 * Order is meaningful in one place only: resolveChords() takes the first
 * surviving candidate, so /admin/dashboard is listed before /my.
 *
 * ─── WHAT REACHES THE BROWSER, MEASURED ────────────────────────────────────
 *
 * CommandPalette.astro's browser script imports rankCommands() from this
 * module, which drags the module in with it. Rollup drops what it can — rbac.ts
 * goes entirely, so none of the 32 roles or their grants reach the browser,
 * which is why clientAndMemberFloor() above is a function and not a constant —
 * but it retains these top-level literals, so the palette's client chunk
 * carries the registry's own text: about 26 kB raw, 7.6 kB gzipped.
 * Annotating the derivation as pure does not change it, and nor does hoisting
 * the derivation into buildRegistry(); the project does not declare
 * `sideEffects: false`, which is the setting that would let a bundler drop an
 * unreferenced literal, and that declaration is a whole-project decision rather
 * than this file's to take.
 *
 * That is a size cost and NOT a disclosure one, and the difference matters. The
 * chunk contains the SHAPE of the registry — labels and paths that are already
 * in the public navigation and the admin sidebar. What it never contains is the
 * result of buildCommands(): which of these the reader may actually run. That
 * is computed on the server, per request, and only the survivors are serialised
 * into the page.
 */
const BASE_COMMANDS: Command[] = [

  // ── Contextual ────────────────────────────────────────────────────────────
  //
  // Every href here was checked against a page that actually reads the
  // parameter. /competitions reads ?event=, /admin/leads reads ?lead=,
  // /admin/grading reads ?g=, /admin/membership reads ?id=, /admin/workflows
  // reads ?run=, /admin/approvals reads ?requestId=, /admin/dashboard reads
  // ?scope=&id=, /verify prefills from ?id=. Where a page has no such parameter
  // the contextual command opens the list instead, and says so.

  { id: 'ctx.competition.open', label: 'Open this competition', section: 'contextual',
    context: ['competition'], href: '/competitions?event=:id',
    keywords: 'event entry details competition' },
  { id: 'ctx.competition.scoreboard', label: 'Scoreboard for this competition', section: 'contextual',
    context: ['competition'], href: '/scoreboard?event=:id',
    keywords: 'results mat live score' },
  { id: 'ctx.competition.manage', label: 'Manage competitions', section: 'contextual',
    context: ['competition'], href: '/admin/competition', requires: 'competition:read',
    keywords: 'sanction draw officials administration' },

  { id: 'ctx.athlete.open', label: 'Open this athlete', section: 'contextual',
    context: ['athlete'], href: '/athlete/:id',
    keywords: 'profile record competitor' },
  { id: 'ctx.athlete.rankings', label: 'Rankings', section: 'contextual',
    context: ['athlete'], href: '/rankings',
    keywords: 'standings order points' },

  { id: 'ctx.member.record', label: 'Look this member up in the register', section: 'contextual',
    context: ['member'], href: '/admin/membership?id=:id', requires: 'membership:read',
    keywords: 'membership number register lookup' },
  { id: 'ctx.member.verify', label: 'Verify this credential', section: 'contextual',
    context: ['member'], href: '/verify?id=:id',
    keywords: 'certificate authenticity check public' },

  { id: 'ctx.person.open', label: 'Open this profile', section: 'contextual',
    context: ['person'], href: '/people/:id',
    keywords: 'biography official profile' },

  // A coach has no page of their own, so the coach verbs are the pipeline
  // stages the federation actually works. Naming them here rather than
  // inventing /admin/coaches/:id keeps the palette honest.
  { id: 'ctx.coach.pipeline', label: 'Coach pipeline', section: 'contextual',
    context: ['coach'], href: '/admin/coaches', requires: 'coach:read',
    keywords: 'candidates recruitment instructors' },
  { id: 'ctx.coach.screening', label: 'Coaches in screening', section: 'contextual',
    context: ['coach'], href: '/admin/coaches?status=screening', requires: 'coach:review',
    keywords: 'vetting background candidate' },
  { id: 'ctx.coach.documents', label: 'Coaches awaiting a document check', section: 'contextual',
    context: ['coach'], href: '/admin/coaches?status=document_check', requires: 'coach:review',
    keywords: 'papers qualifications certificates check' },

  { id: 'ctx.lead.open', label: 'Open this lead', section: 'contextual',
    context: ['lead'], href: '/admin/leads?lead=:id', requires: 'engagement:read',
    keywords: 'crm enquiry pipeline opportunity' },

  { id: 'ctx.application.open', label: 'Open this application', section: 'contextual',
    context: ['application'], href: '/learn/applications/:id',
    keywords: 'reference institution school progress' },
  { id: 'ctx.application.queue', label: 'Application queue', section: 'contextual',
    context: ['application'], href: '/admin/applications', requires: 'engagement:read',
    keywords: 'intake institutions submissions' },

  { id: 'ctx.quote.list', label: 'Quotes and proposals', section: 'contextual',
    context: ['quote'], href: '/admin/quotes', requires: 'quote:read',
    keywords: 'quotation proposal pricing approval' },

  { id: 'ctx.program.list', label: 'Programmes', section: 'contextual',
    context: ['program'], href: '/admin/programs', requires: 'program:read',
    keywords: 'template curriculum delivery' },
  { id: 'ctx.program.attendance', label: 'Attendance for programmes', section: 'contextual',
    context: ['program'], href: '/admin/attendance', requires: 'attendance:read',
    keywords: 'register sessions marks' },

  { id: 'ctx.grading.open', label: 'Open this grading', section: 'contextual',
    context: ['grading'], href: '/admin/grading?g=:id', requires: 'grading:read',
    keywords: 'examination panel belt kyu dan' },

  { id: 'ctx.booking.list', label: 'Bookings and calendar', section: 'contextual',
    context: ['booking'], href: '/admin/bookings', requires: 'booking:read',
    keywords: 'schedule diary sessions' },
  { id: 'ctx.venue.list', label: 'Venues', section: 'contextual',
    context: ['venue'], href: '/admin/venues', requires: 'venue:read',
    keywords: 'hall space location' },
  { id: 'ctx.venue.withdrawn', label: 'Withdrawn venues', section: 'contextual',
    context: ['venue'], href: '/admin/venues?show=withdrawn', requires: 'venue:read',
    keywords: 'removed unavailable retired' },

  { id: 'ctx.task.open', label: 'Open tasks', section: 'contextual',
    context: ['task'], href: '/admin/tasks?view=open', requires: 'task:read',
    keywords: 'work queue assigned todo' },
  { id: 'ctx.ticket.desk', label: 'Support desk', section: 'contextual',
    context: ['ticket'], href: '/admin/support', requires: 'support:read',
    keywords: 'help enquiry member question' },

  { id: 'ctx.workflow.run', label: 'Open this automation run', section: 'contextual',
    context: ['workflow'], href: '/admin/workflows?run=:id', requires: 'workflow:read',
    keywords: 'automation trigger execution log' },

  { id: 'ctx.approval.open', label: 'Find this approval request', section: 'contextual',
    context: ['approval'], href: '/admin/approvals?requestId=:id', requires: 'audit:read',
    keywords: 'audit trail decision record' },

  { id: 'ctx.listing.open', label: 'Open this listing', section: 'contextual',
    context: ['listing'], href: '/portal/listings/:id',
    keywords: 'marketplace item seller product' },
  { id: 'ctx.listing.review', label: 'Marketplace review queue', section: 'contextual',
    context: ['listing'], href: '/admin/listings', requires: 'marketplace:review',
    keywords: 'seller approve suspend listing' },

  { id: 'ctx.kata.open', label: 'Open this kata', section: 'contextual',
    context: ['kata'], href: '/kata/:id',
    keywords: 'form syllabus embusen' },

  // The one dashboard, narrowed. See the header of /admin/dashboard: authority
  // is resolved from the database, never from the query string, so pointing at
  // a scope the caller cannot see produces a refusal rather than a leak.
  { id: 'ctx.state.dashboard', label: 'Dashboard for this state', section: 'contextual',
    context: ['state'], href: '/admin/dashboard?scope=state&id=:id', requires: 'dojo:read',
    keywords: 'figures register measurements unit' },
  { id: 'ctx.district.dashboard', label: 'Dashboard for this district', section: 'contextual',
    context: ['district'], href: '/admin/dashboard?scope=district&id=:id', requires: 'dojo:read',
    keywords: 'figures register measurements unit' },
  { id: 'ctx.dojo.dashboard', label: 'Dashboard for this dojo', section: 'contextual',
    context: ['dojo'], href: '/admin/dashboard?scope=dojo&id=:id', requires: 'dojo:read',
    keywords: 'figures register measurements club' },

  // ── Actions ───────────────────────────────────────────────────────────────

  // The four verbs that run in the browser. None of them invents anything: they
  // act on the page the reader is already on.
  { id: 'do.search', label: 'Search the federation', section: 'action',
    verb: 'search', href: '/search',
    keywords: 'find look up query everything' },
  { id: 'do.copy', label: 'Copy a link to this page', section: 'action',
    verb: 'copy-link',
    keywords: 'url address share clipboard' },
  { id: 'do.print', label: 'Print this page', section: 'action',
    verb: 'print',
    keywords: 'pdf paper export hard copy' },
  { id: 'do.shortcuts', label: 'Keyboard shortcuts', section: 'action',
    verb: 'shortcuts',
    keywords: 'keys chords help accelerators question mark' },

  // Entry points to something new. The keyword "new" is what the N shortcut
  // types into the palette, so these are what a reader sees when they press it —
  // the federation's real starting points, not an invented "create" screen.
  { id: 'do.register', label: 'Register with the federation', section: 'action',
    href: '/register',
    keywords: 'new join member sign up start create' },
  { id: 'do.affiliate', label: 'Affiliate a dojo', section: 'action',
    href: '/affiliation',
    keywords: 'new club charter apply start create' },
  { id: 'do.request.training', label: 'Request training', section: 'action',
    href: '/learn/request',
    keywords: 'new school corporate university enquiry start create' },
  { id: 'do.apply', label: 'Start an application', section: 'action',
    href: '/learn/apply',
    keywords: 'new institution intake start create' },
  { id: 'do.seller.register', label: 'Register as a seller', section: 'action',
    href: '/portal/register',
    keywords: 'new marketplace vendor start create' },
  { id: 'do.verify', label: 'Verify a credential', section: 'action',
    href: '/verify',
    keywords: 'certificate rank membership authenticity check' },
  { id: 'do.estimate', label: 'Estimate a programme', section: 'action',
    href: '/training/estimate',
    keywords: 'cost indication planning school' },

  // Filtered views of a queue. Each one is a query string a page already
  // parses; none of them is a saved search this file invented.
  { id: 'do.applications.unassigned', label: 'Applications nobody has picked up', section: 'action',
    href: '/admin/applications?unassigned=1', requires: 'engagement:read',
    keywords: 'unclaimed intake queue institutions' },
  { id: 'do.applications.submitted', label: 'Applications waiting to be read', section: 'action',
    href: '/admin/applications?status=submitted', requires: 'engagement:read',
    keywords: 'submitted new queue intake' },
  { id: 'do.leads.new', label: 'Leads nobody has picked up', section: 'action',
    href: '/admin/leads?status=new', requires: 'engagement:read',
    keywords: 'crm enquiry unclaimed pipeline' },
  { id: 'do.support.unassigned', label: 'Tickets nobody has picked up', section: 'action',
    href: '/admin/support?unassigned=1', requires: 'support:read',
    keywords: 'unclaimed help desk queue' },
  { id: 'do.tasks.open', label: 'Open tasks', section: 'action',
    href: '/admin/tasks?view=open', requires: 'task:read',
    keywords: 'work queue todo assigned' },
  { id: 'do.coaches.screening', label: 'Coaches in screening', section: 'action',
    href: '/admin/coaches?status=screening', requires: 'coach:review',
    keywords: 'vetting candidate pipeline' },
  { id: 'do.coaches.documents', label: 'Coaches awaiting a document check', section: 'action',
    href: '/admin/coaches?status=document_check', requires: 'coach:review',
    keywords: 'papers qualifications candidate' },
  { id: 'do.programs.review', label: 'Programmes under review', section: 'action',
    href: '/admin/programs?status=under_review', requires: 'program:read',
    keywords: 'template approval curriculum' },
  { id: 'do.attendance.noshow', label: 'Sessions marked no show', section: 'action',
    href: '/admin/attendance?view=no_show', requires: 'attendance:read',
    keywords: 'absent register missing' },
  { id: 'do.attendance.corrected', label: 'Corrected attendance marks', section: 'action',
    href: '/admin/attendance?view=corrected', requires: 'attendance:read',
    keywords: 'amended changed register provenance' },

  // ── Navigation: operations ────────────────────────────────────────────────
  //
  // Not in ADMIN_GROUPS, and a real page. It is the one dashboard for every
  // level of the federation, gated on dojo:read because that is the action held
  // by exactly the administrators who have a register to look at.
  { id: 'go.admin.dashboard', label: 'Federation dashboard', section: 'navigation',
    href: '/admin/dashboard', requires: 'dojo:read',
    keywords: 'figures statistics register scope state district dojo home' },

  // buildRegistry() inserts the admin modules directly after this command, so
  // an administrator's operations sit at the top of the navigation section
  // rather than below the kata library. It keys off the id above.

  // ── Navigation: the personal record ───────────────────────────────────────
  { id: 'go.my', label: 'My record', section: 'navigation',
    href: '/my',
    keywords: 'me personal account home dashboard mine' },
  { id: 'go.my.passport', label: 'My karate passport', section: 'navigation',
    href: '/my/passport',
    keywords: 'grades ranks history record book' },
  { id: 'go.my.courses', label: 'My courses', section: 'navigation',
    href: '/my/courses',
    keywords: 'academy learning enrolled study' },

  // ── Navigation: competition ───────────────────────────────────────────────
  { id: 'go.competitions', label: 'Competitions', section: 'navigation',
    href: '/competitions',
    keywords: 'tournament championship event kumite kata' },
  { id: 'go.events', label: 'Calendar of events', section: 'navigation',
    href: '/events',
    keywords: 'diary dates fixtures results' },
  { id: 'go.calendar', label: 'Federation calendar', section: 'navigation',
    href: '/calendar',
    keywords: 'dates ics subscribe diary' },
  { id: 'go.rankings', label: 'Rankings', section: 'navigation',
    href: '/rankings',
    keywords: 'standings order points league table' },
  { id: 'go.athletes', label: 'Athletes', section: 'navigation',
    href: '/athletes',
    keywords: 'competitors squad roster people' },
  { id: 'go.officials', label: 'Officials', section: 'navigation',
    href: '/officials',
    keywords: 'referees judges licences panel' },
  { id: 'go.scoreboard', label: 'Scoreboard', section: 'navigation',
    href: '/scoreboard',
    keywords: 'live score mat tatami' },
  { id: 'go.live', label: 'Live', section: 'navigation',
    href: '/live',
    keywords: 'now streaming happening today' },

  // ── Navigation: the sport ─────────────────────────────────────────────────
  { id: 'go.shotokan', label: 'Shotokan', section: 'navigation',
    href: '/shotokan',
    keywords: 'style lineage jka history' },
  { id: 'go.kata', label: 'Kata library', section: 'navigation',
    href: '/kata',
    keywords: 'forms syllabus heian bassai' },
  { id: 'go.belt', label: 'Grades and belts', section: 'navigation',
    href: '/belt-system',
    keywords: 'kyu dan syllabus ranks colours' },
  { id: 'go.regulations', label: 'Regulations', section: 'navigation',
    href: '/regulations',
    keywords: 'rules competition wkf law' },

  // ── Navigation: the federation ────────────────────────────────────────────
  { id: 'go.about', label: 'About MMAKF', section: 'navigation',
    href: '/about',
    keywords: 'federation history who we are' },
  { id: 'go.governance', label: 'Governance', section: 'navigation',
    href: '/governance',
    keywords: 'constitution board committee policy' },
  { id: 'go.people', label: 'People', section: 'navigation',
    href: '/people',
    keywords: 'officers instructors profiles directory' },
  { id: 'go.network', label: 'Network', section: 'navigation',
    href: '/network',
    keywords: 'states districts units map structure' },
  { id: 'go.documents', label: 'Documents', section: 'navigation',
    href: '/documents',
    keywords: 'policies forms downloads papers' },
  { id: 'go.press', label: 'Media and press', section: 'navigation',
    href: '/press',
    keywords: 'news journalist release crest' },
  { id: 'go.contact', label: 'Support', section: 'navigation',
    href: '/contact',
    keywords: 'help contact email question reach' },
  { id: 'go.faq', label: 'Frequently asked questions', section: 'navigation',
    href: '/faq',
    keywords: 'help answers common questions' },

  // ── Navigation: the network ───────────────────────────────────────────────
  { id: 'go.dojos', label: 'Affiliated centres', section: 'navigation',
    href: '/dojos',
    keywords: 'clubs dojo find near map' },
  { id: 'go.affiliation', label: 'Affiliation', section: 'navigation',
    href: '/affiliation',
    keywords: 'join charter club recognition' },
  { id: 'go.facilities', label: 'Headquarters', section: 'navigation',
    href: '/facilities',
    keywords: 'patratu building dojo address' },
  { id: 'go.unit', label: 'Unit portal', section: 'navigation',
    href: '/unit',
    keywords: 'state district access code' },

  // ── Navigation: training and engagement ───────────────────────────────────
  { id: 'go.training', label: 'Training and engagement', section: 'navigation',
    href: '/training',
    keywords: 'programmes institutions delivery' },
  { id: 'go.learn', label: 'Learn', section: 'navigation',
    href: '/learn',
    keywords: 'training institutions clients home' },
  { id: 'go.learn.schools', label: 'For schools', section: 'navigation',
    href: '/learn/schools',
    keywords: 'school children curriculum institution' },
  { id: 'go.learn.corporates', label: 'For corporates', section: 'navigation',
    href: '/learn/corporates',
    keywords: 'corporate workplace employees wellbeing' },
  { id: 'go.learn.universities', label: 'For universities', section: 'navigation',
    href: '/learn/universities',
    keywords: 'university college campus students' },
  { id: 'go.learn.government', label: 'For government', section: 'navigation',
    href: '/learn/government',
    keywords: 'government public sector scheme' },
  { id: 'go.learn.communities', label: 'For communities', section: 'navigation',
    href: '/learn/communities',
    keywords: 'community outreach neighbourhood' },
  { id: 'go.learn.individuals', label: 'For individuals', section: 'navigation',
    href: '/learn/individuals',
    keywords: 'personal private one to one' },
  { id: 'go.learn.coaches', label: 'For coaches', section: 'navigation',
    href: '/learn/coaches',
    keywords: 'instructor teach career apply' },
  { id: 'go.learn.portal', label: 'Client portal', section: 'navigation',
    href: '/learn/portal',
    keywords: 'institution login account clients' },
  { id: 'go.academy', label: 'Education and courses', section: 'navigation',
    href: '/academy',
    keywords: 'online learning course study' },
  { id: 'go.programs', label: 'Programmes', section: 'navigation',
    href: '/programs',
    keywords: 'classes offerings curriculum' },
  { id: 'go.schedule', label: 'Class schedule', section: 'navigation',
    href: '/schedule',
    keywords: 'timetable times classes when' },

  // ── Navigation: the marketplace and the member ────────────────────────────
  { id: 'go.shop', label: 'Shop', section: 'navigation',
    href: '/shop',
    keywords: 'marketplace gi equipment buy' },
  { id: 'go.portal', label: 'Seller portal', section: 'navigation',
    href: '/portal',
    keywords: 'marketplace vendor account listings' },
  { id: 'go.portal.listings', label: 'My listings', section: 'navigation',
    href: '/portal/listings',
    keywords: 'marketplace items products seller' },
  { id: 'go.portal.applications', label: 'My seller applications', section: 'navigation',
    href: '/portal/applications',
    keywords: 'marketplace vendor review status' },
  { id: 'go.registration', label: 'Member registration', section: 'navigation',
    href: '/registration',
    keywords: 'join membership enrol number' },
  { id: 'go.gallery', label: 'Gallery', section: 'navigation',
    href: '/gallery',
    keywords: 'photographs images pictures' },
  { id: 'go.home', label: 'Home', section: 'navigation',
    href: '/',
    keywords: 'front page start index mmakf' },
];

/**
 * BASE_COMMANDS with the admin modules spliced in after the dashboard.
 *
 * The modules are GENERATED from ADMIN_GROUPS rather than retyped, so the
 * sidebar and the palette cannot disagree about which modules exist or which
 * action gates each one — a module added to surface.ts appears in both without
 * anybody remembering this file.
 */
function buildRegistry(): Command[] {
  const modules: Command[] = [];
  for (const group of ADMIN_GROUPS) {
    for (const m of group.modules) {
      modules.push({
        id: `go${m.href.replace(/\//g, '.')}`,
        label: m.label,
        section: 'navigation',
        group: 'Operations',
        keywords: `${group.label} operations admin module`,
        href: m.href,
        requires: m.action as Action,
      });
    }
  }

  const out: Command[] = [];
  for (const c of BASE_COMMANDS) {
    out.push(c);
    if (c.id === 'go.admin.dashboard') out.push(...modules);
  }
  return out;
}

const REGISTRY: Command[] = buildRegistry();

export const COMMANDS: readonly Command[] = REGISTRY;

/**
 * Every action the palette gates on, once each.
 *
 * Derived from the registry so that adding a command with a new `requires`
 * cannot leave that action unasked. actionsFor() walks this and nothing wider —
 * there is no reason to interrogate the whole authorisation model to draw a
 * menu.
 */
export const PALETTE_ACTIONS: readonly Action[] = Array.from(
  new Set(REGISTRY.map((c) => c.requires).filter((a): a is Action => !!a))
);

/**
 * The caller's actions, as buildCommands() wants them.
 *
 * canAnywhere() rather than can(): the palette offers a LIST, and asking can()
 * with an empty resource would refuse every scoped administrator — a state
 * administrator holds no national binding, and would see an empty palette while
 * their own sidebar was full. The page behind each href then applies the scope
 * filter to the rows, which is where scoping belongs.
 */
export function actionsFor(principal: Principal | null | undefined): Action[] {
  if (!principal) return [];
  return PALETTE_ACTIONS.filter((a) => canAnywhere(principal, a));
}

// ─── Surface reachability ───────────────────────────────────────────────────

/**
 * Can this internal path be reached from this host at all?
 *
 * www serves every internal path as written. learn and admin rewrite anything
 * unprefixed into their own tree, so from learn.mmakf.in only /learn/… survives
 * — see rewriteTarget() in surface.ts. Offering the rest would be offering 404s.
 */
export function reachableOn(surface: Surface, path: string): boolean {
  const prefix = SURFACE_PREFIX[surface];
  if (!prefix) return true;
  const clean = path.split('?')[0];
  return clean === prefix || clean.startsWith(`${prefix}/`);
}

// ─── Building the list ──────────────────────────────────────────────────────

export interface ResolvedCommand {
  id: string;
  label: string;
  section: Section;
  /** The heading this command sits under. */
  group: string;
  keywords: string;
  /** Surface-resolved and entity-substituted, or null for a pure verb. */
  href: string | null;
  verb: ClientVerb | null;
}

export interface BuildOptions {
  /** What the caller may do. See actionsFor(). */
  actions: readonly Action[];
  surface: Surface;
  /**
   * Is the caller federation operations staff? See isOperations().
   *
   * DEFAULTS TO FALSE, which is the fail-safe direction: a caller who forgets
   * to pass it gets a palette with no operations entries, rather than a member
   * being offered the approval queue.
   */
  operations?: boolean;
  /** What the page is looking at, if anything. */
  entity?: EntityContext | null;
}

/** Substitute :id, or refuse the command when there is nothing to substitute. */
function fillId(path: string, id: string | number | null | undefined): string | null {
  if (!path.includes(':id')) return path;
  const raw = id === 0 ? '0' : id ? String(id) : '';
  if (!raw.trim()) return null;
  return path.replace(':id', encodeURIComponent(raw.trim()));
}

/**
 * The commands this caller may run, on this host, on this page.
 *
 * Section order is contextual, then actions, then navigation. Recent is
 * inserted by the browser after the contextual block: what the page is looking
 * at beats what the reader did yesterday, because they opened the palette while
 * looking at it.
 */
export function buildCommands(o: BuildOptions): ResolvedCommand[] {
  const held = new Set<Action>(o.actions);
  const operations = o.operations === true;
  const entity = o.entity ?? null;
  const out: ResolvedCommand[] = [];

  const contextHeading = entity
    ? (entity.label || '').trim() || ENTITY_HEADING[entity.kind]
    : '';

  for (const c of REGISTRY) {
    // Contextual commands exist only when the page declared the right entity.
    if (c.section === 'contextual') {
      if (!entity) continue;
      if (!c.context || !c.context.includes(entity.kind)) continue;
    } else if (c.context) {
      continue;   // a contextual verb mislabelled — never offer it loose
    }

    if (c.requires && !held.has(c.requires)) continue;

    // The operations floor. Every /admin destination needs both the module's
    // own action AND a caller who is operations staff — see isOperations() and
    // the reasoning above it. Keyed off the path rather than a flag per command
    // so a destination added under /admin cannot be given the weaker gate by
    // forgetting a field.
    if (!operations && c.href && c.href.startsWith('/admin')) continue;

    let href: string | null = null;
    if (c.href) {
      const filled = fillId(c.href, entity?.id);
      if (!filled) continue;                       // needed an id, had none
      if (!reachableOn(o.surface, filled)) continue;
      href = surfaceHref(o.surface, filled);
    }

    out.push({
      id: c.id,
      label: c.label,
      section: c.section,
      group: c.group ?? (c.section === 'contextual' ? contextHeading
        : c.section === 'action' ? 'Actions'
        : 'Navigation'),
      keywords: c.keywords ?? '',
      href,
      verb: c.verb ?? null,
    });
  }

  return out;
}

// ─── Chords (§81) ───────────────────────────────────────────────────────────

/**
 * G-then-D, G-then-C, G-then-A, G-then-R.
 *
 * Each chord names CANDIDATES in order and the first survivor wins, so G then D
 * takes an administrator to the federation dashboard and a member to their own
 * record — both real pages, neither invented, and no chord silently does
 * nothing for anybody who has somewhere to be. When no candidate survives
 * filtering the chord is not bound at all, and the help panel does not list it:
 * a shortcut advertised and then ignored is the same broken promise as a
 * command the caller will be refused.
 */
const CHORD_TABLE: ReadonlyArray<{ keys: string; label: string; candidates: readonly string[] }> = [
  { keys: 'g d', label: 'Dashboard', candidates: ['go.admin.dashboard', 'go.my'] },
  { keys: 'g c', label: 'Competitions', candidates: ['go.admin.competition', 'go.competitions'] },
  { keys: 'g a', label: 'Athletes', candidates: ['go.athletes', 'go.admin.membership'] },
  { keys: 'g r', label: 'Rankings', candidates: ['go.rankings', 'go.admin.report'] },
];

export interface ChordBinding {
  /** As typed, space separated: 'g d'. */
  keys: string;
  label: string;
  commandId: string;
  href: string | null;
}

export function resolveChords(commands: readonly ResolvedCommand[]): ChordBinding[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const out: ChordBinding[] = [];
  for (const row of CHORD_TABLE) {
    for (const id of row.candidates) {
      const cmd = byId.get(id);
      if (!cmd || !cmd.href) continue;
      out.push({ keys: row.keys, label: cmd.label, commandId: cmd.id, href: cmd.href });
      break;
    }
  }
  return out;
}

// ─── Matching (§11) ─────────────────────────────────────────────────────────
//
// Subsequence matching, ranked so that an exact prefix wins. Plain code: a
// fuzzy-search library is four kilobytes and a dependency for something that is
// forty lines and needs to behave in a way this codebase can argue about.
//
// The ordering, best first:
//
//   the whole label            typing "rankings" puts Rankings above everything
//   a prefix of the label      "comp" -> Competitions before Federation dashboard
//   a prefix of a word in it   "desk" -> Support desk
//   anywhere in the label      earlier is better
//   a subsequence of it        "cmpt" -> Competitions; contiguity is rewarded
//   one typo away              "rnakings", "competiton"
//
// Keywords are matched by the same rules and scored at a discount, so a command
// whose LABEL matches always beats one that only matched a synonym.

export interface Match {
  score: number;
  /** Indices in the label that matched, for emphasis. Empty for a keyword hit. */
  indices: number[];
}

const WORD_BREAK = /[^a-z0-9]+/;

/** Is `b` reachable from `a` by one insertion, deletion, substitution or swap? */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  if (la === lb) {
    let diff = -1;
    for (let i = 0; i < la; i++) {
      if (a[i] === b[i]) continue;
      if (diff >= 0) {
        // A transposition is the typo people actually make: "competiton".
        return diff === i - 1 && a[diff] === b[i] && a[i] === b[diff]
          && a.slice(i + 1) === b.slice(i + 1);
      }
      diff = i;
    }
    return true;
  }

  const short = la < lb ? a : b;
  const long = la < lb ? b : a;
  let i = 0, j = 0, skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/**
 * Score `query` against one piece of text, or null when it does not match.
 *
 * Scores are absolute rather than normalised so that the sections can be ordered
 * by their best member without a second pass of arithmetic.
 */
export function matchText(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  if (!t) return null;

  const all = (from: number) => {
    const idx: number[] = [];
    for (let i = 0; i < q.length; i++) idx.push(from + i);
    return idx;
  };

  if (t === q) return { score: 1000, indices: all(0) };
  if (t.startsWith(q)) {
    // Penalised by what is left of the FIRST WORD, not by the length of the
    // whole string. Penalising the whole string is wrong for keywords, which
    // are a bag of words rather than a phrase: typing "new" put "Media and
    // press" (keywords "news journalist release crest") above "Affiliate a
    // dojo" (keywords "new club charter apply start create") purely because the
    // first bag is eight characters shorter. What should decide it is that one
    // word IS "new" and the other is "news".
    const firstWord = t.split(WORD_BREAK)[0] ?? t;
    return { score: 900 - Math.min(Math.max(firstWord.length - q.length, 0), 60), indices: all(0) };
  }

  // A prefix of any word: "desk" in "Support desk".
  let cursor = 0;
  for (const word of t.split(WORD_BREAK)) {
    if (!word) { cursor += 1; continue; }
    const at = t.indexOf(word, cursor);
    if (at >= 0 && word.startsWith(q)) return { score: 780 - at, indices: all(at) };
    cursor = at >= 0 ? at + word.length : cursor + word.length;
  }

  const inside = t.indexOf(q);
  if (inside > 0) return { score: 620 - inside, indices: all(inside) };

  // Subsequence. Contiguous runs score better, and a match that starts early
  // scores better than the same letters found at the end.
  const indices: number[] = [];
  let qi = 0, run = 0, bonus = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) { run = 0; continue; }
    indices.push(ti);
    run += 1;
    bonus += run;
    // A letter that begins a word is worth more than one in the middle.
    if (ti === 0 || WORD_BREAK.test(t[ti - 1] ?? '')) bonus += 4;
    qi++;
  }
  if (qi === q.length) {
    return { score: 400 + Math.min(bonus, 80) - Math.min(indices[0] ?? 0, 40), indices };
  }

  // Typo tolerance, last: only reached when nothing above matched at all.
  if (q.length >= 4) {
    if (withinOneEdit(q, t.slice(0, q.length + 1))) return { score: 260, indices: [] };
    for (const word of t.split(WORD_BREAK)) {
      if (word.length >= 4 && withinOneEdit(q, word)) return { score: 240, indices: [] };
    }
  }

  return null;
}

export interface RankedCommand {
  cmd: ResolvedCommand;
  score: number;
  indices: number[];
}

/**
 * Rank a built list against what the reader typed.
 *
 * An empty query returns the list in registry order with no scores — the
 * palette's resting state is the federation's own ordering, not an alphabetical
 * one that buries the command centre under "Attendance".
 */
export function rankCommands(query: string, commands: readonly ResolvedCommand[]): RankedCommand[] {
  const q = query.trim();
  if (!q) return commands.map((cmd) => ({ cmd, score: 0, indices: [] }));

  const ranked: RankedCommand[] = [];
  for (const cmd of commands) {
    const onLabel = matchText(q, cmd.label);
    const onKeywords = cmd.keywords ? matchText(q, cmd.keywords) : null;
    if (!onLabel && !onKeywords) continue;

    const labelScore = onLabel ? onLabel.score : 0;
    // 0.55 rather than 0.5 for no deep reason beyond the outcome: it keeps a
    // strong keyword hit above a weak subsequence on an unrelated label.
    const keywordScore = onKeywords ? onKeywords.score * 0.55 : 0;

    let score = Math.max(labelScore, keywordScore);
    // The reader opened the palette while looking at the entity, so its verbs
    // are worth a nudge — not enough to beat an exact match on something else.
    if (cmd.section === 'contextual') score += 60;

    ranked.push({ cmd, score, indices: onLabel ? onLabel.indices : [] });
  }

  // Stable: equal scores keep registry order, so the list does not reshuffle
  // between two keystrokes that changed nothing.
  return ranked
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (b.r.score - a.r.score) || (a.i - b.i))
    .map(({ r }) => r);
}
