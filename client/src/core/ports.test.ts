import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE } from "./capabilities";
import { canConnect, type Connection } from "./graph";
import { connectablePorts, dragKind, edgeClassName, nodeClassName, portDragClassName, portKey, promptPortKind, type DragState } from "./ports";

const SEEDREAM_PRO = "doubao-seedream-5-0-pro-260628";

function node(id: string, type: "prompt" | "reference"): BoardNode {
  const base = { id, pos: [0, 0] as [number, number], size: [100, 100] as [number, number], extra: {} };
  if (type === "prompt") return { ...base, type, text: "" };
  return { ...base, type, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png` };
}

function task(id: string, model = SEEDREAM_PRO): TaskNode {
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
  };
}

function edge(from: string, to: string, toPort: string): BoardEdge {
  return { from: [from, "out"], to: [to, toPort], source_layer: null, region: null, system: false, extra: {} };
}

function board(nodes: BoardNode[], edges: BoardEdge[] = []): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

const validFor = (b: Board, locked: ReadonlySet<string> = new Set()) => (c: Connection) => !locked.has(c.target) && canConnect(b, BUILTIN_TABLE, c).ok;
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("拖线态合法端口集合", () => {
  it("从参考图输出拖：只有各任务的下一个空图片端口合法", () => {
    const b = board([node("r", "reference"), node("r2", "reference"), node("p", "prompt"), task("t"), task("u")], [edge("r2", "t", "image:0")]);
    const ports = connectablePorts(b, { nodeId: "r", handleId: "out", type: "source" }, validFor(b));
    expect(sorted(ports)).toEqual([portKey("t", "image:1"), portKey("u", "image:0")].sort());
  });

  it("从提示词输出拖：未连的正向端口合法，锁定任务的端口一律不合法", () => {
    const b = board([node("p", "prompt"), node("q", "prompt"), task("t", "qwen-image-3.0-pro"), task("u", "qwen-image-3.0-pro"), task("k", "qwen-image-3.0-pro")], [edge("q", "u", "positive")]);
    const ports = connectablePorts(b, { nodeId: "p", handleId: "out", type: "source" }, validFor(b, new Set(["k"])));
    expect(sorted(ports)).toEqual([portKey("t", "negative"), portKey("t", "positive"), portKey("u", "negative")].sort());
  });

  it("从任务的空输入端口反向拖：可连进来的来源输出端口合法", () => {
    const b = board([node("p", "prompt"), node("r", "reference"), task("t")]);
    expect(sorted(connectablePorts(b, { nodeId: "t", handleId: "image:0", type: "target" }, validFor(b)))).toEqual([portKey("r", "out")]);
    expect(sorted(connectablePorts(b, { nodeId: "t", handleId: "positive", type: "target" }, validFor(b)))).toEqual([portKey("p", "out")]);
  });
});

describe("拖线态类名", () => {
  const drag: DragState = { from: { nodeId: "r", handleId: "out", type: "source" }, ports: new Set([portKey("t", "image:0")]) };

  it("未拖线时端口、节点都不加拖线类名", () => {
    expect(portDragClassName(null, "t", "image:0")).toBe("");
    expect(nodeClassName("u", { lineage: false, selecting: false, drag: null })).toBe("");
  });

  it("起点端口保持原样，合法端口发光，其余端口去强调", () => {
    expect(portDragClassName(drag, "r", "out")).toBe("port-origin");
    expect(portDragClassName(drag, "t", "image:0")).toBe("port-valid");
    expect(portDragClassName(drag, "t", "positive")).toBe("port-invalid");
  });

  it("起点节点与含合法端口的节点不去强调，其余节点去强调", () => {
    const idle = { lineage: false, selecting: false, drag };
    expect(nodeClassName("r", idle)).toBe("");
    expect(nodeClassName("t", idle)).toBe("");
    expect(nodeClassName("u", idle)).toBe("dimmed");
  });

  it("节点 id 含分隔符时不误判为含合法端口", () => {
    const tricky: DragState = { from: drag.from, ports: new Set([portKey("a|b", "positive")]) };
    expect(nodeClassName("a", { lineage: false, selecting: false, drag: tricky })).toBe("dimmed");
  });

  it("谱系节点发光；有选中时非谱系去强调；拖线中改按拖线态去强调", () => {
    expect(nodeClassName("u", { lineage: true, selecting: true, drag: null })).toBe("in-lineage");
    expect(nodeClassName("u", { lineage: false, selecting: true, drag: null })).toBe("dimmed");
    expect(nodeClassName("t", { lineage: false, selecting: true, drag })).toBe("");
    expect(nodeClassName("u", { lineage: true, selecting: true, drag })).toBe("in-lineage dimmed");
  });
});

describe("连线类名", () => {
  const e = (toPort: string, system = false): BoardEdge => ({ ...edge("a", "t", toPort), system });
  const idle = { lineage: false, selecting: false, dragging: false };

  it("按类型着色：图片、正向、负向、系统", () => {
    expect(edgeClassName(e("image:0"), idle)).toBe("edge-image");
    expect(edgeClassName(e("positive"), idle)).toBe("edge-positive");
    expect(edgeClassName(e("negative"), idle)).toBe("edge-negative");
    expect(edgeClassName(e("result", true), idle)).toBe("edge-system");
  });

  it("谱系高亮叠加在类型色上；有选中时非谱系去强调；拖线中一律去强调", () => {
    expect(edgeClassName(e("positive"), { ...idle, lineage: true, selecting: true })).toBe("edge-positive edge-lineage");
    expect(edgeClassName(e("positive"), { ...idle, selecting: true })).toBe("edge-positive dimmed");
    expect(edgeClassName(e("positive"), { ...idle, lineage: true, selecting: true, dragging: true })).toBe("edge-positive edge-lineage dimmed");
  });
});

describe("提示词输出端口类型色", () => {
  it("只连负向端口时为负向色，否则为正向色", () => {
    expect(promptPortKind(board([node("p", "prompt"), task("t")]), "p")).toBe("positive");
    expect(promptPortKind(board([node("p", "prompt"), task("t")], [edge("p", "t", "negative")]), "p")).toBe("negative");
    expect(promptPortKind(board([node("p", "prompt"), task("t"), task("u")], [edge("p", "t", "negative"), edge("p", "u", "positive")]), "p")).toBe("positive");
  });
});

describe("拖线中的连线色", () => {
  it("取起点端口的类型色", () => {
    const b = board([node("p", "prompt"), node("r", "reference"), task("t")], [edge("p", "t", "negative")]);
    expect(dragKind(b, { nodeId: "r", handleId: "out", type: "source" })).toBe("image");
    expect(dragKind(b, { nodeId: "p", handleId: "out", type: "source" })).toBe("negative");
    expect(dragKind(b, { nodeId: "t", handleId: "positive", type: "target" })).toBe("positive");
    expect(dragKind(b, { nodeId: "t", handleId: "image:0", type: "target" })).toBe("image");
  });
});
