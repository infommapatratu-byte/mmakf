import { getViteConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

export default getViteConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    dir: fileURLToPath(new URL('./tests/tmp-verify', import.meta.url)),
    include: ['**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
