// 统一更新流程（#12）：发布查询 → 官方 updater 检查 → 后台下载 → 就绪。
// 安装前严格保存与任务保护由 restartGuard 注入，失败时显式释放。
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
  restartGuard(): Promise<{ allowed: boolean; reason?: string }>;
  restartReleased(): void;
  restart(): Promise<void>;
}

export interface UpdateState {
  phase: "idle" | "checking" | "downloading" | "ready" | "preparing" | "installing" | "error";
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
  let cancelTimer: (() => void) | null = null;
  let lifecycle = 0;
  let stopped = false;
  let installing = false;

  const emit = () => listeners.forEach((l) => l());
  const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    emit();
  };

  async function runCheck(): Promise<void> {
    if (inflight) return inflight;
    if (stopped || downloaded || installing) return;
    const generation = lifecycle;
    const cancelled = () => stopped || generation !== lifecycle;
    const p = (async () => {
      let candidate: OfficialUpdate | null = null;
      set({ phase: "checking", error: null });
      try {
        const current = await ports.currentVersion();
        if (cancelled()) return;
        const release = await ports.release.fetchLatest();
        if (cancelled()) return;
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
          candidate = update;
          if (cancelled()) return;
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
            if (cancelled()) return;
            if (e.event === "Started") total = e.data.contentLength ?? null;
            if (e.event === "Progress") {
              done += e.data.chunkLength;
              set({ progress: { done, total } });
            }
          });
          if (cancelled()) return;
          downloaded = { update, release };
          candidate = null;
          set({ phase: "ready", progress: { done: total ?? done, total: total ?? done } });
        } else {
          set({ phase: "ready" });
        }
      } catch (e) {
        if (cancelled()) return;
        ports.log("update.check_failed", { message: e instanceof Error ? e.message : String(e) });
        set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (candidate) await candidate.close().catch((e) => ports.log("update.close_failed", { message: String(e) }));
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
      stopped = false;
      const generation = ++lifecycle;
      // 3 秒首检；每次检查完成后 6 小时再检，避免与下载重叠。
      const schedule = (ms: number) => {
        if (stopped || generation !== lifecycle) return;
        cancelTimer = ports.schedule(ms, () => {
          cancelTimer = null;
          void runCheck().finally(() => schedule(CHECK_INTERVAL_MS));
        });
      };
      cancelTimer?.();
      schedule(STARTUP_DELAY_MS);
      return () => {
        if (generation !== lifecycle) return;
        stopped = true;
        lifecycle++;
        cancelTimer?.();
        cancelTimer = null;
        if (downloaded && !installing) {
          void downloaded.update.close().catch((e) => ports.log("update.close_failed", { message: String(e) }));
          downloaded = null;
          set({ ...initial });
        }
      };
    },
    checkManual: () => runCheck(),
    async requestInstall() {
      if (stopped || installing || state.phase !== "ready" || !downloaded) return;
      const generation = lifecycle;
      installing = true;
      set({ phase: "preparing", error: null, installBlockedReason: null });
      try {
        const guard = await ports.restartGuard();
        if (stopped || generation !== lifecycle) {
          ports.restartReleased();
          installing = false;
          if (downloaded) await downloaded.update.close();
          downloaded = null;
          return;
        }
        if (!guard.allowed) {
          ports.restartReleased();
          installing = false;
          set({ phase: "ready", installBlockedReason: guard.reason ?? "无法准备更新" });
          return;
        }
        set({ phase: "installing" });
        await downloaded.update.install({ restartAfterInstall: true });
        if (ports.platform() === "macos-arm64") await ports.restart();
        // Windows 安装器接管进程，macOS relaunch 退出；保护保留到退出。
      } catch (e) {
        ports.restartReleased();
        installing = false;
        const message = e instanceof Error ? e.message : String(e);
        ports.log("update.install_failed", { message });
        set({ phase: "ready", error: `更新安装失败：${message}。请手动下载安装。` });
        if (stopped && downloaded) {
          await downloaded.update.close().catch((closeError) => ports.log("update.close_failed", { message: String(closeError) }));
          downloaded = null;
        }
      }
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getState: () => state,
  };
}
