import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test FILE gets its own worker thread = separate module registry = fresh DB singleton
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    env: {
      DB_PATH: ':memory:',
      ADMIN_KEY: 'change-me-in-production',
    },
  },
});
