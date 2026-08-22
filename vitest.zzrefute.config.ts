import { getViteConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

export default getViteConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/zz-refute/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
