// 生成尺寸：UI 统一「档位 + 比例」两个下拉，客户端按 size_rule 换算为像素。
// 宽高比可处于自动状态：跟随参考图推测，ratio 里始终存算出的具体值，auto_ratio 标记自动并缓存推测依据。
import type { PixelRange, SizeRule } from "./capabilities";

/** 自动宽高比的标记与缓存：读不到图时沿用，换模型 / 分辨率档时不必重读图。 */
export interface AutoRatio {
  /** 写入时算出的宽高比；与 SizeSpec.ratio 不一致 = 不认识本字段的旧客户端改过宽高比，视为手动。 */
  ratio: string;
  /** 跟随的「图N」（1 起）；没有参考图为 null。 */
  image: number | null;
  /** 跟随图片的像素宽高；没有参考图或还没读到为 null。 */
  source: [number, number] | null;
}

export interface SizeSpec {
  tier: string | null;
  ratio: string | null;
  width: number | null;
  height: number | null;
  /** 缺省 / null = 手动。 */
  auto_ratio?: AutoRatio | null;
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

/** 换算为发送像素；档位 / 比例不在表内或自定义越界时返回 null（任务不可运行）。自动宽高比不在表内时按面积换算。 */
export function resolveSize(rule: SizeRule, spec: SizeSpec): { width: number; height: number } | null {
  if (spec.tier !== null) {
    const px = spec.ratio === null ? undefined : rule.tiers[spec.tier]?.[spec.ratio];
    if (px) return { width: px[0], height: px[1] };
    const value = isAutoRatio(spec) ? ratioValue(spec.ratio) : null;
    return value === null ? null : pixelsForRatio(rule, spec.tier, value);
  }
  if (spec.width === null || spec.height === null || rule.custom === null) return null;
  return withinPixelRange(rule.custom, spec.width, spec.height) ? { width: spec.width, height: spec.height } : null;
}

/** 新建任务时的默认尺寸：分辨率档不推测，取 inheritedTier（在表内时）否则表中第一个；宽高比为自动，接上参考图后由 syncAutoRatios 跟随。 */
export function defaultSizeSpec(rule: SizeRule, inheritedTier: string | null = null): SizeSpec {
  const tier = inheritedTier !== null && inheritedTier in rule.tiers ? inheritedTier : (sizeTiersOf(rule)[0] ?? null);
  return autoSizeSpec(rule, tier, null, null);
}

// ---- 自动宽高比 ----

/** 吸附到预设宽高比的相对容差。 */
export const RATIO_SNAP_TOLERANCE = 0.03;
/** 非预设宽高比换算出的宽高取整到它的倍数。 */
export const PIXEL_STEP = 16;

export function isAutoRatio(spec: SizeSpec): boolean {
  return !!spec.auto_ratio && spec.auto_ratio.ratio === spec.ratio;
}

/** 「W:H」→ 宽 / 高；读不出为 null。 */
export function ratioValue(ratio: string | null): number | null {
  const [w, h, ...rest] = (ratio ?? "").split(":").map(Number);
  return rest.length === 0 && w > 0 && h > 0 && Number.isFinite(w / h) ? w / h : null;
}

/** 规则里出现过的全部预设宽高比，当前分辨率档的排前。 */
function presetRatios(rule: SizeRule, tier: string): string[] {
  return [...new Set([...ratiosForSizeTier(rule, tier), ...sizeTiersOf(rule).flatMap((t) => ratiosForSizeTier(rule, t))])];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const trimmed = (n: number) => String(Number(n.toFixed(2)));
/** 宽 / 高 →「N:1」或「1:N」，保留两位小数。 */
const unitRatio = (value: number) => (value >= 1 ? `${trimmed(value)}:1` : `1:${trimmed(1 / value)}`);

/**
 * 由跟随图片的像素宽高推测宽高比：先钳制到模型的 custom 宽高比上下限，再在 ±3% 内吸附到预设，否则保留原始 W:H。
 * source = null（没有参考图）为 1:1。
 */
export function inferRatio(rule: SizeRule, tier: string, source: [number, number] | null): { ratio: string; limited: boolean } {
  if (!source || !(source[0] > 0) || !(source[1] > 0)) return { ratio: "1:1", limited: false };
  const raw = source[0] / source[1];
  const value = Math.min(Math.max(raw, rule.custom?.min_aspect_ratio ?? 0), rule.custom?.max_aspect_ratio ?? Infinity);
  const limited = value !== raw;
  const distance = (preset: string) => Math.abs(value / (ratioValue(preset) ?? Infinity) - 1);
  // 没有 custom 范围的模型发不了非预设像素，只能落在当前分辨率档的预设上。
  const presets = rule.custom === null ? ratiosForSizeTier(rule, tier) : presetRatios(rule, tier);
  const nearest = presets.reduce<string | null>((best, p) => (best === null || distance(p) < distance(best) ? p : best), null);
  if (nearest !== null && (distance(nearest) <= RATIO_SNAP_TOLERANCE + 1e-9 || rule.custom === null)) return { ratio: nearest, limited };
  if (limited) return { ratio: unitRatio(value), limited };
  const [w, h] = source.map(Math.round);
  const g = gcd(w, h) || 1;
  return { ratio: `${w / g}:${h / g}`, limited };
}

/** 自动状态的 size_spec；previous = 原 size_spec（保留其中不认识的字段）。 */
export function autoSizeSpec(rule: SizeRule, tier: string | null, image: number | null, source: [number, number] | null, previous: SizeSpec | null = null): SizeSpec {
  const ratio = tier === null ? "1:1" : inferRatio(rule, tier, source).ratio;
  return { ...previous, tier, ratio, width: null, height: null, auto_ratio: { ratio, image, source } };
}

/** 转为手动：去掉自动标记，其余字段不动。 */
export function manualSizeSpec(spec: SizeSpec, ratio: string | null = spec.ratio): SizeSpec {
  const { auto_ratio: _dropped, ...rest } = spec;
  return { ...rest, ratio };
}

/**
 * 非预设宽高比换算成像素：目标面积取该分辨率档 1:1 的面积（没有 1:1 取第一个比例的），宽高取整到 16 的倍数，
 * 且落在 custom 的总像素与宽高比范围内；在理想值附近的候选里优先贴近宽高比，其次贴近面积。
 */
function pixelsForRatio(rule: SizeRule, tier: string, value: number): { width: number; height: number } | null {
  const base = rule.tiers[tier]?.["1:1"] ?? Object.values(rule.tiers[tier] ?? {})[0];
  if (!base || rule.custom === null) return null;
  const area = base[0] * base[1];
  const steps = (ideal: number) => [-3, -2, -1, 0, 1, 2, 3].map((d) => (Math.round(ideal / PIXEL_STEP) + d) * PIXEL_STEP).filter((n) => n > 0);
  let best: { width: number; height: number; cost: number } | null = null;
  for (const width of steps(Math.sqrt(area * value))) {
    for (const height of steps(Math.sqrt(area / value))) {
      if (!withinPixelRange(rule.custom, width, height)) continue;
      const cost = 10 * Math.abs(Math.log(width / height / value)) + Math.abs(Math.log((width * height) / area));
      if (best === null || cost < best.cost) best = { width, height, cost };
    }
  }
  return best && { width: best.width, height: best.height };
}

/** 宽高比的显示文本：预设与「N:1」原样，其余显示为「≈1.43:1」。 */
export function ratioText(rule: SizeRule, ratio: string): string {
  const value = ratioValue(ratio);
  if (value === null || ratio.split(":").includes("1") || sizeTiersOf(rule).some((t) => ratio in rule.tiers[t])) return ratio;
  return `≈${unitRatio(value)}`;
}

/** 宽高比下拉里「自动」项的文本：自动（16:9 · 图1，已限制）；没有参考图为 自动（1:1）。 */
export function autoRatioLabel(rule: SizeRule, spec: SizeSpec): string {
  const auto = spec.auto_ratio;
  const ratio = ratioText(rule, spec.ratio ?? "1:1");
  if (!auto || auto.image === null) return `自动（${ratio}）`;
  const limited = spec.tier !== null && inferRatio(rule, spec.tier, auto.source).limited;
  return `自动（${ratio} · 图${auto.image}${limited ? "，已限制" : ""}）`;
}
