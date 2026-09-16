import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器约定：固定端口、不清屏，让 Rust 侧日志可见；
// 不监视 src-tauri（Windows 上 cargo 构建产物被占用时 watch 会 EBUSY 崩溃）。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022" },
});
