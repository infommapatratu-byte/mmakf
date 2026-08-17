import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests share the app's "@/" path alias (tsconfig paths) so modules import
// identically in tests and at runtime.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Most suites boot a real Postgres (PGlite) and apply all four migrations —
    // 87 tables and roughly a thousand statements — inside beforeAll. That
    // exceeds vitest's 10s hook default, and a timeout there fails the whole
    // file with no useful message, which looks exactly like a broken test.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    // The suites are I/O-bound on their own database instances rather than
    // CPU-bound, and running every one concurrently starves them all.
    maxConcurrency: 4,

    // AND THAT SETTING ALONE WAS NOT ENOUGH, WHICH TOOK A WHILE TO SEE.
    //
    // `maxConcurrency` caps concurrent tests WITHIN a file. It says nothing
    // about how many FILES vitest opens at once, and that is the number that
    // matters here: the suite has grown to 89 files and most of them boot their
    // own PGlite instance and apply all 24 migrations — 144 tables, a few
    // thousand statements — inside beforeAll.
    //
    // Run unbounded, the machine ran out of file descriptors and EVERY file
    // reported "no tests" rather than a failure. That is a uniquely misleading
    // symptom: it looks like 89 broken suites and it is one exhausted process.
    // Every one of those files passes on its own, which is how it was finally
    // diagnosed — and diagnosing it that way costs an hour.
    //
    // Capping the pool trades wall-clock for a suite that actually completes. A
    // test run that cannot finish is a test run nobody performs, and the guards
    // in this repository are the only thing standing between the federation and
    // the class of defect it has been finding all week.
    // AND THE CAP ABOVE WAS NOT IN FORCE, WHICH IS WHY THIS KEPT MOVING.
    //
    // What lived here was a poolOptions block capping threads and forks at
    // four, written against Vitest 3. VITEST 4 REMOVED poolOptions. This
    // project is on 4.1.9, which prints one DEPRECATED line, discards the
    // block, and falls back to availableParallelism() - 1. On a 16-CPU
    // machine that is FIFTEEN workers, not four. The limit everyone believed
    // was protecting this suite had never once applied.
    //
    // It did not fail loudly, which is why it survived. Three suites boot a
    // real `astro dev`; with fifteen files starting at once their readiness
    // probes time out with "astro dev never came up", and vitest reports
    // those tests as SKIPPED rather than failed. Two runs of an identical
    // tree gave 47 failures and then 7, and every one of those suites passes
    // when it is run on its own.
    //
    // Related, and it was correct: ASTRO_CACHE_DIR does NOT isolate the content
    // store for `astro dev`. Astro honours cacheDir on build, but in dev it
    // writes <root>/.astro/data-store.json unconditionally, so concurrent dev
    // servers still share one file.
    //
    // RESOLVED 17 August 2026, and capping the workers was never enough. With
    // maxWorkers: 4 in force the race still fired, this time as
    //
    //   EPERM: operation not permitted, rename
    //     '.astro/data-store.json.tmp' -> '.astro/data-store.json'
    //
    // which killed one dev server and produced "3357 passed | 144 skipped" —
    // a green-looking run whose largest suite had verified nothing.
    //
    // The three suites that boot a server now take an explicit cross-process
    // lock and run one at a time: tests/helpers/astro-dev.ts. That is the fix;
    // this cap remains for the PGlite instances, which is what it was actually
    // good for.
    maxWorkers: 4,
  },
});
