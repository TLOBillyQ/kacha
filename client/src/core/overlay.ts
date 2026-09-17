// 高亮叠加（规格第 6 节）：把区域矩形以 50% 不透明紫色画到源图上，合成出紧随原图的参考图。
// 这里是纯像素运算，可单测；解码 / 编码在壳层（WebView canvas，src/shell/overlay.ts）。

/** 叠加紫：RGB(128,0,255)，50% 不透明。 */
export const OVERLAY_RGB: [number, number, number] = [128, 0, 255];
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

/** 返回新缓冲：矩形内像素与叠加紫 50% 混合，alpha 通道保持源图。 */
export function applyHighlightOverlay(rgba: Uint8Array, width: number, height: number, rects: [number, number, number, number][]): Uint8Array {
  const out = new Uint8Array(rgba);
  const [pr, pg, pb] = OVERLAY_RGB;
  for (const rect of rects) {
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
