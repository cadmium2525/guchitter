import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const port = Number(process.env.PLAYWRIGHT_PORT || 4173);
const configuredBase = process.env.VITE_BASE_PATH || '/';
const basePath = configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`;
if (!basePath.startsWith('/') || basePath.startsWith('//')) {
  throw new Error('VITE_BASE_PATH must be a local absolute path, such as /guchitter/.');
}
const baseURL = `http://127.0.0.1:${port}${basePath}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  // These are browser engines and emulated viewports, not real mobile devices.
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL } },
    { name: 'chromium-android-emulation', use: { ...devices['Pixel 7'], channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL } },
    { name: 'webkit-iphone-emulation', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
});
