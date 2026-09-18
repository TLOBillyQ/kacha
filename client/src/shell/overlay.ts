// 高亮叠加的壳层实现：WebView canvas 解码 / 编码（与 imageCodec 共用），像素混合在 core/overlay.ts。
import { applyHighlightOverlay } from "../core/overlay";
import { canvasOf, decodeBitmap, encodeCanvas } from "./imageCodec";

/** 解码图片 → 画叠加矩形 → 编码为 PNG。 */
export async function composeOverlay(image: Uint8Array, rects: [number, number, number, number][], firstRegion = 0): Promise<Uint8Array> {
  const bitmap = await decodeBitmap(image);
  try {
    const { canvas, ctx } = canvasOf(bitmap.width, bitmap.height);
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const overlaid = applyHighlightOverlay(new Uint8Array(data.data.buffer), canvas.width, canvas.height, rects, firstRegion);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(overlaid.buffer as ArrayBuffer), canvas.width, canvas.height), 0, 0);
    return await encodeCanvas(canvas, "png");
  } finally {
    bitmap.close();
  }
}
