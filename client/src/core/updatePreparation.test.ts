import { describe, expect, it } from "vitest";
import { createUpdatePreparation, BUSY_MESSAGE } from "./updatePreparation";
import { board, harness, settle } from "./testing/runnerHarness";

function fixture(saves: { boards?: () => Promise<void>; ui?: () => Promise<void> } = {}) {
  const h = harness({ concurrency: 1 });
  const disk = new Map<string, string>();
  const prep = createUpdatePreparation({
    queue: {
      pending: () => h.runner.getSnapshot().pending(),
      setSubmissionGuard: (guard) => h.runner.setSubmissionGuard(guard),
    },
    saveBoards: saves.boards ?? (async () => { disk.set("board", "最新画板"); }),
    saveUi: saves.ui ?? (async () => { disk.set("ui", "最新标签页"); }),
  });
  return { ...h, prep, disk };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("更新准备：真实任务队列与严格保存", () => {
  it("已开始的操作失败时等待全部在途操作结束，再拒绝安装并恢复", async () => {
    const slow = deferred();
    const h = fixture();
    h.prep.track(Promise.reject(new Error("导入失败")));
    h.prep.track(slow.promise);
    const result = h.prep.prepare();
    await settle();
    expect(h.prep.active()).toBe(true);
    slow.resolve();
    expect(await result).toEqual({ ok: false, reason: "更新准备失败：导入失败" });
    expect(h.prep.active()).toBe(false);
    expect(h.disk.size).toBe(0);
  });
  it("严格保存全部成功后保持保护，直到安装结束；解除后允许新的提交", async () => {
    const h = fixture();
    expect(await h.prep.prepare()).toEqual({ ok: true });
    expect([...h.disk.values()]).toEqual(["最新画板", "最新标签页"]);
    expect(h.prep.active()).toBe(true);
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.files.size).toBe(0);
    h.prep.release();
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.files.size).toBeGreaterThan(0);
  });

  it("跨画板排队和执行中均阻止更新，不取消任务、不安排结束后重启", async () => {
    const h = fixture();
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(), ["t1"]);
    await h.runner.submit(h.target("B"), board(), ["t1"]);
    await settle();
    expect(h.statuses("A").t1).toMatchObject({ kind: "running" });
    expect(h.statuses("B").t1).toMatchObject({ kind: "queued" });
    expect(await h.prep.prepare()).toEqual({ ok: false, reason: BUSY_MESSAGE });
    expect(h.runner.getSnapshot().pending()).toBe(2);
    expect(h.disk.size).toBe(0);
    h.gateway.open();
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.disk.size).toBe(0);
    expect(h.prep.active()).toBe(false);
  });

  it("限流退避阻止更新，保持任务的退避状态", async () => {
    const h = fixture();
    h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.statuses().t1).toMatchObject({ kind: "backoff" });
    expect(await h.prep.prepare()).toEqual({ ok: false, reason: BUSY_MESSAGE });
    expect(h.statuses().t1).toMatchObject({ kind: "backoff" });
    expect(h.disk.size).toBe(0);
    h.runner.cancel({ kind: "all" });
  });

  it("读取参考图阶段立刻阻止更新，不等读图、不取消已提交任务", async () => {
    const h = fixture();
    h.read.closed = true;
    const submitting = h.runner.submit(h.target(), board(["t1"], true), ["t1"]);
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(1);
    expect(await h.prep.prepare()).toEqual({ ok: false, reason: BUSY_MESSAGE });
    expect(h.runner.getSnapshot().pending()).toBe(1);
    h.read.open();
    await submitting;
    await settle();
    expect(h.files.size).toBeGreaterThan(0);
  });

  it("摘要间隙中的旧提交在准备失败并恢复后仍不能进入队列", async () => {
    const h = fixture({ boards: async () => { throw new Error("磁盘已满"); } });
    const submitting = h.runner.submit(h.target(), board(), ["t1"]);
    const regenerating = h.runner.regenerate(h.target(), board(), "t1");
    expect(await h.prep.prepare()).toEqual({ ok: false, reason: "保存画板失败：磁盘已满" });
    await Promise.all([submitting, regenerating]);
    await settle();
    expect(h.files.size).toBe(0);
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.files.size).toBeGreaterThan(0);
  });

  it("界面状态写入失败也拒绝安装并解除保护", async () => {
    const h = fixture({ ui: async () => { throw new Error("只读文件系统"); } });
    expect(await h.prep.prepare()).toEqual({ ok: false, reason: "保存界面状态失败：只读文件系统" });
    expect(h.prep.active()).toBe(false);
  });

  it("一个保存失败后仍等待其余真实写入，修复后允许重试", async () => {
    const slow = deferred();
    let broken = true;
    let persisted = false;
    const h = fixture({
      boards: async () => { if (broken) throw new Error("磁盘已满"); },
      ui: async () => { await slow.promise; persisted = true; },
    });
    const preparation = h.prep.prepare();
    await settle();
    expect(persisted).toBe(false);
    expect(h.prep.active()).toBe(true);
    slow.resolve();
    expect(await preparation).toEqual({ ok: false, reason: "保存画板失败：磁盘已满" });
    expect(persisted).toBe(true);
    broken = false;
    expect(await h.prep.prepare()).toEqual({ ok: true });
  });

  it("并发点击在同一个实际写入完成之前共享准备结果", async () => {
    const slow = deferred();
    let persisted = false;
    const h = fixture({ boards: async () => { await slow.promise; persisted = true; } });
    const first = h.prep.prepare();
    const second = h.prep.prepare();
    expect(first).toBe(second);
    expect(persisted).toBe(false);
    slow.resolve();
    expect(await first).toEqual({ ok: true });
    expect(persisted).toBe(true);
  });

  it("已开始的异步打开操作完成并产生最新状态后才严格保存", async () => {
    const slow = deferred();
    let content = "旧状态";
    let disk = "旧状态";
    const h = fixture({ ui: async () => { disk = content; } });
    h.prep.track(slow.promise.then(() => { content = "包含新增画板"; }));
    const preparation = h.prep.prepare();
    await settle();
    expect(disk).toBe("旧状态");
    slow.resolve();
    expect(await preparation).toEqual({ ok: true });
    expect(disk).toBe("包含新增画板");
  });
});
