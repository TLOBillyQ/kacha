import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE, findModel } from "./capabilities";
import { effectiveRegionRender, expandImageEdges, overlayPhrases, setEdgeRegion } from "./region";

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

function reference(id: string): BoardNode {
  return { id, type: "reference", pos: [0, 0], size: [100, 100], extra: {}, path: `refs/${id}.png`, sha256: "a".repeat(64), display_name: `${id}.png` };
}

function edge(from: string, to: string, port: string, patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from: [from, "out"], to: [to, port], source_layer: null, region: null, system: false, extra: {}, ...patch };
}

function board(nodes: BoardNode[], edges: BoardEdge[]): Board {
  return { format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges, extra: {} };
}

const qwen = findModel(BUILTIN_TABLE, "qwen-image-3.0-pro")!;
const doubao = { ...findModel(BUILTIN_TABLE, "doubao-seedream-5-0-lite-260128")!, region_hint: { highlight_overlay: "untested" as const, marked_image: "unsupported" as const, bbox_tag: "unsupported" as const } };

const REGION = { rects: [[0.1, 0.1, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };

describe("渲染方式推导", () => {
  it("取优先级列表中模型支持的第一个", () => {
    expect(effectiveRegionRender(qwen)).toBe("highlight_overlay");
  });

  it("全部不支持 / 待测时为 null", () => {
    expect(effectiveRegionRender(doubao)).toBeNull();
    expect(effectiveRegionRender(undefined)).toBeNull();
  });

  it("bbox_tag 优先于 highlight_overlay", () => {
    const model = { ...qwen, region_hint: { highlight_overlay: "supported" as const, marked_image: "unsupported" as const, bbox_tag: "supported" as const } };
    expect(effectiveRegionRender(model)).toBe("bbox_tag");
  });
});

describe("端口槽展开", () => {
  it("highlight_overlay：有区域的线贡献原图 + 紧随的叠加槽，序号顺延", () => {
    const edges = [edge("r1", "t", "image:0", { region: REGION }), edge("r2", "t", "image:1")];
    const slots = expandImageEdges(edges, "highlight_overlay");
    expect(slots.map((s) => [s.port, s.kind, s.sourcePort])).toEqual([
      [1, "image", null],
      [2, "overlay", 1],
      [3, "image", null],
    ]);
    expect(slots[1].edge).toBe(edges[0]);
  });

  it("无区域的线不占叠加名额", () => {
    const slots = expandImageEdges([edge("r1", "t", "image:0"), edge("r2", "t", "image:1")], "highlight_overlay");
    expect(slots.map((s) => s.kind)).toEqual(["image", "image"]);
  });

  it("空矩形列表视同无区域", () => {
    const slots = expandImageEdges([edge("r1", "t", "image:0", { region: { ...REGION, rects: [] } })], "highlight_overlay");
    expect(slots).toHaveLength(1);
  });

  it("非 highlight_overlay 渲染不占名额", () => {
    const slots = expandImageEdges([edge("r1", "t", "image:0", { region: REGION })], "bbox_tag");
    expect(slots).toHaveLength(1);
  });

  it("渲染方式为 null 时全部只有原图槽", () => {
    const slots = expandImageEdges([edge("r1", "t", "image:0", { region: REGION })], null);
    expect(slots.map((s) => s.kind)).toEqual(["image"]);
  });
});

describe("区域固定句", () => {
  it("按语言取模板并替换 {source} / {overlay}", () => {
    const slots = expandImageEdges([edge("r1", "t", "image:0", { region: REGION }), edge("r2", "t", "image:1")], "highlight_overlay");
    const zh = overlayPhrases(qwen, slots, "zh");
    expect(zh).toHaveLength(1);
    expect(zh[0]).toContain("图2 是图1 的标注版");
    const en = overlayPhrases(qwen, slots, "en");
    expect(en[0]).toContain("Image 2 is an annotated copy of Image 1");
  });

  it("多个区域各出一句；无叠加槽时为空", () => {
    const two = expandImageEdges([edge("r1", "t", "image:0", { region: REGION }), edge("r2", "t", "image:1", { region: REGION })], "highlight_overlay");
    expect(overlayPhrases(qwen, two, "zh")).toHaveLength(2);
    expect(overlayPhrases(qwen, expandImageEdges([edge("r1", "t", "image:0")], "highlight_overlay"), "zh")).toEqual([]);
  });

  it("模型没有模板时为空", () => {
    const noTemplate = { ...qwen, region_hint_phrasing: {} };
    const slots = expandImageEdges([edge("r1", "t", "image:0", { region: REGION })], "highlight_overlay");
    expect(overlayPhrases(noTemplate, slots, "zh")).toEqual([]);
  });
});

describe("区域 CRUD", () => {
  it("按 from/to 定位连线设置区域", () => {
    const b = board([reference("r1"), task("t")], [edge("r1", "t", "image:0")]);
    const out = setEdgeRegion(b, { from: ["r1", "out"], to: ["t", "image:0"] }, REGION);
    expect(out.edges[0].region).toEqual(REGION);
  });

  it("传 null 清除区域；不匹配的连线不动", () => {
    const b = board(
      [reference("r1"), reference("r2"), task("t")],
      [edge("r1", "t", "image:0", { region: REGION }), edge("r2", "t", "image:1", { region: REGION })],
    );
    const out = setEdgeRegion(b, { from: ["r1", "out"], to: ["t", "image:0"] }, null);
    expect(out.edges[0].region).toBeNull();
    expect(out.edges[1].region).toEqual(REGION);
  });
});
