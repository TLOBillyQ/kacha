import { describe, expect, it } from "vitest";
import { dragRect, isMeaningful, moveRect, resizeRect } from "./rects";

describe("dragRect", () => {
  it("任意方向拖拽都归一化为 [x1, y1, x2, y2]", () => {
    expect(dragRect({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.3 })).toEqual([0.2, 0.3, 0.8, 0.7]);
    expect(dragRect({ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.6 })).toEqual([0.1, 0.2, 0.5, 0.6]);
  });

  it("越界坐标钳回 0–1", () => {
    expect(dragRect({ x: -0.5, y: 0.5 }, { x: 1.5, y: 0.8 })).toEqual([0, 0.5, 1, 0.8]);
  });
});

describe("moveRect", () => {
  it("平移保持形状", () => {
    expect(moveRect([0.125, 0.25, 0.375, 0.5], 0.25, 0.125)).toEqual([0.375, 0.375, 0.625, 0.625]);
  });

  it("整体钳回图内，不缩不变形", () => {
    expect(moveRect([0.125, 0.25, 0.375, 0.75], 5, -5)).toEqual([0.75, 0, 1, 0.5]);
  });
});

describe("resizeRect", () => {
  it("拖动角柄，对角不动", () => {
    expect(resizeRect([0.2, 0.2, 0.6, 0.6], "se", { x: 0.8, y: 0.7 })).toEqual([0.2, 0.2, 0.8, 0.7]);
    expect(resizeRect([0.2, 0.2, 0.6, 0.6], "nw", { x: 0.1, y: 0.4 })).toEqual([0.1, 0.4, 0.6, 0.6]);
    expect(resizeRect([0.2, 0.2, 0.6, 0.6], "ne", { x: 0.9, y: 0.1 })).toEqual([0.2, 0.1, 0.9, 0.6]);
  });

  it("拖过对角时交换边，保持有序", () => {
    expect(resizeRect([0.2, 0.2, 0.6, 0.6], "se", { x: 0.1, y: 0.1 })).toEqual([0.1, 0.1, 0.2, 0.2]);
  });

  it("指针越界钳回 0–1", () => {
    expect(resizeRect([0.2, 0.2, 0.6, 0.6], "se", { x: 2, y: -1 })).toEqual([0.2, 0, 1, 0.2]);
  });
});

describe("isMeaningful", () => {
  it("两边都达到阈值才算有效矩形", () => {
    expect(isMeaningful([0.1, 0.1, 0.2, 0.2])).toBe(true);
    expect(isMeaningful([0.1, 0.1, 0.105, 0.5])).toBe(false);
    expect(isMeaningful([0.1, 0.1, 0.5, 0.1005])).toBe(false);
  });
});
