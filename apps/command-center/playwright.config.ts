import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : 3,
  reporter: "list",
  outputDir: "../../test-results",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    {
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "webkit-phone",
      testMatch: ["**/pairing.spec.ts", "**/qr-pairing.spec.ts"],
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: "laptop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "tv", use: { browserName: "chromium", viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: {
    command: "bun run demo:preview",
    cwd: "../..",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
