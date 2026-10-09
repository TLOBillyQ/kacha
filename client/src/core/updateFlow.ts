// 统一更新流程（#12）：发布查询 → 官方 updater 检查 → 后台下载 → 就绪。
// 只到就绪为止；安装由 #13 的受保护更新重启接入，本票经 restartGuard 永远阻止。
// 时钟与 updater 都注入，便于 vitest 与 e2e 观察。

import { compareVersions, parseUpdaterDescriptor, type Platform, type SelectedUpdate } from "./update";

export interface ReleaseInfo {
  version: string;
  pageUrl: string;
  descriptorUrl: string;
  packageUrl: string;
  target: string;
}

/** 官方 updater 的 Update 资源形态（接口对齐 @tauri-apps/plugin-updater）。 */
export interface OfficialUpdate {
  version: string;
  currentVersion?: string;
  body?: string;
  rawJson?: Record<string, unknown>;
  download(onEvent?: (e: { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" }) => void): Promise<void>;
  install(options?: { restartAfterInstall?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateFlowPorts {
  currentVersion(): Promise<string>;
  platform(): Platform;
  /** 安排回调；返回取消函数。 */
  schedule(ms: number, fn: () => void): () => void;
  log(kind: string, fields: Record<string, unknown>): void;
  release: {
    fetchLatest(): Promise<SelectedUpdate | null>;
  };
  updater: {
    check(descriptorUrl: string, target: string): Promise<OfficialUpdate | null>;
  };
  /** #13 接入前永远阻止；接入后由它决定能否安装。 */
  restartGuard(): Promise<{ allowed: boolean; reason?: string }>;
}

export interface UpdateState {
  phase: "idle" | "checking" | "downloading" | "ready" | "error";
  version: string | null;
  notes: string;
  progress: { done: number; total: number | null } | null;
  error: string | null;
  pageUrl: string | null;
  downloadUrl: string | null;
  installBlockedReason: string | null;
}

const initial: UpdateState = {
  phase: "idle",
  version: null,
  notes: "",
  progress: null,
  error: null,
  pageUrl: null,
  downloadUrl: null,
  installBlockedReason: null,
};

const STARTUP_DELAY_MS = 3000;
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

export interface UpdateFlow {
  start(): () => void;
  checkManual(): Promise<void>;
  requestInstall(): Promise<void>;
  subscribe(listener: () => void): () => void;
  getState(): UpdateState;
}

export function createUpdateFlow(ports: UpdateFlowPorts): UpdateFlow {
  let state: UpdateState = { ...initial };
  const listeners = new Set<() => void>();
  let inflight: Promise<void> | null = null;
  let downloaded: { update: OfficialUpdate; release: SelectedUpdate } | null = null;
  let stopFns: (() => void)[] = [];

  const emit = () => listeners.forEach((l) => l());
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    emit();
  };

  async function runCheck(): Promise<void> {
    if (inflight) return inflight;
    const p = (async () => {
      set({ phase: "checking", error: null });
      try {
        const current = await ports.currentVersion();
        const release = await ports.release.fetchLatest();
        if (!release) {
          set({ phase: "idle", version: null, notes: "", progress: null, downloadUrl: null, pageUrl: null });
          return;
        }
        if (!downloaded) {
          if (compareVersions(release.version, current) <= 0) {
            set({ phase: "idle", version: null });
            return;
          }
          const update = await ports.updater.check(release.descriptorUrl, release.target);
          if (!update) {
            set({ phase: "idle", version: null });
            return;
          }
          // 二次核对：官方返回的版本与描述平台条目须与所选 Release 一致，否则视为发布不完整。
          if (update.version !== release.version) throw new Error(`更新描述版本 ${update.version} 与发布 ${release.version} 不一致`);
          const descriptor = parseUpdaterDescriptor(update.rawJson, release);
          if (!descriptor) throw new Error("更新描述缺少本平台 URL 或签名，或版本与发布不一致");
          set({ phase: "downloading", version: release.version, notes: update.body ?? descriptor.notes, pageUrl: release.pageUrl, downloadUrl: descriptor.url, progress: { done: 0, total: null } });
          let done = 0;
          let total: number | null = null;
          // 只有 download() resolve 才算就绪；Finished 事件早于签名验证，不能作为就绪信号。
          await update.download((e) => {
            if (e.event === "Started") total = e.data.contentLength ?? null;
            if (e.event === "Progress") {
              done += e.data.chunkLength;
              set({ progress: { done, total } });
            }
          });
          downloaded = { update, release };
          set({ phase: "ready", progress: { done: total ?? done, total: total ?? done } });
        } else {
          set({ phase: "ready" });
        }
      } catch (e) {
        ports.log("update.check_failed", { message: e instanceof Error ? e.message : String(e) });
        set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      }
    })();
    inflight = p;
    try {
      await p;
    } finally {
      inflight = null;
    }
  }

  return {
    start() {
      // 3 秒首检；每次检查完成后 6 小时再检，避免与下载重叠。
      const loop = () => stopFns.push(ports.schedule(CHECK_INTERVAL_MS, () => void runCheck().finally(loop)));
      stopFns.push(ports.schedule(STARTUP_DELAY_MS, () => void runCheck().finally(loop)));
      return () => {
        stopFns.forEach((f) => f());
        stopFns = [];
      };
    },
    checkManual: () => runCheck(),
    async requestInstall() {
      if (state.phase !== "ready" || !downloaded) return;
      const guard = await ports.restartGuard();
      if (!guard.allowed) {
        set({ installBlockedReason: guard.reason ?? "更新重启保护尚未接入" });
        return;
      }
      // #13 接入前不会到达这里；到达即由统一流程执行官方安装。
      await downloaded.update.install();
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getState: () => state,
  };
}
