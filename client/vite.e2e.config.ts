import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.ts";

// Playwright 专用：另开端口，入口 e2e/app.html 先装假壳再加载 src/main.tsx；网关请求改走浏览器 fetch，由 page.route 伪造。
export default mergeConfig(
  base,
  defineConfig({
    server: { port: 1421, strictPort: true },
    resolve: { alias: { "@tauri-apps/plugin-http": fileURLToPath(new URL("./e2e/shim/http.ts", import.meta.url)) } },
  }),
);
