import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE } from "./capabilities";
import { autoRatioLabel, autoSizeSpec, commitRatioInput, inferRatio, isAutoRatio, ratioRangeText, ratiosForSizeTier, resolveSize, sizeTiersOf, withinPixelRange, withSizeTier } from "./size";

const rule = BUILTIN_TABLE.models[0].workflows.text_to_image.size_rule;

describe("分辨率档 × 宽高比 → 像素", () => {
  it("分辨率档按表声明顺序，宽高比随分辨率档变化", () => {
    expect(sizeTiersOf(rule)).toEqual(["1K", "2K"]);
    expect(ratiosForSizeTier(rule, "1K")).toEqual(["1:1"]);
    expect(ratiosForSizeTier(rule, "2K")).toEqual(["1:1", "16:9", "9:16"]);
    expect(ratiosForSizeTier(rule, "4K")).toEqual([]);
  });

  it("换算为像素", () => {
    expect(resolveSize(rule, { tier: "2K", ratio: "16:9", width: null, height: null })).toEqual({ width: 1920, height: 1080 });
  });

  it("分辨率档不在表里、或没有 custom 范围的模型宽高比不在表里时返回 null", () => {
    expect(resolveSize(rule, { tier: "8K", ratio: "1:1", width: null, height: null })).toBeNull();
    expect(resolveSize({ ...rule, custom: null }, { tier: "1K", ratio: "16:9", width: null, height: null })).toBeNull();
  });

  it("自定义宽高在区间内按原值、越界返回 null", () => {
    expect(resolveSize(rule, { tier: null, ratio: null, width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(resolveSize(rule, { tier: null, ratio: null, width: 100, height: 100 })).toBeNull();
    expect(resolveSize(rule, { tier: null, ratio: null, width: 2048, height: 128 })).toBeNull();
  });
});

describe("Seedream 5.0 分辨率档 × 宽高比按官方映射表（API 参考 82379/1541523）", () => {
  const RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"];
  const seedream = (id: string) => BUILTIN_TABLE.models.find((m) => m.model_id === id)!;
  const pro = seedream("doubao-seedream-5-0-pro-260628");
  const lite = seedream("doubao-seedream-5-0-lite-260128");

  it("pro：1K / 1.5K / 2K，lite：2K / 3K / 4K，各 8 个宽高比；文生图与图片编辑同表", () => {
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

  it("每个分辨率档的像素都落在该模型像素模式的总像素与宽高比区间内，宽高比与标称一致（±2%）", () => {
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

describe("自动宽高比：吸附、钳制、像素换算", () => {
  const model = (id: string) => BUILTIN_TABLE.models.find((m) => m.model_id === id)!.workflows.image_edit.size_rule;
  const qwen = model("qwen-image-3.0");
  const pro = model("doubao-seedream-5-0-pro-260628");
  const lite = model("doubao-seedream-5-0-lite-260128");
  const auto = (r: typeof qwen, tier: string, image: number | null, source: [number, number] | null) => autoSizeSpec(r, tier, image, source);

  it("与预设宽高比相差 ±3% 内吸附到预设，发送像素查表", () => {
    const spec = auto(pro, "2K", 1, [1918, 1080]);
    expect(spec.ratio).toBe("16:9");
    expect(isAutoRatio(spec)).toBe(true);
    expect(resolveSize(pro, spec)).toEqual({ width: 2816, height: 1584 });
    expect(inferRatio(pro, "1K", [1030, 1000])).toEqual({ ratio: "1:1", limited: false });
    expect(inferRatio(pro, "1K", [1040, 1000]).ratio).toBe("26:25");
  });

  it("预设只在别的分辨率档里时仍按预设命名，像素按面积换算", () => {
    const spec = auto(qwen, "1K", 1, [1920, 1080]);
    expect(spec.ratio).toBe("16:9");
    expect(resolveSize(qwen, spec)).toEqual({ width: 1360, height: 768 });
  });

  it("非预设宽高比保留原始 W:H；像素为 16 的倍数、面积接近该档 1:1、在总像素范围内", () => {
    for (const [r, tier] of [
      [qwen, "1K"],
      [qwen, "2K"],
      [pro, "1K"],
      [pro, "2K"],
      [lite, "2K"],
      [lite, "4K"],
    ] as const) {
      const spec = auto(r, tier, 1, [1000, 700]);
      expect(spec.ratio).toBe("10:7");
      const px = resolveSize(r, spec)!;
      const [sw, sh] = r.tiers[tier]["1:1"];
      expect(px.width % 16).toBe(0);
      expect(px.height % 16).toBe(0);
      expect(Math.abs((px.width * px.height) / (sw * sh) - 1)).toBeLessThan(0.05);
      expect(Math.abs(px.width / px.height / (10 / 7) - 1)).toBeLessThan(0.02);
      expect(withinPixelRange(r.custom!, px.width, px.height)).toBe(true);
    }
  });

  it("越界钳制到模型的宽高比边界并标记已限制", () => {
    expect(inferRatio(pro, "1K", [4000, 200])).toEqual({ ratio: "16:1", limited: true });
    expect(inferRatio(qwen, "1K", [4000, 200])).toEqual({ ratio: "8:1", limited: true });
    expect(inferRatio(qwen, "1K", [200, 4000])).toEqual({ ratio: "1:8", limited: true });
    for (const [r, tier] of [
      [qwen, "1K"],
      [qwen, "2K"],
      [pro, "1K"],
      [lite, "4K"],
    ] as const) {
      const px = resolveSize(r, auto(r, tier, 1, [4000, 200]))!;
      expect(withinPixelRange(r.custom!, px.width, px.height)).toBe(true);
      expect(px.width % 16 + (px.height % 16)).toBe(0);
    }
  });

  it("模型没有自定义像素范围时只落在当前分辨率档的预设上", () => {
    const fixed = { ...qwen, custom: null };
    expect(inferRatio(fixed, "1K", [1920, 1080])).toEqual({ ratio: "1:1", limited: false });
    expect(inferRatio(fixed, "2K", [1000, 700]).ratio).toBe("16:9");
    expect(resolveSize(fixed, autoSizeSpec(fixed, "2K", 1, [1000, 700]))).toEqual({ width: 1920, height: 1080 });
  });

  it("没有参考图时为 1:1", () => {
    const spec = auto(qwen, "1K", null, null);
    expect(spec).toEqual({ tier: "1K", ratio: "1:1", width: null, height: null, auto_ratio: { ratio: "1:1", image: null, source: null } });
  });

  it("旧客户端改过宽高比（与缓存不一致）视为手动", () => {
    const edited = { ...auto(qwen, "2K", 1, [1000, 700]), ratio: "9:16" };
    expect(isAutoRatio(edited)).toBe(false);
    expect(isAutoRatio({ tier: "1K", ratio: "1:1", width: null, height: null })).toBe(false);
  });

  it("标签：自动（16:9 · 图1）/ ≈ / 已限制 / 无参考图", () => {
    expect(autoRatioLabel(pro, auto(pro, "2K", 1, [1920, 1080]))).toBe("自动（16:9 · 图1）");
    expect(autoRatioLabel(pro, auto(pro, "2K", 2, [1000, 700]))).toBe("自动（≈1.43:1 · 图2）");
    expect(autoRatioLabel(pro, auto(pro, "2K", 1, [700, 1000]))).toBe("自动（≈1:1.43 · 图1）");
    expect(autoRatioLabel(qwen, auto(qwen, "1K", 1, [4000, 200]))).toBe("自动（8:1 · 图1，已限制）");
    expect(autoRatioLabel(qwen, auto(qwen, "1K", null, null))).toBe("自动（1:1）");
  });
});

describe("手填宽高比", () => {
  const model = (id: string) => BUILTIN_TABLE.models.find((m) => m.model_id === id)!.workflows.image_edit.size_rule;
  const qwen = model("qwen-image-3.0");
  const pro = model("doubao-seedream-5-0-pro-260628");
  const manual = (tier: string, ratio: string) => ({ tier, ratio, width: null, height: null });

  it("四个上架模型都能手填非预设的 5:2：像素按该分辨率档 1:1 的面积、16 的倍数", () => {
    for (const m of BUILTIN_TABLE.models.filter((m) => m.tier !== null)) {
      const r = m.workflows.image_edit.size_rule;
      const tier = sizeTiersOf(r)[0];
      expect(commitRatioInput(r, "5:2")).toEqual({ ratio: "5:2", clamped: false });
      const px = resolveSize(r, manual(tier, "5:2"))!;
      const base = r.tiers[tier]["1:1"];
      expect(px.width % 16).toBe(0);
      expect(px.height % 16).toBe(0);
      expect(px.width / px.height / 2.5).toBeCloseTo(1, 1);
      expect((px.width * px.height) / (base[0] * base[1])).toBeCloseTo(1, 1);
    }
  });

  it("命中预设查表；手动与自动换算一致", () => {
    expect(resolveSize(qwen, manual("2K", "16:9"))).toEqual({ width: qwen.tiers["2K"]["16:9"][0], height: qwen.tiers["2K"]["16:9"][1] });
    expect(resolveSize(pro, manual("2K", "10:7"))).toEqual(resolveSize(pro, autoSizeSpec(pro, "2K", 1, [1000, 700])));
  });

  it("输入归一化：全角冒号、空白、约分、小数", () => {
    expect(commitRatioInput(qwen, " 32：18 ")).toEqual({ ratio: "16:9", clamped: false });
    expect(commitRatioInput(qwen, "2.35:1")).toEqual({ ratio: "2.35:1", clamped: false });
    expect(commitRatioInput(qwen, "5 : 2")).toEqual({ ratio: "5:2", clamped: false });
  });

  it("越界钳制到模型边界并给出范围", () => {
    expect(commitRatioInput(qwen, "12:1")).toEqual({ ratio: "8:1", clamped: true });
    expect(commitRatioInput(qwen, "1:12")).toEqual({ ratio: "1:8", clamped: true });
    expect(commitRatioInput(pro, "12:1")).toEqual({ ratio: "12:1", clamped: false });
    const odd = { ...qwen, custom: { ...qwen.custom!, min_aspect_ratio: 1 / 2.336, max_aspect_ratio: 2.336 } };
    expect(commitRatioInput(odd, "3:1")).toEqual({ ratio: "2.33:1", clamped: true });
    expect(commitRatioInput(odd, "1:3")).toEqual({ ratio: "1:2.33", clamped: true });
    expect(ratioRangeText(qwen)).toBe("1:8–8:1");
    expect(ratioRangeText(pro)).toBe("1:16–16:1");
    expect(resolveSize(qwen, manual("1K", "8:1"))).not.toBeNull();
    expect(resolveSize(qwen, manual("1K", "1:8"))).not.toBeNull();
  });

  it("无法解析的输入、没有 custom 范围的模型返回 null", () => {
    for (const text of ["abc", "", "16:", ":9", "0:1", "1:0", "-1:2", "1:2:3", "16/9", "1e3:1"]) expect(commitRatioInput(qwen, text)).toBeNull();
    expect(commitRatioInput({ ...qwen, custom: null }, "5:2")).toBeNull();
  });

  it("换模型后手动值越界：不可运行，值不改", () => {
    expect(resolveSize(pro, manual("2K", "12:1"))).not.toBeNull();
    expect(resolveSize(qwen, manual("2K", "12:1"))).toBeNull();
  });

  it("旧画板带 width / height 的 size_spec 仍可换算", () => {
    expect(resolveSize(qwen, { tier: null, ratio: null, width: 1024, height: 768 })).toEqual({ width: 1024, height: 768 });
  });

  it("换分辨率档：手动宽高比能换算则保留（含手填值与旧画板像素宽高），否则取新档第一个预设；自动只换档", () => {
    expect(withSizeTier(qwen, manual("2K", "5:2"), "1K")).toEqual(manual("1K", "5:2"));
    expect(withSizeTier({ ...qwen, custom: null }, manual("2K", "16:9"), "1K")).toEqual(manual("1K", "1:1"));
    expect(withSizeTier(qwen, manual("2K", "12:1"), "1K")).toEqual(manual("1K", "1:1"));
    const auto = autoSizeSpec(qwen, "2K", 1, [1000, 700]);
    expect(withSizeTier(qwen, auto, "1K")).toEqual({ ...auto, tier: "1K" });
  });
});
