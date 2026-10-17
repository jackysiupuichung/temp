import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // mocked agent server for the Ask tests (no network, no API key)
      command: 'npx tsx server/index.ts --mock --port 8791 --data .e2e-agent-data',
      port: 8791,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { AGENT_SERVER_TOKEN: 'e2e-token' },
    },
  ],
});
