import "@xyflow/react/dist/style.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// 屏蔽 WebView 自带的网页右键菜单（刷新、检查等）；文本输入里保留以便复制粘贴。
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
