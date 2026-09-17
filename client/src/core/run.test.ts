import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, ResultNode, TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import type { FetchLike } from "./gateway";
import { CancelledError, executeJob, failureLabel, prepareJob, prepareRegenerate, writeJob, type RunDeps } from "./run";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const PNG_B64 = btoa(String.fromCharCode(...PNG));

function board(withReference: boolean): Board {
  const nodes: BoardNode[] = [
    { id: "p", type: "prompt", pos: [0, 0], size: [100, 100], extra: {}, text: "一只橘猫" },
    { id: "t", type: "task", pos: [200, 0], size: [280, 260], extra: {}, model: "qwen-image-3.0-pro", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, image_ports: withReference ? 1 : 0, layer_decomposition: false, transparent_background: false, last_submitted: null } satisfies TaskNode,
  ];
  const edges: BoardEdge[] = [{ from: ["p", "out"], to: ["t", "positive"], source_layer: null, region: null, system: false, extra: {} }];
  if (withReference) {
    nodes.push({ id: "r", type: "reference", pos: [0, 200], size: [100, 100], extra: {}, path: "refs/cat.png", sha256: "a".repeat(64), display_name: "cat.png" });
    edges.push({ from: ["r", "out"], to: ["t", "image:0"], source_layer: null, region: null, system: false, extra: {} });
  }
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

function deps(respond: (url: string, init: Parameters<FetchLike>[1]) => { status: number; body: string }) {
  const files = new Map<string, Uint8Array>();
  const requests: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const d: RunDeps = {
    writeNewFile: async (path, bytes) => {
      if (files.has(path)) throw new Error("exists");
      files.set(path, bytes);
    },
    readBytes: async (path) => {
      if (path === "/root/refs/cat.png") return PNG;
      const written = files.get(path);
      if (written) return written;
      throw new Error("not found");
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      const r = respond(url, init);
      return { status: r.status, headers: { get: () => null }, text: async () => r.body, arrayBuffer: async () => new TextEncoder().encode(r.body).buffer as ArrayBuffer };
    },
    now: () => new Date("2026-09-16T09:15:00Z"),
  };
  return { d, files, requests };
}

const ok = () => ({ status: 200, body: JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: PNG_B64 }] } }] } } }) });

describe("单任务端到端", () => {
  it("图片编辑：提交只改 last_submitted；派发时写任务目录，调网关，存结果并加结果节点", async () => {
    const { d, files, requests } = deps(ok);
    const b0 = board(true);
    const { job: prepared, board: b1 } = await prepareJob(d, { board: b0, table: BUILTIN_TABLE, tableSha256: "f".repeat(64), outputRoot: "/root", taskNodeId: "t" });
    expect(prepared.relDir).toMatch(/^2026-09-16\/20260916T091500Z-[0-9a-f]{8}$/);
    expect((b1.nodes.find((n) => n.id === "t") as TaskNode).last_submitted?.task_id).toBe(prepared.taskId);
    expect(files.size).toBe(0);

    const job = await writeJob(d, "/root", prepared);
    const dir = `/root/${job.relDir}`;
    expect(files.get(`${dir}/reference-1.png`)).toEqual(PNG);
    const taskJson = JSON.parse(new TextDecoder().decode(files.get(`${dir}/task.json`)));
    expect(taskJson).toMatchObject({ task_id: job.taskId, model: "qwen-image-3.0-pro", capability_table_sha256: "f".repeat(64), send_text: "本次提供 1 张参考图。\n一只橘猫" });
    expect(requests).toHaveLength(0);

    const apply = await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "sk-test", newNodeId: "res" });
    expect(requests.map((r) => r.url)).toEqual(["http://gw/v1/images/edits"]);
    expect(files.get(`${dir}/result.png`)).toEqual(PNG);
    const b2 = apply(b1);
    expect(b2.nodes.find((n) => n.id === "res")).toMatchObject({ type: "result", task_id: job.taskId, path: `${job.relDir}/result.png` } satisfies Partial<ResultNode>);
    expect(b2.edges.at(-1)).toMatchObject({ from: ["t", "result"], to: ["res", "in"], system: true });
  });

  it("执行中取消：网关返回后不存结果图", async () => {
    const { d, files } = deps(ok);
    const controller = new AbortController();
    const { job: prepared } = await prepareJob(d, { board: board(false), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    const job = await writeJob(d, "/root", prepared);
    const pending = executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res", signal: controller.signal });
    controller.abort();
    expect(await pending.catch((e) => e)).toBeInstanceOf(CancelledError);
    expect([...files.keys()].some((k) => k.includes("result"))).toBe(false);
  });

  it("重新生成：按上次任务目录的 task.json 与参考图快照，同参数新任务", async () => {
    const { d, files, requests } = deps(ok);
    const { job: first, board: b1 } = await prepareJob(d, { board: board(true), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    await writeJob(d, "/root", first);
    // 用户之后改了提示词：重新生成仍按上次提交的参数。
    const edited = { ...b1, nodes: b1.nodes.map((n) => (n.type === "prompt" ? { ...n, text: "一只黑猫" } : n)) };
    d.now = () => new Date("2026-09-17T01:00:00Z");
    const { job: again, board: b2 } = await prepareRegenerate(d, { board: edited, table: BUILTIN_TABLE, tableSha256: "y", outputRoot: "/root", taskNodeId: "t" });
    expect(again.taskId).not.toBe(first.taskId);
    expect(again.relDir.startsWith("2026-09-17/")).toBe(true);
    const task = b2.nodes.find((n) => n.id === "t") as TaskNode;
    expect(task.last_submitted).toMatchObject({ task_id: again.taskId, prompt: "一只橘猫" });

    const job = await writeJob(d, "/root", again);
    const taskJson = JSON.parse(new TextDecoder().decode(files.get(`/root/${job.relDir}/task.json`)));
    expect(taskJson).toMatchObject({ prompt: "一只橘猫", send_text: "本次提供 1 张参考图。\n一只橘猫", capability_table_sha256: "y" });
    expect(files.get(`/root/${job.relDir}/reference-1.png`)).toEqual(PNG);
    await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    expect(requests.map((r) => r.url)).toEqual(["http://gw/v1/images/edits"]);
  });

  it("生成变体：按该结果的任务目录重跑，即使父任务之后又提交过别的参数；新结果进父任务结果列", async () => {
    const { d } = deps(ok);
    const { job: older, board: b1 } = await prepareJob(d, { board: board(true), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    await writeJob(d, "/root", older);
    const edited = { ...b1, nodes: b1.nodes.map((n) => (n.type === "prompt" ? { ...n, text: "一只黑猫" } : n)) };
    d.now = () => new Date("2026-09-17T01:00:00Z");
    const { job: newer, board: b2 } = await prepareJob(d, { board: edited, table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    await writeJob(d, "/root", newer);

    d.now = () => new Date("2026-09-18T01:00:00Z");
    const { job: variant, board: b3 } = await prepareRegenerate(d, { board: b2, table: BUILTIN_TABLE, tableSha256: "y", outputRoot: "/root", taskNodeId: "t", fromTaskId: older.taskId });
    expect(variant.taskNodeId).toBe("t");
    expect(variant.record.prompt).toBe("一只橘猫");
    expect(variant.taskId).not.toBe(older.taskId);
    // 任务节点的上次提交仍是 newer：之后「重新生成」重跑的是最近一次提交，不是变体。
    expect(b3).toBe(b2);
  });

  it("文生图走 generations", async () => {
    const { d, requests } = deps(ok);
    const { job } = await prepareJob(d, { board: board(false), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    await executeJob(d, { job: await writeJob(d, "/root", job), outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    expect(requests[0].url).toBe("http://gw/v1/images/generations");
  });

  it("参考图读不到：本地错误，不写任务目录", async () => {
    const { d, files } = deps(ok);
    const b = board(true);
    const bad = { ...b, nodes: b.nodes.map((n) => (n.id === "r" ? { ...n, path: "refs/gone.png" } : n)) as BoardNode[] };
    const err = await prepareJob(d, { board: bad, table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" }).catch((e) => e);
    expect(failureLabel(err)).toBe("本地文件错误");
    expect(files.size).toBe(0);
  });

  it("401 → 鉴权失败，错误信息不含密钥；不存结果、不重发", async () => {
    const { d, files, requests } = deps(() => ({ status: 401, body: '{"error":{"message":"bad key sk-secret"}}' }));
    const { job } = await prepareJob(d, { board: board(false), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    const err = await executeJob(d, { job: await writeJob(d, "/root", job), outputRoot: "/root", baseUrl: "http://gw", apiKey: "sk-secret", newNodeId: "res" }).catch((e) => e);
    expect(failureLabel(err)).toBe("鉴权失败");
    expect(String(err.message)).not.toContain("sk-secret");
    expect(requests).toHaveLength(1);
    expect([...files.keys()].some((k) => k.includes("result"))).toBe(false);
  });

  it("429 计失败为网关限流", async () => {
    const { d } = deps(() => ({ status: 429, body: "{}" }));
    const { job } = await prepareJob(d, { board: board(false), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    const err = await executeJob(d, { job: await writeJob(d, "/root", job), outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" }).catch((e) => e);
    expect(failureLabel(err)).toBe("网关限流");
  });
});
