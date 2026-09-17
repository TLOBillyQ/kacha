import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE, type CapabilityTable, type ModelCapability } from "./capabilities";
import {
  canConnect,
  chainDepth,
  connect,
  removeNodes,
  syncImagePorts,
  disconnect,
  forkPrompt,
  hasDownstreamRecords,
  imageRuleViolations,
  moveImagePort,
  taskIssues,
  taskPorts,
  transparentAlphaIssue,
} from "./graph";

const SEEDREAM_PRO = "doubao-seedream-5-0-pro-260628";

function node(id: string, type: "prompt" | "reference" | "result"): BoardNode {
  const base = { id, pos: [0, 0] as [number, number], size: [100, 100] as [number, number], extra: {} };
  if (type === "prompt") return { ...base, type, text: "" };
  if (type === "reference") return { ...base, type, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png` };
  return {
    ...base,
    type,
    task_id: `t-${id}`,
    file: "result.png",
    path: `x/${id}/result.png`,
    layer_count: 0,
    record: { model: "m", prompt: "", negative_prompt: "", size_spec: { tier: "1K", ratio: "1:1", width: null, height: null }, submitted_at: "" },
  };
}

function task(id: string, model = "qwen-image-3.0-pro", patch: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    type: "task",
    pos: [0, 0],
    size: [100, 100],
    extra: {},
    model,
    size_spec: { tier: "1K", ratio: "1:1", width: null, height: null },
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

const table = BUILTIN_TABLE;
const conn = (source: string, sourceHandle: string, target: string, targetHandle: string) => ({ source, sourceHandle, target, targetHandle });

function withModel(patch: (m: ModelCapability) => void): CapabilityTable {
  const t = structuredClone(BUILTIN_TABLE);
  const m = structuredClone(t.models[0]);
  m.model_id = "test-model";
  patch(m);
  t.models.push(m);
  return t;
}

describe("连线合法性", () => {
  const b = () => board([node("p", "prompt"), node("r", "reference"), node("res", "result"), task("t"), task("t2")]);

  it("提示词 → 正向 / 负向端口", () => {
    expect(canConnect(b(), table, conn("p", "out", "t", "positive")).ok).toBe(true);
    expect(canConnect(b(), table, conn("p", "out", "t", "negative")).ok).toBe(true);
    expect(canConnect(b(), table, conn("p", "out", "t", "image:0")).ok).toBe(false);
  });

  it("参考图 / 结果 → 图片端口；不能接提示词端口", () => {
    expect(canConnect(b(), table, conn("r", "out", "t", "image:0")).ok).toBe(true);
    expect(canConnect(b(), table, conn("res", "out", "t", "image:0")).ok).toBe(true);
    expect(canConnect(b(), table, conn("r", "out", "t", "positive")).ok).toBe(false);
  });

  it("任务 → 结果不可手连；结果输入端口不可作为目标", () => {
    expect(canConnect(b(), table, conn("t", "result", "res", "in")).ok).toBe(false);
    expect(canConnect(b(), table, conn("p", "out", "res", "in")).ok).toBe(false);
  });

  it("输入端口至多一条", () => {
    const g = b();
    g.edges = connect(g, conn("p", "out", "t", "positive"));
    const second = canConnect(g, table, conn("p", "out", "t", "positive"));
    expect(second).toEqual({ ok: false, reason: "该端口已有连线" });
  });

  it("负向端口只在模型支持时可接", () => {
    const g = board([node("p", "prompt"), task("t", SEEDREAM_PRO)]);
    expect(canConnect(g, table, conn("p", "out", "t", "negative")).ok).toBe(false);
  });

  it("图片端口 Autogrow：只能接下一个空端口，达到上限后不可再接", () => {
    const g = board([node("a", "reference"), node("b", "reference"), node("c", "reference"), node("d", "reference"), task("t")]);
    expect(canConnect(g, table, conn("a", "out", "t", "image:1")).ok).toBe(false);
    for (const id of ["a", "b", "c"]) {
      g.edges = connect(g, conn(id, "out", "t", `image:${g.edges.length}`));
    }
    expect(g.edges.map((e) => e.to[1])).toEqual(["image:0", "image:1", "image:2"]);
    expect(canConnect(g, table, conn("d", "out", "t", "image:3"))).toEqual({ ok: false, reason: "参考图已达模型上限 3 张" });
  });

  it("禁止成环：结果接回产出它的任务链上游", () => {
    const g = board([node("res", "result"), task("t"), task("t2")], [
      edge("t", "result", "res", "in", true),
    ]);
    expect(canConnect(g, table, conn("res", "out", "t", "image:0"))).toEqual({ ok: false, reason: "不能形成环" });
    expect(canConnect(g, table, conn("res", "out", "t2", "image:0")).ok).toBe(true);
  });

  it("未知端口与自连拒绝", () => {
    expect(canConnect(b(), table, conn("p", "out", "t", "bogus")).ok).toBe(false);
    expect(canConnect(b(), table, conn("t", "out", "t", "image:0")).ok).toBe(false);
  });
});

describe("断线与端口重排", () => {
  const three = () => {
    const g = board([node("a", "reference"), node("b", "reference"), node("c", "reference"), task("t")]);
    for (const id of ["a", "b", "c"]) g.edges = connect(g, conn(id, "out", "t", `image:${g.edges.length}`));
    return g;
  };
  const order = (g: Board) =>
    g.edges.filter((e) => e.to[1].startsWith("image:")).sort((x, y) => x.to[1].localeCompare(y.to[1])).map((e) => e.from[0]);

  it("删中间一条后序号紧凑", () => {
    const g = three();
    g.edges = disconnect(g, g.edges.filter((e) => e.from[0] === "b"));
    expect(g.edges.map((e) => [e.from[0], e.to[1]])).toEqual([["a", "image:0"], ["c", "image:1"]]);
  });

  it("系统连线用户不可删", () => {
    const g = board([node("res", "result"), task("t")], [edge("t", "result", "res", "in", true)]);
    expect(disconnect(g, g.edges)).toEqual(g.edges);
  });

  it("拖端口重排：参考图序号 = 端口自上而下顺序", () => {
    const g = three();
    g.edges = moveImagePort(g, "t", 2, 0);
    expect(order(g)).toEqual(["c", "a", "b"]);
    g.edges = moveImagePort(g, "t", 0, 1);
    expect(order(g)).toEqual(["a", "c", "b"]);
  });
});

describe("删除节点", () => {
  it("连带删除相关连线，下游图片端口序号紧凑，image_ports 同步", () => {
    const g = board([node("a", "reference"), node("b", "reference"), task("t")]);
    for (const id of ["a", "b"]) g.edges = connect(g, conn(id, "out", "t", `image:${g.edges.length}`));
    const after = removeNodes(syncImagePorts(g), ["a"]).board;
    expect(after.nodes.map((n) => n.id)).toEqual(["b", "t"]);
    expect(after.edges.map((e) => [e.from[0], e.to[1]])).toEqual([["b", "image:0"]]);
    expect((after.nodes.find((n) => n.id === "t") as TaskNode).image_ports).toBe(1);
  });

  it("被下游引用的结果节点照删：级联断开下游连线并报告断开条数", () => {
    const g = board([node("res", "result"), task("up"), task("t"), task("t2")], [
      edge("up", "result", "res", "in", true),
      edge("res", "out", "t", "image:0"),
      edge("res", "out", "t2", "image:0"),
    ]);
    const r = removeNodes(g, ["res"]);
    expect(r.board.nodes.map((n) => n.id)).toEqual(["up", "t", "t2"]);
    expect(r.board.edges).toEqual([]);
    expect(r).toMatchObject({ removedIds: ["res"], severed: 2 });
  });

  it("删任务节点级联删除其结果列；结果的下游连线一并断开", () => {
    const g = board([node("p", "prompt"), task("up"), node("r1", "result"), node("r2", "result"), node("other", "result"), task("t")], [
      edge("p", "out", "up", "positive"),
      edge("up", "result", "r1", "in", true),
      edge("up", "result", "r2", "in", true),
      edge("r2", "out", "t", "image:0"),
    ]);
    const r = removeNodes(g, ["up"]);
    expect(r.board.nodes.map((n) => n.id)).toEqual(["p", "other", "t"]);
    expect(r.board.edges).toEqual([]);
    // 上游输入线随任务消失不算「断开」；断开 = 通往保留节点的下游连线。
    expect(r).toMatchObject({ removedIds: ["up", "r1", "r2"], severed: 1 });
  });

  it("一同删除的两端之间的连线不算断开", () => {
    const g = board([node("res", "result"), task("t")], [edge("res", "out", "t", "image:0")]);
    expect(removeNodes(g, ["res", "t"])).toMatchObject({ removedIds: ["res", "t"], severed: 0 });
  });

  it("未被引用的结果节点删除：只去掉节点与系统连线，产出任务不受影响", () => {
    const g = board([node("res", "result"), task("t", "qwen-image-3.0-pro", { last_submitted: { task_id: "t-res" } })], [edge("t", "result", "res", "in", true)]);
    const r = removeNodes(g, ["res"]);
    expect(r.board.nodes).toEqual([g.nodes[1]]);
    expect(r.board.edges).toEqual([]);
    expect(r.severed).toBe(0);
  });
});

describe("任务节点露出", () => {
  it("qwen：负向露出、图片端口 = 已接 + 1 空位，上限 3", () => {
    const g = board([node("a", "reference"), task("t")]);
    expect(taskPorts(g, table, "t")).toMatchObject({ negative: true, imageSlots: 1, maxReferences: 3, layerDecomposition: false, transparentBackground: false });
    g.edges = connect(g, conn("a", "out", "t", "image:0"));
    expect(taskPorts(g, table, "t").imageSlots).toBe(2);
  });

  it("负向不支持时不露出；已接的负向线保留端口以便标红", () => {
    const g = board([node("p", "prompt"), task("t", SEEDREAM_PRO)]);
    expect(taskPorts(g, table, "t").negative).toBe(false);
    g.edges.push(edge("p", "out", "t", "negative"));
    expect(taskPorts(g, table, "t").negative).toBe(true);
  });

  it("开关按能力露出；待测不露出", () => {
    const g = board([task("t", SEEDREAM_PRO)]);
    expect(taskPorts(g, table, "t")).toMatchObject({ layerDecomposition: false, transparentBackground: false });
    const t = withModel((m) => {
      m.transparent_background = "supported";
      m.workflows.text_to_image.layer_decomposition = "supported";
    });
    const g2 = board([task("t", "test-model")]);
    expect(taskPorts(g2, t, "t")).toMatchObject({ layerDecomposition: true, transparentBackground: true });
  });

  it("超上限的已接线全部露出端口，不再加空位", () => {
    const refs = ["a", "b", "c", "d"].map((id) => node(id, "reference"));
    const g = board([...refs, task("t")], refs.map((r, i) => edge(r.id, "out", "t", `image:${i}`)));
    expect(taskPorts(g, table, "t").imageSlots).toBe(4);
  });
});

describe("换模型标红：连线与设置保留、节点不可运行", () => {
  it("正向端口必接", () => {
    expect(taskIssues(board([task("t")]), table, "t")).toContain("正向提示词未连接");
  });

  it("合法任务无问题", () => {
    const g = board([node("p", "prompt"), task("t")], [edge("p", "out", "t", "positive")]);
    expect(taskIssues(g, table, "t")).toEqual([]);
  });

  it("参考图线超出新上限", () => {
    const t = withModel((m) => (m.workflows.image_edit.max_references = 1));
    const g = board([node("p", "prompt"), node("a", "reference"), node("b", "reference"), task("t", "test-model")], [
      edge("p", "out", "t", "positive"),
      edge("a", "out", "t", "image:0"),
      edge("b", "out", "t", "image:1"),
    ]);
    expect(taskIssues(g, t, "t")).toEqual(["参考图 2 张超出模型上限 1 张"]);
    expect(g.edges.length).toBe(3);
  });

  it("负向端口在新模型不存在", () => {
    const g = board([node("p", "prompt"), node("n", "prompt"), task("t", SEEDREAM_PRO)], [
      edge("p", "out", "t", "positive"),
      edge("n", "out", "t", "negative"),
    ]);
    expect(taskIssues(g, table, "t")).toContain("模型不支持负向提示词");
  });

  it("图片线接到不支持编辑的模型", () => {
    const t = withModel((m) => {
      m.workflows.image_edit.min_references = 0;
      m.workflows.image_edit.max_references = 0;
    });
    const g = board([node("p", "prompt"), node("a", "reference"), task("t", "test-model")], [
      edge("p", "out", "t", "positive"),
      edge("a", "out", "t", "image:0"),
    ]);
    expect(taskIssues(g, t, "t")).toEqual(["模型不支持图片编辑"]);
  });

  it("开关在新模型不支持", () => {
    const g = board([node("p", "prompt"), task("t", "qwen-image-3.0-pro", { layer_decomposition: true, transparent_background: true })], [
      edge("p", "out", "t", "positive"),
    ]);
    expect(taskIssues(g, table, "t")).toEqual(["模型不支持拆分图层", "模型不支持透明背景"]);
  });

  it("尺寸档位在新模型不存在", () => {
    const g = board([node("p", "prompt"), task("t", "qwen-image-3.0-pro", { size_spec: { tier: "4K", ratio: "1:1", width: null, height: null } })], [
      edge("p", "out", "t", "positive"),
    ]);
    expect(taskIssues(g, table, "t")).toEqual(["生成尺寸 4K · 1:1 不在模型尺寸表内"]);
  });

  it("模型不在能力表或未上架", () => {
    const g = board([node("p", "prompt"), task("t", "nope")], [edge("p", "out", "t", "positive")]);
    expect(taskIssues(g, table, "t")).toEqual(["模型 nope 不在能力表内"]);
    const g2 = board([node("p", "prompt"), task("t", SEEDREAM_PRO, { size_spec: { tier: "2K", ratio: "1:1", width: null, height: null } })], [
      edge("p", "out", "t", "positive"),
    ]);
    expect(taskIssues(g2, table, "t")).toEqual(["模型 Seedream 5.0 pro 未上架"]);
  });

  it("编辑工作流低于最少参考图数不算问题（文生图 0 张合法）", () => {
    const g = board([node("p", "prompt"), task("t")], [edge("p", "out", "t", "positive")]);
    expect(taskIssues(g, table, "t")).toEqual([]);
  });
});

describe("参考图 input_image_rule 校验", () => {
  const rule = BUILTIN_TABLE.models[0].input_image_rule;

  it("合规无提示", () => {
    expect(imageRuleViolations({ format: "png", bytes: 1000, width: 1024, height: 768 }, rule)).toEqual([]);
  });

  it("格式、字节、像素、最短边、宽高比逐项说明", () => {
    expect(imageRuleViolations({ format: "webp", bytes: 11 * 1024 * 1024, width: 3000, height: 300 }, rule)).toEqual([
      "格式 WEBP 不受支持（支持 PNG / JPEG）",
      "文件 11.0 MB 超过上限 10.0 MB",
      "最短边 300 px 小于 384 px",
    ]);
    expect(imageRuleViolations({ format: "png", bytes: 1, width: 4096, height: 4096 }, rule)).toEqual(["总像素 16777216 超过上限 4194304"]);
    const seedream = BUILTIN_TABLE.models[2].input_image_rule;
    expect(imageRuleViolations({ format: "jpeg", bytes: 1, width: 3400, height: 200 }, seedream)).toEqual(["宽高比 17.00 超出 0.06～16.00"]);
  });
});

describe("链深", () => {
  /** 参考图 r → t1 → 结果 x1 → t2 → x2 → t3；文生图 s → 结果 y → t3 的另一端口。 */
  function chain(): Board {
    return board(
      [node("r", "reference"), task("t1"), node("x1", "result"), task("t2"), node("x2", "result"), task("t3"), task("s"), node("y", "result"), task("lone")],
      [img("r", "t1", 0), sys("t1", "x1"), img("x1", "t2", 0), sys("t2", "x2"), img("x2", "t3", 0), sys("s", "y")],
    );
  }
  const img = (from: string, to: string, index: number) => edge(from, "out", to, `image:${index}`);
  const sys = (from: string, to: string) => edge(from, "result", to, "in", true);

  it("从最近的参考图节点到本任务经过的生成任务节点数（含本任务）", () => {
    const b = chain();
    expect(chainDepth(b, "t1")).toBe(1);
    expect(chainDepth(b, "t2")).toBe(2);
    expect(chainDepth(b, "t3")).toBe(3);
    expect(chainDepth(b, "lone")).toBe(1);
  });

  it("多条图片线取最近的一条；文生图任务视作链的起点", () => {
    const b = chain();
    b.edges.push(img("y", "t3", 1));
    expect(chainDepth(b, "t3")).toBe(2);
    b.edges.push(img("r", "t3", 2));
    expect(chainDepth(b, "t3")).toBe(1);
  });

  it("结果节点的产出任务已被删除时，该结果视作原图", () => {
    const b = chain();
    b.nodes = b.nodes.filter((n) => n.id !== "t2");
    b.edges = b.edges.filter((e) => e.from[0] !== "t2" && e.to[0] !== "t2");
    expect(chainDepth(b, "t3")).toBe(1);
  });
});

describe("编辑已提交过的提示词节点：三选", () => {
  const submitted = { task_id: "20260916T000000Z-00000000" };
  /** 提示词 p 正向接 t1（已提交）与 t2（未提交），负向接 t3（已提交）。 */
  function b(): Board {
    const p = { ...(node("p", "prompt") as Extract<BoardNode, { type: "prompt" }>), text: "旧文本", pos: [10, 20] as [number, number], size: [240, 140] as [number, number] };
    return board(
      [p, task("t1", undefined, { last_submitted: submitted }), task("t2"), task("t3", undefined, { last_submitted: submitted })],
      [edge("p", "out", "t1", "positive"), edge("p", "out", "t2", "positive"), edge("p", "out", "t3", "negative")],
    );
  }

  it("下游有执行记录（last_submitted）才需要三选", () => {
    expect(hasDownstreamRecords(b(), "p")).toBe(true);
    const fresh = b();
    fresh.edges = fresh.edges.filter((e) => e.to[0] === "t2");
    expect(hasDownstreamRecords(fresh, "p")).toBe(false);
  });

  it("断开并分叉：旧文本进新提示词节点接回已提交的任务，新文本留在被编辑节点，未提交的任务仍接被编辑节点", () => {
    const next = forkPrompt(b(), "p", { newNodeId: "p-old", text: "新文本" });
    const byId = (id: string) => next.nodes.find((n) => n.id === id);
    // 旧文本在原位新建，被编辑节点让到下方。
    expect(byId("p-old")).toMatchObject({ type: "prompt", text: "旧文本", pos: [10, 20], size: [240, 140] });
    expect(byId("p")).toMatchObject({ type: "prompt", text: "新文本", pos: [10, 184] });
    const from = (task: string) => next.edges.find((e) => e.to[0] === task)?.from[0];
    expect([from("t1"), from("t2"), from("t3")]).toEqual(["p-old", "p", "p-old"]);
    expect(next.edges.find((e) => e.to[0] === "t3")?.to[1]).toBe("negative");
    expect(hasDownstreamRecords(next, "p")).toBe(false);
  });
});

describe("区域指示", () => {
  const REGION = { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };

  it("叠加图占名额：2 条用户线（1 条带区域）占满上限 3，拒绝再连、不再给空位", () => {
    const b = board(
      [node("r1", "reference"), node("r2", "reference"), node("r3", "reference"), task("t")],
      [edge("r1", "out", "t", "image:0"), { ...edge("r2", "out", "t", "image:1"), region: REGION }],
    );
    expect(canConnect(b, table, conn("r3", "out", "t", "image:2"))).toEqual({ ok: false, reason: "参考图已达模型上限 3 张" });
    expect(taskPorts(b, table, "t").imageSlots).toBe(2);
  });

  it("展开后超上限标红、连线保留", () => {
    const b = board(
      [node("p", "prompt"), node("r1", "reference"), node("r2", "reference"), node("r3", "reference"), task("t")],
      [edge("p", "out", "t", "positive"), edge("r1", "out", "t", "image:0"), edge("r2", "out", "t", "image:1"), { ...edge("r3", "out", "t", "image:2"), region: REGION }],
    );
    expect(taskIssues(b, table, "t")).toContain("参考图 4 张超出模型上限 3 张");
    expect(imageEdgesCount(b)).toBe(3);
  });

  it("模型不支持区域指示：有区域连线标红，区域数据保留", () => {
    const b = board(
      [node("p", "prompt"), node("r1", "reference"), task("t", "doubao-seedream-5-0-260128")],
      [edge("p", "out", "t", "positive"), { ...edge("r1", "out", "t", "image:0"), region: REGION }],
    );
    expect(taskIssues(b, table, "t")).toContain("模型不支持框选修改区域");
    expect(b.edges[1].region).toEqual(REGION);
  });

  function imageEdgesCount(b: Board): number {
    return b.edges.filter((e) => e.to[1].startsWith("image:")).length;
  }
});

describe("透明背景：alpha 门控", () => {
  function alphaBoard(): Board {
    const t = { ...task("t"), transparent_background: true };
    return board([node("p", "prompt"), node("r1", "reference"), t], [edge("p", "out", "t", "positive"), edge("r1", "out", "t", "image:0")]);
  }

  it("开关打开、恰好一条线、源图无 alpha → 标红；开关保留", () => {
    const b = alphaBoard();
    expect(transparentAlphaIssue(b, "t", false)).toBe("该图不带透明通道");
    expect((b.nodes.find((n) => n.id === "t") as TaskNode).transparent_background).toBe(true);
  });

  it("带 alpha 或未知（未检测）不拦；开关关闭不拦", () => {
    const b = alphaBoard();
    expect(transparentAlphaIssue(b, "t", true)).toBeNull();
    expect(transparentAlphaIssue(b, "t", undefined)).toBeNull();
    const off = { ...b, nodes: b.nodes.map((n) => (n.type === "task" ? { ...n, transparent_background: false } : n)) };
    expect(transparentAlphaIssue(off, "t", false)).toBeNull();
  });

  it("不是恰好一条线时不归它管（由 taskIssues 的「恰好一条」拦）", () => {
    const supported = withModel((m) => {
      m.transparent_background = "supported";
    });
    const t = { ...task("t", "test-model"), transparent_background: true };
    const b = board([node("p", "prompt"), node("r1", "reference"), t], [edge("p", "out", "t", "positive"), edge("r1", "out", "t", "image:0")]);
    expect(transparentAlphaIssue(b, "t", false)).toBe("该图不带透明通道");
    b.edges = [...b.edges, edge("r1", "out", "t", "image:1")];
    expect(transparentAlphaIssue(b, "t", false)).toBeNull();
    expect(taskIssues(b, supported, "t")).toContain("透明背景需要恰好一条图片线");
  });
});
