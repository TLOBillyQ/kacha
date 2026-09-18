import { describe, expect, it } from "vitest";
import type { Board, BoardEdge, BoardNode, TaskNode } from "./board";
import { BUILTIN_TABLE, findModel } from "./capabilities";
import { effectiveRegionRender, expandImageEdges, setEdgeRegion, slotsFromReferences, type SlotRef } from "./region";

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

  it("只认客户端已实现的渲染方式：能力表标了 bbox_tag / marked_image 支持、高亮叠加不支持时为 null", () => {
    const model = { ...qwen, region_hint: { highlight_overlay: "unsupported" as const, marked_image: "supported" as const, bbox_tag: "supported" as const } };
    expect(effectiveRegionRender(model)).toBeNull();
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

  it("用户序号只数用户连线：叠加槽记原图的用户序号，后面的用户图序号不后移", () => {
    const edges = [edge("r1", "t", "image:0", { region: REGION }), edge("r2", "t", "image:1")];
    const slots = expandImageEdges(edges, "highlight_overlay");
    expect(slots.map((s) => [s.kind, s.port, s.userPort])).toEqual([
      ["image", 1, 1],
      ["overlay", 2, 1],
      ["image", 3, 2],
    ]);
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

describe("从任务记录重建槽", () => {
  /** 槽的最小形状：去掉来源连线，便于和重建结果比较。 */
  const shape = (slots: SlotRef[]): SlotRef[] => slots.map(({ kind, port, userPort, sourcePort, regionCount }) => ({ kind, port, userPort, sourcePort, regionCount }));

  // #113 之前的旧口径 task.json：send_text 里叠加图占了用户序号（「把图2的少女」实指发送图3）；references[] 形状不变。
  const OLD_TASK_JSON = {
    task_id: "20260915T080000Z-0a1b2c3d",
    workflow: "image_edit",
    model: "qwen-image-3.0-pro",
    prompt: "把@图2的少女放入图1",
    send_text: "本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图2的少女放入图1\n图2 是图1 的标注版，紫色、黄色半透明高亮标出的是要修改的区域。",
    references: [
      { file: "reference-1.png", media_type: "image/png", sha256: "a".repeat(64), source: { kind: "reference", path: "refs/r1.png", sha256: "a".repeat(64) } },
      {
        file: "reference-2.png",
        media_type: "image/png",
        sha256: "b".repeat(64),
        source: { kind: "overlay", of: 1 },
        region: { rects: [[0.1, 0.1, 0.5, 0.5], [0.6, 0.6, 0.9, 0.9]], render: "highlight_overlay", source_port: 1 },
      },
      { file: "reference-3.png", media_type: "image/png", sha256: "c".repeat(64), source: { kind: "result", task_id: "20260914T000000Z-00000000", file: "result.png" } },
    ],
  };

  it("旧口径 task.json 重建的槽与从画板展开的槽一致", () => {
    const two = { ...REGION, rects: [REGION.rects[0], REGION.rects[0]] };
    const fromBoard = expandImageEdges([edge("r1", "t", "image:0", { region: two }), edge("r2", "t", "image:1")], "highlight_overlay");
    expect(slotsFromReferences(OLD_TASK_JSON.references)).toEqual(shape(fromBoard));
  });

  it("多张图各带区域、无参考图", () => {
    const edges = [edge("r1", "t", "image:0", { region: REGION }), edge("r2", "t", "image:1"), edge("r3", "t", "image:2", { region: REGION })];
    const fromBoard = shape(expandImageEdges(edges, "highlight_overlay"));
    const references = fromBoard.map((s) =>
      s.kind === "overlay"
        ? { source: { kind: "overlay", of: s.sourcePort! }, region: { rects: REGION.rects, render: "highlight_overlay" as const, source_port: s.sourcePort! } }
        : { source: { kind: "reference" } },
    );
    expect(slotsFromReferences(references)).toEqual(fromBoard);
    expect(slotsFromReferences([])).toEqual([]);
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
