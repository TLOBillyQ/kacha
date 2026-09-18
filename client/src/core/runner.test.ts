import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import type { RunDeps } from "./run";
import { parseOutcome } from "./taskDir";
import { createRunner, type RunTarget, type RunnerChange } from "./runner";
import { memoryTaskFs } from "./testing/memoryTaskFs";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const PNG_B64 = btoa(String.fromCharCode(...PNG));
const OK_BODY = JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: PNG_B64 }] } }] } } });

/** 提示词 p 接到每个任务节点；withReference 时 t1 另接参考图 r。 */
function board(taskIds: string[] = ["t1"], withReference = false): Board {
  const nodes: BoardNode[] = [{ id: "p", type: "prompt", pos: [0, 0], size: [100, 100], extra: {}, text: "一只橘猫" }];
  const edges: BoardEdge[] = [];
  for (const [i, id] of taskIds.entries()) {
    const ports = withReference && i === 0 ? 1 : 0;
    nodes.push({ id, type: "task", pos: [200, i * 300], size: [280, 260], extra: {}, model: "qwen-image-3.0-pro", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, image_ports: ports, layer_decomposition: false, transparent_background: false, last_submitted: null } satisfies TaskNode);
    edges.push({ from: ["p", "out"], to: [id, "positive"], source_layer: null, region: null, system: false, extra: {} });
  }
  if (withReference) {
    nodes.push({ id: "r", type: "reference", pos: [0, 200], size: [100, 100], extra: {}, path: "refs/cat.png", sha256: "a".repeat(64), display_name: "cat.png" });
    edges.push({ from: ["r", "out"], to: [taskIds[0], "image:0"], source_layer: null, region: null, system: false, extra: {} });
  }
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

/** 一道闸：关着时调用挂起，开闸后逐个放行。 */
function gate() {
  const waiting: (() => void)[] = [];
  return {
    closed: false,
    pass(): Promise<void> {
      return this.closed ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
    get held() {
      return waiting.length;
    },
    open() {
      this.closed = false;
      waiting.splice(0).forEach((f) => f());
    },
  };
}

type Reply = { status: number; body: string };

/** 内存 RunDeps + 手摇假时钟 + 记录式画板写入 / 日志；网关按 replies 依次应答（用完后一律成功）。 */
function harness(opts: { concurrency?: number } = {}) {
  const fs = memoryTaskFs();
  const files = fs.files;
  const requests: string[] = [];
  const replies: Reply[] = [];
  const read = gate();
  const write = gate();
  const gateway = gate();
  let now = Date.parse("2026-09-16T09:15:00Z");
  let timers: { at: number; fn: () => void }[] = [];
  const deps: RunDeps = {
    readFile: async (path) => {
      await read.pass();
      return path === "/root/refs/cat.png" ? PNG : fs.readFile(path);
    },
    writeNewFile: async (path, bytes) => {
      await write.pass();
      return fs.writeNewFile(path, bytes);
    },
    fetch: async (url) => {
      requests.push(url);
      await gateway.pass();
      const r = replies.shift() ?? { status: 200, body: OK_BODY };
      return { status: r.status, headers: { get: () => null }, text: async () => r.body, arrayBuffer: async () => new TextEncoder().encode(r.body).buffer as ArrayBuffer };
    },
    now: () => new Date(now),
    schedule: (ms, fn) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
  };
  const changes: { boardKey: string; change: RunnerChange }[] = [];
  const logs: { kind: string; fields: Record<string, unknown> }[] = [];
  const runner = createRunner({ deps, apply: (boardKey, change) => changes.push({ boardKey, change }), log: (kind, fields) => logs.push({ kind, fields }), concurrency: opts.concurrency ?? 3 });
  const target = (boardKey = "A"): RunTarget => ({ boardKey, boardFile: `${boardKey}.ugcboard`, table: BUILTIN_TABLE, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k" });
  return {
    runner,
    files,
    requests,
    replies,
    read,
    write,
    gateway,
    changes,
    logs,
    target,
    /** 把时钟拨到 ms 之后，触发到点的定时。 */
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      due.forEach((t) => t.fn());
    },
    statuses: (boardKey = "A") => Object.fromEntries(runner.getSnapshot().board(boardKey).statuses),
    locked: (boardKey = "A") => [...runner.getSnapshot().board(boardKey).locked],
    taskDirs: () => new Set([...files.keys()].map((k) => k.split("/").slice(0, 4).join("/"))),
    transitions: () => logs.filter((l) => l.kind === "task").map((l) => `${l.fields.task_node_id}:${l.fields.from_status}→${l.fields.to_status}`),
  };
}

/** 让挂起的 promise 链（含 crypto.subtle 摘要）走完。 */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("任务运行器：成功", () => {
  it("先后产出「提交记录」「运行结果」两条系统变更，状态清空", async () => {
    const h = harness();
    const problems = await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(problems).toEqual([]);
    expect(h.changes.map((c) => [c.boardKey, c.change.kind])).toEqual([
      ["A", "submitted"],
      ["A", "runResult"],
    ]);
    const [submitted, result] = h.changes.map((c) => c.change);
    expect(submitted).toMatchObject({ taskId: "t1", lastSubmitted: { prompt: "一只橘猫" } });
    const taskId = submitted.kind === "submitted" ? submitted.lastSubmitted?.task_id : null;
    expect(result).toMatchObject({ result: { taskId: "t1", submittedTaskId: taskId } });
    expect(h.statuses()).toEqual({});
    expect(h.locked()).toEqual([]);
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.transitions()).toEqual(["t1:null→queued", "t1:queued→running", "t1:running→succeeded"]);
  });
});

describe("任务运行器：取消", () => {
  it("等待中取消且从未派发：不写任务目录、不写 last_submitted、状态清空", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"]);
    await settle();
    expect(h.statuses()).toMatchObject({ t1: { kind: "running" }, t2: { kind: "queued" } });
    const dirsBefore = h.taskDirs();
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t2" });
    expect(h.statuses().t2).toBeUndefined();
    expect(h.locked()).toEqual(["t1"]);
    h.gateway.open();
    await settle();
    expect(h.taskDirs()).toEqual(dirsBefore);
    expect(h.changes.filter((c) => c.change.kind === "submitted").map((c) => c.change.kind === "submitted" && c.change.taskId)).toEqual(["t1"]);
    expect(h.transitions()).toContain("t2:queued→cancelled");
    expect(h.logs.find((l) => l.fields.task_node_id === "t2" && l.fields.to_status === "cancelled")?.fields.gateway_may_continue).toBe(false);
  });

  it("限流退避中取消：已取消、gatewayMayContinue = false、记 outcome.json", async () => {
    const h = harness();
    h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.statuses().t1).toMatchObject({ kind: "backoff" });
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: false });
    expect(h.locked()).toEqual([]);
    expect(outcomes(h)).toEqual([{ kind: "cancelled", gatewayMayContinue: false }]);
    expect(h.transitions().at(-1)).toBe("t1:backoff→cancelled");
  });

  it("执行中取消：gatewayMayContinue = true、记 outcome.json、结果不落画板", async () => {
    const h = harness();
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.gateway.held).toBe(1);
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: true });
    h.gateway.open();
    await settle();
    expect(outcomes(h)).toEqual([{ kind: "cancelled", gatewayMayContinue: true }]);
    expect(h.changes.map((c) => c.change.kind)).toEqual(["submitted"]);
    expect([...h.files.keys()].some((k) => k.includes("result"))).toBe(false);
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: true });
  });

  it("写任务目录期间取消：目录写完后补记结局，不调网关", async () => {
    const h = harness();
    h.write.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.write.held).toBe(1);
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(h.statuses().t1).toEqual({ kind: "cancelled", gatewayMayContinue: false });
    h.write.open();
    await settle();
    expect(outcomes(h)).toEqual([{ kind: "cancelled", gatewayMayContinue: false }]);
    expect(h.requests).toEqual([]);
  });

  it("读参考图期间取消：不入队、不留状态；同批后续任务不再读图", async () => {
    const h = harness();
    h.read.closed = true;
    const submitting = h.runner.submit(h.target(), board(["t1", "t2"], true), ["t1", "t2"]);
    await settle();
    expect(h.statuses()).toEqual({ t1: { kind: "queued" } });
    expect(h.runner.getSnapshot().pending("A")).toBe(1);
    h.runner.cancel({ kind: "board", boardKey: "A" });
    expect(h.statuses()).toEqual({});
    expect(h.read.held).toBe(1);
    h.read.open();
    expect(await submitting).toEqual([]);
    await settle();
    expect(h.statuses()).toEqual({});
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
    expect(h.logs).toEqual([]);
    // t2 没有参考图：若提交了，会读图后入队留下日志；这里只断言读图闸没再被经过。
    expect(h.read.held).toBe(0);
  });

  it("取消不存在的任务：无事发生", async () => {
    const h = harness();
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    const before = h.runner.getSnapshot();
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "zzz" });
    expect(h.statuses()).toEqual(Object.fromEntries(before.board("A").statuses));
    expect(h.logs.filter((l) => l.fields.to_status === "cancelled")).toEqual([]);
  });

  it("取消全部排队：执行中的不受影响", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2", "t3"]), ["t1", "t2", "t3"]);
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => [a.taskNodeId, a.state])).toEqual([["t1", "running"], ["t2", "waiting"], ["t3", "waiting"]]);
    h.runner.cancel({ kind: "waiting" });
    expect(h.statuses()).toEqual({ t1: expect.objectContaining({ kind: "running" }) });
    h.gateway.open();
    await settle();
    expect(h.changes.map((c) => c.change.kind)).toEqual(["submitted", "runResult"]);
  });
});

/** 已写下的 outcome.json 内容。 */
function outcomes(h: ReturnType<typeof harness>) {
  return [...h.files].filter(([k]) => k.endsWith("/outcome.json")).map(([, v]) => parseOutcome(v));
}

describe("任务运行器：读参考图失败", () => {
  it("状态失败，不写 outcome.json，提交返回本地失败说明", async () => {
    const h = harness();
    const b = board(["t1"], true);
    const gone = { ...b, nodes: b.nodes.map((n) => (n.id === "r" ? { ...n, path: "refs/gone.png" } : n)) as BoardNode[] };
    const problems = await h.runner.submit(h.target(), gone, ["t1"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("读取图1");
    expect(h.statuses()).toEqual({ t1: { kind: "failed", label: "本地文件错误" } });
    expect(h.locked()).toEqual([]);
    expect(h.files.size).toBe(0);
    expect(h.changes).toEqual([]);
  });
});

describe("任务运行器：429 退避", () => {
  it("按 30s / 60s / 120s 退避、整队暂停；重试不重写任务目录与 last_submitted；第 4 次 429 按失败并记结局", async () => {
    const h = harness({ concurrency: 1 });
    for (let i = 0; i < 4; i++) h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"]);
    await settle();
    const t0 = Date.parse("2026-09-16T09:15:00Z");
    expect(h.statuses()).toEqual({ t1: { kind: "backoff", retryAt: t0 + 30_000 }, t2: { kind: "queued" } });
    // 退避期间整队暂停：t2 也不派发。
    expect(h.requests).toHaveLength(1);
    expect(h.runner.getSnapshot().active.map((a) => [a.taskNodeId, a.state])).toEqual([["t1", "waiting"], ["t2", "waiting"]]);

    h.advance(29_999);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.advance(1);
    await settle();
    expect(h.requests).toHaveLength(2);
    expect(h.statuses().t1).toEqual({ kind: "backoff", retryAt: t0 + 30_000 + 60_000 });
    h.advance(60_000);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "backoff", retryAt: t0 + 90_000 + 120_000 });
    h.advance(120_000);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "网关限流" });
    expect(outcomes(h)).toEqual([{ kind: "failed", label: "网关限流" }]);
    // 第 4 次按失败后 t2 立即派发并成功。
    expect(h.statuses().t2).toBeUndefined();
    expect(h.changes.filter((c) => c.change.kind === "submitted")).toHaveLength(2);
    const dirs = [...h.files.keys()].filter((k) => k.endsWith("/task.json"));
    expect(dirs).toHaveLength(2);

    const rateLimits = h.logs.filter((l) => l.kind === "rate_limit").map((l) => [l.fields.attempt, l.fields.outcome]);
    expect(rateLimits).toEqual([[1, "retry"], [2, "retry"], [3, "retry"], [4, "failed"]]);
    expect(h.logs.find((l) => l.kind === "rate_limit")?.fields).toMatchObject({ retry_at: new Date(t0 + 30_000).toISOString(), queue_paused_until: new Date(t0 + 30_000).toISOString() });
    expect(h.transitions().filter((t) => t.startsWith("t1"))).toEqual([
      "t1:null→queued",
      "t1:queued→running",
      "t1:running→backoff",
      "t1:backoff→running",
      "t1:running→backoff",
      "t1:backoff→running",
      "t1:running→backoff",
      "t1:backoff→running",
      "t1:running→failed",
    ]);
  });

  it("多个执行中任务先后 429：按先后回到队首（排在已退避任务之后），暂停到最晚的恢复时刻", async () => {
    const h = harness({ concurrency: 2 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2", "t3"]), ["t1", "t2", "t3"]);
    await settle();
    h.replies.push({ status: 429, body: "{}" }, { status: 429, body: "{}" });
    h.gateway.open();
    h.gateway.closed = true;
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => a.taskNodeId)).toEqual(["t1", "t2", "t3"]);
    expect(h.statuses()).toMatchObject({ t1: { kind: "backoff" }, t2: { kind: "backoff" }, t3: { kind: "queued" } });
    h.advance(30_000);
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => [a.taskNodeId, a.state])).toEqual([["t1", "running"], ["t2", "running"], ["t3", "waiting"]]);
    h.gateway.open();
    await settle();
  });
});

describe("任务运行器：并发上限", () => {
  it("达到上限不再派发；调大后立即补派发", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(["t1", "t2", "t3"]), ["t1", "t2", "t3"]);
    await settle();
    expect(h.requests).toHaveLength(1);
    h.runner.setConcurrency(3);
    await settle();
    expect(h.requests).toHaveLength(3);
    const dispatches = h.logs.filter((l) => l.kind === "queue_dispatch").map((l) => [l.fields.task_node_id, l.fields.running, l.fields.waiting, l.fields.limit]);
    expect(dispatches).toEqual([["t1", 1, 0, 1], ["t2", 3, 0, 3], ["t3", 3, 0, 3]]);
    h.gateway.open();
    await settle();
  });
});

describe("任务运行器：跨画板", () => {
  it("跨画板 FIFO；同一（画板, 任务节点）在占用期间重复提交被跳过", async () => {
    const h = harness({ concurrency: 1 });
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(["t1"]), ["t1"]);
    await h.runner.submit(h.target("B"), board(["t9"]), ["t9"]);
    await h.runner.submit(h.target("A"), board(["t1", "t2"]), ["t1", "t2"]);
    expect(await h.runner.regenerate(h.target("A"), board(["t1"]), "t1")).toBeNull();
    await settle();
    expect(h.runner.getSnapshot().active.map((a) => `${a.boardKey}/${a.taskNodeId}`)).toEqual(["A/t1", "B/t9", "A/t2"]);
    expect(h.logs.filter((l) => l.fields.to_status === "queued").map((l) => `${l.fields.board_file}/${l.fields.task_node_id}`)).toEqual(["A.ugcboard/t1", "B.ugcboard/t9", "A.ugcboard/t2"]);
    h.gateway.open();
    await settle();
    expect(h.changes.filter((c) => c.change.kind === "runResult").map((c) => c.boardKey)).toEqual(["A", "B", "A"]);
  });

  it("两块画板含相同任务节点 id：状态表、锁定集、取消互不影响", async () => {
    const h = harness();
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(["t1"]), ["t1"]);
    await h.runner.submit(h.target("B"), board(["t1"]), ["t1"]);
    await settle();
    expect(h.locked("A")).toEqual(["t1"]);
    expect(h.locked("B")).toEqual(["t1"]);
    h.runner.cancel({ kind: "task", boardKey: "A", taskNodeId: "t1" });
    expect(h.statuses("A").t1).toMatchObject({ kind: "cancelled" });
    expect(h.statuses("B").t1).toMatchObject({ kind: "running" });
    expect(h.locked("A")).toEqual([]);
    expect(h.locked("B")).toEqual(["t1"]);
    expect(h.runner.getSnapshot().pending("A")).toBe(0);
    expect(h.runner.getSnapshot().pending("B")).toBe(1);
    h.gateway.open();
    await settle();
    expect(h.changes.filter((c) => c.change.kind === "runResult").map((c) => c.boardKey)).toEqual(["B"]);
  });
});

describe("任务运行器：关闭画板", () => {
  it("取消该画板并遗忘：状态清空，其任务编号不再算「经手过」；别的画板不动", async () => {
    const h = harness();
    h.replies.push({ status: 401, body: "{}" });
    await h.runner.submit(h.target("A"), board(["t1"]), ["t1"]);
    await settle();
    h.gateway.closed = true;
    await h.runner.submit(h.target("A"), board(["t2"]), ["t2"]);
    await h.runner.submit(h.target("B"), board(["t1"]), ["t1"]);
    await settle();
    expect(h.statuses("A")).toMatchObject({ t1: { kind: "failed" }, t2: { kind: "running" } });
    expect(h.runner.getSnapshot().board("A").handled.size).toBe(2);

    h.runner.closeBoard("A");
    expect(h.statuses("A")).toEqual({});
    expect(h.runner.getSnapshot().board("A").handled.size).toBe(0);
    expect(h.runner.getSnapshot().pending()).toBe(1);
    expect(h.statuses("B").t1).toMatchObject({ kind: "running" });
    h.gateway.open();
    await settle();
    expect(h.statuses("A")).toEqual({});
    // 执行中被关掉的任务照样记下已取消，重开时由 outcome.json 给出。
    expect(outcomes(h)).toEqual(expect.arrayContaining([{ kind: "failed", label: "鉴权失败" }, { kind: "cancelled", gatewayMayContinue: true }]));
    expect(h.changes.filter((c) => c.change.kind === "runResult").map((c) => c.boardKey)).toEqual(["B"]);
  });
});

describe("任务运行器：关闭画板时正在算摘要的提交", () => {
  it("submit / regenerate 在关闭前已开始：不入队、不留状态", async () => {
    const h = harness();
    const submitting = h.runner.submit(h.target(), board(["t1", "t2"]), ["t1", "t2"]);
    const regenerating = h.runner.regenerate(h.target(), board(), "t1");
    h.runner.closeBoard("A");
    expect(await submitting).toEqual([]);
    expect(await regenerating).toBeNull();
    await settle();
    expect(h.statuses()).toEqual({});
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
    expect(h.logs).toEqual([]);
  });
});

describe("任务运行器：日志", () => {
  it("关键迁移带画板文件名、任务节点、任务编号；取消带 gateway_may_continue", async () => {
    const h = harness();
    h.gateway.closed = true;
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    h.runner.cancel({ kind: "all" });
    const task = h.logs.filter((l) => l.kind === "task");
    expect(task.map((l) => [l.fields.from_status, l.fields.to_status, l.fields.gateway_may_continue])).toEqual([
      [null, "queued", undefined],
      ["queued", "running", undefined],
      ["running", "cancelled", true],
    ]);
    expect(task[0].fields).toMatchObject({ board_file: "A.ugcboard", task_node_id: "t1", model: "qwen-image-3.0-pro", workflow: "text_to_image" });
    expect(typeof task[0].fields.task_id).toBe("string");
    h.gateway.open();
    await settle();
    expect(h.logs.filter((l) => l.kind === "download")).toEqual([]);
  });

  it("失败迁移带错误类别；下载事件带任务编号与张数", async () => {
    const h = harness();
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.logs.find((l) => l.kind === "download")?.fields).toMatchObject({ ok: true, images: 1, model: "qwen-image-3.0-pro" });
    h.replies.push({ status: 401, body: "{}" });
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.logs.filter((l) => l.kind === "task").at(-1)?.fields).toMatchObject({ from_status: "running", to_status: "failed", category: "auth", message: "鉴权失败" });
  });
});
