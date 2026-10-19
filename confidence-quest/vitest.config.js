import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    pool: 'forks',
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
