import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// MMAKF — Astro config. Server-rendered for /api routes and admin auth.
export default defineConfig({
  output: 'server',
  adapter: vercel({
    webAnalytics: { enabled: true },
  }),
  // Two test suites boot a real `astro dev` in this same working directory.
  // Astro writes its content data store to <cacheDir>/data-store.json by
  // writing a .tmp file and renaming it over the target; two servers sharing
  // one cacheDir race on that rename and the loser dies with
  // `ENOENT: rename .astro/data-store.json.tmp -> .astro/data-store.json`.
  //
  // It surfaces as "astro dev exited" in whichever suite lost — a failure that
  // names neither the other suite nor the file, and that moves to a different
  // suite whenever the number of test files changes the scheduling. Giving each
  // server its own directory removes the shared file rather than serialising
  // the suites around it. Unset everywhere else, so the default `.astro/` is
  // unchanged for `astro dev` and `astro build`.
  cacheDir: process.env.ASTRO_CACHE_DIR || undefined,
  site: 'https://www.mmakf.in',
  compressHTML: true,
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
});
