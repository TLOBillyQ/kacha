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

  it("结果图下载成功 / 失败都回调下载事件，失败带网关错误", async () => {
    const byUrl = (url: string) =>
      url.startsWith("https://oss") ? { status: 403, body: "denied" } : { status: 200, body: JSON.stringify({ metadata: { output: { choices: [{ message: { content: [{ image: "https://oss/x.png?sig=1" }] } }] } } }) };
    for (const [respond, expected] of [[ok, { ok: true, images: 1 }], [byUrl, { ok: false }]] as const) {
      const { d } = deps(respond);
      const { job: prepared } = await prepareJob(d, { board: board(false), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
      const job = await writeJob(d, "/root", prepared);
      const events: { ok: boolean; error?: unknown }[] = [];
      await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res", onDownload: (e) => events.push(e) }).catch(() => undefined);
      expect(events).toEqual([expect.objectContaining(expected)]);
      if (!expected.ok) expect(events[0].error).toMatchObject({ status: 403 });
    }
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

describe("Seedream：执行", () => {
  function seedreamBoard(): Board {
    const b = board(true);
    b.nodes = b.nodes.map((n) =>
      n.type === "task" ? { ...n, model: "doubao-seedream-5-0-pro-260628", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, transparent_background: true } : n,
    );
    return b;
  }
  const respond = (url: string) =>
    url.startsWith("https://oss/") ? { status: 200, body: "" } : { status: 200, body: JSON.stringify({ data: [{ url: "https://oss/r.png", size: "2048x2048" }] }) };

  it("走 generations 顶层 image，透明背景开关带 background；下载 data[].url 落盘；重新生成沿用开关", async () => {
    const { d, files, requests } = deps(respond);
    d.fetch = ((inner) => async (url, init) => {
      const r = await inner(url, init);
      return url.startsWith("https://oss/") ? { ...r, arrayBuffer: async () => PNG.slice().buffer } : r;
    })(d.fetch);
    const { job: prepared, board: b1 } = await prepareJob(d, { board: seedreamBoard(), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    const job = await writeJob(d, "/root", prepared);
    await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    expect(requests.map((r) => r.url)).toEqual(["http://gw/v1/images/generations", "https://oss/r.png"]);
    const body = JSON.parse(requests[0].init.body!);
    expect(body).toMatchObject({ model: "doubao-seedream-5-0-pro-260628", size: "2048x2048", response_format: "url", background: "transparent", image: [`data:image/png;base64,${PNG_B64}`] });
    expect(files.get(`/root/${job.relDir}/result.png`)).toEqual(PNG);

    const { job: again } = await prepareRegenerate(d, { board: b1, table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    expect(again.input.transparentBackground).toBe(true);
  });
});

describe("区域指示：提交链路", () => {
  const REGION = { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };

  function regionBoard(): Board {
    const b = board(true);
    b.edges = b.edges.map((e) => (e.to[1] === "image:0" ? { ...e, region: REGION } : e));
    return b;
  }

  const withOverlay = (d: RunDeps, composed: Uint8Array) => {
    const calls: { bytes: Uint8Array; rects: unknown }[] = [];
    d.composeOverlay = async (image, rects) => {
      calls.push({ bytes: image, rects });
      return composed;
    };
    return calls;
  };

  it("叠加图紧随原图作参考图；task.json 记端口序号 + 矩形 + 渲染方式；固定句进发送文本与请求", async () => {
    const { d, files, requests } = deps(ok);
    const calls = withOverlay(d, PNG);
    const { job: prepared, board: b1 } = await prepareJob(d, { board: regionBoard(), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    expect(calls).toHaveLength(1);
    expect(calls[0].bytes).toEqual(PNG);
    expect(calls[0].rects).toEqual(REGION.rects);
    expect(prepared.input.regionPhrases?.[0]).toContain("图2 是图1 的标注版");

    const job = await writeJob(d, "/root", prepared);
    const dir = `/root/${job.relDir}`;
    const taskJson = JSON.parse(new TextDecoder().decode(files.get(`${dir}/task.json`)));
    expect(taskJson.references).toHaveLength(2);
    expect(taskJson.references[1]).toMatchObject({
      source: { kind: "overlay", of: 1 },
      region: { rects: REGION.rects, render: "highlight_overlay", source_port: 1 },
    });
    expect(taskJson.send_text).toContain("本次提供 2 张参考图，按顺序为图1、图2。");
    expect(taskJson.send_text).toContain("紫色半透明高亮标出的是要修改的区域");

    await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    const body = JSON.parse(String(requests[0].init.body));
    expect(body.input.messages[0].content).toHaveLength(3);
    expect(body.input.messages[0].content[2].text).toContain("图2 是图1 的标注版");
    void b1;
  });

  it("重新生成：按 task.json 的 region 记录重建固定句，参考图原样重发", async () => {
    const { d, files } = deps(ok);
    withOverlay(d, PNG);
    const { job: first, board: b1 } = await prepareJob(d, { board: regionBoard(), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    await writeJob(d, "/root", first);
    d.now = () => new Date("2026-09-17T01:00:00Z");
    const { job: again } = await prepareRegenerate(d, { board: b1, table: BUILTIN_TABLE, tableSha256: "y", outputRoot: "/root", taskNodeId: "t" });
    expect(again.plan.references[1]).toMatchObject({ source: { kind: "overlay", of: 1 }, region: { source_port: 1 } });
    expect(again.input.regionPhrases?.[0]).toContain("图2 是图1 的标注版");
    const job = await writeJob(d, "/root", again);
    expect(files.get(`/root/${job.relDir}/reference-2.png`)).toEqual(PNG);
  });

  /** 图1（带区域）+ 图2，提示词按用户序号引用图2。 */
  function twoImageBoard(): Board {
    const b = regionBoard();
    b.nodes = b.nodes.map((n) => (n.type === "prompt" ? { ...n, text: "把@图2的少女放入图1" } : n.type === "task" ? { ...n, image_ports: 2 } : n));
    b.nodes.push({ id: "r2", type: "reference", pos: [0, 400], size: [100, 100], extra: {}, path: "refs/cat.png", sha256: "a".repeat(64), display_name: "girl.png" });
    b.edges.push({ from: ["r2", "out"], to: ["t", "image:1"], source_layer: null, region: null, system: false, extra: {} });
    return b;
  }

  it("用户序号换算：task.json 存用户原文与换算后的发送文本，请求文本与之一致", async () => {
    const { d, files, requests } = deps(ok);
    withOverlay(d, PNG);
    const { job: prepared } = await prepareJob(d, { board: twoImageBoard(), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    expect(prepared.plan.references.map((r) => r.source.kind)).toEqual(["reference", "overlay", "reference"]);
    const job = await writeJob(d, "/root", prepared);
    const taskJson = JSON.parse(new TextDecoder().decode(files.get(`/root/${job.relDir}/task.json`)));
    expect(taskJson.prompt).toBe("把@图2的少女放入图1");
    expect(taskJson.send_text).toContain("本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图3的少女放入图1\n图2 是图1 的标注版");

    await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    const body = JSON.parse(String(requests[0].init.body));
    expect(body.input.messages[0].content[3].text).toBe(taskJson.send_text);
  });

  it("重新生成旧 task.json（按旧口径存的 send_text）：按 references[] 还原用户序号，发送文本与新规则一致", async () => {
    const { d, files, requests } = deps(ok);
    withOverlay(d, PNG);
    const { job: first, board: b1 } = await prepareJob(d, { board: twoImageBoard(), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    const written = await writeJob(d, "/root", first);
    const path = `/root/${written.relDir}/task.json`;
    const expected = JSON.parse(new TextDecoder().decode(files.get(path))).send_text;
    const old = JSON.parse(new TextDecoder().decode(files.get(path)));
    old.send_text = old.send_text.replace("图3的少女", "图2的少女");
    files.set(path, new TextEncoder().encode(JSON.stringify(old)));

    d.now = () => new Date("2026-09-17T01:00:00Z");
    const { job: again } = await prepareRegenerate(d, { board: b1, table: BUILTIN_TABLE, tableSha256: "y", outputRoot: "/root", taskNodeId: "t" });
    expect(again.plan.sendText).toBe(expected);
    const job = await writeJob(d, "/root", again);
    await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    expect(JSON.parse(String(requests[0].init.body)).input.messages[0].content[3].text).toBe(expected);
  });

  it("有区域但没注入叠加合成能力：本地错误", async () => {
    const { d } = deps(ok);
    const err = await prepareJob(d, { board: regionBoard(), table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" }).catch((e) => e);
    expect(failureLabel(err)).toBe("本地文件错误");
  });
});

describe("图层拆分：执行", () => {
  const multi = () => ({
    status: 200,
    body: JSON.stringify({
      metadata: {
        output: {
          choices: [
            {
              message: {
                content: [
                  { image: PNG_B64 },
                  { image: PNG_B64, z_index: 2, bounding_box: [0, 0, 10, 10] },
                  { image: PNG_B64, z_index: 1, bounding_box: [5, 5, 20, 20] },
                ],
              },
            },
          ],
        },
      },
    }),
  });

  it("拆分开关下多张返回：首张 result.png，其余按 z_index 落盘 layers/NN，结果节点记 layer_count 与 layers", async () => {
    const { d, files } = deps(multi);
    const b = board(false);
    (b.nodes[1] as TaskNode).layer_decomposition = true;
    const { job: prepared, board: b1 } = await prepareJob(d, { board: b, table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    const job = await writeJob(d, "/root", prepared);
    const apply = await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    const dir = `/root/${job.relDir}`;
    expect(files.get(`${dir}/result.png`)).toEqual(PNG);
    expect(files.get(`${dir}/layers/01.png`)).toEqual(PNG);
    expect(files.get(`${dir}/layers/02.png`)).toEqual(PNG);
    const b2 = apply(b1);
    const res = b2.nodes.find((n) => n.id === "res") as ResultNode;
    expect(res.layer_count).toBe(2);
    expect(res.record.layers).toEqual([
      { file: "layers/01.png", z_index: 1, bounding_box: [5, 5, 20, 20] },
      { file: "layers/02.png", z_index: 2, bounding_box: [0, 0, 10, 10] },
    ]);
  });

  it("拆分只返回一张：按普通结果处理，无图层", async () => {
    const { d, files } = deps(ok);
    const b = board(false);
    (b.nodes[1] as TaskNode).layer_decomposition = true;
    const { job: prepared, board: b1 } = await prepareJob(d, { board: b, table: BUILTIN_TABLE, tableSha256: "x", outputRoot: "/root", taskNodeId: "t" });
    const job = await writeJob(d, "/root", prepared);
    const apply = await executeJob(d, { job, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k", newNodeId: "res" });
    const b2 = apply(b1);
    expect((b2.nodes.find((n) => n.id === "res") as ResultNode).layer_count).toBe(0);
    expect([...files.keys()].some((k) => k.includes("layers/"))).toBe(false);
  });
});
