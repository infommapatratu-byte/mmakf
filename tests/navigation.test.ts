// The navigation, the surfaces, and the promise that a link goes somewhere.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// /training was written with links to /training/individual and
// /training/estimate. Neither page was built. Both returned 404 on production
// for as long as the page was live, and nothing in the repository noticed —
// not the typechecker, not the build, not the test suite, not the link checker.
//
// A menu that offers a page nobody built is worse than a shorter menu. This is
// the check that would have caught it on the same afternoon.

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLIC_NAV, PUBLIC_ACTIONS, LEARN_NAV, LEARN_ACTIONS, ADMIN_GROUPS,
  adminNavFor, surfaceForHost, rewriteTarget, isSharedPath, href,
  canonicalFor, isIndexable, SURFACE_ORIGIN,
} from '../src/lib/surface';

// ── Which routes actually exist ─────────────────────────────────────────────

/** Every route src/pages resolves, as a path. */
function routesOnDisk(dir = 'src/pages', prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...routesOnDisk(full, `${prefix}/${entry.name}`));
      continue;
    }
    if (entry.name.startsWith('_')) continue;              // not a route
    const base = entry.name.replace(/\.(astro|ts|js)$/, '');
    if (base === entry.name) continue;
    out.push(base === 'index' ? (prefix || '/') : `${prefix}/${base}`);
  }
  return out;
}

const ROUTES = routesOnDisk();

/**
 * Does a path resolve to a route, allowing for dynamic segments?
 *
 * `/people/[slug]` answers /people/anything, and `/kata` answers /kata via
 * /kata/index. A menu link to a dynamic route's PARENT is what we are checking,
 * so `/people` matches `/people/[slug]` only if an index also exists.
 */
function resolves(path: string): boolean {
  const clean = path.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
  if (ROUTES.includes(clean)) return true;

  const wanted = clean.split('/').filter(Boolean);
  return ROUTES.some((r) => {
    const parts = r.split('/').filter(Boolean);
    if (parts.length !== wanted.length) return false;
    return parts.every((p, i) => p.startsWith('[') || p === wanted[i]);
  });
}

// ── The links ───────────────────────────────────────────────────────────────

describe('every navigation link goes somewhere', () => {
  const publicLinks = [
    ...PUBLIC_NAV.map((n) => n.href),
    ...PUBLIC_NAV.flatMap((n) => (n.children ?? []).map((c) => c.href)),
    ...PUBLIC_ACTIONS.map((a) => a.href),
  ];

  for (const link of [...new Set(publicLinks)]) {
    it(`public nav → ${link}`, () => {
      expect(resolves(link), `${link} is in the public navigation and no route answers it`).toBe(true);
    });
  }

  const learnLinks = [
    ...LEARN_NAV.map((n) => n.href),
    ...LEARN_ACTIONS.map((a) => a.href),
  ];

  for (const link of [...new Set(learnLinks)]) {
    it(`learn nav → ${link}`, () => {
      expect(resolves(link), `${link} is in the learn navigation and no route answers it`).toBe(true);
    });
  }

  for (const group of ADMIN_GROUPS) {
    for (const m of group.modules) {
      it(`admin nav → ${m.href}`, () => {
        expect(resolves(m.href), `${m.href} is in the admin navigation and no route answers it`).toBe(true);
      });
    }
  }
});

describe('the audience pages the training page links to', () => {
  it('resolves every /learn/<audience> link the audience data implies', async () => {
    const { AUDIENCES } = await import('../src/data/audiences');
    for (const a of AUDIENCES) {
      expect(resolves(`/learn/${a.slug}`), `/learn/${a.slug} does not resolve`).toBe(true);
      expect(resolves(a.action.href), `${a.action.href} (the action on /learn/${a.slug}) does not resolve`).toBe(true);
      if (a.publicPath) {
        expect(resolves(a.publicPath), `${a.publicPath} does not resolve`).toBe(true);
      }
    }
  });

  it('still answers the two links that were 404ing on production', () => {
    // The specific regression. Named, so a future tidy-up that deletes them has
    // to argue with this line.
    expect(existsSync('src/pages/training/individual.astro')).toBe(true);
    expect(existsSync('src/pages/training/estimate.astro')).toBe(true);
  });

  it('has no link left in training.astro that points at a route nobody built', () => {
    const src = readFileSync('src/pages/training.astro', 'utf8');
    const links = [...src.matchAll(/href="(\/[a-z0-9/_-]*)"/gi)].map((m) => m[1]);
    const broken = links.filter((l) => !resolves(l));
    expect(broken).toEqual([]);
  });
});

// ── Host resolution ─────────────────────────────────────────────────────────

describe('which surface a host gets', () => {
  it('recognises the three', () => {
    expect(surfaceForHost('www.mmakf.in')).toBe('public');
    expect(surfaceForHost('mmakf.in')).toBe('public');
    expect(surfaceForHost('learn.mmakf.in')).toBe('learn');
    expect(surfaceForHost('admin.mmakf.in')).toBe('admin');
  });

  it('matches the leftmost LABEL, not a substring', () => {
    // `includes('admin')` would hand the operations platform to anybody who can
    // register a domain. This is the check that says so.
    expect(surfaceForHost('admin.mmakf.in.evil.example')).toBe('public');
    expect(surfaceForHost('notadmin.mmakf.in')).toBe('public');
    expect(surfaceForHost('learning.mmakf.in')).toBe('public');
    expect(surfaceForHost('evil-admin.example')).toBe('public');
  });

  it('ignores the port, so it works in development', () => {
    expect(surfaceForHost('learn.localhost:4321')).toBe('learn');
    expect(surfaceForHost('admin.localhost:4321')).toBe('admin');
  });

  it('falls back to the PUBLIC surface for anything unrecognised', () => {
    // The fail-safe direction: an unknown host getting the public site is a
    // cosmetic surprise; an unknown host getting admin is an incident.
    for (const h of ['', null, undefined, 'x', '::1', '127.0.0.1:3000']) {
      expect(surfaceForHost(h as any)).toBe('public');
    }
  });
});

describe('rewriting', () => {
  it('prefixes a learn or admin path', () => {
    expect(rewriteTarget('learn', '/schools')).toBe('/learn/schools');
    expect(rewriteTarget('admin', '/tasks')).toBe('/admin/tasks');
    expect(rewriteTarget('learn', '/')).toBe('/learn');
  });

  it('leaves the public surface alone', () => {
    expect(rewriteTarget('public', '/about')).toBeNull();
  });

  it('is idempotent, so a rewritten request cannot be rewritten twice', () => {
    // Without this, learn.mmakf.in/learn/schools becomes /learn/learn/schools —
    // and if the middleware re-enters, it keeps going.
    expect(rewriteTarget('learn', '/learn/schools')).toBeNull();
    expect(rewriteTarget('learn', '/learn')).toBeNull();
    expect(rewriteTarget('admin', '/admin/tasks')).toBeNull();
  });

  it('never touches the shared paths', () => {
    // The API is shared deliberately: one set of endpoints, one authorisation
    // choke point. Rewriting it per host would give the three surfaces three
    // different login endpoints.
    for (const p of ['/api/auth/login', '/api/learn/application', '/_astro/x.js', '/logo.png', '/robots.txt', '/sitemap.xml', '/calendar.ics']) {
      expect(rewriteTarget('learn', p), `${p} was rewritten`).toBeNull();
      expect(isSharedPath(p), `${p} is not recognised as shared`).toBe(true);
    }
  });

  it('does not mistake a page for a file', () => {
    expect(isSharedPath('/karate-for-schools')).toBe(false);
    expect(isSharedPath('/learn/apply')).toBe(false);
  });
});

describe('addresses', () => {
  it('writes a link for the host it is on', () => {
    expect(href('learn', '/learn/schools')).toBe('/schools');
    expect(href('public', '/learn/schools')).toBe('/learn/schools');
    expect(href('learn', '/learn')).toBe('/');
    expect(href('admin', '/admin/tasks')).toBe('/tasks');
  });

  it('gives one page one canonical, whichever host it was reached through', () => {
    // The same content at www.mmakf.in/learn/schools and learn.mmakf.in/schools
    // must not advertise two different addresses, or it is two pages competing
    // for the same content.
    expect(canonicalFor('learn', '/learn/schools')).toBe('https://learn.mmakf.in/schools');
    expect(canonicalFor('public', '/karate-for-schools')).toBe('https://www.mmakf.in/karate-for-schools');
    expect(canonicalFor('public', '/')).toBe('https://www.mmakf.in/');
  });

  it('never lets admin be indexed', () => {
    expect(isIndexable('admin')).toBe(false);
    expect(isIndexable('public')).toBe(true);
    // learn IS indexable: its audience pages are how a school finds MMAKF, and
    // PART AN is explicit that discovery content must not sit behind a login.
    expect(isIndexable('learn')).toBe(true);
  });

  it('gives every surface a distinct origin', () => {
    const origins = Object.values(SURFACE_ORIGIN);
    expect(new Set(origins).size).toBe(origins.length);
    for (const o of origins) expect(o).toMatch(/^https:\/\//);
  });
});

// ── Admin navigation is filtered by authority ───────────────────────────────

describe('the admin menu shows only what the principal may reach', () => {
  it('hides safeguarding from a training administrator', () => {
    const trainingActions = new Set([
      'engagement:read', 'program:read', 'quote:read', 'booking:read',
      'venue:read', 'attendance:read', 'coach:read', 'task:read',
      'support:read', 'report:read', 'content:read', 'workflow:read',
    ]);
    const nav = adminNavFor((a) => trainingActions.has(a));
    const labels = nav.flatMap((g) => g.modules.map((m) => m.label));

    expect(labels).toContain('Applications');
    expect(labels).toContain('Coaches');
    expect(labels).not.toContain('Cases');
    expect(labels).not.toContain('Audit trail');
    expect(labels).not.toContain('Members');
  });

  it('drops a group entirely when none of its modules are reachable', () => {
    const nav = adminNavFor((a) => a === 'support:read');
    expect(nav).toHaveLength(1);
    expect(nav[0].modules.map((m) => m.label)).toEqual(['Support desk']);
  });

  it('shows nothing at all to a principal with no authority', () => {
    expect(adminNavFor(() => false)).toEqual([]);
  });

  it('gates every module on an action — none is left ungated', () => {
    // A module with no action would be visible to everybody who reached the
    // admin surface at all.
    for (const g of ADMIN_GROUPS) {
      for (const m of g.modules) {
        expect(m.action, `${m.label} has no action gating it`).toBeTruthy();
        expect(m.action).toMatch(/^[a-z_]+:[a-z_]+$/);
      }
    }
  });
});

describe('the navigation is federation-first, not dojo-first', () => {
  const allLabels = [
    ...PUBLIC_NAV.map((n) => n.label),
    ...PUBLIC_NAV.flatMap((n) => (n.children ?? []).map((c) => c.label)),
    ...PUBLIC_ACTIONS.map((a) => a.label),
  ].join(' | ').toLowerCase();

  it('offers none of the dojo-first calls to action the federation asked to remove', () => {
    for (const phrase of ['free trial', 'book a trial', 'our dojo', 'walk in', 'enroll now', 'join now']) {
      expect(allLabels, `the navigation still offers "${phrase}"`).not.toContain(phrase);
    }
  });

  it('reaches the things a national federation exists to hold', () => {
    for (const needed of ['athletes', 'rankings', 'officials', 'governance', 'verify']) {
      expect(allLabels, `the navigation has no route to ${needed}`).toContain(needed);
    }
  });

  it('makes registering with the federation the primary action, not enrolling in a class', () => {
    expect(PUBLIC_ACTIONS[0].label.toLowerCase()).toBe('register');
  });
});
