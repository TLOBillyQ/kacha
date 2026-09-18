// 检查更新的界面状态：启动后静默查一次（失败不打扰），高级设置里可手动再查。
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, detectPlatform, RELEASES_PAGE_URL, type UpdateCheck } from "../core/update";
import { httpFetch } from "../shell/ipc";

/** 启动后延迟这么久再查，避免和读设置、开画板抢首屏。 */
const STARTUP_DELAY_MS = 3000;

export function useUpdateCheck() {
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const inflight = useRef<Promise<UpdateCheck> | null>(null);

  const check = useCallback(async (): Promise<UpdateCheck> => {
    if (inflight.current) return inflight.current;
    setChecking(true);
    const run = (async () => {
      let current: string;
      try {
        current = await getVersion();
      } catch (e) {
        return { status: "error", message: `读不到当前版本：${e instanceof Error ? e.message : String(e)}` } as UpdateCheck;
      }
      return checkForUpdate(current, detectPlatform(navigator.userAgent), httpFetch);
    })();
    inflight.current = run;
    try {
      const r = await run;
      setResult(r);
      return r;
    } finally {
      inflight.current = null;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void check().catch(() => undefined), STARTUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [check]);

  /** 打开本平台压缩包直链；没有就打开 Release 页面。 */
  const openDownload = useCallback(() => {
    const url = result?.status === "available" ? (result.release.downloadUrl ?? result.release.pageUrl) : RELEASES_PAGE_URL;
    void openUrl(url).catch(() => undefined);
  }, [result]);

  const available = result?.status === "available" ? result.release : null;
  return { result, checking, available, check, openDownload };
}
