// 精简图片节点的尺寸：只显示图片，按图片比例等比缩放；存盘的 size 只在新建与拖角缩放时写。
import type { SizeSpec } from "./size";

export const IMAGE_NODE_WIDTH = 240;
/** 图片节点短边下限。 */
export const IMAGE_NODE_MIN = 80;

/** 按宽度与宽高比（高 / 宽）给出等比尺寸，短边不小于 IMAGE_NODE_MIN。 */
export function imageNodeSize(width: number, aspect: number): [number, number] {
  const w = Math.max(width, IMAGE_NODE_MIN, IMAGE_NODE_MIN / aspect);
  return [Math.round(w), Math.round(w * aspect)];
}

/** 拖角缩放的最小宽高：短边恰为 IMAGE_NODE_MIN。 */
export function imageMinSize(aspect: number): { minWidth: number; minHeight: number } {
  const [minWidth, minHeight] = imageNodeSize(0, aspect);
  return { minWidth, minHeight };
}

/** 画布上的显示尺寸：宽度沿用存的 size，高度按图片实际比例（未知时按 size 比例）；不回写 size，旧画板打开不变。 */
export function renderedImageSize(size: [number, number], image: { width: number; height: number } | null | undefined): [number, number] {
  const aspect = image && image.width > 0 && image.height > 0 ? image.height / image.width : size[0] > 0 && size[1] > 0 ? size[1] / size[0] : 1;
  return imageNodeSize(size[0], aspect);
}

/** 尺寸设置对应的宽高比（高 / 宽）：档位比例「16:9」或自定义像素；读不出时为 1。 */
export function sizeSpecAspect(spec: SizeSpec): number {
  if (spec.tier === null) return spec.width && spec.height ? spec.height / spec.width : 1;
  const [w, h] = (spec.ratio ?? "").split(":").map(Number);
  return w > 0 && h > 0 ? h / w : 1;
}
