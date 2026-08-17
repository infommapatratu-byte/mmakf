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
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 4 },
      forks: { minForks: 1, maxForks: 4 },
    },
  },
});
