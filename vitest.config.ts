import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

const alias = {
  '@ticketing/contracts': src('contracts'),
  '@ticketing/logger': src('logger'),
  '@ticketing/http': src('http'),
  '@ticketing/testkit': src('testkit'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.spec.ts', 'apps/*/test/unit/**/*.spec.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['apps/*/test/integration/**/*.spec.ts'],
          environment: 'node',
          // One real PostgreSQL server is started once for the whole run; each suite
          // gets its own logical database. PRD §15.1 — no mocked infrastructure.
          globalSetup: [fileURLToPath(new URL('./packages/testkit/src/global-setup.ts', import.meta.url))],
          // Integration suites share one server and bind real HTTP ports; one fork
          // keeps port use and backend counts predictable.
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
