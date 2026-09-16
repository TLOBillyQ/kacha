// 生成尺寸：UI 统一「档位 + 比例」两个下拉，客户端按 size_rule 换算为像素（规格第 10.2 节）。
import type { PixelRange, SizeRule } from "./capabilities";

export interface SizeSpec {
  tier: string | null;
  ratio: string | null;
  width: number | null;
  height: number | null;
}

export function sizeTiersOf(rule: SizeRule): string[] {
  return Object.keys(rule.tiers);
}

export function ratiosForSizeTier(rule: SizeRule, tier: string): string[] {
  return Object.keys(rule.tiers[tier] ?? {});
}

export function withinPixelRange(range: PixelRange, width: number, height: number): boolean {
  const total = width * height;
  const ratio = width / height;
  return (
    (range.min_total_pixels === null || total >= range.min_total_pixels) &&
    (range.max_total_pixels === null || total <= range.max_total_pixels) &&
    (range.min_aspect_ratio === null || ratio >= range.min_aspect_ratio) &&
    (range.max_aspect_ratio === null || ratio <= range.max_aspect_ratio)
  );
}

/** 换算为发送像素；档位 / 比例不在表内或自定义越界时返回 null（任务不可运行）。 */
export function resolveSize(rule: SizeRule, spec: SizeSpec): { width: number; height: number } | null {
  if (spec.tier !== null) {
    const px = spec.ratio === null ? undefined : rule.tiers[spec.tier]?.[spec.ratio];
    return px ? { width: px[0], height: px[1] } : null;
  }
  if (spec.width === null || spec.height === null || rule.custom === null) return null;
  return withinPixelRange(rule.custom, spec.width, spec.height) ? { width: spec.width, height: spec.height } : null;
}

/** 新建任务时的默认尺寸：表中第一个档位的第一个比例。 */
export function defaultSizeSpec(rule: SizeRule): SizeSpec {
  const tier = sizeTiersOf(rule)[0] ?? null;
  const ratio = tier === null ? null : (ratiosForSizeTier(rule, tier)[0] ?? null);
  return { tier, ratio, width: null, height: null };
}
