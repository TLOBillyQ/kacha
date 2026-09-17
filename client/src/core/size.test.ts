import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "./capabilities";
import { ratiosForSizeTier, resolveSize, sizeTiersOf, withinPixelRange } from "./size";

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

describe("Seedream 5.0 档位 × 比例按官方映射表（API 参考 82379/1541523）", () => {
  const RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"];
  const seedream = (id: string) => BUILTIN_TABLE.models.find((m) => m.model_id === id)!;
  const pro = seedream("doubao-seedream-5-0-pro-260628");
  const lite = seedream("doubao-seedream-5-0-lite-260128");

  it("pro：1K / 1.5K / 2K，lite：2K / 3K / 4K，各 8 个比例；文生图与图片编辑同表", () => {
    for (const [model, tiers] of [
      [pro, ["1K", "1.5K", "2K"]],
      [lite, ["2K", "3K", "4K"]],
    ] as const) {
      const { text_to_image, image_edit } = model.workflows;
      expect(image_edit.size_rule).toEqual(text_to_image.size_rule);
      expect(sizeTiersOf(text_to_image.size_rule)).toEqual(tiers);
      for (const tier of tiers) expect(ratiosForSizeTier(text_to_image.size_rule, tier)).toEqual(RATIOS);
    }
  });

  it("换算抽样对照官方表", () => {
    const at = (model: typeof pro, tier: string, ratio: string) => resolveSize(model.workflows.image_edit.size_rule, { tier, ratio, width: null, height: null });
    expect(at(pro, "1K", "16:9")).toEqual({ width: 1424, height: 800 });
    expect(at(pro, "1.5K", "21:9")).toEqual({ width: 2352, height: 1008 });
    expect(at(pro, "2K", "16:9")).toEqual({ width: 2816, height: 1584 });
    expect(at(pro, "2K", "3:4")).toEqual({ width: 1776, height: 2368 });
    expect(at(lite, "2K", "16:9")).toEqual({ width: 2848, height: 1600 });
    expect(at(lite, "3K", "4:3")).toEqual({ width: 3456, height: 2592 });
    expect(at(lite, "4K", "9:16")).toEqual({ width: 3040, height: 5504 });
    expect(at(lite, "4K", "21:9")).toEqual({ width: 6240, height: 2656 });
  });

  it("每个档位像素都落在该模型像素模式的总像素与宽高比区间内，比例与标称一致（±2%）", () => {
    for (const model of [pro, lite]) {
      const rule = model.workflows.text_to_image.size_rule;
      for (const [tier, ratios] of Object.entries(rule.tiers)) {
        for (const [ratio, [w, h]] of Object.entries(ratios)) {
          expect(withinPixelRange(rule.custom!, w, h), `${model.model_id} ${tier} ${ratio}`).toBe(true);
          const [rw, rh] = ratio.split(":").map(Number);
          expect(Math.abs(w / h / (rw / rh) - 1), `${model.model_id} ${tier} ${ratio}`).toBeLessThan(0.02);
        }
      }
    }
  });
});
