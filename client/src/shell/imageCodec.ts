// 参考图快照缩放 / 转码的壳层实现（#116）：WebView canvas 解码 / 编码，与叠加图合成共用；处理计划与体积循环在 core/fitImage.ts。
import type { DecodedImage, EncodableFormat, ImageCodec } from "../core/fitImage";
import { sniffImage } from "../core/taskDir";

/** 解码并按 EXIF 方向转正（createImageBitmap 默认行为）。 */
export function decodeBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes.slice().buffer as ArrayBuffer]));
}

export function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 canvas 上下文");
  return { canvas, ctx };
}

export async function encodeCanvas(canvas: HTMLCanvasElement, format: EncodableFormat, quality?: number): Promise<Uint8Array> {
  const type = `image/${format}`;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // 不支持的类型 toBlob 会静默退回 PNG；按失败处理，由调用方退回原图。
  if (!blob || blob.type !== type) throw new Error(`无法编码为 ${format.toUpperCase()}`);
  return new Uint8Array(await blob.arrayBuffer());
}

function bitmapHasAlpha(bitmap: ImageBitmap): boolean {
  const { ctx } = canvasOf(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

export const imageCodec: ImageCodec = {
  async decode(bytes: Uint8Array): Promise<DecodedImage> {
    const bitmap = await decodeBitmap(bytes);
    const isJpeg = sniffImage(bytes)?.ext === "jpg";
    return {
      width: bitmap.width,
      height: bitmap.height,
      hasAlpha: () => !isJpeg && bitmapHasAlpha(bitmap),
      async encode(width, height, format, quality) {
        const { canvas, ctx } = canvasOf(width, height);
        // JPEG 没有透明通道：先铺白底，免得透明处变黑。
        if (format === "jpeg") {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
        }
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, width, height);
        return encodeCanvas(canvas, format, quality);
      },
      close: () => bitmap.close(),
    };
  },
};
