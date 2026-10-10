import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, PromptNode, TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import { addAsReference, addAsReferenceTarget, continueEditing, copySelection, lineage, pasteClip } from "./iterate";
import { PROMPT_NODE_SIZE, TASK_NODE_SIZE } from "./layout";
import type { Discovery } from "./settings";

const NONE: Discovery = { source: "none" };
const SPEC_2K = { tier: "2K", ratio: "16:9", width: null, height: null };
/** 继续编辑的新任务：分辨率档继承，宽高比不继承、统一走自动（由 syncAutoRatios 按参考图算）。 */
const AUTO_2K = { tier: "2K", ratio: "1:1", width: null, height: null, auto_ratio: { ratio: "1:1", image: null, source: null } };

function reference(id: string, pos: [number, number] = [0, 0]): BoardNode {
  return { id, type: "reference", pos, size: [200, 220], extra: {}, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png` };
}

function result(id: string, pos: [number, number] = [0, 0], model = "qwen-image-3.0"): BoardNode {
  return {
    id,
    type: "result",
    pos,
    size: [220, 300],
    extra: {},
    task_id: `t-${id}`,
    file: "result.png",
    path: `x/${id}/result.png`,
    layer_count: 0,
    record: { model, prompt: "", negative_prompt: "", size_spec: SPEC_2K, submitted_at: "" },
  };
}

function prompt(id: string, text = ""): PromptNode {
  return { id, type: "prompt", pos: [-1000, -1000], size: [240, 140], extra: {}, text };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [-2000, 0],
    size: [280, 260],
    extra: {},
    model: "qwen-image-3.0",
    size_spec: SPEC_2K,
    image_ports: 0,
    layer_decomposition: true,
    transparent_background: false,
    last_submitted: null,
    ...patch,
  };
}

function edge(from: string, fromPort: string, to: string, toPort: string, system = false): BoardEdge {
  return { from: [from, fromPort], to: [to, toPort], source_layer: null, region: null, system, extra: {} };
}

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

const ids = { taskId: "new-task", promptId: "new-prompt" };

function ok(r: ReturnType<typeof continueEditing>): Board {
  if (!r.ok) throw new Error(r.reason);
  return r.board;
}

const find = <T extends BoardNode>(b: Board, id: string) => b.nodes.find((n) => n.id === id) as T;

describe("以此继续编辑", () => {
  it("旧 Lite 结果继续编辑保留停用身份与分辨率档，不静默换 Flash", () => {
    const source = result("old", [0, 0], "doubao-seedream-5-0-lite-260128");
    if (source.type !== "result") throw new Error("result");
    source.record.size_spec = { tier: "3K", ratio: "16:9", width: null, height: null };
    const before = board([source]);
    const b = ok(continueEditing(before, BUILTIN_TABLE, NONE, ["old"], "old", ids));
    expect(find<TaskNode>(b, "new-task")).toMatchObject({ model: "doubao-seedream-5-0-lite-260128", size_spec: { tier: "3K" }, image_ports: 1 });
    expect(find(b, "old")).toEqual(source);
  });
  // 源任务 src（经济档 2K 16:9，接了负向）产出结果 res。
  const lineage = () =>
    board(
      [task("src"), prompt("pos", "猫"), prompt("neg", "模糊"), result("res", [400, 100])],
      [edge("pos", "out", "src", "positive"), edge("neg", "out", "src", "negative"), edge("src", "result", "res", "in", true)],
    );

  it("新建任务：结果接图1，空提示词接正向，负向扇出复用源任务的；模型 / 尺寸继承，开关不继承", () => {
    const b = ok(continueEditing(lineage(), BUILTIN_TABLE, NONE, ["res"], "res", ids));
    expect(find<TaskNode>(b, "new-task")).toMatchObject({ model: "qwen-image-3.0", size_spec: AUTO_2K, layer_decomposition: false, image_ports: 1, last_submitted: null });
    expect(find<PromptNode>(b, "new-prompt").text).toBe("");
    const into = b.edges.filter((e) => e.to[0] === "new-task").map((e) => [e.from[0], e.to[1]]);
    expect(into).toEqual(expect.arrayContaining([["res", "image:0"], ["new-prompt", "positive"], ["neg", "negative"]]));
    expect(into).toHaveLength(3);
    expect(b.edges.every((e) => e.region === null)).toBe(true);
  });

  it("新任务在触发节点右侧，空提示词节点在其左上；已有节点位置不动", () => {
    const before = lineage();
    const b = ok(continueEditing(before, BUILTIN_TABLE, NONE, ["res"], "res", ids));
    expect(find<TaskNode>(b, "new-task").pos).toEqual([400 + 220 + 60, 100]);
    expect(find<PromptNode>(b, "new-prompt").pos).toEqual([400 + 220 + 60 - PROMPT_NODE_SIZE[0] - 60, 100 - PROMPT_NODE_SIZE[1] - 24]);
    expect(find<TaskNode>(b, "new-task").size).toEqual(TASK_NODE_SIZE);
    for (const n of before.nodes) expect(find(b, n.id)).toEqual(n);
  });

  it("给定落点（拖线建节点）：新任务左上角落在落点，空提示词节点在其左上", () => {
    const b = ok(continueEditing(lineage(), BUILTIN_TABLE, NONE, ["res"], "res", ids, null, [2000, 900]));
    expect(find<TaskNode>(b, "new-task").pos).toEqual([2000, 900]);
    expect(find<PromptNode>(b, "new-prompt").pos).toEqual([2000 - PROMPT_NODE_SIZE[0] - 60, 900 - PROMPT_NODE_SIZE[1] - 24]);
  });

  it("多选按选中顺序接入；新任务在最右侧的触发节点右边", () => {
    const b = ok(continueEditing(board([reference("a", [0, 0]), reference("b", [500, 300])]), BUILTIN_TABLE, NONE, ["b", "a"], "b", ids));
    const images = b.edges.filter((e) => e.to[0] === "new-task" && e.to[1].startsWith("image:")).map((e) => [e.from[0], e.to[1]]);
    expect(images).toEqual([["b", "image:0"], ["a", "image:1"]]);
    expect(find<TaskNode>(b, "new-task").pos).toEqual([500 + 200 + 60, 300]);
  });

  it("多选：模型 / 尺寸继承点击的触发节点，与其同行；横向仍在最右侧的选中节点右边", () => {
    const b0 = board(
      [task("src1"), result("r1", [400, 0]), task("src2", { model: "qwen-image-3.0-pro", pos: [0, 600] }), result("r2", [300, 600], "qwen-image-3.0-pro")],
      [edge("src1", "result", "r1", "in", true), edge("src2", "result", "r2", "in", true)],
    );
    const b = ok(continueEditing(b0, BUILTIN_TABLE, NONE, ["r1", "r2"], "r2", ids));
    expect(find<TaskNode>(b, "new-task")).toMatchObject({ model: "qwen-image-3.0-pro", pos: [400 + 220 + 60, 600] });
    const images = b.edges.filter((e) => e.to[0] === "new-task" && e.to[1].startsWith("image:")).map((e) => e.from[0]);
    expect(images).toEqual(["r1", "r2"]);
  });

  it("触发于参考图节点：用工具栏模型，不接负向", () => {
    const b = ok(continueEditing(board([reference("r")]), BUILTIN_TABLE, NONE, ["r"], "r", ids));
    expect(find<TaskNode>(b, "new-task").model).toBe("doubao-seedream-5-0-flash-260915");
    expect(b.edges.some((e) => e.to[1] === "negative")).toBe(false);
    const picked = ok(continueEditing({ ...board([reference("r")]), last_model: "qwen-image-3.0" }, BUILTIN_TABLE, NONE, ["r"], "r", ids));
    expect(find<TaskNode>(picked, "new-task").model).toBe("qwen-image-3.0");
  });

  it("源模型与工具栏模型都不支持图片编辑：换默认编辑模型，尺寸不在其尺寸表内时用默认尺寸", () => {
    const b0 = lineage();
    const src = find<TaskNode>(b0, "src");
    src.model = "doubao-seedream-5-0-flash-260915";
    const t = structuredClone(BUILTIN_TABLE);
    t.models.find((m) => m.model_id === src.model)!.workflows.image_edit.max_references = 0;
    const b = ok(continueEditing(b0, t, NONE, ["res"], "res", ids));
    expect(find<TaskNode>(b, "new-task")).toMatchObject({ model: "qwen-image-3.0-pro", size_spec: AUTO_2K });

    src.size_spec = { tier: "8K", ratio: "1:1", width: null, height: null };
    const c = ok(continueEditing(b0, t, NONE, ["res"], "res", ids));
    expect(find<TaskNode>(c, "new-task").size_spec.tier).toBe("1K");
  });

  it("产出任务已删除：按结果记录的模型与尺寸继承", () => {
    const b = ok(continueEditing(board([result("res", [0, 0], "qwen-image-3.0")]), BUILTIN_TABLE, NONE, ["res"], "res", ids));
    expect(find<TaskNode>(b, "new-task")).toMatchObject({ model: "qwen-image-3.0", size_spec: AUTO_2K });
  });

  it("选中的图片超过模型参考图上限：拒绝，画板不变", () => {
    const refs = ["a", "b", "c", "d"].map((id) => reference(id));
    const r = continueEditing({ ...board(refs), last_model: "qwen-image-3.0" }, BUILTIN_TABLE, NONE, ["a", "b", "c", "d"], "a", ids);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/最多接 3 张参考图，选中了 4 张/);
  });

  it("没有图片节点可用时拒绝", () => {
    expect(continueEditing(board([prompt("p")]), BUILTIN_TABLE, NONE, ["p"], "p", ids)).toEqual({ ok: false, reason: "先选中结果或参考图节点" });
  });
});

describe("加为参考图", () => {
  const g = () =>
    board([result("res"), reference("r"), task("t1"), task("t2"), prompt("p")], [edge("r", "out", "t1", "image:0")]);

  it("恰好选中一个生成任务节点时才可用，否则提示先选一个", () => {
    expect(addAsReferenceTarget(g(), ["t1"])).toEqual({ ok: true, taskId: "t1" });
    expect(addAsReferenceTarget(g(), ["res", "t1", "p"])).toEqual({ ok: true, taskId: "t1" });
    expect(addAsReferenceTarget(g(), [])).toEqual({ ok: false, reason: "先选一个生成任务" });
    expect(addAsReferenceTarget(g(), ["t1", "t2"])).toEqual({ ok: false, reason: "先选一个生成任务" });
  });

  it("接到目标的下一个空图片端口，不新增节点、不改参数", () => {
    const before = g();
    const r = addAsReference(before, BUILTIN_TABLE, "res", "t1");
    if (!r.ok) throw new Error(r.reason);
    expect(r.board.nodes.length).toBe(before.nodes.length);
    expect(r.board.edges.filter((e) => e.to[0] === "t1").map((e) => [e.from[0], e.to[1]])).toEqual([["r", "image:0"], ["res", "image:1"]]);
    expect(find<TaskNode>(r.board, "t1")).toMatchObject({ ...find<TaskNode>(before, "t1"), image_ports: 2 });
  });

  it("不合法时给出原因：只接结果节点、已达上限、成环", () => {
    expect(addAsReference(g(), BUILTIN_TABLE, "r", "t1")).toEqual({ ok: false, reason: "只能把结果节点加为参考图" });
    const full = board(
      [result("res"), reference("a"), reference("b"), reference("c"), task("t1")],
      [edge("a", "out", "t1", "image:0"), edge("b", "out", "t1", "image:1"), edge("c", "out", "t1", "image:2")],
    );
    expect(addAsReference(full, BUILTIN_TABLE, "res", "t1")).toEqual({ ok: false, reason: "参考图已达模型上限 3 张" });
    const loop = board([task("t1"), result("res")], [edge("t1", "result", "res", "in", true)]);
    expect(addAsReference(loop, BUILTIN_TABLE, "res", "t1")).toEqual({ ok: false, reason: "不能形成环" });
  });
});

describe("谱系", () => {
  // r → t1 → res1 → t2 → res2；p → t1；旁支 r → t3（与 res1 无上下游关系）。
  const g = () =>
    board(
      [reference("r"), prompt("p"), task("t1"), result("res1"), task("t2"), result("res2"), task("t3")],
      [
        edge("r", "out", "t1", "image:0"),
        edge("p", "out", "t1", "positive"),
        edge("t1", "result", "res1", "in", true),
        edge("res1", "out", "t2", "image:0"),
        edge("t2", "result", "res2", "in", true),
        edge("r", "out", "t3", "image:0"),
      ],
    );

  it("选中结果：上游全链与下游全链，不含兄弟旁支", () => {
    const { nodes, edges } = lineage(g(), ["res1"]);
    expect([...nodes].sort()).toEqual(["p", "r", "res1", "res2", "t1", "t2"]);
    expect(edges.size).toBe(5);
  });

  it("多选取并集；没有选中为空", () => {
    expect([...lineage(g(), ["res2", "t3"]).nodes].sort()).toEqual(["p", "r", "res1", "res2", "t1", "t2", "t3"]);
    expect(lineage(g(), []).nodes.size).toBe(0);
  });
});

describe("复制粘贴", () => {
  const g = () =>
    board(
      [prompt("p", "猫"), reference("r"), task("t", { last_submitted: { task_id: "x" } }), result("res"), prompt("outside")],
      [edge("p", "out", "t", "positive"), edge("r", "out", "t", "image:0"), edge("outside", "out", "t", "negative"), edge("t", "result", "res", "in", true)],
    );
  let n = 0;
  const newId = () => `copy-${n++}`;

  it("复制选中的提示词 / 参考图 / 任务节点及其之间的连线；结果节点与系统连线不复制", () => {
    n = 0;
    const clip = copySelection(g(), ["p", "r", "t", "res"]);
    const { board: b, ids: pasted } = pasteClip(g(), clip, newId);
    expect(pasted).toEqual(["copy-0", "copy-1", "copy-2"]);
    const copies = b.nodes.filter((x) => pasted.includes(x.id));
    expect(copies.map((x) => x.type)).toEqual(["prompt", "reference", "task"]);
    expect(copies[0]).toMatchObject({ text: "猫", pos: [-1000 + 40, -1000 + 40] });
    expect(copies[2]).toMatchObject({ last_submitted: null, image_ports: 1 });
    expect(b.edges.filter((e) => pasted.includes(e.to[0])).map((e) => [e.from[0], e.to[1]])).toEqual([
      ["copy-0", "positive"],
      ["copy-1", "image:0"],
    ]);
  });

  it("剪贴板是复制时的快照，之后画板变化不影响粘贴", () => {
    const clip = copySelection(g(), ["p"]);
    const changed = { ...g(), nodes: g().nodes.filter((x) => x.id !== "p") };
    expect(pasteClip(changed, clip, newId).board.nodes.some((x) => x.type === "prompt" && x.text === "猫" && x.id !== "p")).toBe(true);
  });
});

describe("图层接回", () => {
  const layered = (id: string): BoardNode => {
    const r = result(id) as Extract<BoardNode, { type: "result" }>;
    return {
      ...r,
      layer_count: 2,
      record: { ...r.record, layers: [{ file: "layers/01.png", z_index: 1, bounding_box: [] }, { file: "layers/02.png", z_index: 2, bounding_box: [] }] },
    };
  };

  it("加为参考图：sourceLayer 记在触发连线上", () => {
    const b = board([layered("x"), task("t")]);
    const outcome = addAsReference(b, BUILTIN_TABLE, "x", "t", 2);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.board.edges.at(-1)).toMatchObject({ from: ["x", "out"], to: ["t", "image:0"], source_layer: 2 });
  });

  it("以此继续编辑：按 sourceLayers 接图层而非合成结果", () => {
    const b = board([layered("x")]);
    const outcome = continueEditing(b, BUILTIN_TABLE, NONE, ["x"], "x", ids, new Map([["x", 1]]));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const imageEdge = outcome.board.edges.find((e) => e.from[0] === "x");
      expect(imageEdge).toMatchObject({ source_layer: 1 });
    }
  });
});
