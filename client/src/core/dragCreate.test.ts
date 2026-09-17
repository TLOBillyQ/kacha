import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, PromptNode, ReferenceNode, TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import { attachReferences, cardDropConnection, dragCreateItems, newTask } from "./dragCreate";
import { LOCKED_HINT } from "./iterate";

const SPEC_2K = { tier: "2K", ratio: "16:9", width: null, height: null };

function reference(id: string, pos: [number, number] = [0, 0]): BoardNode {
  return { id, type: "reference", pos, size: [200, 220], extra: {}, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png` };
}

function result(id: string): BoardNode {
  return {
    id,
    type: "result",
    pos: [0, 0],
    size: [220, 300],
    extra: {},
    task_id: `t-${id}`,
    file: "result.png",
    path: `x/${id}/result.png`,
    layer_count: 0,
    record: { model: "qwen-image-3.0", prompt: "", negative_prompt: "", size_spec: SPEC_2K, submitted_at: "" },
  };
}

function prompt(id: string): PromptNode {
  return { id, type: "prompt", pos: [0, 0], size: [240, 140], extra: {}, text: "" };
}

function task(id: string, patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [1000, 500],
    size: [280, 260],
    extra: {},
    model: "qwen-image-3.0",
    size_spec: SPEC_2K,
    image_ports: 0,
    layer_decomposition: false,
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

describe("拖线建节点：起点 → 建节点动作", () => {
  const g = () => board([reference("r"), result("res"), prompt("p"), task("t")], [edge("r", "out", "t", "image:0"), edge("t", "result", "res", "in", true)]);
  const actions = (from: Parameters<typeof dragCreateItems>[1]) => dragCreateItems(g(), from).map((i) => i.action);

  it("图片节点输出端口 = 以此继续编辑（参考图、结果都是）", () => {
    expect(actions({ nodeId: "r", handleId: "out", type: "source" })).toEqual(["continueEditing"]);
    expect(actions({ nodeId: "res", handleId: "out", type: "source" })).toEqual(["continueEditing"]);
  });

  it("提示词输出端口 = 新建生成任务", () => {
    expect(actions({ nodeId: "p", handleId: "out", type: "source" })).toEqual(["newTask"]);
  });

  it("任务节点的空图片端口反向 = 添加参考图", () => {
    expect(actions({ nodeId: "t", handleId: "image:1", type: "target" })).toEqual(["addReferences"]);
  });

  it("其余起点没有候选：结果端口、提示词端口反向、已接线的图片端口、节点不存在", () => {
    expect(actions({ nodeId: "t", handleId: "result", type: "source" })).toEqual([]);
    expect(actions({ nodeId: "t", handleId: "positive", type: "target" })).toEqual([]);
    expect(actions({ nodeId: "t", handleId: "negative", type: "target" })).toEqual([]);
    expect(actions({ nodeId: "t", handleId: "image:0", type: "target" })).toEqual([]);
    expect(actions({ nodeId: "gone", handleId: "out", type: "source" })).toEqual([]);
  });
});

describe("拖线落在任务节点卡片上：选端口", () => {
  const none = new Set<string>();
  const out = (nodeId: string) => ({ nodeId, handleId: "out", type: "source" as const });

  it("图片线接到下一个空图片端口，提示词线接正向", () => {
    const g = board([reference("a"), reference("b"), prompt("p"), task("t")], [edge("a", "out", "t", "image:0")]);
    expect(cardDropConnection(g, BUILTIN_TABLE, out("b"), "t", none)).toEqual({ ok: true, connection: { source: "b", sourceHandle: "out", target: "t", targetHandle: "image:1" } });
    expect(cardDropConnection(g, BUILTIN_TABLE, out("p"), "t", none)).toEqual({ ok: true, connection: { source: "p", sourceHandle: "out", target: "t", targetHandle: "positive" } });
  });

  it("无空位或不合法时给出原因", () => {
    const full = board(
      [reference("a"), reference("b"), reference("c"), reference("d"), prompt("p"), prompt("q"), task("t")],
      [edge("a", "out", "t", "image:0"), edge("b", "out", "t", "image:1"), edge("c", "out", "t", "image:2"), edge("p", "out", "t", "positive")],
    );
    expect(cardDropConnection(full, BUILTIN_TABLE, out("d"), "t", none)).toEqual({ ok: false, reason: "参考图已达模型上限 3 张" });
    expect(cardDropConnection(full, BUILTIN_TABLE, out("q"), "t", none)).toEqual({ ok: false, reason: "该端口已有连线" });
  });

  it("锁定任务不接受接入", () => {
    const g = board([reference("a"), task("t")]);
    expect(cardDropConnection(g, BUILTIN_TABLE, out("a"), "t", new Set(["t"]))).toEqual({ ok: false, reason: LOCKED_HINT });
  });

  it("落在图片节点、提示词节点上，或反向拖线落在卡片上：无效（null，不提示）", () => {
    const g = board([reference("a"), reference("b"), prompt("p"), task("t"), task("u")]);
    expect(cardDropConnection(g, BUILTIN_TABLE, out("a"), "b", none)).toBeNull();
    expect(cardDropConnection(g, BUILTIN_TABLE, out("a"), "p", none)).toBeNull();
    expect(cardDropConnection(g, BUILTIN_TABLE, { nodeId: "t", handleId: "image:0", type: "target" }, "u", none)).toBeNull();
    expect(cardDropConnection(g, BUILTIN_TABLE, out("a"), "a", none)).toBeNull();
  });
});

describe("新建生成任务", () => {
  const NONE = { source: "none" } as const;

  it("默认模型同工具栏（画板最近选择优先），左上角落在给定位置，记为最近选择", () => {
    const g = { ...board([prompt("p")]), last_model: "qwen-image-3.0" };
    const r = newTask(g, BUILTIN_TABLE, NONE, "new", [300, 400]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.board.nodes.find((n) => n.id === "new")).toMatchObject({ type: "task", model: "qwen-image-3.0", pos: [300, 400], image_ports: 0, last_submitted: null });
    expect(r.board.last_model).toBe("qwen-image-3.0");
    expect(r.board.edges).toEqual([]);
  });

  it("从提示词拖出：提示词接新任务的正向端口", () => {
    const r = newTask(board([prompt("p")]), BUILTIN_TABLE, NONE, "new", [0, 0], "p");
    if (!r.ok) throw new Error(r.reason);
    expect(r.board.edges).toEqual([edge("p", "out", "new", "positive")]);
  });

  it("能力表没有上架模型时拒绝", () => {
    expect(newTask(board([]), { ...BUILTIN_TABLE, models: [] }, NONE, "new", [0, 0])).toEqual({ ok: false, reason: "能力表中没有上架模型" });
  });
});

describe("参考图节点接到任务（反向拖线导入、OS 文件拖到任务卡片上）", () => {
  const none = new Set<string>();
  const ref = (id: string) => reference(id, [7, 7]) as ReferenceNode;
  const into = (b: Board) => b.edges.filter((e) => e.to[0] === "t").map((e) => [e.from[0], e.to[1]]);

  it("新节点依次接到下一个空图片端口，一次返回（一个撤销步）", () => {
    const g = board([reference("a"), task("t")], [edge("a", "out", "t", "image:0")]);
    const r = attachReferences(g, BUILTIN_TABLE, [ref("x"), ref("y")], "t", none, "asIs");
    expect(r.reason).toBeNull();
    expect(into(r.board)).toEqual([["a", "image:0"], ["x", "image:1"], ["y", "image:2"]]);
    expect(r.board.nodes.find((n) => n.id === "t")).toMatchObject({ image_ports: 3 });
  });

  it("asIs：保留给定位置（松手处）", () => {
    const r = attachReferences(board([task("t")]), BUILTIN_TABLE, [ref("x")], "t", none, "asIs");
    expect((r.board.nodes.find((n) => n.id === "x") as ReferenceNode).pos).toEqual([7, 7]);
  });

  it("left：落在任务左侧就近空位，多张依次向下让开", () => {
    const r = attachReferences(board([task("t")]), BUILTIN_TABLE, [ref("x"), ref("y")], "t", none, "left");
    // 任务在 [1000, 500]，参考图宽 200、列间距 60、行间距 24。
    expect((r.board.nodes.find((n) => n.id === "x") as ReferenceNode).pos).toEqual([1000 - 200 - 60, 500]);
    expect((r.board.nodes.find((n) => n.id === "y") as ReferenceNode).pos).toEqual([1000 - 200 - 60, 500 + 220 + 24]);
  });

  it("超出模型上限：节点照建，接满为止，给出原因", () => {
    const g = board([reference("a"), reference("b"), task("t")], [edge("a", "out", "t", "image:0"), edge("b", "out", "t", "image:1")]);
    const r = attachReferences(g, BUILTIN_TABLE, [ref("x"), ref("y")], "t", none, "asIs");
    expect(r.reason).toBe("参考图已达模型上限 3 张");
    expect(into(r.board)).toEqual([["a", "image:0"], ["b", "image:1"], ["x", "image:2"]]);
    expect(r.board.nodes.some((n) => n.id === "y")).toBe(true);
  });

  it("锁定任务：节点照建，不接线，提示 LOCKED_HINT", () => {
    const r = attachReferences(board([task("t")]), BUILTIN_TABLE, [ref("x")], "t", new Set(["t"]), "asIs");
    expect(r.reason).toBe(LOCKED_HINT);
    expect(r.board.edges).toEqual([]);
    expect(r.board.nodes.some((n) => n.id === "x")).toBe(true);
  });
});
