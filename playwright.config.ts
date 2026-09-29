import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4318', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: process.env.E2E_SERVER_COMMAND ?? 'pnpm start',
    url: 'http://127.0.0.1:4318/api/health',
    env: {
      PORT: '4318',
      RESULTS_DIR: `.runtime/e2e-${process.pid}/results`,
      CONNECTIONS_FILE: '.runtime/no-connections.json',
      SETTINGS_DB: `.runtime/e2e-${process.pid}/settings.sqlite`,
    },
    reuseExistingServer: false,
    timeout: 30000,
  },
});
