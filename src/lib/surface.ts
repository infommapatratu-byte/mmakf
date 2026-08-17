// Three hosts, one application.
//
//   www.mmakf.in     the national federation — public, discovery, trust, SEO
//   learn.mmakf.in   training, institutional engagement, client portals
//   admin.mmakf.in   internal operations
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY REWRITING RATHER THAN THREE DEPLOYMENTS
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation asked for three interfaces over ONE platform: one identity,
// one database, one authorisation module, one audit trail. Three deployments
// means three builds that can drift, three sets of environment variables, and
// the standing question of which one is running the version of rbac.ts you are
// reading.
//
// So the routes live at /learn/* and /admin/* in a single app, and the
// middleware rewrites `learn.mmakf.in/schools` to `/learn/schools`. The same
// page is reachable both ways, which matters more than it sounds:
//
//   THE SUBDOMAINS DO NOT EXIST YET. No DNS record, no certificate. Everything
//   here works today on www.mmakf.in/learn/... and starts answering on
//   learn.mmakf.in the moment the record is created, with no code change and no
//   redeploy. A design that only worked once DNS was configured would be a
//   design nobody could test.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MUST NOT BE REWRITTEN
// ─────────────────────────────────────────────────────────────────────────────
//
// /api, /_astro, /_image and anything with a file extension. The API is shared
// deliberately — one set of endpoints, one authorisation choke point — and
// rewriting /api/auth/login to /learn/api/auth/login on one host would give the
// three surfaces three different login endpoints, which is exactly the
// duplication this file exists to avoid.

export type Surface = 'public' | 'learn' | 'admin';

export const SURFACES: readonly Surface[] = ['public', 'learn', 'admin'];

export const SURFACE_ORIGIN: Record<Surface, string> = {
  public: 'https://www.mmakf.in',
  learn: 'https://learn.mmakf.in',
  admin: 'https://admin.mmakf.in',
};

/** The path prefix each surface's routes live under inside src/pages. */
export const SURFACE_PREFIX: Record<Surface, string> = {
  public: '',
  learn: '/learn',
  admin: '/admin',
};

/**
 * Hosts that resolve to something other than the public federation.
 *
 * AN ALLOWLIST OF WHOLE HOSTS, not a rule about the leftmost label.
 *
 * The first version of this matched the first label: `h.split('.')[0]`. It was
 * written with a comment claiming it would refuse
 * `admin.mmakf.in.evil.example` — and it did not, because the leftmost label of
 * that host is, exactly, `admin`. tests/navigation.test.ts asserted the claim
 * and the claim was false.
 *
 * That is the whole reason this is an allowlist. Anyone who can register a
 * domain can put any label they like at the front of it, so a rule about the
 * front of the host is a rule an attacker writes. A rule about the WHOLE host
 * is one only DNS can satisfy.
 *
 * The localhost entries are for development, where the same code must answer
 * `learn.localhost:4321`.
 */
const SURFACE_HOSTS: Record<string, Surface> = {
  'learn.mmakf.in': 'learn',
  'admin.mmakf.in': 'admin',
  'learn.localhost': 'learn',
  'admin.localhost': 'admin',
  'learn.127.0.0.1.nip.io': 'learn',
  'admin.127.0.0.1.nip.io': 'admin',
};

/**
 * Which surface a host is asking for.
 *
 * The port is stripped, and a trailing dot (the fully-qualified form,
 * `admin.mmakf.in.`, which resolves identically in DNS) is normalised away —
 * otherwise it would be a spelling of the admin host that this function does
 * not recognise, and an attacker-controlled way to change which surface is
 * served.
 *
 * Anything unrecognised is PUBLIC. That is the fail-safe direction: an
 * unrecognised host getting the public site is a cosmetic surprise, whereas an
 * unrecognised host getting the admin surface is an incident.
 */
export function surfaceForHost(host: string | null | undefined): Surface {
  const h = String(host ?? '')
    .toLowerCase()
    .trim()
    .split(':')[0]
    .replace(/\.$/, '');
  if (!h) return 'public';
  return SURFACE_HOSTS[h] ?? 'public';
}

/** The hosts that are not the public federation. Exported for the tests. */
export const NON_PUBLIC_HOSTS = Object.keys(SURFACE_HOSTS);

const NEVER_REWRITE = ['/api/', '/_astro/', '/_image', '/_actions/'];

/** Paths the rewriter must leave exactly as they are. */
export function isSharedPath(pathname: string): boolean {
  if (NEVER_REWRITE.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p))) return true;
  // Anything with a file extension: /logo.png, /robots.txt, /sitemap.xml,
  // /calendar.ics. These are served identically from every host.
  return /\.[a-z0-9]+$/i.test(pathname);
}

/**
 * The internal route for a request, or null when no rewrite is needed.
 *
 * Idempotent: a path that is already prefixed is left alone, so a request to
 * learn.mmakf.in/learn/schools does not become /learn/learn/schools.
 */
export function rewriteTarget(surface: Surface, pathname: string): string | null {
  const prefix = SURFACE_PREFIX[surface];
  if (!prefix) return null;
  if (isSharedPath(pathname)) return null;
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return null;
  return `${prefix}${pathname === '/' ? '' : pathname}` || prefix;
}

/**
 * Turn an internal path into the address a visitor should see.
 *
 * On learn.mmakf.in, /learn/schools is written as /schools. On www, it stays
 * /learn/schools. This is what lets one navigation definition serve every host
 * without every link needing to know where it is.
 */
export function href(surface: Surface, internalPath: string): string {
  const prefix = SURFACE_PREFIX[surface];
  if (!prefix) return internalPath;
  if (internalPath === prefix) return '/';
  if (internalPath.startsWith(`${prefix}/`)) return internalPath.slice(prefix.length) || '/';
  return internalPath;
}

/**
 * The absolute canonical URL for a page.
 *
 * One page must advertise ONE address. A page reachable at both
 * www.mmakf.in/learn/schools and learn.mmakf.in/schools that names itself
 * differently depending on which one you arrived through is two pages competing
 * for the same content, which is the duplicate-content problem that costs a
 * site its ranking. The canonical is always the surface's own origin.
 */
export function canonicalFor(surface: Surface, internalPath: string): string {
  const path = href(surface, internalPath).replace(/\/+$/, '') || '/';
  return SURFACE_ORIGIN[surface] + (path === '/' ? '/' : path);
}

/**
 * Should crawlers index this surface?
 *
 * learn is indexable: its audience pages are how a school finds MMAKF at all,
 * and PART AN is explicit that discovery content must not be behind a login.
 * admin is not, and never will be.
 */
export function isIndexable(surface: Surface): boolean {
  return surface !== 'admin';
}

export interface NavItem {
  /** Internal path. Render it through href(surface, …). */
  href: string;
  label: string;
  /** Shown in the primary bar; the rest live in the fuller menu. */
  primary?: boolean;
  children?: Array<{ href: string; label: string; note?: string }>;
}

/**
 * The federation's information architecture.
 *
 * Grouped the way a national federation is actually organised — the sport, the
 * people, the competition, the network, the governance — rather than the way a
 * dojo advertises itself. The previous bar was About / Governance / Programs /
 * Schedule / Events / Affiliation / Registration / Contact, which reads as a
 * club's website: it puts a timetable and an enrolment form at the same level
 * as the constitution of a national body.
 *
 * Every href here is checked against the routes that exist by
 * tests/navigation.test.ts. A menu that offers a page nobody built is worse
 * than a shorter menu — the federation shipped six such links once already.
 */
export const PUBLIC_NAV: NavItem[] = [
  {
    href: '/about', label: 'Federation', primary: true,
    children: [
      { href: '/about', label: 'About MMAKF' },
      { href: '/governance', label: 'Governance' },
      { href: '/people', label: 'People' },
      { href: '/network', label: 'Network' },
      { href: '/documents', label: 'Documents' },
    ],
  },
  {
    href: '/shotokan', label: 'The sport', primary: true,
    children: [
      { href: '/shotokan', label: 'Shotokan' },
      { href: '/kata', label: 'Kata library' },
      { href: '/belt-system', label: 'Grades and belts' },
      { href: '/regulations', label: 'Regulations' },
    ],
  },
  {
    href: '/competitions', label: 'Competition', primary: true,
    children: [
      { href: '/competitions', label: 'Competitions' },
      { href: '/events', label: 'Calendar of events' },
      { href: '/rankings', label: 'Rankings' },
      { href: '/athletes', label: 'Athletes' },
      { href: '/officials', label: 'Officials' },
    ],
  },
  {
    href: '/training', label: 'Training', primary: true,
    children: [
      // /start is the first question of the intake — the page that decides
      // which process runs and hands the visitor to it. It was built and then
      // reachable from nowhere: no menu, no call to action, no page linked it,
      // and the only file that named it was the sitemap section list. A front
      // door with no handle on it is the same finding as the dead-end form it
      // replaced, so it is listed first, above the pages that describe the
      // training rather than begin it.
      { href: '/start', label: 'Begin an engagement' },
      { href: '/training', label: 'Training and engagement' },
      { href: '/karate-for-schools', label: 'For schools' },
      { href: '/karate-for-corporates', label: 'For corporates' },
      { href: '/karate-for-universities', label: 'For universities' },
      { href: '/training/individual', label: 'For individuals' },
      { href: '/academy', label: 'Education and courses' },
    ],
  },
  {
    href: '/dojos', label: 'Network', primary: true,
    children: [
      { href: '/dojos', label: 'Affiliated centres' },
      { href: '/affiliation', label: 'Affiliate a dojo' },
      { href: '/facilities', label: 'Headquarters' },
    ],
  },
  {
    href: '/verify', label: 'Verify', primary: true,
    children: [
      { href: '/verify', label: 'Verify a credential' },
      { href: '/press', label: 'Media and press' },
      { href: '/contact', label: 'Support' },
    ],
  },
];

/**
 * The actions the federation wants a visitor to be able to take.
 *
 * Note what is NOT here: "Book a free trial", "Explore programs", "Train under
 * Shihan". Those are a dojo's calls to action. A national federation's are
 * register, affiliate, request training, verify.
 */
export const PUBLIC_ACTIONS = [
  { href: '/register', label: 'Register' },
  { href: '/learn/request', label: 'Request training' },
  { href: '/affiliation', label: 'Affiliate' },
  { href: '/verify', label: 'Verify a credential' },
];

export const LEARN_NAV: NavItem[] = [
  { href: '/learn/schools', label: 'Schools', primary: true },
  { href: '/learn/corporates', label: 'Corporates', primary: true },
  { href: '/learn/universities', label: 'Universities', primary: true },
  { href: '/learn/government', label: 'Government', primary: true },
  { href: '/learn/communities', label: 'Communities', primary: true },
  { href: '/learn/individuals', label: 'Individuals', primary: true },
  { href: '/learn/coaches', label: 'Coaches', primary: true },
];

export const LEARN_ACTIONS = [
  { href: '/learn/apply', label: 'Start an application' },
  { href: '/learn/portal', label: 'Client portal' },
];

/**
 * The admin modules, grouped.
 *
 * `action` is the RBAC action that gates the module. The navigation is FILTERED
 * BY IT — a finance officer does not see safeguarding in the menu, and a
 * training administrator does not see the disciplinary register. The check is
 * repeated on the page itself; hiding a link is a courtesy, not a control.
 */
export interface AdminModule {
  href: string;
  label: string;
  action: string;
  note?: string;
}

export interface AdminGroup {
  label: string;
  modules: AdminModule[];
}

export const ADMIN_GROUPS: AdminGroup[] = [
  {
    label: 'Command',
    modules: [
      { href: '/admin/command', label: 'Command centre', action: 'content:read' },
      { href: '/admin/queue', label: 'Approval queue', action: 'content:read' },
      { href: '/admin/report', label: 'Reports', action: 'report:read' },
    ],
  },
  {
    label: 'Training and engagement',
    modules: [
      { href: '/admin/applications', label: 'Applications', action: 'engagement:read' },
      { href: '/admin/leads', label: 'Leads and CRM', action: 'engagement:read' },
      { href: '/admin/programs', label: 'Programmes', action: 'program:read' },
      // Reading the pricing RULES, which is a different authority from reading
      // a quotation computed under them — and a different one again from
      // writing or publishing them. See the three feeframework:* actions.
      { href: '/admin/fees', label: 'Fee framework', action: 'feeframework:read' },
      { href: '/admin/quotes', label: 'Quotes and proposals', action: 'quote:read' },
      { href: '/admin/bookings', label: 'Bookings and calendar', action: 'booking:read' },
      { href: '/admin/venues', label: 'Venues', action: 'venue:read' },
      { href: '/admin/attendance', label: 'Attendance', action: 'attendance:read' },
    ],
  },
  {
    label: 'Finance',
    modules: [
      // What the federation took, what it cost to take it, and what is still
      // outstanding. Gated on finance:read, which is a different authority from
      // reading the pricing rules above: a treasurer reads the money and does
      // not set the prices, and whoever sets the prices does not need the
      // turnover.
      { href: '/admin/finance', label: 'Money dashboard', action: 'finance:read' },
      { href: '/admin/reconciliation', label: 'Reconciliation', action: 'finance:read' },
      // OTHER ORGANISATIONS' FEES, and gated on its own action rather than on
      // finance:* — note who does not hold it: every institution role. A client
      // reading the market evidence behind their own quotation would be reading
      // MMAKF's pricing preparation. The label says "other federations" in the
      // menu itself, because a menu entry reading "Benchmarks" beside "Fee
      // framework" invites exactly the misreading the register is built to stop.
      { href: '/admin/benchmarks', label: 'Other federations’ fees', action: 'benchmark:read' },
    ],
  },
  {
    label: 'People',
    modules: [
      { href: '/admin/coaches', label: 'Coaches', action: 'coach:read' },
      { href: '/admin/membership', label: 'Members', action: 'membership:read' },
      { href: '/admin/onboarding', label: 'Role applications', action: 'role:grant' },
      { href: '/admin/governance', label: 'Governance', action: 'content:read' },
    ],
  },
  {
    label: 'Sport',
    modules: [
      { href: '/admin/competition', label: 'Competitions', action: 'competition:read' },
      { href: '/admin/grading', label: 'Grading', action: 'grading:read' },
      // The technical knowledge library and its review queue. Gated on
      // 'technical:read' rather than 'content:read', because deciding that a
      // third party's video meets MMAKF's technical standard — and that MMAKF
      // may lawfully show it — is not the same authority as editing federation
      // copy. A media officer holds content:* and does not appear here.
      { href: '/admin/technical-library', label: 'Technical library', action: 'technical:read' },
    ],
  },
  {
    label: 'Operations',
    modules: [
      { href: '/admin/tasks', label: 'Tasks', action: 'task:read' },
      { href: '/admin/support', label: 'Support desk', action: 'support:read' },
      // How the federation answers "what did the system do on our behalf?"
      // without reading TypeScript.
      { href: '/admin/workflows', label: 'Automations', action: 'workflow:read' },
      // Delivery, not composition. There is no screen anywhere that sends a
      // notification by hand — every message is derived from a domain event
      // that already happened — so this module reads and never writes, and it
      // is gated on notification:read rather than notification:send.
      { href: '/admin/notifications', label: 'Notification delivery', action: 'notification:read' },
      { href: '/admin/listings', label: 'Marketplace', action: 'marketplace:read' },
    ],
  },
  {
    label: 'Assurance',
    modules: [
      // The source register and the federation's own instruments, in one place
      // and drawn as two registers. Gated on 'policy:read' rather than on
      // 'content:read': editorial authority over the website is not authority
      // over what MMAKF's rules are, and folding the two would put the policy
      // register in front of everybody who can edit a page.
      { href: '/admin/policy', label: 'Policy Centre', action: 'policy:read' },
      { href: '/admin/cases', label: 'Cases', action: 'safeguarding:read' },
      // RELABELLED. This entry said "Audit trail" and pointed at the two-person
      // approval queue, which reads no audit event at all — so anybody looking
      // for the federation's record of its own decisions was sent to a list of
      // pending requests and found nothing. Two different screens with two
      // different jobs.
      { href: '/admin/approvals', label: 'Approvals', action: 'audit:read' },
      { href: '/admin/audit', label: 'Audit log', action: 'audit:read' },
    ],
  },
];

/** Every module a principal may reach, grouped, with empty groups dropped. */
export function adminNavFor(
  can: (action: string) => boolean
): AdminGroup[] {
  return ADMIN_GROUPS
    .map((g) => ({ ...g, modules: g.modules.filter((m) => can(m.action)) }))
    .filter((g) => g.modules.length > 0);
}
