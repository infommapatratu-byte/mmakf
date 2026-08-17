#!/usr/bin/env node
// Link health for the video source register (§55).
//
//   node scripts/check-video-links.mjs           check every registered id
//   node scripts/check-video-links.mjs --json    machine-readable report
//   node scripts/check-video-links.mjs --quiet   only failures
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS CHECKS IDS AND NEVER PAGES
// ─────────────────────────────────────────────────────────────────────────────
//
// The directive states the rule and the discovery pass proved it in the same
// afternoon: "A 200 response alone does not prove that an embedded video is
// actually playable."
//
// Yale's Shotokan kata video page returns HTTP 200. It has done for years. It
// embeds eight kata recordings and ALL EIGHT ARE DEAD — every id returns oEmbed
// 404. A link checker pointed at the page would have reported a healthy source
// with eight videos on it, indefinitely.
//
// So this script never looks at a page. It asks the platform about each id.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT COUNTS AS HEALTHY, AND WHAT THE FAILURES MEAN
// ─────────────────────────────────────────────────────────────────────────────
//
//   OK             oEmbed 200, an embed iframe in the response, and the title
//                  and channel still match what the register recorded.
//   DRIFTED        still live and embeddable, but the title or the channel has
//                  changed. Not a failure — a video can legitimately be
//                  retitled — but the register is now stale and says something
//                  the platform does not.
//   NO_EMBED       oEmbed 401. The owner has switched embedding off. The video
//                  exists; MMAKF may link to it and may no longer embed it.
//   GONE           oEmbed 404. Deleted, made private, or the id was wrong.
//   UNREACHABLE    the network failed. NOT reported as GONE, because treating a
//                  timeout as a dead video is how a register quietly empties
//                  itself during an outage.
//
// Exit code is non-zero only for GONE and NO_EMBED — states that require a
// human to change the register. DRIFTED is reported and does not fail a build,
// because a retitled video is a curation task, not a broken link.
//
// A NEGATIVE CONTROL RUNS FIRST, and the script aborts if it passes. A checker
// that reports everything healthy because the endpoint changed shape is worse
// than no checker at all: it manufactures confidence.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const quiet = args.includes('--quiet');

// The register is TypeScript, and this script deliberately does not depend on a
// build step: it parses the entries it needs out of the source. That keeps the
// check runnable in CI, in a git hook, and on a machine with no node_modules.
const SRC = 'src/data/shotokan/video-register.ts';
const src = readFileSync(SRC, 'utf8');

const entries = [];
const BLOCK = /V\(\{([\s\S]*?)\}\),/g;
const field = (block, name) => {
  const m = block.match(new RegExp(`${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? JSON.parse(`"${m[1]}"`) : null;
};
let m;
while ((m = BLOCK.exec(src))) {
  const b = m[1];
  const id = field(b, 'id');
  if (!id) continue;
  entries.push({ id, title: field(b, 'title'), channel: field(b, 'channel'), via: field(b, 'discoveredVia') });
}

if (entries.length === 0) {
  console.error(`No register entries found in ${SRC}. Refusing to report success on an empty check.`);
  process.exit(1);
}

const oembed = async (id) => {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
  const res = await fetch(url, { headers: { 'user-agent': 'MMAKF-link-health/1.0' } });
  if (res.status !== 200) return { status: res.status, body: null };
  return { status: 200, body: await res.json().catch(() => null) };
};

// ── Negative control ───────────────────────────────────────────────────────
const control = await oembed('AAAAAAAAAAA').catch(() => ({ status: -1 }));
if (control.status === 200) {
  console.error('Negative control PASSED — the check cannot distinguish a live id from a dead one. Aborting.');
  process.exit(2);
}
if (control.status === -1) {
  console.error('Negative control could not reach the platform. Aborting rather than reporting an all-clear.');
  process.exit(2);
}

// ── The check ──────────────────────────────────────────────────────────────
const results = [];
for (const e of entries) {
  let r = { ...e, state: 'UNREACHABLE', detail: null };
  try {
    const { status, body } = await oembed(e.id);
    if (status === 404) {
      r.state = 'GONE';
      r.detail = 'oEmbed 404 — deleted, private, or a wrong id.';
    } else if (status === 401) {
      r.state = 'NO_EMBED';
      r.detail = 'oEmbed 401 — the owner has disabled embedding. Link only.';
    } else if (status === 200 && body) {
      const embeddable = typeof body.html === 'string' && body.html.includes('/embed/');
      if (!embeddable) {
        r.state = 'NO_EMBED';
        r.detail = 'oEmbed 200 but no embed iframe returned.';
      } else if (body.title !== e.title || body.author_name !== e.channel) {
        r.state = 'DRIFTED';
        r.detail = `platform now reports "${body.title}" on "${body.author_name}"`;
      } else {
        r.state = 'OK';
      }
    } else {
      r.detail = `unexpected HTTP ${status}`;
    }
  } catch (err) {
    r.detail = String(err?.message ?? err);
  }
  results.push(r);
  await new Promise((res) => setTimeout(res, 120));
}

const count = (s) => results.filter((r) => r.state === s).length;
const broken = results.filter((r) => r.state === 'GONE' || r.state === 'NO_EMBED');
const drifted = results.filter((r) => r.state === 'DRIFTED');
const unreachable = results.filter((r) => r.state === 'UNREACHABLE');

if (asJson) {
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    total: results.length,
    ok: count('OK'),
    drifted: drifted.length,
    noEmbed: count('NO_EMBED'),
    gone: count('GONE'),
    unreachable: unreachable.length,
    results,
  }, null, 2));
} else {
  if (!quiet) {
    console.log(`Video source register — link health`);
    console.log(`  checked      ${results.length}`);
    console.log(`  ok           ${count('OK')}`);
    console.log(`  drifted      ${drifted.length}`);
    console.log(`  no embed     ${count('NO_EMBED')}`);
    console.log(`  gone         ${count('GONE')}`);
    console.log(`  unreachable  ${unreachable.length}`);
  }
  for (const r of [...broken, ...drifted]) {
    console.log(`  ${r.state.padEnd(11)} ${r.id}  [${r.via}]  ${r.title}`);
    if (r.detail) console.log(`              ${r.detail}`);
  }
  if (unreachable.length && !quiet) {
    console.log(`\n  ${unreachable.length} could not be reached. NOT counted as dead — rerun before editing the register.`);
  }
}

// Only states that need a human editing the register fail the run.
process.exit(broken.length > 0 ? 1 : 0);
