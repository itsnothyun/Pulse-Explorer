import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@omniview/config': resolve(__dirname, 'packages/config/src/index.ts'),
      '@omniview/shared-types': resolve(__dirname, 'packages/shared-types/src/index.ts'),
      '@omniview/utilities': resolve(__dirname, 'packages/utilities/src/index.ts'),
      '@omniview/viewer-core': resolve(__dirname, 'packages/viewer-core/src/index.ts'),
      '@omniview/viewer-adapters': resolve(__dirname, 'packages/viewer-adapters/src/index.ts'),
      '@omniview/ui': resolve(__dirname, 'packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
