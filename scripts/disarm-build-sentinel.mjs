#!/usr/bin/env node
// Disarm the build sentinel after a build that actually finished.
//
// npm runs `postbuild` ONLY when `build` exited zero, which is the whole
// mechanism: the sentinel file that scripts/clean-vercel-output.mjs writes
// before a build survives if — and only if — that build did not complete.
// The next `prebuild` sees it and clears dist/, so half-written chunks from an
// interrupted run cannot poison the next one.
//
// The failure this closes is genuinely hard to diagnose from its message. A
// dist/ left half-written by a Ctrl-C or a killed process makes the NEXT build
// die in page generation with:
//
//     The requested module './astro/server_BNNY-17X.mjs'
//     does not provide an export named 'x'
//
// It names a hashed chunk, no source file, and no cause. Vite prints "✓ built"
// immediately before it, so it reads as a problem in code that just compiled.
// Rebuilding does not help, because every rebuild reuses the same broken chunk
// — the only cure is deleting dist/, which nothing tells you to do.

// THE PATH MOVED, AND THE MOVE IS THE POINT. This used to remove
// dist/.build-in-progress, which `astro build` had already deleted itself when
// it emptied outDir at the start of the run — so this script was a no-op, and
// the sentinel it was meant to clear never survived long enough to be read by
// anything. The sentinel now sits at the repository root, outside everything the
// build empties. Keep this path and the one in scripts/clean-vercel-output.mjs
// identical; they are the two halves of one mechanism.

import { rmSync } from 'node:fs';

try {
  rmSync(new URL('../.build-in-progress', import.meta.url), { force: true });
} catch {
  // Silent. If it cannot be removed the next build clears dist/ unnecessarily,
  // which costs one cold build and breaks nothing.
}
