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
  },
});
