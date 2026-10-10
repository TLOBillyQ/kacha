import { describe, expect, it } from "vitest";
import type { BoardNode } from "./board";
import { parseOutcome } from "./taskDir";
import { board, harness, settle } from "./testing/runnerHarness";
import { createRunner } from "./runner";
import { BUILTIN_TABLE } from "./capabilities";
import { memoryTaskFs } from "./testing/memoryTaskFs";
import { sendPlanOf } from "./taskView";

it("Flash 区域发送文本、原图/叠加图顺序及任务记录经runner保持一致，重新生成还原坐标", async () => {
  const fs = memoryTaskFs();
  const b = board(["t1"], true);
  const t = b.nodes.find((n) => n.type === "task")!;
  if (t.type !== "task") throw new Error("task");
  t.model = "doubao-seedream-5-0-flash-260915";
  const image = b.edges.find((e) => e.to[1] === "image:0")!;
  image.region = { rects: [[0, 0, 1, 1]], render: "bbox_tag", coordinate_kind: "point" };
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
  fs.files.set("/root/refs/cat.png", png);
  const bodies: any[] = [];
  const r = createRunner({ concurrency: 1, log: () => {}, apply: (_, c) => { if (c.kind === "submitted") t.last_submitted = c.lastSubmitted; }, deps: {
    ...fs, now: () => new Date("2026-10-10T10:00:00Z"), schedule: () => () => {},
    imageCodec: { decode: async () => ({ width: 1024, height: 1024, hasAlpha: () => true, encode: async () => png, close() {} }) },
    fetch: async (_, init) => { bodies.push(JSON.parse(String(init?.body))); return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [{ b64_json: btoa(String.fromCharCode(...png)) }] }), arrayBuffer: async () => png.buffer as ArrayBuffer }; },
  }});
  const target = { boardKey: "A", boardFile: "A", table: BUILTIN_TABLE, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k" };
  const shown = sendPlanOf(b, BUILTIN_TABLE, "t1")!;
  expect(await r.submit(target, b, ["t1"])).toEqual([]);
  await settle();
  const records = [...fs.files].filter(([p]) => p.endsWith("/task.json")).map(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
  expect(records[0].send_text).toBe(shown.text);
  expect(bodies[0].prompt).toBe(shown.text);
  expect(bodies[0].image).toHaveLength(1);
  expect(records[0].references[0].region).toEqual({ rects: [[0, 0, 1, 1]], render: "bbox_tag", coordinate_kind: "point", source_port: 1 });
  expect(await r.regenerate(target, b, "t1")).toBeNull();
  await settle();
  expect(bodies[1].prompt).toBe(shown.text);
  image.region!.rects = [[-1, 0, 1, 1]];
  expect(await r.submit(target, b, ["t1"])).toHaveLength(1);
  expect(bodies).toHaveLength(2);
});

describe("Lite 停用", () => {
  it("普通运行明确阻止，不调用网关或写入任务目录", async () => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-lite-260128";
    expect(await h.runner.submit(h.target(), b, ["t1"])).toEqual(["Lite 已停用，请切换到 Flash"]);
    await settle();
    expect(h.requests).toEqual([]);
    expect(h.files.size).toBe(0);
    expect(h.changes).toEqual([]);
  });
  it.each([undefined, "20260916T091500Z-deadbeef"])("历史 Lite 重新生成/变体在当前节点已改 Flash 后仍阻止且不改历史 (%s)", async (fromTaskId) => {
    const h = harness();
    const b = board();
    const t = b.nodes.find((n) => n.type === "task")!;
    if (t.type !== "task") throw new Error("task");
    const taskId = "20260916T091500Z-deadbeef";
    const path = `/root/2026-09-16/${taskId}/task.json`;
    const old = new TextEncoder().encode(JSON.stringify({ task_id: taskId, submitted_at: "2026-09-16T09:15:00Z", workflow: "text_to_image", model: "doubao-seedream-5-0-lite-260128", capability_format_version: 1, capability_table_sha256: "a".repeat(64), prompt: "旧猫", negative_prompt: "", send_text: "旧猫", size_spec: { tier: "3K", ratio: "1:1", width: null, height: null }, size: { width: 3072, height: 3072 }, layer_decomposition: false, transparent_background: false, references: [] }));
    h.files.set(path, old);
    t.model = "doubao-seedream-5-0-flash-260915";
    t.last_submitted = { task_id: taskId, model: "doubao-seedream-5-0-lite-260128", prompt: "旧猫", negative_prompt: "", size_spec: { tier: "3K", ratio: "1:1", width: null, height: null }, layer_decomposition: false, transparent_background: false, images: [] };
    expect(await h.runner.regenerate(h.target(), b, "t1", fromTaskId)).toBe("Lite 已停用，请切换到 Flash");
    expect(h.requests).toEqual([]);
    expect(h.files.size).toBe(1);
    expect(h.files.get(path)).toEqual(old);
  });
});

describe("Flash 失败政策", () => {
  it.each(["base64", "URL"])("%s 的 PNG 签名残片解码失败，不存结果或产出节点", async (transport) => {
    const damaged = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    const decoded: Uint8Array[] = [];
    const h = harness({ imageCodec: { decode: async (bytes) => {
      decoded.push(bytes);
      throw new Error("truncated PNG");
    } } });
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 200, body: JSON.stringify({ data: [transport === "URL" ? { url: "https://result.test/broken.png" } : { b64_json: btoa(String.fromCharCode(...damaged)) }] }) });
    if (transport === "URL") h.replies.push({ status: 200, body: "", bytes: damaged });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "响应无效" });
    expect(decoded).toEqual([damaged]);
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toEqual([]);
    expect([...h.files.keys()].some((path) => /\/result\./.test(path))).toBe(false);
  });
  it.each([401, 400, 500])("HTTP %i 不重发，保留失败", async (status) => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status, body: "{}" });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1.kind).toBe("failed");
    h.advance(300000);
    await settle();
    expect(h.requests).toHaveLength(1);
  });
  it.each([
    { data: [] },
    { data: [{ url: "https://result.test/a" }, { url: "https://result.test/b" }] },
    { data: [{ b64_json: "not-valid!" }] },
  ])("坏响应失败，不产出结果节点", async (body) => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 200, body: JSON.stringify(body) });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "响应无效" });
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toEqual([]);
    expect(h.requests).toHaveLength(1);
  });
  it("URL 下载拒绝明确失败且不重发生成", async () => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 200, body: JSON.stringify({ data: [{ url: "https://result.test/a" }] }) }, { status: 403, body: "denied" });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "网关拒绝" });
    expect(h.requests).toEqual(["http://gw/v1/images/generations", "https://result.test/a"]);
    expect(h.changes.filter((c) => c.change.kind === "runResult")).toEqual([]);
  });
  it("429 明确失败，不自动退避重发或换模型", async () => {
    const h = harness();
    const b = board();
    for (const node of b.nodes) if (node.type === "task") node.model = "doubao-seedream-5-0-flash-260915";
    h.replies.push({ status: 429, body: "{}" });
    await h.runner.submit(h.target(), b, ["t1"]);
    await settle();
    expect(h.statuses().t1).toEqual({ kind: "failed", label: "网关限流" });
    expect(h.requests).toHaveLength(1);
    expect(h.transitions()).not.toContain("t1:running→backoff");
  });
});

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


describe("任务运行器：提交守护（更新准备）", () => {
  it("准备失败已解除守护后，之前卡在摘要阶段的提交也不能复活", async () => {
    const h = harness();
    const submitting = h.runner.submit(h.target(), board(), ["t1"]);
    const regenerating = h.runner.regenerate(h.target(), board(), "t1");
    h.runner.setSubmissionGuard(() => undefined);
    h.runner.setSubmissionGuard(null);
    expect(await submitting).toEqual([]);
    expect(await regenerating).toBeNull();
    await settle();
    expect(h.files.size).toBe(0);
    expect(h.runner.getSnapshot().pending()).toBe(0);
  });
  it("守护在位时 submit / regenerate 拒绝入队，解除后恢复", async () => {
    const h = harness();
    const blocked: string[] = [];
    h.runner.setSubmissionGuard(() => blocked.push("blocked"));
    expect(await h.runner.submit(h.target(), board(), ["t1"])).toEqual([]);
    expect(await h.runner.regenerate(h.target(), board(), "t1")).toBeNull();
    await settle();
    expect(blocked).toEqual(["blocked", "blocked"]);
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.statuses()).toEqual({});
    expect(h.files.size).toBe(0);
    expect(h.logs).toEqual([]);

    h.runner.setSubmissionGuard(null);
    await h.runner.submit(h.target(), board(), ["t1"]);
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBeGreaterThan(0);
  });

  it("守护在 tableDigest 期间挂上：异步间隙里的提交也不入队", async () => {
    // crypto.subtle 摘要是真异步：守护在摘要算完后才挂上时，这次提交必须被拦在入队前。
    const h = harness();
    const submitting = h.runner.submit(h.target(), board(), ["t1"]);
    h.runner.setSubmissionGuard(() => undefined);
    expect(await submitting).toEqual([]);
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
  });

  it("守护在 regenerate 的摘要间隙挂上：同样拦在入队前", async () => {
    const h = harness();
    const regenerating = h.runner.regenerate(h.target(), board(), "t1");
    h.runner.setSubmissionGuard(() => undefined);
    expect(await regenerating).toBeNull();
    await settle();
    expect(h.runner.getSnapshot().pending()).toBe(0);
    expect(h.files.size).toBe(0);
  });
});
