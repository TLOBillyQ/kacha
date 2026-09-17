// 高亮叠加（规格第 6 节）：把区域矩形以 50% 不透明紫色画到源图上，合成出紧随原图的参考图。
// 这里是纯像素运算，可单测；解码 / 编码在壳层（WebView canvas，src/shell/overlay.ts）。

/** 叠加紫：RGB(128,0,255)，50% 不透明；区域1 的颜色。 */
export const OVERLAY_RGB: [number, number, number] = [128, 0, 255];

/**
 * 区域编号 → 高亮颜色（区域N 取第 N 个），也是一个任务的区域上限。
 * 多区域同色时模型分不清哪个是哪个，分色后按颜色指代才稳定（2026-09-17 冒烟）。
 */
export const REGION_COLORS: { rgb: [number, number, number]; zh: string; en: string }[] = [
  { rgb: OVERLAY_RGB, zh: "紫色", en: "purple" },
  { rgb: [255, 220, 0], zh: "黄色", en: "yellow" },
  { rgb: [255, 0, 160], zh: "洋红色", en: "magenta" },
];
export const MAX_REGIONS = REGION_COLORS.length;

/** 区域编号（0 起）对应颜色的 CSS rgba。 */
export function regionCss(index: number, alpha: number): string {
  const [r, g, b] = REGION_COLORS[index % REGION_COLORS.length].rgb;
  return `rgba(${r},${g},${b},${alpha})`;
}
const OVERLAY_ALPHA = 0.5;

/**
 * 归一化矩形 [x1,y1,x2,y2]（0–1）→ 像素矩形 [x1,y1,x2,y2)（右开下开）。
 * 越界收敛到图内，反向坐标自动交换；结果可能为空（x1===x2 或 y1===y2）。
 */
export function denormalizeRect(rect: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const [ax, bx] = [clamp(Math.round(Math.min(rect[0], rect[2]) * width), width), clamp(Math.round(Math.max(rect[0], rect[2]) * width), width)];
  const [ay, by] = [clamp(Math.round(Math.min(rect[1], rect[3]) * height), height), clamp(Math.round(Math.max(rect[1], rect[3]) * height), height)];
  return [ax, ay, bx, by];
}

/** 返回新缓冲：第 k 个矩形内像素与区域编号 firstRegion+k 的颜色 50% 混合，alpha 通道保持源图。 */
export function applyHighlightOverlay(
  rgba: Uint8Array,
  width: number,
  height: number,
  rects: [number, number, number, number][],
  firstRegion = 0,
): Uint8Array {
  const out = new Uint8Array(rgba);
  for (const [k, rect] of rects.entries()) {
    const [pr, pg, pb] = REGION_COLORS[(firstRegion + k) % REGION_COLORS.length].rgb;
    const [x1, y1, x2, y2] = denormalizeRect(rect, width, height);
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (y * width + x) * 4;
        out[i] = Math.round(out[i] * (1 - OVERLAY_ALPHA) + pr * OVERLAY_ALPHA);
        out[i + 1] = Math.round(out[i + 1] * (1 - OVERLAY_ALPHA) + pg * OVERLAY_ALPHA);
        out[i + 2] = Math.round(out[i + 2] * (1 - OVERLAY_ALPHA) + pb * OVERLAY_ALPHA);
      }
    }
  }
  return out;
}
