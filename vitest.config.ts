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
  },
});
