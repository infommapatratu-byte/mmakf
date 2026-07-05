import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';

// MMAKF — Astro config. Server-rendered for /api routes and admin auth.
export default defineConfig({
  output: 'server',
  adapter: vercel({
    webAnalytics: { enabled: true },
  }),
  site: 'https://www.mmakf.in',
  compressHTML: true,
  prefetch: { prefetchAll: true, defaultStrategy: 'viewport' },
});
