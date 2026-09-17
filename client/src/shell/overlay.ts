// 高亮叠加的壳层实现：WebView canvas 解码 / 编码，像素混合在 core/overlay.ts。
import { applyHighlightOverlay } from "../core/overlay";

/** 解码图片 → 画叠加矩形 → 编码为 PNG。 */
export async function composeOverlay(image: Uint8Array, rects: [number, number, number, number][], firstRegion = 0): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([image.slice().buffer as ArrayBuffer]));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建 canvas 上下文");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const overlaid = applyHighlightOverlay(new Uint8Array(data.data.buffer), canvas.width, canvas.height, rects, firstRegion);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(overlaid.buffer as ArrayBuffer), canvas.width, canvas.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("叠加图编码失败");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
