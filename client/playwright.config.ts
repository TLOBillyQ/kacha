import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:1421", viewport: { width: 1600, height: 1000 }, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } }],
  webServer: { command: "npx vite --config vite.e2e.config.ts", url: "http://localhost:1421/e2e/app.html", reuseExistingServer: true },
});
