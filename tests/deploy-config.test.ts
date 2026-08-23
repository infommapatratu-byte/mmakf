// What the repository must say for a deploy to succeed.
//
// This project has already lost deploys to the Node runtime once:
// docs/DEPLOYMENT.md records that adapter v7 emitted a Node 18 runtime Vercel
// had discontinued, and every build failed in 11–16 seconds. The fix at the
// time was to change a setting in the Vercel dashboard.
//
// A DASHBOARD SETTING IS NOT A FIX. It lives outside the repository, nobody
// reviews it, it does not appear in a diff, and it can be reset by anyone with
// access — at which point every deploy fails again and the last good build
// stays live, which looks exactly like "nothing is deploying" rather than like
// an error. That is precisely the state this project spent hours in.
//
// So the runtime is pinned in package.json, where it is version-controlled, and
// this file is what keeps it there.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('the deploy runtime is pinned in the repository, not in a dashboard', () => {
  it('package.json pins Node, so the build does not depend on a setting nobody reviews', () => {
    expect(pkg.engines, 'package.json has no engines field').toBeTruthy();
    expect(pkg.engines.node, 'engines.node is not set').toBeTruthy();
  });

  it('pins Node 22 or later — 18 is discontinued and 20 is where the adapter drops support', () => {
    const major = Number(String(pkg.engines.node).match(/(\d+)/)?.[1] ?? 0);
    expect(major, `engines.node is "${pkg.engines.node}"`).toBeGreaterThanOrEqual(22);
  });

  it('starts with astro build, and chains anything after it on SUCCESS', () => {
    // This used to assert the whole command equalled "astro build", which made
    // every legitimate addition to the build a test failure. The property worth
    // guarding was never the exact string: it is that the adapter's own build
    // runs FIRST, and that a step added after it cannot mask a failure.
    //
    // `&&` is the whole point. With `;` a post-build step that succeeded would
    // hand Vercel exit 0 over a broken build, and the deploy would go out.
    const build = String(pkg.scripts?.build ?? '');
    expect(build.startsWith('astro build'), `build script is "${build}"`).toBe(true);

    const rest = build.slice('astro build'.length).trim();
    if (rest) {
      expect(rest.startsWith('&&'), `build chains with "${rest.slice(0, 3)}" rather than &&`).toBe(true);
    }
  });

  it('patches the Vercel route table, or the learn surface ships 404s again', () => {
    // Not a style preference. @astrojs/vercel emits no route for /apply, only
    // for /learn/apply, so every learn.mmakf.in page that lives under /learn/
    // fell into the catch-all and was served as 404 CARRYING THE CORRECT HTML.
    // A browser renders it and nobody notices; a crawler reads the status and
    // drops the surface out of the index.
    //
    // scripts/vercel-surface-routes.mjs rewrites that table after the build.
    // Remove it and the failure is invisible in every browser anybody tests in,
    // which is exactly why it is pinned here rather than left to review.
    expect(String(pkg.scripts?.build ?? '')).toContain('vercel-surface-routes.mjs');
    expect(existsSync('scripts/vercel-surface-routes.mjs'), 'the build names a script that is not in the repository').toBe(true);
  });

  it('a lockfile is committed, or the install is not reproducible', () => {
    // Without one, the deploy resolves fresh versions of ~500 transitive
    // dependencies and can differ from every local build.
    expect(existsSync('package-lock.json')).toBe(true);
  });

  it('the project link is NOT committed', () => {
    // .vercel/ carries a projectId and orgId. Committing it ties the repository
    // to one Vercel project and leaks the org identifier into a public repo.
    const ignore = readFileSync('.gitignore', 'utf8');
    expect(/^\.vercel/m.test(ignore), '.vercel is not gitignored').toBe(true);
  });
});

describe('the runbook and the repository agree about the runtime', () => {
  it('DEPLOYMENT.md names the same major version package.json pins', () => {
    // Two places recording a version is how they end up disagreeing, and the
    // one somebody reads is rarely the one the build obeys. This asserts they
    // still match rather than assuming.
    const doc = readFileSync('docs/DEPLOYMENT.md', 'utf8');
    const pinned = Number(String(pkg.engines.node).match(/(\d+)/)?.[1] ?? 0);
    expect(doc).toMatch(new RegExp(`Node ${pinned}`));
  });
});
