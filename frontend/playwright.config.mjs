import { defineConfig } from '@playwright/test';

const chromiumLaunchOptions = process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {};

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: chromiumLaunchOptions } },
    { name: 'chromium-hidpi', grep: /default/, use: { browserName: 'chromium', deviceScaleFactor: 2, launchOptions: chromiumLaunchOptions } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    timeout: 120_000,
  },
});
