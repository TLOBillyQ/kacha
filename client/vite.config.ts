import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器约定：固定端口、不清屏，让 Rust 侧日志可见。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2022" },
});
