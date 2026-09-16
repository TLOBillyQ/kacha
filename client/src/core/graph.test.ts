import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE, type CapabilityTable, type ModelCapability } from "./capabilities";
import {
  canConnect,
  connect,
  deletionBlocker,
  removeNodes,
  syncImagePorts,
  disconnect,
  imageRuleViolations,
  moveImagePort,
  taskIssues,
  taskPorts,
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
  it("连带删除相关连线（含系统连线），下游图片端口序号紧凑，image_ports 同步", () => {
    const g = board([node("a", "reference"), node("b", "reference"), node("res", "result"), task("t"), task("up")], [
      edge("up", "result", "res", "in", true),
    ]);
    for (const id of ["a", "b"]) g.edges = connect(g, conn(id, "out", "t", `image:${g.edges.length - 1}`));
    const after = removeNodes(syncImagePorts(g), ["a", "up"]);
    expect(after.nodes.map((n) => n.id)).toEqual(["b", "res", "t"]);
    expect(after.edges.map((e) => [e.from[0], e.to[1]])).toEqual([["b", "image:0"]]);
    expect((after.nodes.find((n) => n.id === "t") as TaskNode).image_ports).toBe(1);
  });

  it("被下游图片端口引用的结果节点禁止删除", () => {
    const g = board([node("res", "result"), task("t")], [edge("res", "out", "t", "image:0")]);
    expect(deletionBlocker(g, ["res"])).toBe("结果已被下游生成任务引用，请先断开连线");
    expect(deletionBlocker(g, ["res", "t"])).toBeNull();
    expect(deletionBlocker(g, ["t"])).toBeNull();
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
