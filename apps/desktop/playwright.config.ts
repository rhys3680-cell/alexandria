import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Electron launches a real app with a real vault; parallel runs would fight
  // over the single-instance lock.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
