import { defineConfig } from '@playwright/test';

// 用本机 Chrome（channel: 'chrome'），不下载浏览器。开发服务器已在跑时直接复用。
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    locale: 'zh-CN',
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
