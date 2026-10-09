// core 端口的真适配器集中在这里（#128）：ui 只 import 使用，不在调用点就地拼。测试侧各自就地拼伪实现。
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { PackFs, PackIo } from "../core/boardPack";
import type { RelocateFs } from "../core/relocate";
import type { RunDeps } from "../core/run";
import type { SettingsPorts } from "../core/settings";
import type { ImageProbe } from "../core/submission";
import type { TaskFs } from "../core/taskDir";
import type { UpdateFlowPorts } from "../core/updateFlow";
import { detectPlatform, LATEST_RELEASE_API_URL, selectUpdateRelease, type Platform } from "../core/update";
import { imageCodec } from "./imageCodec";
import { httpFetch, ipc } from "./ipc";
import { logEvent } from "./log";
import { composeOverlay } from "./overlay";

export const taskFs: TaskFs = {
  writeNewFile: ipc.writeNewFile,
  readFile: ipc.readFileBytes,
};

export const runDeps: RunDeps = {
  ...taskFs,
  fetch: httpFetch,
  now: () => new Date(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  composeOverlay,
  imageCodec,
};

/** 哈希走 fileSha256（原始字节，不要求可解码）；候选已按扩展名过滤。 */
export const relocateFs: RelocateFs = {
  listDir: ipc.listDir,
  isFile: ipc.isFile,
  sha256: ipc.fileSha256,
};

export const packFs: PackFs = {
  isFile: ipc.isFile,
  sha256: ipc.fileSha256,
};

export const packIo: PackIo = {
  cancel: ipc.boardPackCancel,
  entries: ipc.boardPackEntries,
  readTexts: ipc.boardPackReadTexts,
  importUnits: ipc.boardPackImport,
};

export const imageProbe: ImageProbe = {
  inspectImage: ipc.inspectImage,
};

export const settingsPorts: SettingsPorts = {
  readSettings: ipc.readSettings,
  writeSettings: ipc.writeSettings,
  readModelsCache: ipc.readModelsCache,
  writeModelsCache: ipc.writeModelsCache,
  secretGet: ipc.secretGet,
  secretSet: ipc.secretSet,
  secretDelete: ipc.secretDelete,
  fetch: httpFetch,
  now: () => new Date(),
  log: logEvent,
};

/** 统一更新流程的真端口（#12）。 */
export function updateFlowPorts(): UpdateFlowPorts {
  const platform: Platform = detectPlatform(navigator.userAgent);
  return {
    currentVersion: () => getVersion(),
    platform: () => platform,
    schedule: (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    log: (kind, fields) => void ipc.logEvent(kind, fields).catch(() => undefined),
    release: {
      fetchLatest: async () => {
        const res = await httpFetch(LATEST_RELEASE_API_URL, { method: "GET", headers: { Accept: "application/json" } });
        if (res.status === 404) return null;
        if (res.status < 200 || res.status >= 300) throw new Error(`发布服务器返回 HTTP ${res.status}`);
        return selectUpdateRelease(JSON.parse(await res.text()), platform);
      },
    },
    updater: {
      // 静态端点：官方 updater 直接请求描述 URL；target 固定平台名。
      check: async (_descriptorUrl, target) => check({ target }),
    },
    // #13 接入前：统一重启入口存在，但永远被守护阻止。
    restartGuard: async () => ({ allowed: false, reason: "更新重启保护将在后续版本接入，请稍后再试" }),
  };
}

export const openExternal = (url: string) => void openUrl(url).catch(() => undefined);
