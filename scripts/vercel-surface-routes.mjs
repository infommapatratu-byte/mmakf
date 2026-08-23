#!/usr/bin/env node
// Teach the deployed route table that learn.* and admin.* serve real pages.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS EXISTS TO FIX
// ─────────────────────────────────────────────────────────────────────────────
//
// Every page of learn.mmakf.in that lives only under /learn/ — /apply, /coaches,
// /schools, /request — was served as HTTP 404 CARRYING THE CORRECT PAGE. Twelve
// kilobytes of correct HTML under a status line that says the page does not
// exist. A browser renders it and nobody notices; a search engine reads the
// status and drops the entire surface out of the index.
//
// @astrojs/vercel emits an explicit route per known page into
// .vercel/output/config.json — `^/learn/apply/?$` exists, `^/apply/?$` does not,
// because no such FILE exists. The table therefore ends with a catch-all:
//
//     { "src": "^/.*$", "dest": "_render", "status": 404 }
//
// A request to learn.mmakf.in/apply matches nothing else, falls into that, and
// gets both halves of it: the function runs (so src/middleware.ts rewrites the
// path and renders the right page) AND the routing layer stamps 404 on the way
// out. Only / and /portal escaped, because those paths happen to exist at the
// top level too and matched a real route above the catch-all.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS FIXED HERE AND NOT IN THE MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
//
// It was tried there first and shipped, and it did nothing — measured against
// production, not assumed. The status is not chosen before the rewrite; it is
// applied by the ROUTE ENTRY after the function returns, so nothing the function
// returns can change it. `astro dev` has no such table, which is why the whole
// defect is invisible locally.
//
// So the table is what has to change: two entries, immediately above the
// catch-all, sending every path on a surface host to the same renderer WITHOUT
// the forced status. The middleware still decides what to render; it is simply
// no longer overruled about whether the page exists.
//
// A genuine miss is unaffected — it still reaches the 404 it deserves, because
// the middleware rewrites /nope to /learn/nope, Astro finds nothing, and the
// response says so on its own.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT FAILS LOUDLY
// ─────────────────────────────────────────────────────────────────────────────
//
// This edits a file another tool generates. If the adapter changes that file's
// shape, the safe outcome is a BROKEN BUILD, not a silent no-op that quietly
// restores the bug months later with nobody watching. Every assumption below is
// asserted.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CONFIG = '.vercel/output/config.json';

// Not built for Vercel (a plain `astro build`, a test): nothing to do, and that
// is not a failure.
if (!existsSync(CONFIG)) {
  console.log('[surface-routes] no .vercel/output/config.json — skipping.');
  process.exit(0);
}

/**
 * The surface hosts, read from the ONE place that defines them.
 *
 * Hard-coding them here would be a second list to forget: the day a fourth host
 * is added to SURFACE_HOSTS, its pages would 404 exactly as these did, and the
 * cause would be a file nobody thinks to look in.
 */
function surfaceHosts() {
  const src = readFileSync('src/lib/surface.ts', 'utf8');
  const block = src.slice(
    src.indexOf('const SURFACE_HOSTS'),
    src.indexOf('};', src.indexOf('const SURFACE_HOSTS'))
  );
  if (!block) throw new Error('SURFACE_HOSTS not found in src/lib/surface.ts');
  const hosts = [...block.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]);
  // Only the real deployment hosts. localhost and nip.io entries exist for
  // development and are never seen by this routing table.
  const live = hosts.filter((h) => h.endsWith('.mmakf.in'));
  if (!live.length) throw new Error('no *.mmakf.in hosts found in SURFACE_HOSTS');
  return live;
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
if (!Array.isArray(config.routes)) {
  throw new Error(`${CONFIG} has no routes array — the adapter output has changed shape.`);
}

// The catch-all is the entry being worked around, and its exact shape is the
// assumption this whole script rests on. If it is gone, the bug may be gone too
// — either way a human needs to look, so this stops the build.
const catchAllIndex = config.routes.findIndex(
  (r) => r && r.src === '^/.*$' && r.dest === '_render' && r.status === 404
);
if (catchAllIndex === -1) {
  throw new Error(
    `${CONFIG}: the { src: "^/.*$", dest: "_render", status: 404 } catch-all is not there any more.\n` +
    'scripts/vercel-surface-routes.mjs exists only to sit above it. Re-read that file before deleting this one.'
  );
}

const hosts = surfaceHosts();

/**
 * Is this one of ours?
 *
 * Matched on SHAPE, not on a marker property. A Vercel route object is
 * validated against a fixed schema on deploy, so an extra key of our own is a
 * deployment that fails rather than a build that works — and the whole point of
 * this file is that the deployed table is correct.
 */
const isOurs = (r) =>
  r && r.src === '^/.*$' && r.dest === '_render' && r.status === undefined &&
  Array.isArray(r.has) && r.has.some((h) => h && h.type === 'host' && hosts.includes(h.value));

// Idempotent: a rebuilt config has none of these, but never assume it.
const already = config.routes.filter(isOurs).length;
if (already) {
  console.log(`[surface-routes] ${already} entries already present — leaving them.`);
  process.exit(0);
}

const inserted = hosts.map((host) => ({
  // Every path on this host, sent to the same renderer the catch-all uses —
  // WITHOUT its `status: 404`. The middleware rewrites /apply to /learn/apply
  // and the page answers for itself.
  src: '^/.*$',
  has: [{ type: 'host', value: host }],
  dest: '_render',
}));

config.routes.splice(catchAllIndex, 0, ...inserted);
writeFileSync(CONFIG, JSON.stringify(config, null, 2));

console.log(
  `[surface-routes] inserted ${inserted.length} host routes above the 404 catch-all: ` +
  hosts.join(', ')
);
