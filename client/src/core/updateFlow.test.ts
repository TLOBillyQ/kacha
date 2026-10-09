import { describe, expect, it, vi } from "vitest";
import { createUpdateFlow, type UpdateFlowPorts, type OfficialUpdate, type UpdateState } from "./updateFlow";

// 假 updater：check 返回 Update 资源，download 通过回调发进度，install 记录调用。
function fakePorts(over: Partial<UpdateFlowPorts> = {}) {
  const timers: { at: number; fn: () => void }[] = [];
  let now = 0;
  const schedule = (ms: number, fn: () => void) => {
    const t = { at: now + ms, fn };
    timers.push(t);
    return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
  };
  const tick = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
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
    restartReleased: () => undefined,
    restart: async () => undefined,
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

it("安装失败释放真实准备保护，允许提交与重试；并发点击只安装一次", async () => {
  const { createUpdatePreparation } = await import("./updatePreparation");
  const { harness, board, settle } = await import("./testing/runnerHarness");
  const h = harness();
  const disk: string[] = [];
  const prep = createUpdatePreparation({
    queue: { pending: () => h.runner.getSnapshot().pending(), setSubmissionGuard: g => h.runner.setSubmissionGuard(g) },
    saveBoards: async () => { disk.push("board"); }, saveUi: async () => { disk.push("ui"); },
  });
  const { ports, updates } = fakePorts();
  ports.restartGuard = prep.restartGuard;
  Object.assign(ports, { restartReleased: prep.release, restart: vi.fn() });
  const flow = createUpdateFlow(ports);
  await flow.checkManual();
  let reject!: (e: Error) => void;
  updates[0].install = vi.fn(() => new Promise<void>((_, r) => { reject = r; }));
  const first = flow.requestInstall();
  const second = flow.requestInstall();
  await vi.waitFor(() => expect(updates[0].install).toHaveBeenCalledTimes(1));
  expect(disk).toEqual(["board", "ui"]);
  expect(prep.active()).toBe(true);
  reject(new Error("Access denied"));
  await Promise.all([first, second]);
  expect(prep.active()).toBe(false);
  expect(flow.getState()).toMatchObject({ phase: "ready", error: expect.stringContaining("Access denied"), downloadUrl: "http://x/p.exe" });
  await h.runner.submit(h.target(), board(), ["t1"]);
  await settle();
  expect(h.files.size).toBeGreaterThan(0);
  updates[0].install = vi.fn(async () => undefined);
  await flow.requestInstall();
  expect(updates[0].install).toHaveBeenCalledTimes(1);
});

it("停止中的检查结束后释放更新资源且不重建定时器", async () => {
  const { ports, timers, tick, updates } = fakePorts();
  let finish!: () => void;
  ports.currentVersion = () => new Promise<string>(r => { finish = () => r("0.2.0"); });
  const flow = createUpdateFlow(ports);
  const stop = flow.start();
  tick(3000);
  const pending = flow.checkManual();
  stop();
  finish();
  await pending;
  await vi.waitFor(() => expect(timers).toHaveLength(0));
  expect(updates).toHaveLength(0);
});

it("就绪后的检查保持已下载版本与可安装状态，卸载释放资源", async () => {
  const { ports, updates } = fakePorts();
  const flow = createUpdateFlow(ports);
  const stop = flow.start();
  await flow.checkManual();
  const states: string[] = [];
  flow.subscribe(() => states.push(flow.getState().phase));
  ports.release.fetchLatest = async () => null;
  await flow.checkManual();
  expect(flow.getState()).toMatchObject({ phase: "ready", version: "0.3.0" });
  expect(states).not.toContain("checking");
  updates[0].close = vi.fn(async () => undefined);
  stop();
  expect(updates[0].close).toHaveBeenCalledTimes(1);
});
it("下载错误释放插件资源并保留实际错误", async () => {
  const { ports } = fakePorts();
  const original = ports.updater.check;
  const close = vi.fn(async () => undefined);
  ports.updater.check = async (...args) => {
    const update = (await original(...args))!;
    update.close = close;
    update.download = async () => { throw new Error("invalid signature"); };
    return update;
  };
  const flow = createUpdateFlow(ports);
  await flow.checkManual();
  expect(close).toHaveBeenCalledTimes(1);
  expect(flow.getState()).toMatchObject({ phase: "error", error: "invalid signature" });
});
it("macOS 安装成功后显式重启，重启失败恢复保护且不报告成功", async () => {
  const release = vi.fn();
  const restart = vi.fn(async () => { throw new Error("restart failed"); });
  const { ports, updates } = fakePorts({ platform: () => "macos-arm64", restartGuard: async () => ({ allowed: true }), restartReleased: release, restart });
  const flow = createUpdateFlow(ports);
  await flow.checkManual();
  await flow.requestInstall();
  expect(updates[0].install).toHaveBeenCalledWith({ restartAfterInstall: true });
  expect(restart).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(flow.getState()).toMatchObject({ phase: "ready", error: expect.stringContaining("restart failed") });
});

it("卸载发生于下载中时，下载结束只释放资源而不再就绪", async () => {
  const { ports, updates } = fakePorts();
  const original = ports.updater.check;
  let finish!: () => void;
  const close = vi.fn(async () => undefined);
  ports.updater.check = async (...args) => {
    const update = (await original(...args))!;
    update.download = () => new Promise<void>(r => { finish = r; });
    update.close = close;
    return update;
  };
  const flow = createUpdateFlow(ports);
  const stop = flow.start();
  const checking = flow.checkManual();
  await vi.waitFor(() => expect(flow.getState().phase).toBe("downloading"));
  stop(); finish(); await checking;
  expect(flow.getState().phase).not.toBe("ready");
  expect(close).toHaveBeenCalledTimes(1);
  await flow.requestInstall();
  expect(updates[0].install).not.toHaveBeenCalled();
});
it("卸载后的安装错误释放保护与更新资源", async () => {
  const released = vi.fn();
  const { ports, updates } = fakePorts({ restartGuard: async () => ({ allowed: true }), restartReleased: released });
  const flow = createUpdateFlow(ports);
  const stop = flow.start();
  await flow.checkManual();
  let fail!: () => void;
  updates[0].install = () => new Promise<void>((_, reject) => { fail = () => reject(new Error("install failed")); });
  updates[0].close = vi.fn(async () => undefined);
  const installing = flow.requestInstall();
  await vi.waitFor(() => expect(flow.getState().phase).toBe("installing"));
  stop(); fail(); await installing;
  expect(released).toHaveBeenCalledTimes(1);
  expect(updates[0].close).toHaveBeenCalledTimes(1);
});
