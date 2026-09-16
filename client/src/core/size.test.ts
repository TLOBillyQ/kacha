import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "./capabilities";
import { ratiosForSizeTier, resolveSize, sizeTiersOf } from "./size";

const rule = BUILTIN_TABLE.models[0].workflows.text_to_image.size_rule;

describe("档位 × 比例 → 像素", () => {
  it("档位按表声明顺序，比例随档位变化", () => {
    expect(sizeTiersOf(rule)).toEqual(["1K", "2K"]);
    expect(ratiosForSizeTier(rule, "1K")).toEqual(["1:1"]);
    expect(ratiosForSizeTier(rule, "2K")).toEqual(["1:1", "16:9", "9:16"]);
    expect(ratiosForSizeTier(rule, "4K")).toEqual([]);
  });

  it("换算为像素", () => {
    expect(resolveSize(rule, { tier: "2K", ratio: "16:9", width: null, height: null })).toEqual({ width: 1920, height: 1080 });
  });

  it("档位或比例不在表里时返回 null", () => {
    expect(resolveSize(rule, { tier: "1K", ratio: "16:9", width: null, height: null })).toBeNull();
    expect(resolveSize(rule, { tier: "8K", ratio: "1:1", width: null, height: null })).toBeNull();
  });

  it("自定义宽高在区间内按原值、越界返回 null", () => {
    expect(resolveSize(rule, { tier: null, ratio: null, width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(resolveSize(rule, { tier: null, ratio: null, width: 100, height: 100 })).toBeNull();
    expect(resolveSize(rule, { tier: null, ratio: null, width: 2048, height: 128 })).toBeNull();
  });
});
