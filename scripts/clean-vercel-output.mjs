#!/usr/bin/env node
// Remove .vercel/output before a build, because the adapter cannot.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUG THIS WORKS AROUND, AND WHY IT IS NOT OURS TO FIX
// ─────────────────────────────────────────────────────────────────────────────
//
// @astrojs/vercel's `astro:build:done` hook creates its two output directories
// with different options — verbatim, from node_modules/@astrojs/vercel/dist/index.js:
//
//     mkdirSync(new URL("./.vercel/output/static/", root), { recursive: true });
//     mkdirSync(new URL("./.vercel/output/server/", root));
//
// The first is idempotent. The SECOND IS NOT: `recursive: true` is missing, so
// `mkdirSync` throws EEXIST the moment that directory already exists. It always
// exists after a successful build, which means:
//
//     EVERY BUILD AFTER THE FIRST ONE FAILS, on a clean checkout, with no code
//     change, unless somebody happens to delete the directory in between.
//
// The failure is also badly placed. It happens in the LAST hook, after the
// server bundle, the client bundle and the prerender have all completed — so
// the log reads like a successful build followed by an unrelated crash:
//
//     ✓ Completed in 45.02s
//     [ERROR] [@astrojs/vercel] An unhandled error occurred while running the
//     "astro:build:done" hook
//     EEXIST: file already exists, mkdir '...\.vercel\output\server'
//
// Nothing in that names the cause, and the natural reading — that the build
// broke — is wrong. The build worked. The adapter could not file the result.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A prebuild SCRIPT AND NOT A PATCH
// ─────────────────────────────────────────────────────────────────────────────
//
// Patching node_modules does not survive `npm ci`, and pinning a fork of the
// adapter to fix one missing option is a maintenance burden out of all
// proportion. Deleting a directory the adapter is about to recreate costs
// nothing and is correct whatever the adapter does later: `.vercel/output` is
// pure build output, reproduced in full by every run.
//
// WHAT THIS DELIBERATELY DOES NOT TOUCH: `dist/`. Astro manages it, incremental
// state lives there, and removing it would make every build a cold one.
//
// AND WHAT IT CANNOT FIX: two builds running at once against the same checkout.
// The second still loses, because two processes writing one output directory is
// not a bug anybody can fix from here. If this ever fires and the build still
// reports EEXIST, another `astro build` is running — that is the answer.

import { rmSync, existsSync, writeFileSync } from 'node:fs';
import { activeBuildOwner } from './build-lock-core.mjs';

const target = new URL('../.vercel/output/', import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// STALE dist/ AFTER AN INTERRUPTED BUILD
// ─────────────────────────────────────────────────────────────────────────────
//
// The note above says dist/ is deliberately left alone, and in the normal case
// that is right: Astro manages it, and clearing it makes every build a cold one.
//
// It is wrong in exactly one case, and that case was hit repeatedly here. When a
// build is INTERRUPTED — Ctrl-C, a killed process, a machine running several
// builds at once — dist/ is left holding half-written chunks. The next build
// reuses them and dies during page generation with:
//
//     The requested module './astro/server_BNNY-17X.mjs'
//     does not provide an export named 'x'
//         at generatePages (astro/dist/core/build/generate.js:55)
//
// which names a hashed chunk and no cause, and which no amount of rebuilding
// clears — because every rebuild reuses the same broken chunk. Vite reports
// "✓ built" immediately before it, so the error looks like a source problem in
// a file that compiled fine.
//
// A SENTINEL, not a blanket delete. The file below is written before the build
// and removed after a successful one, so its presence at startup means a build
// started and did not finish. Only then is dist/ cleared, so a normal build
// sequence leaves incremental state exactly as it was.
//
// IT MUST NOT LIVE IN dist/, AND IT MUST NOT CARRY ITS OWN PID. Both of those
// were true as first written, and each one on its own cancelled the mechanism
// out:
//
//   · THE SENTINEL WAS dist/.build-in-progress. `astro build` empties outDir at
//     the start of every run — node_modules/astro/dist/core/build/static-build.js
//     calls emptyDir(config.outDir) unless vite.build.emptyOutDir is false, and
//     nothing here sets that. So the file written in `prebuild` was deleted by
//     astro seconds later, every time. After a genuinely interrupted build there
//     was therefore NO sentinel left, the next `prebuild` skipped the clear, and
//     the half-written chunks poisoned the next build exactly as if none of this
//     existed. The self-heal could only fire if a build was interrupted in the
//     seconds between prebuild and astro's emptyDir.
//
//   · THE PID WAS process.ppid. The comment claimed the parent was "the npm
//     process running prebuild → build → postbuild". It is not: npm spawns a
//     separate short-lived shell for each lifecycle script, and that shell exits
//     when `prebuild` returns. The recorded pid was dead before `astro build`
//     began, so the liveness check always answered "stale" and the guard below
//     never fired once — which left the mutual-destruction pact the next
//     paragraph warns about fully armed rather than prevented.
//
// Several builds run against this one checkout — parallel agents, a second
// terminal, a watch task. A sentinel meaning only "a build started" would make
// every one of them delete dist/ out from under whichever build is CURRENTLY
// RUNNING. The symptom is a build that dies with
//
//     ENOENT: no such file or directory, realpath '...\dist\server\entry.mjs'
//
// naming a file its own compile step wrote seconds earlier.
//
// So: the sentinel sits at the repository root, where nothing empties it, and it
// answers only "a build started". WHO IS RUNNING is answered by the build mutex
// instead — scripts/build-lock-core.mjs already records the astro process's own
// pid in .build-lock/owner.json, and that process lives for exactly as long as
// its build. One source of truth, and it is the one that was already correct.
const distDir = new URL('../dist/', import.meta.url);
const sentinel = new URL('../.build-in-progress', import.meta.url);

if (existsSync(distDir) && existsSync(sentinel)) {
  const holder = activeBuildOwner();
  if (holder) {
    // Say what is about to happen, because the failure it produces names none
    // of this. `astro build` empties and rewrites dist/ at the start of every
    // run, so two builds sharing a checkout overwrite each other's chunks and
    // the loser dies minutes later with one of:
    //
    //     Cannot find module '...\dist\server\manifest_DtVQV2HG.mjs'
    //     ENOENT: ... realpath '...\dist\server\entry.mjs'
    //     The requested module './astro/server_X.mjs' does not provide an export named 'x'
    //
    // Each names a hashed artefact and no cause, and each sends the reader
    // looking for a fault in source code that compiled perfectly. This warning
    // is the only place the real reason is stated. It does NOT abort: a build
    // that would have succeeded must not be blocked by a stale-looking pid, and
    // the other build may well finish first.
    console.warn(
      `[clean-vercel-output] ANOTHER BUILD IS ALREADY RUNNING against this checkout (pid ${holder.pid}, since ${holder.at}).\n` +
      '  Leaving dist/ alone, but be warned: astro build empties dist/ at startup, so\n' +
      '  these two builds will overwrite each other. If this one fails with a missing\n' +
      '  module, a missing entry.mjs, or a chunk "not providing an export", that is why\n' +
      '  — nothing is wrong with the source. Wait for the other build and re-run.'
    );
  } else {
    try {
      rmSync(distDir, { recursive: true, force: true });
      console.log(
        '[clean-vercel-output] previous build did not finish — cleared dist/ so its ' +
        'half-written chunks cannot poison this one.'
      );
    } catch (err) {
      console.warn(`[clean-vercel-output] could not clear a stale dist/ (${err?.code ?? err}).`);
    }
  }
}

try {
  // `force` so a first-ever build, where nothing exists yet, is silent rather
  // than an ENOENT the developer has to learn to ignore.
  rmSync(target, { recursive: true, force: true });
} catch (err) {
  // NOT fatal. A locked file on Windows — an editor, a virus scanner, another
  // build holding a handle — must not stop a build that would otherwise work.
  // The adapter will report EEXIST if it genuinely cannot proceed, and that
  // message is now explained by the comment at the top of this file.
  console.warn(
    `[clean-vercel-output] could not remove .vercel/output (${err?.code ?? err}). ` +
    'Continuing: if the build then fails with EEXIST, another astro build is ' +
    'running against this checkout.'
  );
}

// Arm the sentinel. `postbuild` removes it, and npm runs `postbuild` ONLY when
// the build exited zero — so the file surviving is precisely the signal that a
// build started and did not finish.
//
// NO PID IS RECORDED HERE, deliberately. This script cannot know the pid that
// matters: `astro build` has not started yet, and both this hook's process and
// its parent shell are gone before it does. Liveness is the build mutex's
// question and .build-lock/owner.json is its answer. All this file records is
// "a build started", which is the one fact it is in a position to know.
//
// Best effort: a build that cannot write this still builds. The cost of failing
// to arm it is one missed self-heal, which is what the situation was before.
try {
  writeFileSync(
    sentinel,
    `armed=${new Date().toISOString()}\n` +
    'Written by scripts/clean-vercel-output.mjs before a build and removed by\n' +
    'scripts/disarm-build-sentinel.mjs after a successful one. If this file is\n' +
    'present and no build is running, the last build was interrupted and the\n' +
    'next build clears dist/ before starting. Safe to delete.\n'
  );
} catch {
  // Deliberately silent. This is a convenience, not a requirement.
}
