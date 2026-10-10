import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({ ...base, use: { ...base.use, baseURL: "http://localhost:1437" }, webServer: { command: "npx vite --config vite.e2e.config.ts --port 1437", url: "http://localhost:1437/e2e/app.html", reuseExistingServer: false } });
