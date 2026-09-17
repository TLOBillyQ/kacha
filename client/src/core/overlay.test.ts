import { describe, expect, it } from "vitest";
import { applyHighlightOverlay, denormalizeRect, OVERLAY_RGB } from "./overlay";

/** w×h 的 RGBA 缓冲，fill 为每像素值。 */
function rgba(w: number, h: number, fill: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(fill, i * 4);
  return out;
}

const px = (buf: Uint8Array, w: number, x: number, y: number) => [...buf.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe("坐标归一化", () => {
  it("0–1 坐标换算成像素坐标（取整、含边界）", () => {
    expect(denormalizeRect([0.25, 0.5, 0.75, 1], 100, 200)).toEqual([25, 100, 75, 200]);
  });

  it("越界收敛到图内，反向矩形自动交换", () => {
    expect(denormalizeRect([-0.5, 1.2, 0.5, 0.4], 100, 100)).toEqual([0, 40, 50, 100]);
    expect(denormalizeRect([0.8, 0.9, 0.2, 0.3], 100, 100)).toEqual([20, 30, 80, 90]);
  });
});

describe("高亮叠加合成", () => {
  it("紫色 RGB(128,0,255) 50% 混合，alpha 不变", () => {
    expect(OVERLAY_RGB).toEqual([128, 0, 255]);
    const src = rgba(2, 1, [100, 200, 50, 77]);
    const out = applyHighlightOverlay(src, 2, 1, [[0, 0, 0.5, 1]]);
    // round((100+128)/2)=114, round((200+0)/2)=100, round((50+255)/2)=153(152.5→153)
    expect(px(out, 2, 0, 0)).toEqual([114, 100, 153, 77]);
    expect(px(out, 2, 1, 0)).toEqual([100, 200, 50, 77]);
  });

  it("不修改输入缓冲", () => {
    const src = rgba(1, 1, [0, 0, 0, 255]);
    applyHighlightOverlay(src, 1, 1, [[0, 0, 1, 1]]);
    expect(px(src, 1, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("多个矩形合成到同一张图上，按区域编号分色（紫、黄）", () => {
    const src = rgba(4, 1, [0, 0, 0, 255]);
    const out = applyHighlightOverlay(src, 4, 1, [
      [0, 0, 0.25, 1],
      [0.75, 0, 1, 1],
    ]);
    expect(px(out, 4, 0, 0)).toEqual([64, 0, 128, 255]);
    expect(px(out, 4, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(px(out, 4, 3, 0)).toEqual([128, 110, 0, 255]);
  });

  it("firstRegion 让编号接着前一张图的区域往下排", () => {
    const out = applyHighlightOverlay(rgba(1, 1, [0, 0, 0, 255]), 1, 1, [[0, 0, 1, 1]], 2);
    expect(px(out, 1, 0, 0)).toEqual([128, 0, 80, 255]);
  });

  it("完全越界的矩形不画任何东西", () => {
    const src = rgba(2, 2, [10, 10, 10, 255]);
    const out = applyHighlightOverlay(src, 2, 2, [[2, 2, 3, 3]]);
    expect([...out]).toEqual([...src]);
  });
});
