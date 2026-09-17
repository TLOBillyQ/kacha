import { describe, expect, it } from "vitest";
import type { Board, BoardNode } from "./board";
import { applySelection, duplicateNodes, isTrackpadPan, nudgeDelta, nudgeNodes, settleAltDrag } from "./selection";

const prompt = (id: string, pos: [number, number]): BoardNode => ({ type: "prompt", id, pos, size: [100, 100], text: id, extra: {} });
const board = (nodes: BoardNode[]): Board => ({ format_version: 1, title: "t", viewport: { zoom: 1, x: 0, y: 0 }, nodes, edges: [], extra: {} });

describe("框选命中", () => {
  it("普通框选：选区 = 框内命中的节点", () => {
    // 框选开始时 React Flow 先清空选区，再按命中逐个选中。
    let s = applySelection(new Set(["a"]), [{ id: "a", selected: false }]);
    s = applySelection(s, [{ id: "b", selected: true }, { id: "c", selected: true }]);
    expect([...s].sort()).toEqual(["b", "c"]);
  });

  it("Shift + 框：保留框选开始前的选区，框内命中加进来", () => {
    const base = new Set(["a"]);
    let s = applySelection(base, [{ id: "a", selected: false }], base);
    s = applySelection(s, [{ id: "b", selected: true }], base);
    // 框缩小后 b 离开框，a 仍保留。
    s = applySelection(s, [{ id: "a", selected: false }, { id: "b", selected: false }], base);
    expect([...s]).toEqual(["a"]);
  });

  it("没有变化时返回原集合（避免无谓重渲染）", () => {
    const s = new Set(["a"]);
    expect(applySelection(s, [{ id: "a", selected: true }, { id: "b", selected: false }])).toBe(s);
  });
});

describe("微移", () => {
  it("方向键 1px，Shift + 方向键 10px；其他键不微移", () => {
    expect(nudgeDelta("ArrowLeft", false)).toEqual([-1, 0]);
    expect(nudgeDelta("ArrowDown", true)).toEqual([0, 10]);
    expect(nudgeDelta("ArrowUp", true)).toEqual([0, -10]);
    expect(nudgeDelta("ArrowRight", false)).toEqual([1, 0]);
    expect(nudgeDelta("a", false)).toBeNull();
  });

  it("只移动选中节点", () => {
    const b = nudgeNodes(board([prompt("a", [0, 0]), prompt("b", [5, 5])]), ["a"], [0, 10]);
    expect(b.nodes.map((n) => [n.id, n.type === "unknown" ? null : n.pos])).toEqual([
      ["a", [0, 10]],
      ["b", [5, 5]],
    ]);
  });

  it("没有选中节点时画板不变", () => {
    const b = board([prompt("a", [0, 0])]);
    expect(nudgeNodes(b, [], [1, 0])).toBe(b);
  });
});

describe("原地复制", () => {
  it("按偏移复制选中节点，返回原节点 → 副本的对应", () => {
    let n = 0;
    const r = duplicateNodes(board([prompt("a", [10, 20]), prompt("b", [0, 0])]), ["a"], () => `new${++n}`, 40);
    expect(r.ids).toEqual(["new1"]);
    expect(r.pairs).toEqual([["a", "new1"]]);
    expect(r.board.nodes.find((x) => x.id === "new1")).toMatchObject({ pos: [50, 60], text: "a" });
    expect(r.board.nodes).toHaveLength(3);
  });

  it("Alt + 拖松手：原节点回到起点，副本落在松手处（被拖走的是副本）", () => {
    const dragged = board([prompt("a", [300, 200]), prompt("copy", [0, 0])]);
    const b = settleAltDrag(dragged, [["a", "copy"]], new Map([["a", [0, 0] as [number, number]]]));
    expect(b.nodes.map((x) => [x.id, x.type === "unknown" ? null : x.pos])).toEqual([
      ["a", [0, 0]],
      ["copy", [300, 200]],
    ]);
  });
});

describe("滚轮 / 触控板", () => {
  const wheel = (patch: Partial<{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; altKey: boolean }>) => ({
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    ctrlKey: false,
    altKey: false,
    ...patch,
  });

  it("鼠标滚轮 = 缩放", () => {
    expect(isTrackpadPan(wheel({}))).toBe(false);
    expect(isTrackpadPan(wheel({ deltaY: -3, deltaMode: 1 }))).toBe(false);
  });

  it("触控板双指滑动（带横向分量或非整数增量）= 平移", () => {
    expect(isTrackpadPan(wheel({ deltaX: 4, deltaY: 0 }))).toBe(true);
    expect(isTrackpadPan(wheel({ deltaY: 2.5 }))).toBe(true);
  });

  it("捏合（ctrlKey）、Ctrl + 滚轮、Alt + 滚轮一律缩放", () => {
    expect(isTrackpadPan(wheel({ deltaY: 2.5, ctrlKey: true }))).toBe(false);
    expect(isTrackpadPan(wheel({ deltaX: 4, altKey: true }))).toBe(false);
  });
});
