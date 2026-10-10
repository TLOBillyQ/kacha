import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE, type CapabilityTable } from "./capabilities";
import { imagePortSlots } from "./graph";
import { buildConfirmItems } from "./submission";
import { sendPlanOf, taskView, type TaskFacts } from "./taskView";

const QWEN_PRO = "qwen-image-3.0-pro";

function prompt(id: string, text: string): BoardNode {
  return { id, type: "prompt", pos: [0, 0], size: [100, 100], extra: {}, text };
}

function reference(id: string): BoardNode {
  return { id, type: "reference", pos: [0, 0], size: [100, 100], extra: {}, path: `refs/${id}.png`, sha256: "a".repeat(64), display_name: `${id}.png` };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [0, 0],
    size: [100, 100],
    extra: {},
    model: QWEN_PRO,
    size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
    ...patch,
  };
}

function edge(from: string, to: string, toPort: string): BoardEdge {
  return { from: [from, "out"], to: [to, toPort], source_layer: null, region: null, system: false, extra: {} };
}

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

/** 事实全未知：没读到缺图、没读到透明通道、没发现模型列表。 */
const UNKNOWN: TaskFacts = { missingNodes: new Set(), alphaByNode: new Map(), discovery: { source: "none" } };

const view = (b: Board, table: CapabilityTable = BUILTIN_TABLE, facts: TaskFacts = UNKNOWN) => taskView(b, table, "t", facts)!;
const kinds = (b: Board, table?: CapabilityTable, facts?: TaskFacts) => view(b, table, facts).reasons.map((r) => [r.kind, r.category]);

/** 测试用模型：复制 qwen-image-3.0-pro 后按需改能力。 */
function withModel(patch: (m: CapabilityTable["models"][number]) => void): CapabilityTable {
  const t = structuredClone(BUILTIN_TABLE);
  const m = structuredClone(t.models[0]);
  m.model_id = "test-model";
  patch(m);
  t.models.push(m);
  return t;
}

/** 接好正向提示词的任务，外加若干参考图（按顺序接到图片端口）。 */
function ready(patch: Partial<TaskNode> = {}, refs: string[] = [], text = "@图1 改色"): Board {
  return board(
    [prompt("p", text), ...refs.map(reference), task("t", patch)],
    [edge("p", "t", "positive"), ...refs.map((r, i) => edge(r, "t", `image:${i}`))],
  );
}

describe("坐标区域按当前模型推导", () => {
  const COORD = { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "bbox_tag" as const, coordinate_kind: "bbox" as const };

  /** Flash 上框出的坐标区域，切到别的模型后区域数据原样保留。 */
  const coordBoard = (model: string): Board => {
    const b = ready({ model }, ["r1"], "把区域1改为红色");
    b.edges[1] = { ...b.edges[1], region: COORD };
    return b;
  };

  it("Flash：坐标区域不占叠加名额，发送文本带坐标标签", () => {
    const b = coordBoard("doubao-seedream-5-0-flash-260915");
    const slots = imagePortSlots(b, BUILTIN_TABLE, "t");
    expect(slots.map((s) => s.kind)).toEqual(["image"]);
    expect(slots[0].coordinateRegion).toBeDefined();
    expect(sendPlanOf(b, BUILTIN_TABLE, "t")!.text).toContain("<bbox>");
  });

  it.each([
    ["doubao-seedream-5-0-pro-260628", "坐标通路只接 Flash"],
    ["qwen-image-3.0-pro", "模型不支持坐标标签"],
  ])("切到 %s（%s）：按高亮叠加发送，不出现坐标语法", (model) => {
    const b = coordBoard(model);
    const slots = imagePortSlots(b, BUILTIN_TABLE, "t");
    expect(slots.map((s) => s.kind)).toEqual(["image", "overlay"]);
    expect(slots[0].coordinateRegion).toBeUndefined();
    const text = sendPlanOf(b, BUILTIN_TABLE, "t")!.text;
    expect(text).not.toContain("<bbox>");
    expect(text).not.toContain("<point>");
    expect(text).toContain("标注版");
  });
});

describe("Flash 图层任务视图", () => {
  it("单图自动拆分不需要提示词，普通模式仍需要提示词", () => {
    const b = board([reference("r"), task("t", { model: "doubao-seedream-5-0-flash-260915", layer_decomposition: true })], [edge("r", "t", "image:0")]);
    expect(view(b).reasons).toEqual([]);
    expect(view(b).toggles.layerDecomposition.canEnable).toBe(true);
    (b.nodes[1] as TaskNode).layer_decomposition = false;
    expect(kinds(b)).toContainEqual(["positiveMissing", "notReady"]);
  });
  it("专用尺寸无效或输入数量不是一张时阻断", () => {
    const b = ready({ model: "doubao-seedream-5-0-flash-260915", layer_decomposition: true, layer_size: "bad" as any }, ["a", "b"]);
    expect(view(b).reasons.map((r) => r.kind)).toEqual(expect.arrayContaining(["layerNeedsOneImage", "sizeUnsupported"]));
  });
});

const REGION = { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };

/** 带两个图层记录的结果节点。 */
function layeredResult(id: string): BoardNode {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [100, 100],
    extra: {},
    task_id: `task-${id}`,
    file: "result.png",
    path: `2026-09-16/task-${id}/result.png`,
    layer_count: 2,
    record: {
      model: "m",
      prompt: "",
      negative_prompt: "",
      size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
      submitted_at: "",
      layers: [
        { file: "layers/01.png", z_index: 1, bounding_box: [] },
        { file: "layers/02.png", z_index: 2, bounding_box: [] },
      ],
    },
  };
}

/** 正向提示词 + 结果节点以 source_layer 接入的任务。 */
function layerReady(sourceLayer: number | null): Board {
  return board([prompt("p", "@图1 改色"), layeredResult("x"), task("t")], [edge("p", "t", "positive"), { ...edge("x", "t", "image:0"), source_layer: sourceLayer }]);
}

interface Case {
  name: string;
  board: Board;
  table?: CapabilityTable;
  facts?: TaskFacts;
  expected: [string, "notReady" | "error"][];
}

const CASES: Case[] = [
  { name: "Lite 停用明确提示", board: ready({ model: "doubao-seedream-5-0-lite-260128" }, [], "猫"), expected: [["modelRetired", "error"]] },
  { name: "正向提示词未连接：未就绪", board: board([task("t")]), expected: [["positiveMissing", "notReady"]] },
  { name: "合法任务无原因", board: ready({}, [], "一只橘猫"), expected: [] },
  { name: "编辑工作流低于最少参考图数不算原因（文生图 0 张合法）", board: ready({}, [], "猫"), expected: [] },
  {
    name: "参考图超出模型上限",
    board: ready({ model: "test-model" }, ["r1", "r2"], "@图1 @图2"),
    table: withModel((m) => (m.workflows.image_edit.max_references = 1)),
    expected: [["tooManyReferences", "error"]],
  },
  {
    name: "展开后超上限（叠加图占名额）",
    board: (() => {
      const b = ready({}, ["r1", "r2", "r3"], "@图1 @图2 @图3");
      b.edges[3] = { ...b.edges[3], region: REGION };
      return b;
    })(),
    expected: [["tooManyReferences", "error"]],
  },
  {
    name: "模型不支持图片编辑",
    board: ready({ model: "test-model" }, ["r1"]),
    table: withModel((m) => {
      m.workflows.image_edit.min_references = 0;
      m.workflows.image_edit.max_references = 0;
    }),
    expected: [["imageEditUnsupported", "error"]],
  },
  {
    name: "模型不支持框选修改区域",
    board: (() => {
      const b = ready({ model: "test-model" }, ["r1"]);
      b.edges[1] = { ...b.edges[1], region: REGION };
      return b;
    })(),
    table: withModel((m) => (m.region_hint = { highlight_overlay: "unsupported", marked_image: "unsupported", bbox_tag: "untested" })),
    expected: [["regionUnsupported", "error"]],
  },
  {
    name: "框选超过区域上限",
    board: (() => {
      const b = ready({}, ["r1"], "改");
      b.edges[1] = { ...b.edges[1], region: { ...REGION, rects: Array.from({ length: 4 }, () => REGION.rects[0]) } };
      return b;
    })(),
    expected: [["tooManyRegions", "error"]],
  },
  {
    name: "模型不支持负向提示词",
    board: board([prompt("p", "猫"), prompt("n", "模糊"), task("t", { model: "doubao-seedream-5-0-pro-260628", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null } })], [
      edge("p", "t", "positive"),
      edge("n", "t", "negative"),
    ]),
    expected: [["negativeUnsupported", "error"]],
  },
  {
    name: "分辨率档不在模型尺寸表内",
    board: ready({ size_spec: { tier: "4K", ratio: "1:1", width: null, height: null } }, [], "猫"),
    expected: [["sizeUnsupported", "error"]],
  },
  {
    name: "手填的宽高比越界",
    board: ready({ size_spec: { tier: "2K", ratio: "12:1", width: null, height: null } }, [], "猫"),
    expected: [["sizeUnsupported", "error"]],
  },
  {
    name: "模型不支持拆分图层",
    board: ready({ layer_decomposition: true }, [], "猫"),
    expected: [["layerUnsupported", "error"]],
  },
  { name: "模型不在能力表内", board: ready({ model: "nope" }, [], "猫"), expected: [["modelUnknown", "error"]] },
  {
    name: "模型未上架",
    board: ready({ model: "doubao-seedream-5-0-pro-260628", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null } }, [], "猫"),
    table: (() => {
      const t = structuredClone(BUILTIN_TABLE);
      t.models.find((m) => m.model_id === "doubao-seedream-5-0-pro-260628")!.tier = null;
      return t;
    })(),
    expected: [["modelUnshelved", "error"]],
  },
  { name: "正向提示词为空：未就绪", board: ready({}, [], "  \n "), expected: [["positiveEmpty", "notReady"]] },
  {
    name: "请求形态尚未接入：错误",
    board: ready({ model: "test-model" }, [], "猫"),
    table: withModel((m) => (m.request_shape = "unknown_shape")),
    expected: [["requestShapeMissing", "error"]],
  },
  {
    name: "已发现模型列表但网关未提供",
    board: ready({}, [], "猫"),
    facts: { ...UNKNOWN, discovery: { source: "cached", ids: ["qwen-image-3.0"], fetchedAt: "t" } },
    expected: [["modelNotFromGateway", "error"]],
  },
  { name: "提示词引用的图N 越界", board: ready({}, ["r1"], "把@图3 用到@图1 上"), expected: [["referenceOutOfRange", "error"]] },
  {
    name: "提示词引用的区域N 越界",
    board: (() => {
      const b = ready({}, ["r1"], "@图1 的区域2 改成红色");
      b.edges[1] = { ...b.edges[1], region: REGION };
      return b;
    })(),
    expected: [["referenceOutOfRange", "error"]],
  },
  { name: "参考图文件缺失", board: ready({}, ["r1"]), facts: { ...UNKNOWN, missingNodes: new Set(["r1"]) }, expected: [["imageMissing", "error"]] },
  { name: "缺图未知（没读到）不拦", board: ready({}, ["r1"]), expected: [] },
  { name: "来源图层身份无效（越界）：错误", board: layerReady(3), expected: [["sourceLayerInvalid", "error"]] },
  { name: "来源图层身份无效（非整数）：错误", board: layerReady(1.5), expected: [["sourceLayerInvalid", "error"]] },
  { name: "来源图层文件缺失：缺图原因点明图层", board: layerReady(2), facts: { ...UNKNOWN, missingNodes: new Set(["x:layer:2"]) }, expected: [["imageMissing", "error"]] },
  { name: "来源图层缺失不株连底图：底图线无原因", board: (() => { const b = layerReady(2); b.edges.push({ from: ["x", "out"], to: ["t", "image:1"], source_layer: null, region: null, system: false, extra: {} }); return b; })(), facts: { ...UNKNOWN, missingNodes: new Set(["x:layer:2"]) }, expected: [["imageMissing", "error"]] },
  { name: "合法来源图层：无原因", board: layerReady(2), expected: [] },
  { name: "底图缺失不株连图层线", board: layerReady(2), facts: { ...UNKNOWN, missingNodes: new Set(["x"]) }, expected: [] },
  { name: "模型不支持透明背景", board: ready({ transparent_background: true }, [], "猫"), expected: [["transparentUnsupported", "error"]] },
  { name: "透明背景没有恰好一条图片线", board: seedreamPro({ transparent_background: true }, []), expected: [["transparentNeedsOneImage", "error"]] },
  {
    name: "透明背景的源图不带透明通道",
    board: seedreamPro({ transparent_background: true }, ["r1"]),
    facts: { ...UNKNOWN, alphaByNode: new Map([["r1", false]]) },
    expected: [["transparentNoAlpha", "error"]],
  },
  { name: "透明通道未知明确阻断", board: seedreamPro({ transparent_background: true }, ["r1"]), expected: [["transparentNoAlpha", "error"]] },
];

/** 支持透明背景的 Seedream 5.0 pro（2K · 1:1），提示词引用全部参考图。 */
function seedreamPro(patch: Partial<TaskNode>, refs: string[]): Board {
  const text = refs.length ? refs.map((_, i) => `@图${i + 1}`).join(" ") : "猫";
  return ready({ model: "doubao-seedream-5-0-pro-260628", size_spec: { tier: "2K", ratio: "1:1", width: null, height: null }, ...patch }, refs, text);
}

describe("不可运行原因：种类与类别", () => {
  it.each(CASES)("$name", ({ board: b, table, facts, expected }) => {
    expect(kinds(b, table, facts)).toEqual(expected);
  });
});

describe("不可运行原因：文案", () => {
  const texts = (b: Board, table?: CapabilityTable) => view(b, table).reasons.map((r) => r.text);

  it("尺寸：档位不在尺寸表 / 宽高比越界给出范围 / 同一宽高比在支持的模型上可运行", () => {
    expect(texts(ready({ size_spec: { tier: "4K", ratio: "1:1", width: null, height: null } }, [], "猫"))).toEqual(["生成尺寸 4K · 1:1 不在模型尺寸表内"]);
    const size_spec = { tier: "2K", ratio: "12:1", width: null, height: null };
    expect(texts(ready({ size_spec }, [], "猫"))).toEqual(["宽高比 12:1 超出模型范围 1:8–8:1"]);
    expect(texts(ready({ size_spec, model: "doubao-seedream-5-0-pro-260628" }, [], "猫"))).toEqual([]);
  });

  it("名额与模型：超上限（叠加图占名额）/ 不在能力表 / 未上架", () => {
    const t = withModel((m) => (m.workflows.image_edit.max_references = 1));
    expect(texts(ready({ model: "test-model" }, ["r1", "r2"], "@图1 @图2"), t)).toEqual(["参考图 2 张超出模型上限 1 张"]);
    const b = ready({}, ["r1", "r2", "r3"], "@图1 @图2 @图3");
    b.edges[3] = { ...b.edges[3], region: REGION };
    expect(texts(b)).toContain("参考图 4 张超出模型上限 3 张");
    expect(texts(ready({ model: "nope" }, [], "猫"))).toEqual(["模型 nope 不在能力表内"]);
  });

  it("换模型后开关不支持：原因按拆分图层、透明背景的顺序，开关与连线保留", () => {
    const b = ready({ layer_decomposition: true, transparent_background: true }, [], "猫");
    expect(texts(b)).toEqual(["模型不支持拆分图层", "模型不支持透明背景"]);
    expect(b.nodes.find((n) => n.id === "t")).toMatchObject({ layer_decomposition: true, transparent_background: true });
  });

  it("带区域的线：叠加图不算未引用，未引用只报用户序号", () => {
    const b = ready({}, ["r1", "r2"], "@图1 的区域1 改红");
    b.edges[1] = { ...b.edges[1], region: REGION };
    expect(view(b).unreferenced).toEqual([2]);
  });

  it("来源图层：无效身份与缺图的文案点明图层", () => {
    expect(texts(layerReady(3))).toEqual(["图1 来源图层无效：result.png 图层3"]);
    expect(view(layerReady(2), BUILTIN_TABLE, { ...UNKNOWN, missingNodes: new Set(["x:layer:2"]) }).reasons.map((r) => r.text)).toEqual(["图1 图片缺失：result.png 图层2"]);
  });
});

describe("节点标红 ≡ 运行被拦：二次确认与任务视图同一份", () => {
  it.each(CASES)("$name", ({ board: b, table = BUILTIN_TABLE, facts = UNKNOWN }) => {
    const [item] = buildConfirmItems(b, table, ["t"], facts);
    const v = view(b, table, facts);
    expect(item.reasons).toEqual(v.reasons);
    expect(item.warnings).toEqual(v.warnings);
  });
});

describe("任务开关的可用性", () => {
  const TRANSPARENT = new Set(["transparentUnsupported", "transparentNeedsOneImage", "transparentNoAlpha"]);
  const alphaOf = (a: boolean | undefined): TaskFacts => ({ ...UNKNOWN, alphaByNode: a === undefined ? new Map() : new Map([["r1", a]]) });
  const setups = [
    { name: "不支持透明背景的模型", board: (on: boolean) => ready({ transparent_background: on }, ["r1"]) },
    ...[[], ["r1"], ["r1", "r2"]].map((refs) => ({ name: `${refs.length} 条图片线`, board: (on: boolean) => seedreamPro({ transparent_background: on }, refs) })),
  ];
  const cases = setups.flatMap((s) => [true, false, undefined].map((alpha) => ({ ...s, alpha, label: `${s.name}，透明通道 ${alpha ?? "未知"}` })));

  it.each(cases)("透明背景：可开为假 ⇔ 打开后必有对应原因（$label）", ({ board: b, alpha }) => {
    const off = view(b(false), BUILTIN_TABLE, alphaOf(alpha));
    const on = view(b(true), BUILTIN_TABLE, alphaOf(alpha));
    expect(off.reasons.some((r) => TRANSPARENT.has(r.kind))).toBe(false);
    expect(on.reasons.some((r) => TRANSPARENT.has(r.kind))).toBe(!off.toggles.transparentBackground.canEnable);
    expect(off.toggles.transparentBackground.hint === "").toBe(off.toggles.transparentBackground.canEnable);
  });

  it("透明背景提示：不是恰好一条线 / 源图不带透明通道 / 可开", () => {
    expect(view(seedreamPro({}, ["r1", "r2"])).toggles.transparentBackground).toEqual({ canEnable: false, hint: "需要恰好一条图片线" });
    expect(view(seedreamPro({}, ["r1"]), BUILTIN_TABLE, alphaOf(false)).toggles.transparentBackground).toEqual({ canEnable: false, hint: "该图不带透明通道" });
    expect(view(seedreamPro({}, ["r1"]), BUILTIN_TABLE, alphaOf(true)).toggles.transparentBackground).toEqual({ canEnable: true, hint: "" });
  });

  it("拆分图层：模型不支持时不可开，打开即产生原因", () => {
    const off = view(ready({}, [], "猫"));
    expect(off.toggles.layerDecomposition.canEnable).toBe(false);
    expect(kinds(ready({ layer_decomposition: true }, [], "猫"))).toEqual([["layerUnsupported", "error"]]);
    const t = withModel((m) => (m.workflows.text_to_image.layer_decomposition = "supported"));
    expect(view(ready({ model: "test-model" }, [], "猫"), t).toggles.layerDecomposition).toEqual({ canEnable: true, hint: "" });
  });
});

describe("模型标签", () => {
  const unshelved = structuredClone(BUILTIN_TABLE);
  unshelved.models.find((m) => m.model_id === QWEN_PRO)!.tier = null;
  const gateway: TaskFacts = { ...UNKNOWN, discovery: { source: "live", ids: ["qwen-image-3.0"], fetchedAt: "t" } };

  it.each([
    { name: "正常", model: QWEN_PRO, table: BUILTIN_TABLE, facts: UNKNOWN, expected: { state: "ok", label: "qwen-image-3.0-pro" } },
    { name: "未知模型", model: "nope", table: BUILTIN_TABLE, facts: UNKNOWN, expected: { state: "unknown", label: "nope（未知模型）" } },
    { name: "网关未提供", model: QWEN_PRO, table: BUILTIN_TABLE, facts: gateway, expected: { state: "notFromGateway", label: "qwen-image-3.0-pro（网关未提供）" } },
    { name: "未上架", model: QWEN_PRO, table: unshelved, facts: UNKNOWN, expected: { state: "unshelved", label: "qwen-image-3.0-pro（未上架）" } },
  ])("$name", ({ model, table, facts, expected }) => {
    expect(view(ready({ model }, [], "猫"), table, facts).model).toEqual(expected);
  });
});

describe("生成尺寸与宽高比", () => {
  const spec = (tier: string | null, ratio: string | null) => ({ size_spec: { tier, ratio, width: null, height: null } });

  it("生成尺寸按模型尺寸表换算", () => {
    expect(view(ready(spec("2K", "16:9"), [], "猫")).size).toEqual({ width: 1920, height: 1080 });
  });

  it("手动宽高比在当前档位下发不出去：ratioUnsupported，生成尺寸为空", () => {
    const v = view(ready(spec("2K", "12:1"), [], "猫"));
    expect(v.size).toBeNull();
    expect(v.ratioUnsupported).toBe(true);
  });

  it("档位本身不在尺寸表内时不归宽高比管", () => {
    const v = view(ready(spec("4K", "1:1"), [], "猫"));
    expect(v.size).toBeNull();
    expect(v.ratioUnsupported).toBe(false);
  });

  it("模型缺失：没有生成尺寸", () => {
    expect(view(ready({ model: "nope" }, [], "猫")).size).toBeNull();
  });
});

describe("警告与未引用序号", () => {
  it("有线未被引用：黄色警告，给出未引用的用户序号", () => {
    const v = view(ready({}, ["r1", "r2"], "把@图1 调亮"));
    expect(v.warnings).toEqual(["图2 已连接，尚未说明它的用途。可在提示词中点击参考图插入引用，并描述如何使用它。"]);
    expect(v.unreferenced).toEqual([2]);
    expect(v.reasons).toEqual([]);
  });

  it("英文提示词 + 参考图 + 英文序号未验证的模型：黄色警告，不阻断", () => {
    const flash = "doubao-seedream-5-0-flash-260915";
    const t = structuredClone(BUILTIN_TABLE);
    t.models.find((m) => m.model_id === flash)!.reference_phrasing.en_verified = "untested";
    const patch = { model: flash, size_spec: { tier: "2K", ratio: "1:1", width: null, height: null } };
    const v = view(ready(patch, ["r1"], "Put @图1 on a beach"), t);
    expect(v.warnings).toEqual(["该模型英文序号未验证"]);
    expect(v.reasons).toEqual([]);
    expect(view(ready(patch, [], "a cat"), t).warnings).toEqual([]);
  });
});
