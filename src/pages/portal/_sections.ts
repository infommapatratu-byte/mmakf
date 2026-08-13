// The portal's section catalogue.
//
// UNDERSCORE-PREFIXED, so Astro does not route it: this is the data behind
// /portal, not a page. It is a .ts file rather than an .astro partial for the
// same reason — a partial under src/pages/ would be walked by
// tests/accessibility.test.ts and required to carry an <h1> it has no business
// carrying.
//
// THE ONE IDEA THIS FILE EXISTS TO ENFORCE
// ────────────────────────────────────────
// A menu that lists what a role "should" be able to do drifts from what the
// policy engine actually permits, and the drift is only ever discovered by a
// user clicking a link and being refused. So no role appears anywhere in this
// file. Every entry declares the ACTIONS its destination requires, and
// visibleSections() asks src/lib/rbac.ts whether the caller holds one. Widening
// or narrowing a role in rbac.ts moves this menu on the next request, with no
// edit here.
//
// WHY canAnywhere() AND NOT can()
// ───────────────────────────────
// `can(principal, action, {})` asks about a resource with no location, and a
// resource with no location is only reachable from a NATIONAL binding — by
// design, so a state administrator cannot edit national content. Every
// destination below is a LIST surface whose rows are then restricted by
// visibleScopes(), which is exactly the shape canAnywhere() was written for
// (see its docstring, and the gates on /admin/grading and /admin/governance
// that already work this way). Using can() here would hide every one of these
// links from every scoped administrator in the federation — a menu that is
// wrong in the safe direction is still wrong.
//
// THE MENU IS NEVER THE CONTROL. Each destination re-checks server-side, and
// several of them refuse things this catalogue cannot see: a listing queue is
// scoped to the reviewer's own state, /admin/dashboard re-authorises the unit it
// resolved from the database, and the marketplace refuses a seller reviewing
// their own shop. Hiding a link is a courtesy to the user; the refusal is the
// control.

import { canAnywhere, type Action, type Principal } from '@/lib/rbac';

/** A destination, and what reaches it. */
export interface PortalLink {
  href: string;
  label: string;
  /** One line describing what is actually behind the link. */
  what: string;
  /**
   * Any ONE of these actions reaches the destination. An empty list means the
   * surface needs no authority beyond a signed-in account — it reads the
   * caller's own record and takes no identifier — and the destination still
   * decides what it will show.
   */
  anyOf: readonly Action[];
  /**
   * A gate that is not an action at all but a fact about the caller's records.
   * Rule 5: an approved seller may list; a seller who has merely applied may
   * not, and no role in rbac.ts can express that because it is not authority
   * over other people — it is a status on the caller's own seller row.
   */
  dataGate?: 'approved_seller';
}

export interface PortalSection {
  id: string;
  eyebrow: string;
  title: string;
  blurb: string;
  links: readonly PortalLink[];
}

/**
 * What the caller's own records say, for the gates an action cannot express.
 * Resolved by the page from the session — never from the request.
 */
export interface PortalFacts {
  /**
   * True when the credential belongs to an individual — `identity.userId` is
   * not null.
   *
   * A shared office credential (the legacy admin password, the unit access
   * code) authenticates a DESK, not a person. It holds national authority and
   * every federation section below is correct for it, but it has no member
   * record, no applications and no seller account, and every "your own" module
   * in this codebase returns nothing for it by construction — mySellerAccount()
   * and myApplications() both key on `principal.userId`. Offering those links
   * to a shared credential would send it to three pages that can only tell it
   * there is nothing there.
   */
  attributable?: boolean;
  sellerApproved?: boolean;
}

// ─── The catalogue ──────────────────────────────────────────────────────────
//
// EVERY href BELOW IS A ROUTE THAT EXISTS IN THIS REPOSITORY. tests/portal.test.ts
// asserts it against the filesystem, because a portal that offers the federation
// a surface nobody built is worse than one that offers nothing: it makes the
// missing thing look like a fault in the user's account.

export const PORTAL_SECTIONS: readonly PortalSection[] = [
  {
    id: 'own-record',
    eyebrow: 'Yours',
    title: 'Your own record',
    blurb:
      'Read from the federation’s system of record against the account you signed in with. ' +
      'None of these pages accepts an identifier — there is no "whose record?" to get wrong.',
    links: [
      {
        href: '/my',
        label: 'Member area',
        what: 'Your grade, your membership standing, your event entries and your courses.',
        anyOf: [],
      },
      {
        href: '/my/passport',
        label: 'Athlete passport',
        what: 'Every grade, membership term, licence and result the federation holds against your name.',
        anyOf: [],
      },
      {
        href: '/my/courses',
        label: 'Courses',
        what: 'Your enrolments and the progress derived from the lessons you have completed.',
        anyOf: [],
      },
    ],
  },

  {
    id: 'applications',
    eyebrow: 'Standing',
    title: 'Applying to the federation',
    blurb:
      'Creating an account confers nothing. A coach, referee, judge, examiner or athlete role is ' +
      'applied for here and conferred by MMAKF after a person has read the evidence.',
    links: [
      {
        href: '/portal/applications',
        label: 'Role applications',
        what: 'Apply for a role, see where an application stands, and withdraw one you no longer want.',
        anyOf: [],
      },
    ],
  },

  {
    id: 'selling',
    eyebrow: 'Marketplace',
    title: 'Selling on the MMAKF shop',
    blurb:
      'Two separate gates, and both are the federation’s. MMAKF approves the SELLER; then MMAKF ' +
      'approves each ITEM before the public can see it.',
    links: [
      {
        href: '/portal/selling',
        label: 'Seller account',
        what: 'Apply to sell, or read the standing of the seller record this account already holds.',
        anyOf: [],
      },
      {
        href: '/portal/listings',
        label: 'My listings',
        what: 'Create, edit, submit and withdraw your own items, and see which are publicly visible right now.',
        anyOf: [],
        dataGate: 'approved_seller',
      },
    ],
  },

  {
    id: 'marketplace-review',
    eyebrow: 'Federation',
    title: 'Marketplace review',
    blurb:
      'Seller applications and item listings inside your scope. A state administrator reviews their ' +
      'own state’s sellers and no others; the restriction is applied in SQL, not to the page.',
    links: [
      {
        href: '/portal/review',
        label: 'Seller and listing queues',
        what: 'Approve, reject, suspend or delist — each with a recorded reason.',
        anyOf: ['marketplace:read', 'marketplace:review', 'marketplace:suspend'],
      },
    ],
  },

  {
    id: 'role-review',
    eyebrow: 'Federation',
    title: 'Role applications',
    blurb:
      'Conferring a role on another person. Approval goes through canGrantRole(), so you may only ' +
      'confer what you already hold, and only inside the scope of your own binding.',
    links: [
      {
        href: '/portal/review#applications',
        label: 'Application queue',
        what: 'Read the evidence, then approve or reject with a recorded reason.',
        anyOf: ['role:grant'],
      },
    ],
  },

  {
    id: 'people',
    eyebrow: 'Federation',
    title: 'Members and units',
    blurb: 'The register, the units that hold it, and the measurements taken from both.',
    links: [
      {
        href: '/admin/dashboard',
        label: 'Scoped dashboard',
        what: 'The same measurements at whichever level of the federation your binding reaches.',
        anyOf: ['unit:read'],
      },
      {
        href: '/admin/membership',
        label: 'Membership',
        what: 'Issue, renew and read membership terms; standing is derived, never stored.',
        anyOf: ['membership:read', 'membership:issue', 'membership:revoke'],
      },
      {
        href: '/admin/governance',
        label: 'Units, committees and documents',
        what: 'The unit hierarchy, committee rosters and the federation’s published documents.',
        anyOf: ['unit:read', 'unit:write', 'content:read', 'content:write'],
      },
    ],
  },

  {
    id: 'technical',
    eyebrow: 'Federation',
    title: 'Grading and competition',
    blurb: 'The technical surfaces — what is scored, what is approved, and what is published.',
    links: [
      {
        href: '/admin/grading',
        label: 'Gradings and certificates',
        what: 'Grading panels, scoring, Dan approval and certificate issue.',
        anyOf: ['grading:read', 'grading:score', 'grading:approve', 'certificate:issue', 'certificate:revoke'],
      },
      {
        href: '/admin/competition',
        label: 'Competition',
        what: 'Events, entries, draws, results and the sanctioning decision.',
        anyOf: ['competition:read', 'competition:write', 'competition:sanction', 'result:enter', 'result:finalize'],
      },
    ],
  },

  {
    id: 'office',
    eyebrow: 'Federation',
    title: 'The office queues',
    blurb: 'Work that arrives and has to be decided by somebody.',
    links: [
      {
        href: '/admin/queue',
        label: 'Submissions queue',
        what: 'Membership applications, event entries and unit submissions awaiting a decision.',
        anyOf: ['membership:issue', 'competition:write', 'content:write'],
      },
      {
        href: '/admin/approvals',
        label: 'Two-person control',
        what: 'Acts that need a second person to agree. You can never approve your own request.',
        anyOf: [
          'certificate:revoke', 'grading:approve', 'finance:write',
          'competition:sanction', 'membership:revoke', 'content:write', 'result:finalize',
        ],
      },
      {
        href: '/admin/cases',
        label: 'Safeguarding and discipline',
        what: 'Child-protection casework and disciplinary records.',
        anyOf: ['safeguarding:read', 'safeguarding:write'],
      },
    ],
  },

  {
    id: 'oversight',
    eyebrow: 'Federation',
    title: 'Oversight',
    blurb: 'What the federation can show an auditor, a court or its own general body.',
    links: [
      {
        href: '/admin/command',
        label: 'Command centre',
        what: 'The national view: what is failing, what is lapsing, what is unreconciled.',
        anyOf: ['audit:read'],
      },
      {
        href: '/admin/report',
        label: 'Annual report',
        what: 'The year’s figures, each with the query that produced it.',
        anyOf: ['audit:read'],
      },
    ],
  },
];

// ─── The decision ───────────────────────────────────────────────────────────

/** Does the caller hold any one of these actions, in any scope they are bound in? */
export function holdsAny(
  principal: Principal | null | undefined,
  actions: readonly Action[]
): boolean {
  return actions.some((a) => canAnywhere(principal, a));
}

/**
 * May this link be drawn for this caller?
 *
 * A link with no actions is a "your own record" surface: it needs no authority
 * over anybody, but it does need a credential that belongs to a person.
 *
 * EVERY FACT IS READ FAIL-CLOSED — absent means false, not true. A page that
 * could not load the seller record, or that forgot to say whether the
 * credential is attributable, hides the control rather than offering one the
 * server would then refuse.
 */
export function linkVisible(
  principal: Principal | null | undefined,
  link: PortalLink,
  facts: PortalFacts = {}
): boolean {
  if (!principal) return false;
  if (link.dataGate === 'approved_seller' && facts.sellerApproved !== true) return false;
  if (link.anyOf.length === 0) return facts.attributable === true;
  return holdsAny(principal, link.anyOf);
}

/**
 * The sections this caller may actually reach, with the links they may reach
 * inside them. A section whose every link is hidden is dropped entirely: an
 * empty heading tells the reader they are missing something without telling
 * them what, which is the worst of both.
 */
export function visibleSections(
  principal: Principal | null | undefined,
  facts: PortalFacts = {}
): PortalSection[] {
  const out: PortalSection[] = [];
  for (const section of PORTAL_SECTIONS) {
    const links = section.links.filter((l) => linkVisible(principal, l, facts));
    if (links.length) out.push({ ...section, links });
  }
  return out;
}

/**
 * Which of a link's actions the caller actually holds.
 *
 * Printed under the link so the reason the section is on the page is visible.
 * It discloses nothing: it names only authority the caller already has, read
 * back to them. A person who cannot work out why they can see a queue cannot
 * report it when they should not be able to.
 */
export function admittingActions(
  principal: Principal | null | undefined,
  link: PortalLink
): Action[] {
  return link.anyOf.filter((a) => canAnywhere(principal, a));
}

/** Every destination in the catalogue — used by the route-existence test. */
export function allPortalHrefs(): string[] {
  return PORTAL_SECTIONS.flatMap((s) => s.links.map((l) => l.href));
}
