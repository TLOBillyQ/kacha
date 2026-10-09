// 统一更新流程的 React 适配器（#12）：注入真实端口，订阅 updateFlow 状态。
// 顶栏与高级设置共用同一实例；3 秒首检 + 6 小时循环由核心流程调度。
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createUpdateFlow, type UpdateFlowPorts } from "../core/updateFlow";
import { detectPlatform, RELEASES_PAGE_URL } from "../core/update";
import { openExternal, updateFlowPorts } from "../shell/adapters";

export function useUpdateCheck(protection: Pick<UpdateFlowPorts, "restartGuard" | "restartReleased">) {
  const flow = useMemo(() => createUpdateFlow(updateFlowPorts(protection)), [protection.restartGuard, protection.restartReleased]);
  useEffect(() => flow.start(), [flow]);
  const state = useSyncExternalStore(flow.subscribe, flow.getState);

  // 顶栏提示只在确有新版本时出现；idle/error 不增加提示。
  const available = state.version
    ? { version: state.version, notes: state.notes, pageUrl: state.pageUrl, downloadUrl: state.downloadUrl }
    : null;
  // macOS 的 updater tar.gz 不用于手动安装；Release 页面提供首次安装 zip。
  const manualDownloadUrl = detectPlatform(navigator.userAgent) === "macos-arm64"
    ? state.pageUrl
    : state.downloadUrl ?? state.pageUrl;

  return {
    state,
    checking: state.phase === "checking",
    available,
    check: flow.checkManual,
    requestInstall: flow.requestInstall,
    openDownload: () => openExternal(manualDownloadUrl ?? RELEASES_PAGE_URL),
  };
}
