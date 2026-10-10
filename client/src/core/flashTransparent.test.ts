import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE, findModel } from "./capabilities";
import { buildGenerationRequest, flashFeatureImplemented } from "./gateway";
import { taskView } from "./taskView";
import { board } from "./testing/runnerHarness";
import { collectRunFacts } from "./submission";
import type { TaskNode } from "./board";
import { createRunner } from "./runner";
import { memoryTaskFs } from "./testing/memoryTaskFs";
import { settle } from "./testing/runnerHarness";
import { png as makePng } from "../../e2e/app";
import type { RunDeps } from "./run";
import { editBoard } from "./edit";

function runnerSetup(alpha: boolean | undefined = true) {
  const bytes = Uint8Array.from(Buffer.from(makePng(32, 32, { alpha: true }), "base64"));
  const fs = memoryTaskFs([["/root/refs/cat.png", bytes]]);
  const bodies: Record<string, any>[] = [];
  let b = board(["t1"], true);
  const t = b.nodes.find(n => n.type === "task") as TaskNode;
  t.model = "doubao-seedream-5-0-flash-260915";
  t.transparent_background = true;
  let tick = 0;
  let badOutput = false;
  let httpStatus = 200;
  let downloadFails = false;
  const opaqueBytes = Uint8Array.from(Buffer.from(makePng(32, 32), "base64"));
  const deps: RunDeps = { ...fs, now: () => new Date(Date.UTC(2026, 9, 10, 0, 0, tick++)), schedule: () => () => {},
    composeOverlay: async () => bytes,
    imageCodec: { decode: async data => ({ width: 32, height: 32, hasAlpha: () => data[25] === 2 ? false : alpha as boolean, encode: async () => bytes, close: () => {} }) },
    fetch: async (_url, init) => {
      if (init.method === "GET") return { status: 403, headers: { get: () => null }, text: async () => "denied", arrayBuffer: async () => bytes.slice().buffer };
      bodies.push(JSON.parse(init.body!));
      return { status: httpStatus, headers: { get: () => null }, text: async () => JSON.stringify({ data: [downloadFails ? { url: "https://result.test/transparent.png" } : { b64_json: Buffer.from(badOutput ? opaqueBytes : bytes).toString("base64") }] }), arrayBuffer: async () => bytes.slice().buffer };
    } };
  const runner = createRunner({ deps, apply: (_key, change) => { b = editBoard(b, change, { table: BUILTIN_TABLE, discovery: { source: "none" }, locked: new Set(), imageSize: () => undefined, newId: () => "result" }).board; }, log: () => {}, concurrency: 1 });
  const target = { boardKey: "A", boardFile: "A", table: BUILTIN_TABLE, outputRoot: "/root", baseUrl: "http://gw", apiKey: "k" };
  return { fs, bytes, bodies, runner, target, board: () => b, unknownAlpha: () => { alpha = undefined; }, opaqueOutput: () => { badOutput = true; }, reject: () => { httpStatus = 400; }, failDownload: () => { downloadFails = true; } };
}

it("公开运行器提交保存透明参数与快照，重新生成沿用历史 PNG/透明而非节点当前 JPEG/关闭状态", async () => {
  const h = runnerSetup();
  expect(await h.runner.submit(h.target, h.board(), ["t1"])).toEqual([]);
  await settle();
  expect(h.bodies).toHaveLength(1);
  expect(h.bodies[0]).toMatchObject({ background: "transparent", output_format: "png" });
  const records = [...h.fs.files.entries()].filter(([path]) => path.endsWith("/task.json"));
  expect(JSON.parse(new TextDecoder().decode(records[0][1]))).toMatchObject({ transparent_background: true, references: [{ source: { kind: "reference" } }] });
  const task = h.board().nodes.find(n => n.type === "task") as TaskNode;
  task.transparent_background = false;
  task.output_options = { output_format: "jpeg", response_format: "url", watermark: false };
  h.fs.files.delete("/root/refs/cat.png");
  await h.runner.regenerate(h.target, h.board(), "t1");
  await settle();
  expect(h.bodies).toHaveLength(2);
  expect(h.bodies[1]).toMatchObject({ background: "transparent", output_format: "png", image: h.bodies[0].image });
  expect([...h.fs.files.keys()].filter(p => p.endsWith("/result.png"))).toHaveLength(2);
});

it.each(["reject", "failDownload"] as const)("透明任务 %s 明确失败，生成只发一次", async mode => {
  const h = runnerSetup();
  h[mode]();
  await h.runner.submit(h.target, h.board(), ["t1"]);
  await settle();
  expect(h.runner.getSnapshot().board("A").statuses.get("t1")).toEqual({ kind: "failed", label: "网关拒绝" });
  expect(h.bodies).toHaveLength(1);
  expect([...h.fs.files.keys()].some(p => p.endsWith("/result.png"))).toBe(false);
});

it("透明结果若实际不带 alpha，不保存或伪造成功", async () => {
  const h = runnerSetup();
  h.opaqueOutput();
  await h.runner.submit(h.target, h.board(), ["t1"]);
  await settle();
  expect(h.runner.getSnapshot().board("A").statuses.get("t1")).toEqual({ kind: "failed", label: "响应无效" });
  expect([...h.fs.files.keys()].some(p => p.endsWith("/result.png"))).toBe(false);
});

it("区域指示把唯一 alpha 输入展开成原图+叠加图后，运行前以同一理由阻断：零请求零写入", async () => {
  // 组合验收（区域 × 透明）：叠加展开发生在发送计划，透明要求恰好一张实际参考图，
  // 阻断理由必须与节点控件展示的 transparentNeedsOneImage 一致。
  const h = runnerSetup();
  const b = h.board();
  b.edges[1].region = { rects: [[0, 0, 0.5, 0.5]], render: "highlight_overlay" };
  expect(await h.runner.submit(h.target, b, ["t1"])).toContain("透明背景需要恰好一张实际参考图");
  await settle();
  expect(h.bodies).toEqual([]);
  expect([...h.fs.files.keys()].some(p => p.endsWith("/task.json"))).toBe(false);
});

it.each([false, undefined])("公开运行器对实际快照 alpha=%s 拒绝发送", async alpha => {
  const h = runnerSetup(alpha);
  if (alpha === undefined) {
    // 明确模拟未知，不让默认参数把 unknown 变成 true。
    h.unknownAlpha();
  }
  expect(await h.runner.submit(h.target, h.board(), ["t1"])).toHaveLength(1);
  await settle();
  expect(h.bodies).toEqual([]);
  expect([...h.fs.files.keys()].some(p => p.endsWith("/task.json"))).toBe(false);
});

const model = findModel(BUILTIN_TABLE, "doubao-seedream-5-0-flash-260915")!;
const png = { mediaType: "image/png", bytes: new Uint8Array([1]), hasAlpha: true };
const input = { model, text: "改色", nativeNegativePrompt: null, size: { width: 1024, height: 1024 }, references: [png], transparentBackground: true };

it("来源图层探测所选文件并与底图 alpha 事实分开", async () => {
  const b = board(["t1"], true);
  const t = b.nodes.find(n => n.type === "task") as TaskNode;
  t.model = model.model_id;
  t.transparent_background = true;
  b.nodes = b.nodes.filter(n => n.id !== "r");
  b.nodes.push({ id: "r", type: "result", pos: [0, 0], size: [100, 100], extra: {}, task_id: "20261010T000000000-abcdefgh", file: "result.png", path: "2026-10-10/id/result.png", layer_count: 1, record: { model: model.model_id, prompt: "", negative_prompt: "", size_spec: t.size_spec, submitted_at: "", layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [0, 0, 32, 32] }] } });
  b.edges[1].source_layer = 1;
  const paths: string[] = [];
  const facts = await collectRunFacts({ inspectImage: async path => { paths.push(path); return { has_alpha: true }; } }, b, ["t1"], "/root");
  expect(paths).toEqual(["/root/2026-10-10/id/layers/01.png"]);
  expect(facts.alphaByNode.get("r:layer:1")).toBe(true);
  expect(taskView(b, BUILTIN_TABLE, "t1", { ...facts, discovery: { source: "none" } })!.reasons).toEqual([]);
  expect(taskView(b, BUILTIN_TABLE, "t1", { ...facts, alphaByNode: new Map([["r", true]]), discovery: { source: "none" } })!.reasons.map(r => r.kind)).toContain("transparentNoAlpha");
});

it("Flash 透明与图层路径共同开放", () => {
  expect(flashFeatureImplemented(model, "transparent")).toBe(true);
  expect(flashFeatureImplemented(model, "layers")).toBe(true);
});
it.each([
  { name: "无图", references: [] },
  { name: "多图", references: [png, png] },
  { name: "无 alpha", references: [{ ...png, hasAlpha: false }] },
  { name: "未知 alpha", references: [{ mediaType: "image/png", bytes: png.bytes }] },
  { name: "JPEG 输出", references: [png], outputOptions: { output_format: "jpeg" as const, response_format: "url" as const, watermark: false } },
])("网关发送边界拒绝 $name 的透明组合", patch => {
  expect(() => buildGenerationRequest({ ...input, ...patch })).toThrow();
});

it("一张已确认 alpha 的 PNG 输出编辑发送 transparent，关闭默认 opaque", () => {
  expect(buildGenerationRequest(input).body).toMatchObject({ background: "transparent", output_format: "png", image: ["data:image/png;base64,AQ=="] });
  expect(buildGenerationRequest({ ...input, transparentBackground: false }).body).not.toHaveProperty("background");
});

describe("透明背景控件和运行规则一致", () => {
  it("只在一张已确认 alpha 的实际输入及 PNG 输出时允许启用", () => {
    const b = board(["t1"], true);
    const t = b.nodes.find(n => n.type === "task") as TaskNode;
    t.model = model.model_id;
    const facts = { discovery: { source: "none" as const }, missingNodes: new Set<string>(), alphaByNode: new Map([["r", true]]) };
    expect(taskView(b, BUILTIN_TABLE, "t1", facts)!.toggles.transparentBackground.canEnable).toBe(true);
    expect(taskView(b, BUILTIN_TABLE, "t1", { ...facts, alphaByNode: new Map() })!.toggles.transparentBackground.canEnable).toBe(false);
    t.output_options = { output_format: "jpeg", response_format: "url", watermark: false };
    expect(taskView(b, BUILTIN_TABLE, "t1", facts)!.toggles.transparentBackground.canEnable).toBe(false);
    t.transparent_background = true;
    expect(taskView(b, BUILTIN_TABLE, "t1", facts)!.reasons.map(r => r.kind)).toContain("transparentNeedsPng");
    t.output_options.output_format = "png";
    b.edges[1].region = { rects: [[0, 0, 0.5, 0.5]], render: "highlight_overlay" };
    expect(taskView(b, BUILTIN_TABLE, "t1", facts)!.reasons.map(r => r.kind)).toContain("transparentNeedsOneImage");
  });
});
