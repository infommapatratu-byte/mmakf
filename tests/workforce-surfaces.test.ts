// The workforce surfaces — employee.mmakf.in, /careers, /admin/hr, /admin/hiring.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THESE ASSERT THAT A BEHAVIOURAL TEST WOULD NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// Most of this file checks ROUTING AND ABSENCE, because the failures that
// matter on a new surface are structural:
//
//   · a host that resolves to the wrong surface serves the wrong site;
//   · an employee page that accepts an employment id has an IDOR whether or not
//     today's caller exercises it;
//   · a nav entry pointing at a page that does not exist ships a 404 behind a
//     menu — which this repository has done twice and recorded both times;
//   · `hr:read` reaching a FEDERATION_ADMIN would silently undo PART X.
//
// tests/routes-live.test.ts fetches pages over HTTP; this one reads the source
// and the route table, so it fails in CI without a server.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  SURFACES, SURFACE_ORIGIN, SURFACE_PREFIX, surfaceForHost, surfaceOfPath,
  rewriteTarget, href, linkTo, isIndexable, canonicalFor,
  EMPLOYEE_NAV, PUBLIC_NAV, ADMIN_GROUPS, adminNavFor,
} from '../src/lib/surface';
// The role->action table through its published accessor rather than a
// test-only export of the private GRANTS map: a test that reaches past the
// public API stops testing what callers actually get.
import { actionsForRole } from '../src/lib/rbac';

// ─── The fourth host ────────────────────────────────────────────────────────

describe('employee.mmakf.in resolves to its own surface', () => {
  it('is a recognised surface with an origin and a prefix', () => {
    expect(SURFACES).toContain('employee');
    expect(SURFACE_ORIGIN.employee).toBe('https://employee.mmakf.in');
    expect(SURFACE_PREFIX.employee).toBe('/employee');
  });

  it('maps the host, including the development spellings', () => {
    expect(surfaceForHost('employee.mmakf.in')).toBe('employee');
    expect(surfaceForHost('employee.mmakf.in:443')).toBe('employee');
    // The fully-qualified form resolves identically in DNS and must here too.
    expect(surfaceForHost('employee.mmakf.in.')).toBe('employee');
    expect(surfaceForHost('EMPLOYEE.MMAKF.IN')).toBe('employee');
    expect(surfaceForHost('employee.localhost:4321')).toBe('employee');
  });

  it('refuses a host that merely starts with the label', () => {
    // The allowlist is over WHOLE hosts. Anybody who can register a domain can
    // put any label at the front of it, so a rule about the front of the host
    // is a rule an attacker writes.
    expect(surfaceForHost('employee.mmakf.in.evil.example')).toBe('public');
    expect(surfaceForHost('notemployee.mmakf.in')).toBe('public');
    expect(surfaceForHost('employees.mmakf.in')).toBe('public');
    expect(surfaceForHost('evil-employee.example')).toBe('public');
  });

  it('rewrites its paths and strips the prefix back off for links', () => {
    expect(rewriteTarget('employee', '/leave')).toBe('/employee/leave');
    expect(rewriteTarget('employee', '/')).toBe('/employee');
    // Idempotent: an already-prefixed path is left alone.
    expect(rewriteTarget('employee', '/employee/leave')).toBeNull();
    // Shared paths are never rewritten — one API, one authorisation choke point.
    expect(rewriteTarget('employee', '/api/auth/logout')).toBeNull();
    expect(href('employee', '/employee/leave')).toBe('/leave');
    expect(href('employee', '/employee')).toBe('/');
  });

  it('links off-surface absolutely, so the middleware cannot swallow them', () => {
    // The defect linkTo() exists for: a relative /admin rendered on
    // employee.mmakf.in comes back as a request the middleware rewrites to
    // /employee/admin, and 404s.
    expect(linkTo('employee', '/admin')).toBe('https://admin.mmakf.in/admin');
    expect(linkTo('employee', '/careers')).toBe('https://www.mmakf.in/careers');
    expect(linkTo('employee', '/employee/leave')).toBe('/leave');
  });

  it('classifies its internal paths', () => {
    expect(surfaceOfPath('/employee')).toBe('employee');
    expect(surfaceOfPath('/employee/leave')).toBe('employee');
    expect(surfaceOfPath('/employees')).toBe('public');
  });

  it('is NEVER indexable, and the careers page is', () => {
    expect(isIndexable('employee')).toBe(false);
    expect(isIndexable('admin')).toBe(false);
    // The one workforce thing meant to be found lives on the public surface,
    // which is why closing the employee surface costs the federation nothing.
    expect(isIndexable('public')).toBe(true);
    expect(surfaceOfPath('/careers')).toBe('public');
  });

  it('canonicalises to its own origin', () => {
    expect(canonicalFor('employee', '/employee/leave')).toBe('https://employee.mmakf.in/leave');
  });
});

// ─── Every link resolves to a page that exists ──────────────────────────────

/** src/pages path for an internal route, or null when there is no file. */
function pageFileFor(route: string): string | null {
  const base = `src/pages${route === '/' ? '/index' : route}`;
  for (const c of [`${base}.astro`, `${base}/index.astro`, `${base}.ts`]) {
    if (existsSync(c)) return c;
  }
  return null;
}

describe('no menu entry points at a page that does not exist', () => {
  // This repository has shipped a 404 behind a menu entry twice — /learn/coaches
  // and /learn/request — and recorded both. The discipline that stopped a third
  // is asserted here rather than remembered.
  it('every EMPLOYEE_NAV entry has a page', () => {
    for (const n of EMPLOYEE_NAV) {
      expect(pageFileFor(n.href), `${n.href} has no page file`).not.toBeNull();
    }
  });

  it('the careers entry and its detail route exist', () => {
    const fed = PUBLIC_NAV.find((n) => n.label === 'Federation');
    const careers = fed?.children?.find((c) => c.href === '/careers');
    expect(careers, '/careers is not in PUBLIC_NAV').toBeTruthy();
    expect(pageFileFor('/careers')).not.toBeNull();
    expect(existsSync('src/pages/careers/[slug].astro')).toBe(true);
  });

  it('the two new admin modules have pages', () => {
    const modules = ADMIN_GROUPS.flatMap((g) => g.modules);
    for (const path of ['/admin/hr', '/admin/hiring']) {
      const m = modules.find((x) => x.href === path);
      expect(m, `${path} is not in ADMIN_GROUPS`).toBeTruthy();
      expect(pageFileFor(path), `${path} has no page file`).not.toBeNull();
    }
  });

  it('every employee page renders through EmployeeShell', () => {
    // The shell is what refuses an unauthenticated caller and what tells a
    // signed-in non-employee they have no employment. A page under /employee
    // that skipped it would render its own body to anybody.
    for (const f of readdirSync('src/pages/employee')) {
      if (!f.endsWith('.astro')) continue;
      const src = readFileSync(`src/pages/employee/${f}`, 'utf8');
      expect(src, `src/pages/employee/${f} does not use EmployeeShell`)
        .toContain('EmployeeShell');
    }
  });
});

// ─── PART X, through the navigation ─────────────────────────────────────────

describe('PART X — HR does not appear in an ordinary administrator’s menu', () => {
  it('a FEDERATION_ADMIN is offered neither HR nor recruitment', () => {
    // NATIONAL_FULL deliberately omits hr:*; hiring:* is granted only to
    // HR_OFFICER. adminNavFor() filters on exactly the action each module
    // declares, so this is the navigation half of the same control.
    const nav = adminNavFor((action) => actionsForRole('FEDERATION_ADMIN').includes(action));
    const hrefs = nav.flatMap((g) => g.modules.map((m) => m.href));
    expect(hrefs).not.toContain('/admin/hr');
    expect(hrefs).not.toContain('/admin/hiring');
    // …while the modules they DO hold are still there, so this is not an
    // accidentally-empty menu.
    expect(hrefs).toContain('/admin/team');
  });

  it('an HR_OFFICER is offered both', () => {
    const nav = adminNavFor((action) => actionsForRole('HR_OFFICER').includes(action));
    const hrefs = nav.flatMap((g) => g.modules.map((m) => m.href));
    expect(hrefs).toContain('/admin/hr');
    expect(hrefs).toContain('/admin/hiring');
  });
});

// ─── The employee surface has no id to substitute ───────────────────────────

describe('the employee surface never takes an employment id from the client', () => {
  const PAGES = readdirSync('src/pages/employee').filter((f) => f.endsWith('.astro'));

  it('has pages to check', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(4);
  });

  for (const f of PAGES) {
    it(`${f} posts no employmentId and reads none from the query`, () => {
      const src = readFileSync(`src/pages/employee/${f}`, 'utf8');
      // The self-service functions resolve the caller's own employment from the
      // session. A page that sent an id would be handing the client the one
      // parameter the whole design removes.
      expect(src, `${f} sends an employmentId`).not.toMatch(/name="employmentId"/);
      expect(src, `${f} reads an employmentId from the URL`)
        .not.toMatch(/searchParams\.get\(['"]employmentId/);
      expect(src, `${f} reads a personId from the URL`)
        .not.toMatch(/searchParams\.get\(['"]personId/);
    });
  }

  it('every mutating employee page rate limits and re-checks the session', () => {
    for (const f of PAGES) {
      const src = readFileSync(`src/pages/employee/${f}`, 'utf8');
      if (!src.includes("Astro.request.method === 'POST'")) continue;
      expect(src, `${f} does not rate limit`).toContain('rateLimit(');
      // The rendered page is not evidence of authority: every POST re-reads the
      // session rather than trusting that the form was rendered.
      expect(src, `${f} does not re-check the session on POST`).toContain('!identity');
    }
  });
});

// ─── The careers page is public, and careful about what it exposes ──────────

/** Source with every run of whitespace collapsed, for prose assertions. */
const flat = (src: string) => src.replace(/\s+/g, ' ');

describe('the public careers pages', () => {
  const idx = readFileSync('src/pages/careers/index.astro', 'utf8');
  const detail = readFileSync('src/pages/careers/[slug].astro', 'utf8');

  it('read only the public vacancy functions', () => {
    expect(idx).toContain('publicVacancies');
    expect(detail).toContain('publicVacancy');
    // Never the admin register, which carries the internal id and the counts.
    expect(idx).not.toContain('vacancyRegister');
    expect(detail).not.toContain('vacancyRegister');
  });

  it('never cache an application page', () => {
    // The advert is public; the form beside it carries somebody's name, email
    // and employment history the moment it is filled in.
    expect(detail).toContain('no-store');
  });

  it('carry a honeypot and a rate limit, since anybody at all can reach them', () => {
    expect(detail).toContain('rateLimit(');
    expect(detail).toMatch(/name="website"/);
    // Hidden from assistive technology too — a screen-reader user must never be
    // asked to fill the field that refuses their application.
    expect(detail).toMatch(/hidden aria-hidden="true"/);
  });

  it('promise no response time the federation has not published', () => {
    for (const src of [idx, detail]) {
      expect(src).not.toMatch(/within \d+\s*(hours?|days?|working days?)/i);
      expect(src).not.toMatch(/\b(24|48|72)[\s-]*hours?\b/i);
    }
  });

  it('do not claim a confirmation email that nothing sends', () => {
    // There is no email transport wired in this repository. Promising one would
    // be exactly the fake automation the directive forbids — so the page says
    // the opposite, and this pins it.
    //
    // Matched against whitespace-normalised source, because the sentence is
    // prose inside JSX and a maintainer re-wrapping the paragraph must not fail
    // a test about what the page SAYS. It failed exactly that way: the page
    // carried the sentence with a newline between "no" and "confirmation".
    expect(flat(detail)).toContain('no confirmation email is sent');
  });
});
