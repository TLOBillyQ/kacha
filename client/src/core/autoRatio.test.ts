import { describe, expect, it } from "vitest";
import { newBoard, parseBoard, serializeBoard, type Board, type BoardEdge, type BoardNode, type TaskNode } from "./board";
import { syncAutoRatios, followedImage } from "./autoRatio";
import { BUILTIN_TABLE } from "./capabilities";
import { emptyHistory, recordChange, undo } from "./history";
import { autoSizeSpec, isAutoRatio, resolveSize, type SizeSpec } from "./size";

const QWEN = "qwen-image-3.0";
const PRO = "doubao-seedream-5-0-pro-260628";
const ruleOf = (id: string) => BUILTIN_TABLE.models.find((m) => m.model_id === id)!.workflows.image_edit.size_rule;

function reference(id: string): BoardNode {
  return { id, type: "reference", pos: [0, 0], size: [200, 200], extra: {}, path: `${id}.png`, sha256: "0".repeat(64), display_name: `${id}.png` };
}

function task(id: string, model: string, size_spec: SizeSpec): TaskNode {
  return { id, type: "task", pos: [0, 0], size: [280, 260], extra: {}, model, size_spec, image_ports: 0, layer_decomposition: false, transparent_background: false, last_submitted: null };
}

function edge(from: string, to: string, port: number, patch: Partial<BoardEdge> = {}): BoardEdge {
  return { from: [from, "out"], to: [to, `image:${port}`], source_layer: null, region: null, system: false, extra: {}, ...patch };
}

const REGION = { rects: [[0, 0, 0.5, 0.5] as [number, number, number, number]], render: "highlight_overlay" as const };
const DIMS: Record<string, [number, number]> = { wide: [1920, 1080], tall: [900, 1200], odd: [1000, 700], long: [4000, 200] };
const dims = (id: string) => DIMS[id];

function boardOf(model: string, spec: SizeSpec, edges: BoardEdge[]): Board {
  return { ...newBoard(), nodes: [...Object.keys(DIMS).map(reference), reference("lost"), task("t", model, spec)], edges };
}

const specOf = (board: Board) => (board.nodes.find((n) => n.id === "t") as TaskNode).size_spec;
const AUTO_PRO = autoSizeSpec(ruleOf(PRO), "2K", null, null);

describe("自动宽高比跟随哪张图", () => {
  it("没有区域指示时跟随图1；没有参考图为 null", () => {
    expect(followedImage(boardOf(PRO, AUTO_PRO, []), "t")).toBeNull();
    expect(followedImage(boardOf(PRO, AUTO_PRO, [edge("tall", "t", 1), edge("wide", "t", 0)]), "t")).toEqual({ image: 1, nodeId: "wide" });
  });

  it("跟随序号最前的带区域指示的参考图；空区域不算", () => {
    const edges = [edge("wide", "t", 0, { region: { ...REGION, rects: [] } }), edge("tall", "t", 1, { region: REGION }), edge("odd", "t", 2, { region: REGION })];
    expect(followedImage(boardOf(PRO, AUTO_PRO, edges), "t")).toEqual({ image: 2, nodeId: "tall" });
  });
});

describe("自动宽高比随画板变更重算", () => {
  it("图1 是 16:9：宽高比变为 16:9，发出的是该分辨率档的查表像素", () => {
    const spec = specOf(syncAutoRatios(boardOf(PRO, AUTO_PRO, [edge("wide", "t", 0)]), BUILTIN_TABLE, dims));
    expect(spec.ratio).toBe("16:9");
    expect(spec.auto_ratio).toEqual({ ratio: "16:9", image: 1, source: [1920, 1080] });
    expect(resolveSize(ruleOf(PRO), spec)).toEqual({ width: 2816, height: 1584 });
  });

  it("图1 换成 3:4 后跟着变；手动后不再变；选回自动恢复跟随", () => {
    let board = syncAutoRatios(boardOf(PRO, AUTO_PRO, [edge("wide", "t", 0)]), BUILTIN_TABLE, dims);
    board = syncAutoRatios({ ...board, edges: [edge("tall", "t", 0)] }, BUILTIN_TABLE, dims);
    expect(specOf(board).ratio).toBe("3:4");

    const manual = boardOf(PRO, { tier: "2K", ratio: "1:1", width: null, height: null }, [edge("wide", "t", 0)]);
    expect(syncAutoRatios(manual, BUILTIN_TABLE, dims)).toBe(manual);

    const back = boardOf(PRO, autoSizeSpec(ruleOf(PRO), "2K", null, null, specOf(manual)), [edge("wide", "t", 0)]);
    expect(specOf(syncAutoRatios(back, BUILTIN_TABLE, dims)).ratio).toBe("16:9");
  });

  it("区域指示画在图2 上时跟随图2，删掉区域后回到图1", () => {
    const edges = [edge("wide", "t", 0), edge("tall", "t", 1, { region: REGION })];
    const board = syncAutoRatios(boardOf(PRO, AUTO_PRO, edges), BUILTIN_TABLE, dims);
    expect(specOf(board).auto_ratio).toMatchObject({ ratio: "3:4", image: 2 });
    const cleared = syncAutoRatios({ ...board, edges: [edge("wide", "t", 0), edge("tall", "t", 1)] }, BUILTIN_TABLE, dims);
    expect(specOf(cleared).auto_ratio).toMatchObject({ ratio: "16:9", image: 1 });
  });

  it("连线带来源图层时仍按该节点（底图）的宽高", () => {
    const board = syncAutoRatios(boardOf(PRO, AUTO_PRO, [edge("wide", "t", 0, { source_layer: 2 })]), BUILTIN_TABLE, dims);
    expect(specOf(board).ratio).toBe("16:9");
  });

  it("拔掉全部参考图回到 1:1", () => {
    const board = syncAutoRatios(boardOf(PRO, AUTO_PRO, [edge("wide", "t", 0)]), BUILTIN_TABLE, dims);
    expect(specOf(syncAutoRatios({ ...board, edges: [] }, BUILTIN_TABLE, dims)).auto_ratio).toEqual({ ratio: "1:1", image: null, source: null });
  });

  it("读不到图时保留上次算出的值，不回落到 1:1", () => {
    const board = syncAutoRatios(boardOf(PRO, AUTO_PRO, [edge("wide", "t", 0)]), BUILTIN_TABLE, dims);
    expect(syncAutoRatios(board, BUILTIN_TABLE, () => undefined)).toBe(board);
    const swapped = syncAutoRatios({ ...board, edges: [edge("lost", "t", 0)] }, BUILTIN_TABLE, dims);
    expect(specOf(swapped).ratio).toBe("16:9");
  });

  it("换模型 / 分辨率档后不读图也按新规则重算：长图在 Seedream 钳到 16:1，在 qwen 钳到 8:1", () => {
    const board = syncAutoRatios(boardOf(PRO, AUTO_PRO, [edge("long", "t", 0)]), BUILTIN_TABLE, dims);
    expect(specOf(board).ratio).toBe("16:1");
    const switched = { ...board, nodes: board.nodes.map((n) => (n.id === "t" && n.type === "task" ? { ...n, model: QWEN } : n)) };
    const spec = specOf(syncAutoRatios(switched, BUILTIN_TABLE, () => undefined));
    expect(spec.ratio).toBe("8:1");
    expect(isAutoRatio(spec)).toBe(true);
  });

  it("新模型没有该分辨率档时不动（沿用「不支持」标红）", () => {
    const board = boardOf(QWEN, autoSizeSpec(ruleOf(PRO), "1.5K", null, null), [edge("wide", "t", 0)]);
    expect(syncAutoRatios(board, BUILTIN_TABLE, dims)).toBe(board);
  });

  it("跳过锁定（排队 / 执行中）的任务；无变化时返回原画板", () => {
    const board = boardOf(PRO, AUTO_PRO, [edge("wide", "t", 0)]);
    expect(syncAutoRatios(board, BUILTIN_TABLE, dims, new Set(["t"]))).toBe(board);
    const synced = syncAutoRatios(board, BUILTIN_TABLE, dims);
    expect(syncAutoRatios(synced, BUILTIN_TABLE, dims)).toBe(synced);
  });
});

describe("撤销（ADR 0012）", () => {
  it("接入图1 与随之的自动重算是同一个撤销步：撤销一次，连线与宽高比一起恢复", () => {
    const before = boardOf(PRO, AUTO_PRO, []);
    const after = syncAutoRatios({ ...before, edges: [edge("wide", "t", 0)] }, BUILTIN_TABLE, dims);
    const history = recordChange(emptyHistory(), before, { label: "连线" }, 0);
    expect(history.undo).toHaveLength(1);
    const back = undo(history, after, new Set())!;
    expect(back.board.edges).toEqual([]);
    expect(specOf(back.board)).toEqual(AUTO_PRO);
    expect(back.history.undo).toHaveLength(0);
    // 撤销后的画板已自洽，补算不再产生变更。
    expect(syncAutoRatios(back.board, BUILTIN_TABLE, dims)).toBe(back.board);
  });
});

describe("画板文件兼容", () => {
  it("没有 auto_ratio 的旧任务节点是手动，读写后原样", () => {
    const board = boardOf(PRO, { tier: "2K", ratio: "16:9", width: null, height: null }, []);
    const parsed = parseBoard(serializeBoard(board));
    expect(parsed.kind === "ok" && specOf(parsed.board)).toEqual({ tier: "2K", ratio: "16:9", width: null, height: null });
  });

  it("auto_ratio 读写往返；格式不对的当作手动", () => {
    const board = syncAutoRatios(boardOf(PRO, AUTO_PRO, [edge("wide", "t", 0)]), BUILTIN_TABLE, dims);
    const parsed = parseBoard(serializeBoard(board));
    expect(parsed.kind === "ok" && specOf(parsed.board)).toEqual(specOf(board));

    const broken = JSON.parse(serializeBoard(board));
    broken.nodes.find((n: { id: string }) => n.id === "t").size_spec.auto_ratio = { ratio: 3 };
    const reparsed = parseBoard(JSON.stringify(broken));
    expect(reparsed.kind === "ok" && isAutoRatio(specOf(reparsed.board))).toBe(false);
  });
});
