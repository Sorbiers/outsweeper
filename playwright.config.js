import { defineConfig, devices } from '@playwright/test';

const photosDir = process.env.TEST_PHOTOS_DIR || 'test_folder';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/report' }]],
  use: {
    baseURL: 'http://localhost:1976',
    headless: false,
    viewport: { width: 1280, height: 800 },
    screenshot: 'on',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
  webServer: {
    command: `python app.py ${photosDir}`,
    url: 'http://localhost:1976',
    reuseExistingServer: true,
    timeout: 15_000,
  },
  outputDir: 'tests/screenshots',
});
