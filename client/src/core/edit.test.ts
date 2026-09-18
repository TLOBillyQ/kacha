import { describe, expect, it } from "vitest";
import { newBoard, type Board, type BoardEdge, type BoardNode, type PromptNode, type ReferenceNode, type ResultNode, type TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import { changeClass, continueEditingChange, editBoard, type BoardChange, type EditEnv } from "./edit";
import { cardDropConnection } from "./dragCreate";
import { MERGE_PAUSE_MS } from "./history";
import { copySelection, LOCKED_HINT, PASTE_OFFSET } from "./iterate";
import type { RunResult } from "./layout";
import type { Discovery } from "./settings";
import { autoSizeSpec, type SizeSpec } from "./size";

const QWEN = "qwen-image-3.0";
const PRO = "doubao-seedream-5-0-pro-260628";
const ruleOf = (id: string) => BUILTIN_TABLE.models.find((m) => m.model_id === id)!.workflows.image_edit.size_rule;
const NONE: Discovery = { source: "none" };
const MANUAL: SizeSpec = { tier: "2K", ratio: "1:1", width: null, height: null };

function reference(id: string, pos: [number, number] = [0, 0]): ReferenceNode {
  return { id, type: "reference", pos, size: [200, 200], extra: {}, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png` };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return { id, type: "task", pos: [400, 0], size: [280, 260], extra: {}, model: PRO, size_spec: MANUAL, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null, ...patch };
}

function prompt(id: string, text = "猫", pos: [number, number] = [0, 300]): PromptNode {
  return { id, type: "prompt", pos, size: [240, 140], extra: {}, text };
}

function result(id: string, taskId: string): ResultNode {
  return {
    id,
    type: "result",
    pos: [800, 0],
    size: [240, 240],
    extra: {},
    task_id: `${taskId}-run`,
    file: `${id}.png`,
    path: `${id}.png`,
    layer_count: 0,
    record: { model: PRO, prompt: "猫", negative_prompt: "", size_spec: MANUAL, submitted_at: "2026-09-16T09:15:00.000Z" },
  };
}

function edge(from: string, to: string, toPort: string, patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from: [from, "out"], to: [to, toPort], source_layer: null, region: null, system: false, extra: {}, ...patch };
}

const systemEdge = (taskId: string, resultId: string): BoardEdge => ({ from: [taskId, "result"], to: [resultId, "in"], source_layer: null, region: null, system: true, extra: {} });

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return { ...newBoard(), nodes, edges };
}

const DIMS: Record<string, [number, number]> = { "wide.png": [1920, 1080], "tall.png": [900, 1200] };

function env(patch: Partial<EditEnv> = {}): EditEnv {
  let n = 0;
  return { table: BUILTIN_TABLE, discovery: NONE, locked: new Set(), imageSize: (path) => DIMS[path], newId: () => `n${++n}`, ...patch };
}

const node = <T extends BoardNode>(b: Board, id: string) => b.nodes.find((n) => n.id === id) as T;
const taskOf = (b: Board, id = "t") => node<TaskNode>(b, id);
const locked = (...ids: string[]) => env({ locked: new Set(ids) });

describe("变更类别由种类决定", () => {
  it("视图 / 系统 / 用户", () => {
    expect(changeClass({ kind: "viewport", viewport: { x: 0, y: 0, zoom: 1 } })).toBe("view");
    expect(changeClass({ kind: "lastModel", model: PRO })).toBe("view");
    expect(changeClass({ kind: "title", title: "x" })).toBe("view");
    expect(changeClass({ kind: "submitted", taskId: "t", lastSubmitted: {} })).toBe("system");
    expect(changeClass({ kind: "syncAutoRatios" })).toBe("system");
    expect(changeClass({ kind: "move", moves: [], drag: null })).toBe("user");
  });
});

describe("用户变更：结果画板、撤销步、建议选中", () => {
  it("移动：取整；拖动中按拖动编号归并，Alt + 拖显示复制", () => {
    const b = board([reference("a"), reference("b")]);
    const r = editBoard(b, { kind: "move", moves: [["a", [10.4, 20.6]]], drag: null }, env());
    expect(node<ReferenceNode>(r.board, "a").pos).toEqual([10, 21]);
    expect(r.step).toEqual({ label: "移动 1 个节点" });
    const dragging = editBoard(b, { kind: "move", moves: [["a", [5, 5]], ["b", [6, 6]]], drag: { id: 3, copies: 0 } }, env());
    expect(dragging.step).toEqual({ label: "移动 2 个节点", merge: { key: "drag:3" } });
    const copying = editBoard(b, { kind: "move", moves: [["a", [5, 5]]], drag: { id: 3, copies: 1 } }, env());
    expect(copying.step).toEqual({ label: "复制 1 个节点", merge: { key: "drag:3" } });
  });

  it("位置没变不构成撤销步，返回同一画板", () => {
    const b = board([reference("a")]);
    const r = editBoard(b, { kind: "move", moves: [["a", [0.2, 0]]], drag: null }, env());
    expect(r.board).toBe(b);
    expect(r.step).toBeNull();
  });

  it("缩放：按显示宽高重算尺寸，从左上角缩放带位置", () => {
    const b = board([reference("a")]);
    const r = editBoard(b, { kind: "resize", resize: 2, boxes: [{ id: "a", width: 300, height: 150, pos: [-10, 4] }] }, env());
    expect(node<ReferenceNode>(r.board, "a")).toMatchObject({ pos: [-10, 4], size: [300, 150] });
    expect(r.step).toEqual({ label: "缩放 1 个节点", merge: { key: "resize:2" } });
  });

  it("微移：归并键与选中顺序无关，停顿窗口合并", () => {
    const b = board([reference("a"), reference("b")]);
    const r = editBoard(b, { kind: "nudge", ids: ["b", "a"], delta: [1, 0] }, env());
    expect(node<ReferenceNode>(r.board, "b").pos).toEqual([1, 0]);
    expect(r.step).toEqual({ label: "微移 2 个节点", merge: { key: "nudge:a,b", windowMs: MERGE_PAUSE_MS } });
  });

  it("复制（Ctrl+J）：错开 PASTE_OFFSET，选中副本；Alt + 拖叠在原处并与这次拖动合为一步", () => {
    const b = board([reference("a")]);
    const r = editBoard(b, { kind: "duplicate", ids: ["a"], drag: null }, env());
    expect(r.selection).toEqual(["n1"]);
    expect(node<ReferenceNode>(r.board, "n1").pos).toEqual([PASTE_OFFSET, PASTE_OFFSET]);
    expect(r.step).toEqual({ label: "复制 1 个节点" });
    const alt = editBoard(b, { kind: "duplicate", ids: ["a"], drag: { id: 7, copies: 1 } }, env());
    expect(node<ReferenceNode>(alt.board, "n1").pos).toEqual([0, 0]);
    expect(alt.step).toEqual({ label: "复制 1 个节点", merge: { key: "drag:7" } });
    expect(alt.selection).toBeUndefined();
  });

  it("Alt + 拖松手：原节点回起点，副本落在松手处并被选中", () => {
    const b = board([reference("a", [100, 100]), reference("n1", [0, 0])]);
    const r = editBoard(b, { kind: "settleDrag", drag: { id: 7, copies: 1 }, pairs: [["a", "n1"]], starts: [["a", [0, 0]]] }, env());
    expect(node<ReferenceNode>(r.board, "a").pos).toEqual([0, 0]);
    expect(node<ReferenceNode>(r.board, "n1").pos).toEqual([100, 100]);
    expect(r.selection).toEqual(["n1"]);
    expect(r.step).toEqual({ label: "复制 1 个节点", merge: { key: "drag:7" } });
  });

  it("粘贴：新 id、选中新节点；空剪贴板不构成步", () => {
    const b = board([reference("a"), task("t")], [edge("a", "t", "image:0")]);
    const r = editBoard(b, { kind: "paste", clip: copySelection(b, ["a", "t"]) }, env());
    expect(r.selection).toEqual(["n1", "n2"]);
    expect(r.board.edges.some((e) => e.from[0] === "n1" && e.to[0] === "n2")).toBe(true);
    expect(r.step).toEqual({ label: "粘贴 2 个节点" });
    expect(editBoard(b, { kind: "paste", clip: { nodes: [], edges: [] } }, env()).step).toBeNull();
  });

  it("新建提示词 / 生成任务：选中新节点；从提示词拖出的任务接正向端口", () => {
    const b = board([prompt("p")]);
    const p = editBoard(b, { kind: "newPrompt", at: [10.2, 20] }, env());
    expect(node<PromptNode>(p.board, "n1")).toMatchObject({ type: "prompt", pos: [10, 20], text: "" });
    expect(p).toMatchObject({ step: { label: "新建提示词" }, selection: ["n1"] });
    const t = editBoard(b, { kind: "newTask", at: [500, 0], promptId: "p" }, env());
    expect(taskOf(t.board, "n1").type).toBe("task");
    expect(t.board.edges).toEqual([expect.objectContaining({ from: ["p", "out"], to: ["n1", "positive"] })]);
    expect(t).toMatchObject({ step: { label: "新建生成任务" }, selection: ["n1"] });
  });

  it("添加参考图：逐张错开、选中最后一张；带 attach 时接到任务的空端口", () => {
    const images = ["wide.png", "tall.png"].map((path) => ({ path, sha256: "1".repeat(64), display_name: path, width: DIMS[path][0], height: DIMS[path][1] }));
    const b = board([task("t")]);
    const r = editBoard(b, { kind: "addReferences", images, at: [0, 0], attach: null }, env());
    expect(node<ReferenceNode>(r.board, "n2").pos).toEqual([32, 32]);
    expect(r).toMatchObject({ step: { label: "添加 2 张参考图" }, selection: ["n2"] });
    const attached = editBoard(b, { kind: "addReferences", images, at: [0, 0], attach: { taskId: "t", place: "asIs" } }, env());
    expect(attached.board.edges.map((e) => [e.from[0], e.to[1]])).toEqual([
      ["n1", "image:0"],
      ["n2", "image:1"],
    ]);
    expect(taskOf(attached.board).image_ports).toBe(2);
  });

  it("连线：合法才连；不合法不构成步", () => {
    const b = board([prompt("p"), task("t")]);
    const r = editBoard(b, { kind: "connect", connection: { source: "p", sourceHandle: "out", target: "t", targetHandle: "positive" } }, env());
    expect(r.board.edges).toHaveLength(1);
    expect(r.step).toEqual({ label: "连线" });
    const bad = editBoard(b, { kind: "connect", connection: { source: "p", sourceHandle: "out", target: "t", targetHandle: "image:0" } }, env());
    expect(bad.board).toBe(b);
    expect(bad.step).toBeNull();
  });

  it("删除：级联删结果列、断开下游连线，提示可撤销，清空选中", () => {
    const b = board([reference("a"), task("t"), result("r", "t"), task("u")], [edge("a", "t", "image:0"), systemEdge("t", "r"), edge("r", "u", "image:0")]);
    const r = editBoard(b, { kind: "delete", nodes: ["t"], edges: [], cancelled: [] }, env());
    expect(r.board.nodes.map((n) => n.id)).toEqual(["a", "u"]);
    expect(r.board.edges).toEqual([]);
    expect(r.step).toEqual({ label: "删除 2 个节点" });
    expect(r.hint).toBe("已删除 2 个节点、断开 1 条连线，Ctrl+Z 撤销");
    expect(r.selection).toEqual([]);
  });

  it("只断开连线：计为断开 N 条连线；系统连线不能单独断开", () => {
    const b = board([reference("a"), task("t"), result("r", "t")], [edge("a", "t", "image:0"), systemEdge("t", "r")]);
    const r = editBoard(b, { kind: "delete", nodes: [], edges: [{ from: ["a", "out"], to: ["t", "image:0"] }], cancelled: [] }, env());
    expect(r.board.edges).toEqual([systemEdge("t", "r")]);
    expect(r.step).toEqual({ label: "断开 1 条连线" });
    const sys = editBoard(b, { kind: "delete", nodes: [], edges: [{ from: ["t", "result"], to: ["r", "in"] }], cancelled: [] }, env());
    expect(sys.board).toBe(b);
  });

  it("编辑提示词：同一节点连续输入按停顿合并", () => {
    const b = board([prompt("p")]);
    const r = editBoard(b, { kind: "editPrompt", promptId: "p", text: "狗" }, env());
    expect(node<PromptNode>(r.board, "p").text).toBe("狗");
    expect(r.step).toEqual({ label: "编辑提示词", merge: { key: "text:p", windowMs: MERGE_PAUSE_MS } });
  });

  it("分辨率档 / 开关 / 模型 / 图片顺序 / 区域", () => {
    const b = board([reference("a"), reference("b"), task("t", { image_ports: 2 })], [edge("a", "t", "image:0"), edge("b", "t", "image:1")]);
    const tier = editBoard(b, { kind: "setTier", taskId: "t", tier: "4K" }, env());
    expect(taskOf(tier.board).size_spec.tier).toBe("4K");
    expect(tier.step).toEqual({ label: "修改尺寸" });

    const flag = editBoard(b, { kind: "setTaskFlag", taskId: "t", flag: "transparent_background", value: true }, env());
    expect(taskOf(flag.board).transparent_background).toBe(true);
    expect(flag.step).toEqual({ label: "切换透明背景" });
    expect(editBoard(b, { kind: "setTaskFlag", taskId: "t", flag: "layer_decomposition", value: true }, env()).step).toEqual({ label: "切换图层拆分" });

    const model = editBoard(b, { kind: "setModel", taskId: "t", model: QWEN }, env());
    expect(taskOf(model.board).model).toBe(QWEN);
    expect(model.board.last_model).toBe(QWEN);
    expect(model.step).toEqual({ label: "切换模型" });

    const order = editBoard(b, { kind: "moveImagePort", taskId: "t", from: 1, to: 0 }, env());
    expect(order.board.edges.map((e) => [e.from[0], e.to[1]])).toEqual(expect.arrayContaining([["b", "image:0"], ["a", "image:1"]]));
    expect(order.step).toEqual({ label: "调整图片顺序" });

    const region = { rects: [[0, 0, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };
    const set = editBoard(b, { kind: "setRegion", edge: { from: ["a", "out"], to: ["t", "image:0"] }, region }, env());
    expect(set.board.edges[0].region).toEqual(region);
    expect(set.step).toEqual({ label: "框选修改区域" });
    expect(editBoard(set.board, { kind: "setRegion", edge: { from: ["a", "out"], to: ["t", "image:0"] }, region: null }, env()).step).toEqual({ label: "清除修改区域" });
  });

  it("分叉提示词：旧文本留在原位给已提交的任务", () => {
    const b = board([prompt("p"), task("t", { last_submitted: { prompt: "猫" } })], [edge("p", "t", "positive")]);
    const r = editBoard(b, { kind: "forkPrompt", promptId: "p", text: "狗" }, env());
    expect(node<PromptNode>(r.board, "n1").text).toBe("猫");
    expect(r.board.edges[0].from[0]).toBe("n1");
    expect(r.step).toEqual({ label: "分叉提示词" });
  });

  it("以此继续编辑：新任务接上来源，选中新提示词", () => {
    const b = board([task("t"), result("r", "t")], [systemEdge("t", "r")]);
    const r = editBoard(b, continueEditingChange(new Set(), "r"), env());
    expect(r.step).toEqual({ label: "以此继续编辑" });
    expect(r.selection).toEqual(["n2"]);
    expect(r.board.edges.some((e) => e.from[0] === "r" && e.to[0] === "n1")).toBe(true);
    expect(r.board.edges.some((e) => e.from[0] === "n2" && e.to[0] === "n1")).toBe(true);
  });

  it("加为参考图：目标是选区里的唯一生成任务；没有目标时带原因", () => {
    const b = board([task("t"), result("r", "t"), task("u")], [systemEdge("t", "r")]);
    const r = editBoard(b, { kind: "addAsReference", resultId: "r", selected: ["r", "u"], sourceLayer: null }, env());
    expect(r.board.edges.some((e) => e.from[0] === "r" && e.to[0] === "u")).toBe(true);
    expect(r.step).toEqual({ label: "加为参考图" });
    const none = editBoard(b, { kind: "addAsReference", resultId: "r", selected: ["r"], sourceLayer: null }, env());
    expect(none.board).toBe(b);
    expect(none.step).toBeNull();
    expect(none.hint).toBeTruthy();
  });

  it("重新定位：参考图换身份，手选时改显示名；结果只改路径", () => {
    const b = board([reference("a"), task("t"), result("r", "t")], [systemEdge("t", "r")]);
    const ref = editBoard(b, { kind: "relocate", nodeId: "a", path: "x/new.png", sha256: "f".repeat(64), fileName: "new.png", picked: true }, env());
    expect(node<ReferenceNode>(ref.board, "a")).toMatchObject({ path: "x/new.png", sha256: "f".repeat(64), display_name: "new.png" });
    expect(ref.step).toEqual({ label: "重新定位图片" });
    const found = editBoard(b, { kind: "relocate", nodeId: "a", path: "x/a.png", sha256: "f".repeat(64), fileName: "a.png", picked: false }, env());
    expect(node<ReferenceNode>(found.board, "a").display_name).toBe("a.png");
    const res = editBoard(b, { kind: "relocate", nodeId: "r", path: "x/r.png", sha256: "f".repeat(64), fileName: "r.png", picked: true }, env());
    expect(node<ResultNode>(res.board, "r")).toMatchObject({ path: "x/r.png", file: "r.png" });
  });
});

describe("自动宽高比在同一次变更里算好", () => {
  it("设宽高比 = 自动：一次变更得到参考图的宽高比，只有一个撤销步", () => {
    const b = board([reference("wide"), task("t", { image_ports: 1 })], [edge("wide", "t", "image:0")]);
    const r = editBoard(b, { kind: "setRatio", taskId: "t", ratio: null }, env());
    expect(taskOf(r.board).size_spec).toMatchObject({ ratio: "16:9", auto_ratio: { ratio: "16:9", image: 1 } });
    expect(r.step).toEqual({ label: "修改尺寸" });
  });

  it("设为手动值后不再跟随", () => {
    const auto = autoSizeSpec(ruleOf(PRO), "2K", null, null);
    const b = board([reference("wide"), task("t", { size_spec: auto, image_ports: 1 })], [edge("wide", "t", "image:0")]);
    const r = editBoard(b, { kind: "setRatio", taskId: "t", ratio: "1:1" }, env());
    expect(taskOf(r.board).size_spec.ratio).toBe("1:1");
    expect(taskOf(r.board).size_spec.auto_ratio ?? null).toBeNull();
  });

  it("连上参考图即重算，和连线同一步", () => {
    const auto = autoSizeSpec(ruleOf(PRO), "2K", null, null);
    const b = board([reference("tall"), task("t", { size_spec: auto })]);
    const r = editBoard(b, { kind: "connect", connection: { source: "tall", sourceHandle: "out", target: "t", targetHandle: "image:0" } }, env());
    expect(taskOf(r.board).size_spec.ratio).toBe("3:4");
    expect(r.step).toEqual({ label: "连线" });
  });

  it("视图变更不跑管线", () => {
    const auto = autoSizeSpec(ruleOf(PRO), "2K", null, null);
    const b = board([reference("tall"), task("t", { size_spec: auto, image_ports: 1 })], [edge("tall", "t", "image:0")]);
    const r = editBoard(b, { kind: "title", title: "新标题" }, env());
    expect(r.board.title).toBe("新标题");
    expect(taskOf(r.board).size_spec).toBe(auto);
    expect(r.step).toBeNull();
  });
});

describe("运行期锁定：后置不变量", () => {
  const b = board([prompt("p"), reference("a"), reference("b"), task("t", { image_ports: 1 }), task("u")], [edge("p", "t", "positive"), edge("a", "t", "image:0")]);
  const rejected = (change: BoardChange, e = locked("t")) => {
    const r = editBoard(b, change, e);
    expect(r).toEqual({ board: b, step: null, hint: LOCKED_HINT });
  };

  it("改锁定任务的参数被整体拒绝", () => {
    rejected({ kind: "setTier", taskId: "t", tier: "4K" });
    rejected({ kind: "setRatio", taskId: "t", ratio: "16:9" });
    rejected({ kind: "setTaskFlag", taskId: "t", flag: "layer_decomposition", value: true });
    rejected({ kind: "setModel", taskId: "t", model: QWEN });
    rejected({ kind: "setRegion", edge: { from: ["a", "out"], to: ["t", "image:0"] }, region: { rects: [[0, 0, 1, 1]], render: "highlight_overlay" } });
  });

  it("接入锁定任务被拒：连线、加为参考图", () => {
    rejected({ kind: "connect", connection: { source: "b", sourceHandle: "out", target: "t", targetHandle: "image:1" } });
    const withResult = board([...b.nodes, result("r", "u")], [...b.edges, systemEdge("u", "r")]);
    const r = editBoard(withResult, { kind: "addAsReference", resultId: "r", selected: ["r", "t"], sourceLayer: null }, locked("t"));
    expect(r).toEqual({ board: withResult, step: null, hint: LOCKED_HINT });
  });

  it("文件拖到锁定任务上：参考图照样加上，只是不接线", () => {
    const images = [{ path: "wide.png", sha256: "1".repeat(64), display_name: "wide.png", width: 1920, height: 1080 }];
    const r = editBoard(b, { kind: "addReferences", images, at: [0, 0], attach: { taskId: "t", place: "left" } }, locked("t"));
    expect(r.board.nodes).toHaveLength(b.nodes.length + 1);
    expect(r.board.edges).toBe(b.edges);
    expect(r.hint).toBe(LOCKED_HINT);
    expect(r.step).toEqual({ label: "添加 1 张参考图" });
  });

  it("断开锁定任务的输入连线被拒：直接断开，或删掉上游节点级联断开", () => {
    rejected({ kind: "delete", nodes: [], edges: [{ from: ["a", "out"], to: ["t", "image:0"] }], cancelled: [] });
    rejected({ kind: "delete", nodes: ["a"], edges: [], cancelled: [] });
    rejected({ kind: "delete", nodes: ["p"], edges: [], cancelled: [] });
  });

  it("删除锁定任务：不在连同取消里被拒，在则放行", () => {
    rejected({ kind: "delete", nodes: ["t"], edges: [], cancelled: [] });
    const r = editBoard(b, { kind: "delete", nodes: ["t"], edges: [], cancelled: ["t"] }, locked("t"));
    expect(r.board.nodes.some((n) => n.id === "t")).toBe(false);
    expect(r.step).toEqual({ label: "删除 1 个节点" });
  });

  it("移动、缩放、分叉提示词、编辑上游提示词、重新定位不受锁定影响", () => {
    const e = locked("t");
    expect(editBoard(b, { kind: "move", moves: [["t", [1, 1]]], drag: null }, e).step).not.toBeNull();
    expect(editBoard(b, { kind: "nudge", ids: ["t"], delta: [1, 0] }, e).step).not.toBeNull();
    expect(editBoard(b, { kind: "resize", resize: 1, boxes: [{ id: "t", width: 320, height: 300, pos: null }] }, e).step).not.toBeNull();
    const submitted = board(b.nodes.map((n) => (n.id === "t" ? { ...n, last_submitted: { prompt: "猫" } } : n)), b.edges);
    const fork = editBoard(submitted, { kind: "forkPrompt", promptId: "p", text: "狗" }, e);
    expect(fork.step).toEqual({ label: "分叉提示词" });
    expect(fork.board.edges.find((x) => x.to[1] === "positive")?.from[0]).toBe("n1");
    expect(editBoard(b, { kind: "editPrompt", promptId: "p", text: "狗" }, e).step).not.toBeNull();
    expect(editBoard(b, { kind: "relocate", nodeId: "a", path: "x.png", sha256: "f".repeat(64), fileName: "x.png", picked: true }, e).step).not.toBeNull();
  });

  it("锁定任务不重算自动宽高比，其余任务照常", () => {
    const auto = autoSizeSpec(ruleOf(PRO), "2K", null, null);
    const two = board([reference("wide"), task("t", { size_spec: auto, image_ports: 1 }), task("u", { size_spec: auto, image_ports: 1 })], [edge("wide", "t", "image:0"), edge("wide", "u", "image:0")]);
    const r = editBoard(two, { kind: "move", moves: [["wide", [5, 5]]], drag: null }, locked("t"));
    expect(taskOf(r.board, "t").size_spec).toBe(auto);
    expect(taskOf(r.board, "u").size_spec.ratio).toBe("16:9");
  });
});

describe("系统变更", () => {
  const record = result("x", "t").record;
  const run: RunResult = { taskId: "t", submittedTaskId: "t-run", file: "out.png", path: "out.png", record };

  it("不构成撤销步：写提交记录、运行结果落地", () => {
    const b = board([task("t")]);
    const s = editBoard(b, { kind: "submitted", taskId: "t", lastSubmitted: { prompt: "猫" } }, env());
    expect(taskOf(s.board).last_submitted).toEqual({ prompt: "猫" });
    expect(s.step).toBeNull();
    const r = editBoard(b, { kind: "runResult", result: run }, env());
    expect(node<ResultNode>(r.board, "n1")).toMatchObject({ type: "result", task_id: "t-run" });
    expect(r.board.edges).toEqual([systemEdge("t", "n1")]);
    expect(r.step).toBeNull();
  });

  it("系统变更不受锁定限制", () => {
    const b = board([task("t")]);
    expect(taskOf(editBoard(b, { kind: "submitted", taskId: "t", lastSubmitted: { prompt: "猫" } }, locked("t")).board).last_submitted).toEqual({ prompt: "猫" });
  });

  it("运行结果落地不改任何宽高比（结果不是任务的输入）", () => {
    const auto = autoSizeSpec(ruleOf(PRO), "2K", null, null);
    const b = board([task("t", { size_spec: auto })]);
    const r = editBoard(b, { kind: "runResult", result: { ...run, path: "wide.png" } }, env());
    expect(taskOf(r.board).size_spec).toBe(auto);
  });

  it("补算自动宽高比：图片宽高读到后才算；无事可做时返回同一引用", () => {
    const auto = autoSizeSpec(ruleOf(PRO), "2K", null, null);
    const b = board([reference("wide"), task("t", { size_spec: auto, image_ports: 1 })], [edge("wide", "t", "image:0")]);
    const unknown = editBoard(b, { kind: "syncAutoRatios" }, env({ imageSize: () => undefined }));
    expect(taskOf(unknown.board).size_spec.ratio).toBe(auto.ratio);
    const known = editBoard(b, { kind: "syncAutoRatios" }, env());
    expect(taskOf(known.board).size_spec.ratio).toBe("16:9");
    expect(known.step).toBeNull();
    expect(editBoard(known.board, { kind: "syncAutoRatios" }, env()).board).toBe(known.board);
  });
});

describe("不同入口发出同一变更、得到同一结果", () => {
  const b = board([task("t"), result("r", "t"), result("s", "t")], [systemEdge("t", "r"), systemEdge("t", "s")]);

  it("以此继续编辑：菜单与悬浮动作条（选区内）沿用多选；拖线建节点只接拖出的一张", () => {
    const selected = new Set(["r", "s"]);
    const menu = continueEditingChange(selected, "r");
    const bar = continueEditingChange(selected, "r");
    expect(menu).toEqual(bar);
    expect(menu).toMatchObject({ sources: ["r", "s"] });
    expect(editBoard(b, menu, env())).toEqual(editBoard(b, bar, env()));
    expect(continueEditingChange(selected, "r", null, [900, 0])).toMatchObject({ sources: ["r"], at: [900, 0] });
    expect(continueEditingChange(new Set(["s"]), "r")).toMatchObject({ sources: ["r"] });
  });

  it("拖线落在任务卡片上与直接连到端口是同一个连线变更", () => {
    const g = board([reference("a"), task("u")]);
    const drop = cardDropConnection(g, BUILTIN_TABLE, { nodeId: "a", handleId: "out", type: "source" }, "u", new Set());
    if (!drop?.ok) throw new Error("应能接上");
    const direct = { source: "a", sourceHandle: "out", target: "u", targetHandle: "image:0" };
    expect(drop.connection).toEqual(direct);
    expect(editBoard(g, { kind: "connect", connection: drop.connection }, env())).toEqual(editBoard(g, { kind: "connect", connection: direct }, env()));
  });
});
