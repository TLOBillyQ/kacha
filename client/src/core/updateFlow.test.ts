import { describe, expect, it, vi } from "vitest";
import { createUpdateFlow, type UpdateFlowPorts, type OfficialUpdate, type UpdateState } from "./updateFlow";

// 假 updater：check 返回 Update 资源，download 通过回调发进度，install 记录调用。
function fakePorts(over: Partial<UpdateFlowPorts> = {}) {
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const schedule = (ms: number, fn: () => void) => {
    const t = { at: now + ms, fn };
    timers.push(t);
    return () => timers.splice(timers.indexOf(t), 1);
  };
  const tick = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) t.fn();
  };
  const updates: OfficialUpdate[] = [];
  const ports: UpdateFlowPorts = {
    currentVersion: async () => "0.2.0",
    platform: () => "win-x64",
    schedule,
    log: () => undefined,
    release: {
      fetchLatest: async () => ({
        version: "0.3.0",
        pageUrl: "http://x/releases/tag/v0.3.0",
        descriptorUrl: "http://x/d.json",
        packageUrl: "http://x/p.exe",
        target: "windows-x86_64",
      }),
    },
    updater: {
      check: async () => {
        const u: OfficialUpdate = {
          version: "0.3.0",
          currentVersion: "0.2.0",
          body: "更新说明",
          rawJson: { version: "0.3.0", platforms: { "windows-x86_64": { url: "http://x/p.exe", signature: "sig" } } },
          download: async (onEvent) => {
            onEvent?.({ event: "Started", data: { contentLength: 100 } });
            onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
            onEvent?.({ event: "Finished" });
          },
          install: vi.fn(async () => undefined),
          close: async () => undefined,
        };
        updates.push(u);
        return u;
      },
    },
    restartGuard: async () => ({ allowed: false, reason: "更新重启保护尚未接入" }),
    ...over,
  };
  return { ports, tick, updates, timers };
}

describe("统一更新流程", () => {
  it("启动 3 秒后检查，之后每 6 小时检查一次", async () => {
    const { ports, tick } = fakePorts();
    const checks: string[] = [];
    ports.updater.check = async () => {
      checks.push("x");
      return null;
    };
    const flow = createUpdateFlow(ports);
    flow.start();
    expect(checks).toHaveLength(0);
    tick(3000);
    await vi.waitFor(() => expect(checks).toHaveLength(1));
    tick(6 * 3600 * 1000);
    await vi.waitFor(() => expect(checks).toHaveLength(2));
  });

  it("发现新版即后台下载，进度可见，就绪后才可请求更新", async () => {
    const { ports, updates } = fakePorts();
    const flow = createUpdateFlow(ports);
    flow.start();
    const states: UpdateState["phase"][] = [];
    flow.subscribe(() => states.push(flow.getState().phase));
    await flow.checkManual();
    expect(flow.getState().phase).toBe("ready");
    expect(flow.getState().version).toBe("0.3.0");
    expect(flow.getState().progress).toEqual({ done: 100, total: 100 });
    expect(states).toContain("downloading");
    expect(updates[0].install).not.toHaveBeenCalled();
  });

  it("并发检查合并：第二次复用进行中的 Promise", async () => {
    const { ports } = fakePorts();
    let releaseResolve!: (v: import("../core/update").SelectedUpdate | null) => void;
    ports.release.fetchLatest = () => new Promise((r) => (releaseResolve = r));
    const flow = createUpdateFlow(ports);
    const a = flow.checkManual();
    const b = flow.checkManual();
    await vi.waitFor(() => expect(releaseResolve).toBeDefined());
    releaseResolve({
      version: "0.3.0",
      pageUrl: "http://x/releases/tag/v0.3.0",
      descriptorUrl: "http://x/d.json",
      packageUrl: "http://x/p.exe",
      target: "windows-x86_64",
    });
    await Promise.all([a, b]);
    expect(flow.getState().phase).toBe("ready");
  });

  it("下载失败可重试；签名失败（download reject）不标记就绪", async () => {
    const { ports, updates } = fakePorts();
    let failOnce = true;
    ports.updater.check = async () => ({
      version: "0.3.0",
      currentVersion: "0.2.0",
      rawJson: { version: "0.3.0", platforms: { "windows-x86_64": { url: "http://x/p.exe", signature: "sig" } } },
      download: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("签名验证失败");
        }
      },
      install: vi.fn(),
      close: async () => undefined,
    });
    const flow = createUpdateFlow(ports);
    await flow.checkManual();
    expect(flow.getState().phase).toBe("error");
    expect(flow.getState().error).toContain("签名验证失败");
    expect(updates).toHaveLength(0); // 未 ready 时不会持有
    await flow.checkManual();
    expect(flow.getState().phase).toBe("ready");
  });

  it("requestInstall 受守护阻止时不安装、不重启", async () => {
    const { ports, updates } = fakePorts();
    const flow = createUpdateFlow(ports);
    await flow.checkManual();
    expect(flow.getState().phase).toBe("ready");
    await flow.requestInstall();
    expect(updates[0].install).not.toHaveBeenCalled();
    expect(flow.getState().phase).toBe("ready");
    expect(flow.getState().installBlockedReason).toBe("更新重启保护尚未接入");
  });
});
