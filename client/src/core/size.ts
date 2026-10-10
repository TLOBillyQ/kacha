// 生成尺寸：UI 统一「分辨率档 + 宽高比」两个控件，客户端按 size_rule 换算为像素。
// 宽高比命中当前分辨率档的预设时查表；否则（手填或自动推测的非预设值）在模型允许任意宽高比（custom 非空）时按面积换算。
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
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
  const total = width * height;
  const ratio = width / height;
  return (
    (range.min_total_pixels === null || total >= range.min_total_pixels) &&
    (range.max_total_pixels === null || total <= range.max_total_pixels) &&
    (range.min_aspect_ratio === null || ratio >= range.min_aspect_ratio) &&
    (range.max_aspect_ratio === null || ratio <= range.max_aspect_ratio)
  );
}

/** 换算为发送像素；分辨率档不在表内、宽高比既不在表内又超出 custom 范围、或旧画板的像素宽高越界时返回 null（任务不可运行）。 */
export function resolveSize(rule: SizeRule, spec: SizeSpec): { width: number; height: number } | null {
  if (spec.tier !== null) {
    const px = spec.ratio === null ? undefined : rule.tiers[spec.tier]?.[spec.ratio];
    if (px) return { width: px[0], height: px[1] };
    const value = ratioValue(spec.ratio);
    return value === null || !withinRatioRange(rule, value) ? null : pixelsForRatio(rule, spec.tier, value);
  }
  // 旧画板的像素宽高：界面不再提供输入，仍能读、能运行。
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

/** 宽高比上下限比较的浮点容差。 */
const RATIO_EPSILON = 1e-9;

/** 宽 / 高是否在模型的 custom 宽高比上下限内；没有 custom 范围为 false。 */
export function withinRatioRange(rule: SizeRule, value: number): boolean {
  if (rule.custom === null) return false;
  const { min_aspect_ratio: min, max_aspect_ratio: max } = rule.custom;
  return (min === null || value >= min - RATIO_EPSILON) && (max === null || value <= max + RATIO_EPSILON);
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

/** 换分辨率档：自动宽高比只换档（随画板变更当场按新档重算）；手动的宽高比在新档下能换算则保留，否则取新档的第一个预设。 */
export function withSizeTier(rule: SizeRule, spec: SizeSpec, tier: string): SizeSpec {
  if (isAutoRatio(spec)) return { ...spec, tier };
  const next = { ...spec, tier, width: null, height: null };
  return resolveSize(rule, next) !== null ? next : { ...next, ratio: ratiosForSizeTier(rule, tier)[0] ?? null };
}

// ---- 手填宽高比 ----

/** 手填文本 →「W:H」：接受全角冒号与空白，整数约分（32:18 → 16:9），小数保留两位；读不出为 null。 */
function parseRatioInput(text: string): string | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (!(w > 0) || !(h > 0)) return null;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return `${trimmed(w)}:${trimmed(h)}`;
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/** 边界值 →「N:1」/「1:N」，两位小数向范围内取整（下限向上、上限向下），保证钳制后的值仍在范围内。 */
function boundRatio(bound: number, isMin: boolean): string {
  const inward = (n: number, up: boolean) => String((up ? Math.ceil(n * 100 - RATIO_EPSILON) : Math.floor(n * 100 + RATIO_EPSILON)) / 100);
  return bound >= 1 ? `${inward(bound, isMin)}:1` : `1:${inward(1 / bound, !isMin)}`;
}

/**
 * 提交手填的宽高比：越界钳制到模型的 custom 宽高比边界（clamped = true，界面提示范围）。
 * 读不出、或模型不允许任意宽高比（custom 为空）时返回 null，界面恢复为改动前的值。
 */
export function commitRatioInput(rule: SizeRule, text: string): { ratio: string; clamped: boolean } | null {
  const ratio = parseRatioInput(text);
  const value = ratioValue(ratio);
  if (ratio === null || value === null || rule.custom === null) return null;
  if (withinRatioRange(rule, value)) return { ratio, clamped: false };
  const { min_aspect_ratio: min, max_aspect_ratio: max } = rule.custom;
  return { ratio: boundRatio(min !== null && value < min ? min : max!, min !== null && value < min), clamped: true };
}

/** 模型的宽高比范围文本「1:8–8:1」；某一侧不限为「不限」，没有 custom 范围为 null。 */
export function ratioRangeText(rule: SizeRule): string | null {
  if (rule.custom === null) return null;
  const { min_aspect_ratio: min, max_aspect_ratio: max } = rule.custom;
  return `${min === null ? "不限" : unitRatio(min)}–${max === null ? "不限" : unitRatio(max)}`;
}

/**
 * 非预设宽高比换算成像素：目标面积取该分辨率档 1:1 的面积（没有 1:1 取第一个宽高比的），宽高取整到 16 的倍数，
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
