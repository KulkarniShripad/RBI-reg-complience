import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 3987;
export const E2E_ADMIN_TOKEN = 'e2e-admin-token-0123456789';
const dbPath = path.join(os.tmpdir(), `cq-e2e-${Date.now()}.sqlite`);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1000, height: 900 } },
  webServer: {
    command: 'node server/index.js',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DB_PATH: dbPath, ADMIN_TOKEN: E2E_ADMIN_TOKEN, ALLOCATION_SEED: 'e2e-seed', NODE_ENV: 'test' },
  },
});
