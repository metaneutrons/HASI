import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(([
      ['@', './apps/web/src'],
      ['@hasi/demo-runtime', './packages/demo-runtime/src/index.ts'],
      ['@hasi/api', './apps/api/src/index.ts'],
      ['@hasi/state', './packages/state/src/index.ts'],
      ['@hasi/plugin-sdk', './packages/plugin-sdk/src/index.ts'],
      ['@hasi/anny-client', './packages/anny-client/src/index.ts'],
      ['@hasi/anny-plugin', './apps/anny-plugin/src/index.ts'],
      ['@hasi/anny-mock', './apps/anny-mock/src/index.ts'],
    ] as const).map(([name, path]) => [name, fileURLToPath(new URL(path, import.meta.url))]))
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts', 'apps/api/src/**/*.ts', 'apps/anny-plugin/src/**/*.ts'],
      exclude: ['apps/*/src/server.ts'],
      thresholds: { lines: 75, functions: 75, statements: 75, branches: 65 }
    }
  }
});
