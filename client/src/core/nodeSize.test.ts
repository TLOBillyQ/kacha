import { describe, expect, it } from "vitest";
import { IMAGE_NODE_MIN, IMAGE_NODE_WIDTH, imageMinSize, imageNodeSize, renderedImageSize, sizeSpecAspect } from "./nodeSize";

describe("图片节点尺寸约束", () => {
  it("新节点默认宽 240px、最小 80px", () => {
    expect(IMAGE_NODE_WIDTH).toBe(240);
    expect(IMAGE_NODE_MIN).toBe(80);
  });

  it("按图片宽高比（高 / 宽）给出等比尺寸", () => {
    expect(imageNodeSize(240, 9 / 16)).toEqual([240, 135]);
    expect(imageNodeSize(240, 16 / 9)).toEqual([240, 427]);
  });

  it("短边不小于 80px：宽图抬高宽度，高图保持宽 80", () => {
    expect(imageNodeSize(100, 1 / 2)).toEqual([160, 80]);
    expect(imageNodeSize(20, 2)).toEqual([80, 160]);
  });

  it("拖角缩放的最小宽高与短边 80px 一致", () => {
    expect(imageMinSize(1 / 2)).toEqual({ minWidth: 160, minHeight: 80 });
    expect(imageMinSize(2)).toEqual({ minWidth: 80, minHeight: 160 });
  });

  it("旧画板：宽度沿用存的 size，高度按实际图片比例，不改存盘尺寸", () => {
    expect(renderedImageSize([200, 220], { width: 1024, height: 512 })).toEqual([200, 100]);
  });

  it("图片尺寸未知时按存的 size 比例显示", () => {
    expect(renderedImageSize([240, 135], undefined)).toEqual([240, 135]);
  });

  it("尺寸设置的比例：档位比例或自定义像素，读不出时为 1", () => {
    expect(sizeSpecAspect({ tier: "2K", ratio: "16:9", width: null, height: null })).toBeCloseTo(9 / 16);
    expect(sizeSpecAspect({ tier: null, ratio: null, width: 1000, height: 500 })).toBe(0.5);
    expect(sizeSpecAspect({ tier: "2K", ratio: null, width: null, height: null })).toBe(1);
  });
});
