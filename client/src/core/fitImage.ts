// 参考图快照按模型 input_image_rule 自动缩放 / 转码（#116）：只处理发给模型的那份，画板上的原图不动。
// 计划与体积循环是纯函数，可单测；解码 / 编码由壳层 WebView canvas 注入（src/shell/imageCodec.ts）。
// 尺寸一律按 EXIF 转正后的宽高（由解码方保证）。
import type { InputImageRule } from "./capabilities";
import { imageRuleViolations, mb, type ImageFacts } from "./graph";
import { sniffImage } from "./taskDir";

export type EncodableFormat = "png" | "jpeg";

export interface FitFacts extends ImageFacts {
  hasAlpha: boolean;
}

export interface FitPlan {
  width: number;
  height: number;
  format: EncodableFormat;
  /** 按总像素上限缩小过。 */
  resized: boolean;
}

/** JPEG 质量阶梯；降到最低仍超体积再等比缩小。 */
export const JPEG_QUALITIES = [0.92, 0.85, 0.78, 0.7];
export const JPEG_MIN_QUALITY = JPEG_QUALITIES[JPEG_QUALITIES.length - 1];
const MAX_ENCODE_STEPS = 24;

const ENCODABLE: readonly string[] = ["png", "jpeg"] satisfies EncodableFormat[];

function targetFormat(image: FitFacts, rule: InputImageRule, bytesOver: boolean): EncodableFormat | null {
  const allowed = (f: string) => rule.formats.includes(f);
  if (allowed(image.format) && ENCODABLE.includes(image.format)) {
    return image.format === "png" && bytesOver && !image.hasAlpha && allowed("jpeg") ? "jpeg" : (image.format as EncodableFormat);
  }
  const order: EncodableFormat[] = image.hasAlpha ? ["png", "jpeg"] : ["jpeg", "png"];
  return order.find(allowed) ?? null;
}

function scaledSize(image: ImageFacts, rule: InputImageRule): { width: number; height: number } | null {
  const total = image.width * image.height;
  if (rule.max_total_pixels === null || total <= rule.max_total_pixels) return null;
  const s = Math.sqrt(rule.max_total_pixels / total);
  // 向下取整：w'·h' ≤ w·s·h·s = 上限。
  return { width: Math.max(1, Math.floor(image.width * s)), height: Math.max(1, Math.floor(image.height * s)) };
}

/** 超总像素上限、格式不受支持、超体积上限时给出处理计划；已合规或无法编码时为 null（原样发送）。 */
export function planFit(image: FitFacts, rule: InputImageRule): FitPlan | null {
  const scaled = image.width > 0 && image.height > 0 ? scaledSize(image, rule) : null;
  const formatOk = rule.formats.includes(image.format);
  const bytesOver = rule.max_bytes !== null && image.bytes > rule.max_bytes;
  if (!scaled && formatOk && !bytesOver) return null;
  const format = targetFormat(image, rule, bytesOver);
  if (!format) return null;
  return { width: scaled?.width ?? image.width, height: scaled?.height ?? image.height, format, resized: scaled !== null };
}

export type Encode = (width: number, height: number, format: EncodableFormat, quality?: number) => Promise<Uint8Array>;

/** 体积循环：按计划编码；超体积时无透明 PNG 改 JPEG → JPEG 逐级降质量 → 保持最低质量继续等比缩小。 */
export async function encodeWithin(
  plan: FitPlan,
  rule: InputImageRule,
  hasAlpha: boolean,
  encode: Encode,
): Promise<{ bytes: Uint8Array; width: number; height: number; format: EncodableFormat }> {
  let { width, height, format } = plan;
  let q = 0;
  for (let step = 0; step < MAX_ENCODE_STEPS; step++) {
    const bytes = await encode(width, height, format, format === "jpeg" ? JPEG_QUALITIES[q] : undefined);
    if (rule.max_bytes === null || bytes.length <= rule.max_bytes) return { bytes, width, height, format };
    if (format === "png" && !hasAlpha && rule.formats.includes("jpeg")) {
      format = "jpeg";
      q = 0;
    } else if (format === "jpeg" && q < JPEG_QUALITIES.length - 1) {
      q++;
    } else {
      if (width === 1 && height === 1) break;
      const s = Math.min(0.9, Math.sqrt(rule.max_bytes / bytes.length) * 0.95);
      width = Math.max(1, Math.floor(width * s));
      height = Math.max(1, Math.floor(height * s));
    }
  }
  throw new Error("无法压缩到体积上限内");
}

export interface DecodedImage {
  width: number;
  height: number;
  /** 真的有非不透明像素；只在需要处理时才调用（要逐像素扫）。 */
  hasAlpha(): boolean;
  encode: Encode;
  close(): void;
}

export interface ImageCodec {
  decode(bytes: Uint8Array): Promise<DecodedImage>;
}

/** task.json references[] 条目上的处理记录；没处理的条目不带。 */
export interface FittedRecord {
  from: ImageFacts;
  to: ImageFacts;
}

/** 发给模型的那份字节；fitted = 按规则处理过。 */
export interface FittedBytes {
  bytes: Uint8Array;
  fitted?: FittedRecord;
}

function formatOf(bytes: Uint8Array): string {
  const ext = sniffImage(bytes)?.ext ?? "";
  return ext === "jpg" ? "jpeg" : ext;
}

/** 按规则处理一张要发给模型的图；已合规、解码或编码失败时原样返回（与未处理时行为一致）。 */
export async function fitImage(bytes: Uint8Array, rule: InputImageRule, codec: ImageCodec): Promise<FittedBytes> {
  let decoded: DecodedImage;
  try {
    decoded = await codec.decode(bytes);
  } catch {
    return { bytes };
  }
  try {
    const facts = { format: formatOf(bytes), bytes: bytes.length, width: decoded.width, height: decoded.height };
    // 先不带透明判断看是否需要处理，免得每张合规大图都逐像素扫一遍。
    if (!planFit({ ...facts, hasAlpha: false }, rule)) return { bytes };
    const hasAlpha = decoded.hasAlpha();
    const plan = planFit({ ...facts, hasAlpha }, rule);
    if (!plan) return { bytes };
    const out = await encodeWithin(plan, rule, hasAlpha, decoded.encode);
    return {
      bytes: out.bytes,
      fitted: { from: facts, to: { width: out.width, height: out.height, format: out.format, bytes: out.bytes.length } },
    };
  } catch {
    return { bytes };
  } finally {
    decoded.close();
  }
}

/**
 * 节点提示：notes = 发送时会自动做的处理（不标黄）；warnings = 不能自动修复的项（标黄）。
 * 透明通道按导入时检测的 has_alpha 估计，实际发送时按像素判断。
 */
export function inputImageAdvice(image: ImageFacts & { has_alpha?: boolean }, rule: InputImageRule): { warnings: string[]; notes: string[] } {
  const plan = planFit({ ...image, hasAlpha: image.has_alpha ?? false }, rule);
  if (!plan) return { warnings: imageRuleViolations(image, rule), notes: [] };
  const notes: string[] = [];
  if (plan.resized) notes.push(`发送时将自动缩小到 ${plan.width}×${plan.height}`);
  if (plan.format !== image.format) notes.push(`发送时将转为 ${plan.format.toUpperCase()}`);
  if (rule.max_bytes !== null && image.bytes > rule.max_bytes) notes.push(`发送时将压缩到 ${mb(rule.max_bytes)} 以内`);
  // 处理后的样子再过一遍规则：剩下的只有下限、宽高比这类不可修复项。
  const warnings = imageRuleViolations({ format: plan.format, bytes: 0, width: plan.width, height: plan.height }, rule);
  return { warnings, notes };
}

/** 一张图接多个模型：各按各的规则算，再合并去重。 */
export function inputImageAdviceAll(image: (ImageFacts & { has_alpha?: boolean }) | null | undefined, rules: InputImageRule[]): { warnings: string[]; notes: string[] } {
  const all = image ? rules.map((rule) => inputImageAdvice(image, rule)) : [];
  return { warnings: [...new Set(all.flatMap((a) => a.warnings))], notes: [...new Set(all.flatMap((a) => a.notes))] };
}
