import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig(base, {
  testMatch: "**/layers.spec.ts",
  use: { baseURL: "http://localhost:1439" },
  webServer: { command: "npx vite --config vite.e2e.config.ts --port 1439", url: "http://localhost:1439/e2e/app.html", reuseExistingServer: false },
});
