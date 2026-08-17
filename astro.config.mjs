import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// MMAKF — Astro config. Server-rendered for /api routes and admin auth.
export default defineConfig({
  output: 'server',
  adapter: vercel({
    webAnalytics: { enabled: true },
  }),
  // Overridable so a BUILD can be given its own cache directory.
  //
  // ─────────────────────────────────────────────────────────────────────────
  // WHAT THIS DOES NOT DO, WHICH IS WHAT IT USED TO CLAIM
  // ─────────────────────────────────────────────────────────────────────────
  //
  // This option used to carry a comment saying it gave each of the test suites
  // that boot `astro dev` its own content store, "rather than serialising the
  // suites around it". THAT WAS NEVER TRUE, and three suites passed a distinct
  // ASTRO_CACHE_DIR for months on the strength of it.
  //
  // Astro resolves the store's location differently in dev and in build:
  //
  //   node_modules/astro/dist/content/content-layer.js
  //     new URL(DATA_STORE_FILE, isDev ? settings.dotAstroDir : config.cacheDir)
  //
  //   node_modules/astro/dist/core/config/settings.js
  //     const dotAstroDir = new URL(".astro/", config.root);
  //
  // In DEV the store goes to <root>/.astro/ and `cacheDir` is not consulted at
  // all. So every dev server shared one data-store.json, wrote it by renaming a
  // .tmp over it, and raced — the loser dying with EPERM on Windows. Because a
  // failed beforeAll makes vitest SKIP a file's tests rather than fail them,
  // that surfaced as "3357 passed | 144 skipped": a green-looking run that had
  // verified nothing.
  //
  // The suites are now serialised by an explicit lock — tests/helpers/astro-dev.ts
  // — which is what the comment above wrongly claimed was unnecessary.
  cacheDir: process.env.ASTRO_CACHE_DIR || undefined,
  site: 'https://www.mmakf.in',
  compressHTML: true,
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
});
