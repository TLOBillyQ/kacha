import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import { buildConfirmItems, imageRefProblems, imageSources, isDirty, isInterrupted, runDispatch, runScope, snapshotOf, withSubmitted, type ConfirmItem } from "./submission";

function prompt(id: string, text: string): BoardNode {
  return { id, type: "prompt", pos: [0, 0], size: [100, 100], extra: {}, text };
}

function reference(id: string, sha = "a".repeat(64)): BoardNode {
  return { id, type: "reference", pos: [0, 0], size: [100, 100], extra: {}, path: `refs/${id}.png`, sha256: sha, display_name: `${id}.png` };
}

function result(id: string): BoardNode {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [100, 100],
    extra: {},
    task_id: `task-${id}`,
    file: "result.png",
    path: `2026-09-16/task-${id}/result.png`,
    layer_count: 0,
    record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "" },
  };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [0, 0],
    size: [100, 100],
    extra: {},
    model: "qwen-image-3.0-pro",
    size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
    ...patch,
  };
}

function edge(from: string, to: string, port: string, patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from: [from, from.startsWith("t") ? "result" : "out"], to: [to, port], source_layer: null, region: null, system: false, extra: {}, ...patch };
}

function board(nodes: BoardNode[], edges: BoardEdge[]): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

/** p 正向、n 负向、r1 参考图、x 结果 → 任务 t。 */
function editBoard(): Board {
  return board(
    [prompt("p", "把图2的帽子戴到图1头上\n第二行"), prompt("n", "模糊"), reference("r1"), result("x"), task("t")],
    [edge("p", "t", "positive"), edge("n", "t", "negative"), edge("r1", "t", "image:0"), edge("x", "t", "image:1")],
  );
}

const submitted = (b: Board, taskId: string, id = "20260916T091500Z-3f9c2a1b") => withSubmitted(b, taskId, id);

/** 提交并产出结果节点（结果节点的 task_id 与 last_submitted 对应）。 */
function executed(b: Board, taskId: string): Board {
  const id = `sub-${taskId}`;
  const out = result(`out-${taskId}`) as Extract<BoardNode, { type: "result" }>;
  return { ...submitted(b, taskId, id), nodes: [...submitted(b, taskId, id).nodes, { ...out, task_id: id }] };
}

describe("脏判据快照", () => {
  it("快照含上游提示词、图片端口集合（来源图层与区域）、模型、尺寸、开关", () => {
    expect(snapshotOf(editBoard(), "t")).toEqual({
      prompt: "把图2的帽子戴到图1头上\n第二行",
      negative_prompt: "模糊",
      model: "qwen-image-3.0-pro",
      size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
      layer_decomposition: false,
      transparent_background: false,
      images: [
        { kind: "reference", path: "refs/r1.png", sha256: "a".repeat(64), region: null },
        { kind: "result", task_id: "task-x", file: "result.png", source_layer: null, region: null },
      ],
    });
  });

  it("提交时写入 last_submitted = task_id + 快照", () => {
    const b = submitted(editBoard(), "t");
    const t = b.nodes.find((n) => n.id === "t") as TaskNode;
    expect(t.last_submitted).toEqual({ task_id: "20260916T091500Z-3f9c2a1b", ...snapshotOf(editBoard(), "t") });
  });

  it("未提交过即脏；刚提交后不脏", () => {
    expect(isDirty(editBoard(), "t")).toBe(true);
    expect(isDirty(submitted(editBoard(), "t"), "t")).toBe(false);
  });

  const mutations: [string, (b: Board) => Board][] = [
    ["上游提示词文本", (b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === "p" ? { ...n, text: "别的" } : n)) as BoardNode[] })],
    ["负向提示词文本", (b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === "n" ? { ...n, text: "" } : n)) as BoardNode[] })],
    ["图片端口顺序", (b) => ({ ...b, edges: b.edges.map((e) => (e.to[1] === "image:0" ? { ...e, to: ["t", "image:1"] } : e.to[1] === "image:1" ? { ...e, to: ["t", "image:0"] } : e)) as BoardEdge[] })],
    ["图片端口减少", (b) => ({ ...b, edges: b.edges.filter((e) => e.to[1] !== "image:1") })],
    ["参考图换了文件", (b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === "r1" ? { ...n, sha256: "b".repeat(64) } : n)) as BoardNode[] })],
    ["区域指示", (b) => ({ ...b, edges: b.edges.map((e) => (e.to[1] === "image:0" ? { ...e, region: { rects: [[0, 0, 1, 1]], render: "bbox_tag" } } : e)) as BoardEdge[] })],
    ["模型", (b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === "t" ? { ...n, model: "qwen-image-3.0" } : n)) as BoardNode[] })],
    ["尺寸", (b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === "t" ? { ...n, size_spec: { ...(n as TaskNode).size_spec, ratio: "16:9" } } : n)) as BoardNode[] })],
    ["开关", (b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === "t" ? { ...n, layer_decomposition: true } : n)) as BoardNode[] })],
  ];
  for (const [name, mutate] of mutations) {
    it(`${name}变化 → 脏`, () => {
      expect(isDirty(mutate(submitted(editBoard(), "t")), "t")).toBe(true);
    });
  }

  it("不相干的变化（位置、别的节点、快照里的未知字段顺序）不算脏", () => {
    const b = submitted(editBoard(), "t");
    const moved: Board = {
      ...b,
      nodes: [
        ...b.nodes.map((n) => (n.id === "t" ? { ...n, pos: [50, 50] as [number, number], last_submitted: { future: 1, ...(n as TaskNode).last_submitted } } : n)),
        prompt("other", "x"),
      ] as BoardNode[],
    };
    expect(isDirty(moved, "t")).toBe(false);
  });
});

describe("运行范围", () => {
  const twoTasks = () =>
    board([prompt("p", "猫"), prompt("q", "狗"), task("t1"), task("t2")], [edge("p", "t1", "positive"), edge("q", "t2", "positive")]);

  it("无选中：整个画板的脏任务，已执行且不脏的跳过", () => {
    expect(runScope(twoTasks(), [])).toEqual(["t1", "t2"]);
    expect(runScope(executed(twoTasks(), "t1"), [])).toEqual(["t2"]);
  });

  it("提交过但没有结果（失败、中断）不算已执行，仍在范围内", () => {
    expect(runScope(submitted(twoTasks(), "t1"), [])).toEqual(["t1", "t2"]);
  });

  it("有选中：只跑选中子图（选中的任务 + 选中节点直接下游的任务）", () => {
    expect(runScope(twoTasks(), ["t2"])).toEqual(["t2"]);
    expect(runScope(twoTasks(), ["p"])).toEqual(["t1"]);
    expect(runScope(twoTasks(), ["p", "t2"])).toEqual(["t1", "t2"]);
    expect(runScope(executed(twoTasks(), "t2"), ["t2"])).toEqual([]);
  });

  it("正在排队或执行的任务不重复提交", () => {
    expect(runScope(twoTasks(), [], new Set(["t1"]))).toEqual(["t2"]);
  });
});

describe("二次确认清单", () => {
  const ctx = { discovery: { source: "none" as const }, missingNodes: new Set<string>() };

  it("每项：模型名 + 提示词首行 + 完整发送文本；可运行的默认勾选", () => {
    const [item] = buildConfirmItems(editBoard(), BUILTIN_TABLE, ["t"], ctx);
    expect(item).toMatchObject({
      taskId: "t",
      modelName: "qwen-image-3.0-pro",
      firstLine: "把图2的帽子戴到图1头上",
      issues: [],
    });
    expect(item.sendText).toBe("本次提供 2 张参考图，按顺序为图1、图2。\n把图2的帽子戴到图1头上\n第二行");
    expect(item.negativeInlined).toBe(false);
    expect(item.negativePrompt).toBe("模糊");
  });

  it("qwen 支持原生负向：发送文本即提示词，负向另列", () => {
    const b = board([prompt("p", "一只橘猫"), prompt("n", "模糊"), task("t")], [edge("p", "t", "positive"), edge("n", "t", "negative")]);
    const [item] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], ctx);
    expect(item.sendText).toBe("一只橘猫");
    expect(item.negativePrompt).toBe("模糊");
    expect(item.negativeInlined).toBe(false);
  });

  it("Seedream 无原生负向：负向拼进发送文本末尾", () => {
    const b = board([prompt("p", "一只橘猫"), prompt("n", "模糊"), task("t", { model: "doubao-seedream-5-0-lite-260128" })], [edge("p", "t", "positive"), edge("n", "t", "negative")]);
    const [item] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], ctx);
    expect(item.sendText).toBe("一只橘猫\n避免出现：模糊");
    expect(item.negativeInlined).toBe(true);
  });

  it("标红任务列出原因：未连正向、提示词为空、请求形态未接入、网关未发现、缺图", () => {
    const b = board(
      [prompt("p", "  "), reference("r1"), task("t1"), task("t2", { model: "doubao-seedream-5-0-pro-260628" }), task("t3")],
      [edge("p", "t2", "positive"), edge("p", "t3", "positive"), edge("r1", "t3", "image:0")],
    );
    const table = structuredClone(BUILTIN_TABLE);
    table.models.find((m) => m.model_id === "doubao-seedream-5-0-pro-260628")!.request_shape = "unknown_shape";
    const items = buildConfirmItems(b, table, ["t1", "t2", "t3"], {
      discovery: { source: "cached", ids: ["qwen-image-3.0"], fetchedAt: "t" },
      missingNodes: new Set(["r1"]),
    });
    expect(items[0].issues).toContain("正向提示词未连接");
    expect(items[1].issues).toEqual(expect.arrayContaining(["正向提示词为空", "模型 Seedream 5.0 pro 的请求形态尚未接入"]));
    expect(items[2].issues).toEqual(expect.arrayContaining(["网关未提供模型 qwen-image-3.0-pro", "图1 图片缺失：r1.png"]));
  });

  it("Seedream 请求形态已接入，不因请求形态标红", () => {
    const b = board([prompt("p", "一只橘猫"), task("t", { model: "doubao-seedream-5-0-lite-260128" })], [edge("p", "t", "positive")]);
    const [item] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], { discovery: { source: "none" }, missingNodes: new Set() });
    expect(item.issues.join()).not.toContain("请求形态");
  });
});

describe("运行分派", () => {
  const confirmItem = (taskId: string, patch: Partial<ConfirmItem> = {}): ConfirmItem => ({
    taskId,
    modelName: "m",
    firstLine: "",
    negativePrompt: "",
    negativeInlined: false,
    sendText: "",
    referenceCount: 0,
    issues: [],
    warnings: [],
    ...patch,
  });

  it("没有需要运行的任务：提示，不弹窗", () => {
    expect(runDispatch([])).toEqual({ kind: "toast", message: "没有需要运行的任务" });
  });

  it("恰好一个干净任务：直接提交", () => {
    expect(runDispatch([confirmItem("t")])).toEqual({ kind: "submit", taskId: "t" });
  });

  it("恰好一个标红任务：提示第一条原因", () => {
    expect(runDispatch([confirmItem("t", { issues: ["正向提示词未连接"] })])).toEqual({ kind: "toast", message: "无法运行：正向提示词未连接" });
  });

  it("恰好一个标红任务、多条原因：追加「等另外 N 项」（N 不含第一条）", () => {
    const item = confirmItem("t", { issues: ["正向提示词未连接", "图1 图片缺失：r1.png"], warnings: ["该模型英文序号未验证"] });
    expect(runDispatch([item])).toEqual({ kind: "toast", message: "无法运行：正向提示词未连接 等另外 1 项" });
  });

  it("恰好一个任务仅有黄色警告：弹确认窗", () => {
    expect(runDispatch([confirmItem("t", { warnings: ["图2 已接线但提示词未引用"] })])).toEqual({ kind: "confirm" });
  });

  it("两个及以上任务：弹确认窗，即使全部干净", () => {
    expect(runDispatch([confirmItem("t1"), confirmItem("t2")])).toEqual({ kind: "confirm" });
    expect(runDispatch([confirmItem("t1", { issues: ["x"] }), confirmItem("t2")])).toEqual({ kind: "confirm" });
  });
});

describe("二次确认：「图N」校验与提示", () => {
  const ctx = { discovery: { source: "none" as const }, missingNodes: new Set<string>() };

  it("引用越界为红（硬阻断），有线未被引用为黄（仅警告）", () => {
    const b = editBoard();
    (b.nodes[0] as { text: string }).text = "把@图3 的颜色用到@图1 上";
    const [item] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], ctx);
    expect(item.issues).toEqual(["提示词引用了图3，但只接了 2 张参考图"]);
    expect(item.warnings).toEqual(["图2 已接线但提示词未引用"]);
    expect(item.sendText).toContain("把图3 的颜色用到图1 上");
  });

  it("英文序号未验证的模型：英文提示词带参考图时提示", () => {
    const b = board(
      [prompt("p", "Put @图1 on a beach"), reference("r1"), task("t", { model: "doubao-seedream-5-0-lite-260128" })],
      [edge("p", "t", "positive"), edge("r1", "t", "image:0")],
    );
    const t = structuredClone(BUILTIN_TABLE);
    t.models.find((m) => m.model_id === "doubao-seedream-5-0-lite-260128")!.reference_phrasing.en_verified = "untested";
    const [item] = buildConfirmItems(b, t, ["t"], ctx);
    expect(item.warnings).toContain("该模型英文序号未验证");
    expect(item.sendText).toBe("This request provides 1 reference image.\nPut Image 1 on a beach");
  });
});

describe("图片来源", () => {
  it("按端口顺序给出绝对路径；结果回灌文件本身", () => {
    expect(imageSources(editBoard(), "t", "/root")).toEqual([
      { nodeId: "r1", label: "r1.png", absPath: "/root/refs/r1.png" },
      { nodeId: "x", label: "result.png", absPath: "/root/2026-09-16/task-x/result.png" },
    ]);
  });
});

describe("已中断：重开时推导", () => {
  it("已提交、画板上没有结果、本次运行期间没经手过的任务", () => {
    const submitted = withSubmitted(board([prompt("p", "猫"), task("t")], [edge("p", "t", "positive")]), "t", "task-x");
    expect(isInterrupted(submitted, "t", new Set())).toBe(true);
    expect(isInterrupted(submitted, "t", new Set(["task-x"]))).toBe(false);
    const withResult = { ...submitted, nodes: [...submitted.nodes, result("x")] };
    expect(isInterrupted(withResult, "t", new Set())).toBe(false);
    expect(isInterrupted(board([task("t")], []), "t", new Set())).toBe(false);
  });
});

describe("区域指示：图N 校验与发送文本", () => {
  const ctx = { discovery: { source: "none" as const }, missingNodes: new Set<string>() };
  const REGION = { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };
  const regionBoard = (text: string) =>
    board([prompt("p", text), reference("r1"), task("t")], [edge("p", "t", "positive"), { ...edge("r1", "t", "image:0"), region: REGION }]);

  it("叠加图紧随原图占序号：固定句算引用、叠加序号豁免黄检、固定句进发送文本", () => {
    const [item] = buildConfirmItems(regionBoard("把@图1 的帽子改成红色"), BUILTIN_TABLE, ["t"], ctx);
    expect(item.issues).toEqual([]);
    expect(item.warnings).toEqual([]);
    expect(item.referenceCount).toBe(2);
    expect(item.sendText).toBe(
      "本次提供 2 张参考图，按顺序为图1、图2。\n把图1 的帽子改成红色\n图2 是图1 的标注版，紫色半透明高亮标出的是要修改的区域。只修改图1 中高亮区域内的内容，高亮区域之外的所有内容保持完全不变，输出图里不要出现任何高亮颜色。",
    );
  });

  it("多区域：跨图连续编号分色，「区域N」改写为颜色指代，越界编号标红", () => {
    const two = { rects: [REGION.rects[0], [0.6, 0.6, 0.9, 0.9] as [number, number, number, number]], render: "highlight_overlay" as const };
    const b = board(
      [prompt("p", "区域1 放狐狸，区域3 放礼物盒，区域2 放路牌"), reference("r1"), reference("r2"), task("t")],
      [edge("p", "t", "positive"), { ...edge("r1", "t", "image:0"), region: two }, { ...edge("r2", "t", "image:1"), region: REGION }],
    );
    const [item] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], ctx);
    // 两张图各带叠加图共 4 张，超出 qwen 上限另行标红；这里只看区域编号本身。
    expect(item.issues.filter((i) => i.includes("区域"))).toEqual([]);
    expect(item.sendText).toContain("紫色区域 放狐狸，洋红色区域 放礼物盒，黄色区域 放路牌");
    expect(item.sendText).toContain("图2 是图1 的标注版，紫色、黄色半透明高亮");
    expect(item.sendText).toContain("图4 是图3 的标注版，洋红色半透明高亮");

    const [over] = buildConfirmItems(regionBoard("区域2 改成红色"), BUILTIN_TABLE, ["t"], ctx);
    expect(over.issues).toContain("提示词引用了区域2，但只框选了 1 个区域");
  });

  it("超过 3 个区域标红；没有框选时「区域N」是普通文字", () => {
    const four = { rects: Array.from({ length: 4 }, () => REGION.rects[0]), render: "highlight_overlay" as const };
    const b = board([prompt("p", "改"), reference("r1"), task("t")], [edge("p", "t", "positive"), { ...edge("r1", "t", "image:0"), region: four }]);
    expect(buildConfirmItems(b, BUILTIN_TABLE, ["t"], ctx)[0].issues).toContain("框选了 4 个区域，最多 3 个");

    const plain = board([prompt("p", "把区域2 的草地加深"), reference("r1"), task("t")], [edge("p", "t", "positive"), edge("r1", "t", "image:0")]);
    const [item] = buildConfirmItems(plain, BUILTIN_TABLE, ["t"], ctx);
    expect(item.issues).toEqual([]);
    expect(item.sendText).toContain("把区域2 的草地加深");
  });

  const twoImages = (text: string, region: typeof REGION | null) =>
    board(
      [prompt("p", text), reference("r1"), reference("r2"), task("t")],
      [edge("p", "t", "positive"), { ...edge("r1", "t", "image:0"), region }, edge("r2", "t", "image:1")],
    );

  it("区域端口不占用户序号：在图1 上框选后，提示词里的图2 仍指第二张用户图，发送时换算为图3", () => {
    const [item] = buildConfirmItems(twoImages("把@图2的少女放入图1的区域1", REGION), BUILTIN_TABLE, ["t"], ctx);
    expect(item.issues).toEqual([]);
    expect(item.warnings).toEqual([]);
    expect(item.referenceCount).toBe(3);
    expect(item.sendText).toBe(
      "本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图3的少女放入图1的紫色区域\n图2 是图1 的标注版，紫色半透明高亮标出的是要修改的区域。只修改图1 中高亮区域内的内容，高亮区域之外的所有内容保持完全不变，输出图里不要出现任何高亮颜色。",
    );

    // 删除区域：恢复原发送顺序，用户序号不变。
    const [plain] = buildConfirmItems(twoImages("把@图2的少女放入图1", null), BUILTIN_TABLE, ["t"], ctx);
    expect(plain.sendText).toBe("本次提供 2 张参考图，按顺序为图1、图2。\n把图2的少女放入图1");
  });

  it("多张图各带区域（共 3 个区域）：@图N、不带 @ 的图N、Image N 都按用户序号换算，地图2 不动", () => {
    const two = { rects: [REGION.rects[0], [0.6, 0.6, 0.9, 0.9] as [number, number, number, number]], render: "highlight_overlay" as const };
    const b = board(
      [prompt("p", "把@图2 放进图1，照着地图2 摆，图3 当背景；Image 3"), reference("r1"), reference("r2"), reference("r3"), task("t", { model: "doubao-seedream-5-0-pro-260628" })],
      [edge("p", "t", "positive"), { ...edge("r1", "t", "image:0"), region: two }, edge("r2", "t", "image:1"), { ...edge("r3", "t", "image:2"), region: REGION }],
    );
    const [item] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], ctx);
    expect(item.referenceCount).toBe(5);
    expect(item.issues).toEqual([]);
    expect(item.sendText).toContain("本次提供 5 张参考图，按顺序为图1、图2、图3、图4、图5。\n把图3 放进图1，照着地图2 摆，图4 当背景；Image 4\n");
    expect(item.sendText).toContain("图2 是图1 的标注版，紫色、黄色半透明高亮");
    expect(item.sendText).toContain("图5 是图4 的标注版，洋红色半透明高亮");
  });

  it("引用越界按用户连线数：两张用户图其中一张带区域时 @图3 标红；未引用的用户图标黄，叠加图从不标黄", () => {
    const [item] = buildConfirmItems(twoImages("把@图3 的颜色用到@图1 上", REGION), BUILTIN_TABLE, ["t"], ctx);
    expect(item.issues).toEqual(["提示词引用了图3，但只接了 2 张参考图"]);
    expect(item.warnings).toEqual(["图2 已接线但提示词未引用"]);
    expect(imageRefProblems(twoImages("改", REGION), BUILTIN_TABLE, "t").unreferenced).toEqual([2]);
  });

  it("区域变更让任务变脏", () => {
    const b = regionBoard("把@图1 的帽子改成红色");
    const done = submitted(b, "t");
    expect(isDirty(done, "t")).toBe(false);
    const moved = {
      ...done,
      edges: done.edges.map((e) => (e.to[1] === "image:0" ? { ...e, region: { rects: [[0.2, 0.2, 0.6, 0.6] as [number, number, number, number]], render: "highlight_overlay" as const } } : e)),
    };
    expect(isDirty(moved, "t")).toBe(true);
  });
});

describe("图层来源", () => {
  it("source_layer 指向 layers/NN 文件，标签点明图层序号", () => {
    const r = result("x") as Extract<BoardNode, { type: "result" }>;
    const withLayers = {
      ...r,
      layer_count: 2,
      record: { ...r.record, layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [] }, { file: "layers/02.jpg", z_index: 2, bounding_box: [] }] },
    };
    const b = board([prompt("p", "@图1 改色"), withLayers, task("t")], [edge("p", "t", "positive"), { ...edge("x", "t", "image:0"), source_layer: 2 }]);
    expect(imageSources(b, "t", "/root")).toEqual([{ nodeId: "x", label: "result.png 图层2", absPath: "/root/2026-09-16/task-x/layers/02.jpg" }]);
    // 快照也记 source_layer：换图层让任务变脏。
    expect(snapshotOf(b, "t")?.images[0]).toMatchObject({ kind: "result", source_layer: 2 });
  });
});

describe("透明背景：二次确认标红", () => {
  it("源图不带透明通道时标红（alpha 由界面注入；缺省未知不拦）", () => {
    const b = board(
      [prompt("p", "抠出@图1 的主体"), reference("r1"), task("t", { transparent_background: true })],
      [edge("p", "t", "positive"), edge("r1", "t", "image:0")],
    );
    const [bad] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], { discovery: { source: "none" }, missingNodes: new Set(), alphaByNode: new Map([["r1", false]]) });
    expect(bad.issues).toContain("该图不带透明通道");
    const [unknown] = buildConfirmItems(b, BUILTIN_TABLE, ["t"], { discovery: { source: "none" }, missingNodes: new Set() });
    expect(unknown.issues).not.toContain("该图不带透明通道");
  });
});
