// The portal catalogue, checked against the filesystem.
//
// src/pages/portal/_sections.ts says: "EVERY href BELOW IS A ROUTE THAT EXISTS
// IN THIS REPOSITORY. tests/portal.test.ts asserts it against the filesystem,
// because a portal that offers the federation a surface nobody built is worse
// than one that offers nothing: it makes the missing thing look like a fault in
// the user's account." It also exports allPortalHrefs() with the comment "used
// by the route-existence test".
//
// That test did not exist, and while it did not exist the catalogue drifted:
// /portal/selling and /portal/review were both offered and neither was ever
// built. A member following the seller link got the 404 page, which reads as
// "your account cannot do this" to everyone who is not the person who wrote it.
//
// The rule this file enforces is narrow and mechanical on purpose. It does not
// know which role should see which link — that is rbac.ts's job and the
// catalogue deliberately names no role. It knows only that a destination the
// menu offers must be a destination that exists.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  PORTAL_SECTIONS, allPortalHrefs, linkVisible, visibleSections, admittingActions,
} from '../src/pages/portal/_sections';
import type { Principal } from '@/lib/rbac';

/**
 * The files Astro would route a path to, in the order it resolves them.
 * `/admin/queue` is src/pages/admin/queue.astro; `/my` is src/pages/my/index.astro.
 */
function candidatesFor(path: string): string[] {
  const clean = path.replace(/[#?].*$/, '').replace(/^\/+|\/+$/g, '');
  const base = `src/pages/${clean}`;
  return [`${base}.astro`, `${base}/index.astro`, `${base}.ts`, `${base}/index.ts`];
}

function resolves(path: string): string | null {
  return candidatesFor(path).find((f) => existsSync(f)) ?? null;
}

describe('every destination the portal offers exists', () => {
  it.each(allPortalHrefs())('%s is a route in this repository', (href) => {
    // The failure message names the candidates so whoever hits it can see
    // immediately whether the page moved or was never written.
    expect(resolves(href), `${href} resolves to none of: ${candidatesFor(href).join(', ')}`).not.toBeNull();
  });

  it('offers no destination twice under two different labels by accident', () => {
    // Two rows may lead to the same page — the seller area shows a different
    // face before and after approval — but they must differ in what they
    // promise, or one of them is a copy somebody forgot to delete.
    const seen = new Map<string, string[]>();
    for (const s of PORTAL_SECTIONS) {
      for (const l of s.links) {
        seen.set(l.href, [...(seen.get(l.href) ?? []), `${l.label}: ${l.what}`]);
      }
    }
    for (const [, descriptions] of seen) {
      expect(new Set(descriptions).size).toBe(descriptions.length);
    }
  });
});

describe('every fragment the portal links to is an anchor that exists', () => {
  const withFragments = allPortalHrefs().filter((h) => h.includes('#'));

  it.each(withFragments.length ? withFragments : ['(none)'])('%s', (href) => {
    if (href === '(none)') return;
    // A link to #applications on a page with no such id scrolls nowhere and
    // leaves the reader at the top of a queue they were told was filtered.
    const [path, fragment] = href.split('#');
    const file = resolves(path);
    expect(file, `${path} does not resolve`).not.toBeNull();
    const source = readFileSync(file!, 'utf8');
    expect(
      new RegExp(`id=["']${fragment}["']`).test(source),
      `${file} carries no id="${fragment}"`,
    ).toBe(true);
  });
});

describe('the catalogue names no role, only actions', () => {
  it('mentions no role name anywhere in the file', () => {
    // The one idea the file exists to enforce: a menu that lists what a role
    // "should" reach drifts from what rbac.ts permits, and the drift is only
    // discovered by a user being refused. Comments are stripped first — this
    // guard has to survive its own explanation (see the trap in
    // docs/PROJECT-CONTEXT.md about a grep tripped by its own comment).
    const source = readFileSync('src/pages/portal/_sections.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const role of ['SUPER_ADMIN', 'FEDERATION_ADMIN', 'STATE_ADMIN', 'DISTRICT_ADMIN', 'DOJO_ADMIN']) {
      expect(source).not.toContain(role);
    }
  });
});

describe('linkVisible fails closed', () => {
  const anon = null;
  const person = { userId: 7, bindings: [] } as unknown as Principal;

  it('draws nothing at all for a caller with no principal', () => {
    for (const s of PORTAL_SECTIONS) {
      for (const l of s.links) expect(linkVisible(anon, l)).toBe(false);
    }
    expect(visibleSections(anon)).toHaveLength(0);
  });

  it('hides an own-record link from a credential that belongs to no person', () => {
    // A shared office credential authenticates a desk. Every "your own" module
    // keys on userId and would return nothing, so offering the link sends it to
    // a page that can only say there is nothing there.
    const ownRecord = PORTAL_SECTIONS.flatMap((s) => s.links).filter((l) => l.anyOf.length === 0);
    expect(ownRecord.length).toBeGreaterThan(0);
    for (const l of ownRecord) {
      expect(linkVisible(person, l, { attributable: false })).toBe(false);
      expect(linkVisible(person, l, {})).toBe(false);
    }
  });

  it('hides a seller-gated link when the seller record could not be read', () => {
    // Rule 5: approval to sell is a status on the caller's own row, not
    // authority over anybody, so no action in rbac.ts can express it. Absent
    // must read as "not approved" — a seller record that failed to load must
    // not open the gate.
    const gated = PORTAL_SECTIONS.flatMap((s) => s.links).filter((l) => l.dataGate === 'approved_seller');
    expect(gated.length).toBeGreaterThan(0);
    for (const l of gated) {
      expect(linkVisible(person, l, { attributable: true })).toBe(false);
      expect(linkVisible(person, l, { attributable: true, sellerApproved: false })).toBe(false);
      expect(linkVisible(person, l, { attributable: true, sellerApproved: true })).toBe(true);
    }
  });

  it('drops a section whose every link is hidden rather than printing an empty heading', () => {
    expect(visibleSections(person, { attributable: false })).toHaveLength(0);
  });

  it('names back only authority the caller actually holds', () => {
    for (const s of PORTAL_SECTIONS) {
      for (const l of s.links) expect(admittingActions(person, l)).toEqual([]);
    }
  });
});
