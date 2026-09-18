import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE, type InputImageRule } from "./capabilities";
import { encodeWithin, fitImage, inputImageAdvice, JPEG_MIN_QUALITY, planFit, type DecodedImage, type EncodableFormat } from "./fitImage";

const QWEN = BUILTIN_TABLE.models[0].input_image_rule;
const SEEDREAM = BUILTIN_TABLE.models[2].input_image_rule;
const rule = (patch: Partial<InputImageRule>): InputImageRule => ({ ...QWEN, ...patch });

describe("planFit：发给模型前的处理计划", () => {
  it("已满足全部规则：不处理", () => {
    expect(planFit({ format: "png", bytes: 1000, width: 1024, height: 768, hasAlpha: false }, QWEN)).toBeNull();
    expect(planFit({ format: "png", bytes: 1000, width: 4096, height: 4096, hasAlpha: false }, SEEDREAM)).toBeNull();
  });

  it("只超总像素：等比缩小到上限内，格式不变", () => {
    const plan = planFit({ format: "png", bytes: 1000, width: 4096, height: 4096, hasAlpha: false }, QWEN)!;
    expect(plan).toMatchObject({ width: 2048, height: 2048, format: "png", resized: true });
    const odd = planFit({ format: "jpeg", bytes: 1000, width: 3001, height: 2003, hasAlpha: false }, QWEN)!;
    expect(odd.width * odd.height).toBeLessThanOrEqual(4194304);
    expect(odd.width / odd.height).toBeCloseTo(3001 / 2003, 2);
    expect(odd.format).toBe("jpeg");
  });

  it("格式不受支持：带透明转 PNG，不带透明转 JPEG，尺寸不变", () => {
    expect(planFit({ format: "webp", bytes: 1000, width: 800, height: 600, hasAlpha: true }, QWEN)).toMatchObject({ width: 800, height: 600, format: "png", resized: false });
    expect(planFit({ format: "webp", bytes: 1000, width: 800, height: 600, hasAlpha: false }, QWEN)).toMatchObject({ format: "jpeg" });
    expect(planFit({ format: "", bytes: 1000, width: 800, height: 600, hasAlpha: false }, rule({ formats: ["png"] }))).toMatchObject({ format: "png" });
  });

  it("支持但无法编码的格式需要缩小时，改用 PNG / JPEG", () => {
    expect(planFit({ format: "webp", bytes: 1000, width: 8000, height: 6000, hasAlpha: false }, SEEDREAM)).toMatchObject({ format: "jpeg", resized: true });
  });

  it("只超体积：无透明 PNG 直接改 JPEG；JPEG 保持 JPEG；带透明 PNG 保持 PNG", () => {
    const big = 11 * 1024 * 1024;
    expect(planFit({ format: "png", bytes: big, width: 1000, height: 1000, hasAlpha: false }, QWEN)).toMatchObject({ format: "jpeg", resized: false });
    expect(planFit({ format: "jpeg", bytes: big, width: 1000, height: 1000, hasAlpha: false }, QWEN)).toMatchObject({ format: "jpeg" });
    expect(planFit({ format: "png", bytes: big, width: 1000, height: 1000, hasAlpha: true }, QWEN)).toMatchObject({ format: "png" });
  });

  it("多项叠加：WebP + 超像素 + 超体积", () => {
    expect(planFit({ format: "webp", bytes: 11 * 1024 * 1024, width: 4096, height: 4096, hasAlpha: true }, QWEN)).toMatchObject({ width: 2048, height: 2048, format: "png", resized: true });
  });

  it("规则里没有可编码的格式：无法处理", () => {
    expect(planFit({ format: "webp", bytes: 1, width: 10, height: 10, hasAlpha: false }, rule({ formats: ["gif"] }))).toBeNull();
    expect(planFit({ format: "gif", bytes: 1, width: 4096, height: 4096, hasAlpha: false }, rule({ formats: ["gif"] }))).toBeNull();
  });

  it("不可修复项（低于下限、宽高比越界）不触发处理", () => {
    expect(planFit({ format: "png", bytes: 1, width: 300, height: 300, hasAlpha: false }, QWEN)).toBeNull();
    expect(planFit({ format: "jpeg", bytes: 1, width: 3400, height: 200, hasAlpha: false }, SEEDREAM)).toBeNull();
  });
});

/** 假编码器：PNG 每像素 3 字节，JPEG 每像素 quality 字节。 */
function fakeEncode() {
  const calls: { width: number; height: number; format: EncodableFormat; quality?: number }[] = [];
  const encode = async (width: number, height: number, format: EncodableFormat, quality?: number) => {
    calls.push({ width, height, format, quality });
    return new Uint8Array(Math.ceil(width * height * (format === "png" ? 3 : quality!)));
  };
  return { calls, encode };
}

describe("encodeWithin：体积循环", () => {
  it("没有体积上限：按计划编码一次", async () => {
    const { calls, encode } = fakeEncode();
    const out = await encodeWithin({ width: 100, height: 100, format: "png", resized: true }, rule({ max_bytes: null }), false, encode);
    expect(out).toMatchObject({ width: 100, height: 100, format: "png" });
    expect(calls).toHaveLength(1);
  });

  it("JPEG 逐级降质量，满足即停", async () => {
    const { calls, encode } = fakeEncode();
    const out = await encodeWithin({ width: 100, height: 100, format: "jpeg", resized: false }, rule({ max_bytes: 8000 }), false, encode);
    expect(out.bytes.length).toBeLessThanOrEqual(8000);
    expect(calls.map((c) => c.quality)).toEqual([0.92, 0.85, 0.78]);
  });

  it("无透明 PNG 超限改 JPEG", async () => {
    const { calls, encode } = fakeEncode();
    const out = await encodeWithin({ width: 100, height: 100, format: "png", resized: true }, rule({ max_bytes: 9500 }), false, encode);
    expect(out.format).toBe("jpeg");
    expect(calls.map((c) => c.format)).toEqual(["png", "jpeg"]);
  });

  it("最低质量仍超限：保持最低质量继续等比缩小，质量不低于 0.7", async () => {
    const { calls, encode } = fakeEncode();
    const out = await encodeWithin({ width: 100, height: 100, format: "jpeg", resized: false }, rule({ max_bytes: 3000 }), false, encode);
    expect(out.bytes.length).toBeLessThanOrEqual(3000);
    expect(out.width).toBeLessThan(100);
    expect(out.width).toBe(out.height);
    expect(Math.min(...calls.map((c) => c.quality!))).toBe(JPEG_MIN_QUALITY);
  });

  it("带透明 PNG 超限：不改 JPEG，直接缩小", async () => {
    const { calls, encode } = fakeEncode();
    const out = await encodeWithin({ width: 100, height: 100, format: "png", resized: false }, rule({ max_bytes: 15000 }), true, encode);
    expect(out.format).toBe("png");
    expect(out.bytes.length).toBeLessThanOrEqual(15000);
    expect(calls.every((c) => c.format === "png")).toBe(true);
  });
});

function fakeDecoded(width: number, height: number, hasAlpha = false): DecodedImage & { closed: boolean } {
  const { encode } = fakeEncode();
  return { width, height, hasAlpha: () => hasAlpha, encode, closed: false, close() { this.closed = true; } };
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_HEAD = [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)));

describe("fitImage：解码 → 计划 → 编码", () => {
  it("满足规则：原样返回，不带 fitted", async () => {
    const bytes = Uint8Array.from(PNG_HEAD);
    const decoded = fakeDecoded(800, 600);
    const out = await fitImage(bytes, QWEN, { decode: async () => decoded });
    expect(out.bytes).toBe(bytes);
    expect(out.fitted).toBeUndefined();
    expect(decoded.closed).toBe(true);
  });

  it("超像素：缩小并记录处理前后", async () => {
    const bytes = Uint8Array.from(PNG_HEAD);
    const out = await fitImage(bytes, rule({ max_bytes: null }), { decode: async () => fakeDecoded(4096, 4096) });
    expect(out.fitted).toEqual({
      from: { width: 4096, height: 4096, format: "png", bytes: 8 },
      to: { width: 2048, height: 2048, format: "png", bytes: 2048 * 2048 * 3 },
    });
  });

  it("WebP 转码：fitted 记录格式变化", async () => {
    const bytes = Uint8Array.from(WEBP_HEAD);
    const out = await fitImage(bytes, QWEN, { decode: async () => fakeDecoded(10, 10, true) });
    expect(out.fitted?.from.format).toBe("webp");
    expect(out.fitted?.to.format).toBe("png");
  });

  it("解码或编码失败：退回原图", async () => {
    const bytes = Uint8Array.from(WEBP_HEAD);
    expect(await fitImage(bytes, QWEN, { decode: async () => Promise.reject(new Error("bad")) })).toEqual({ bytes });
    const broken = { ...fakeDecoded(10, 10), encode: async () => Promise.reject(new Error("bad")) };
    expect(await fitImage(bytes, QWEN, { decode: async () => broken })).toEqual({ bytes });
  });
});

describe("inputImageAdvice：节点提示分两类", () => {
  it("可自动处理的项给出发送说明，不标黄", () => {
    expect(inputImageAdvice({ format: "webp", bytes: 11 * 1024 * 1024, width: 4096, height: 4096, has_alpha: false }, QWEN)).toEqual({
      warnings: [],
      notes: ["发送时将自动缩小到 2048×2048", "发送时将转为 JPEG", "发送时将压缩到 10.0 MB 以内"],
    });
  });

  it("不可修复项照旧标黄", () => {
    expect(inputImageAdvice({ format: "png", bytes: 1, width: 3000, height: 300 }, QWEN)).toEqual({ warnings: ["最短边 300 px 小于 384 px"], notes: [] });
    expect(inputImageAdvice({ format: "jpeg", bytes: 1, width: 3400, height: 200 }, SEEDREAM).warnings).toEqual(["宽高比 17.00 超出 0.06～16.00"]);
  });

  it("缩小后低于最短边下限：同时说明缩放并标黄", () => {
    const advice = inputImageAdvice({ format: "png", bytes: 1, width: 12000, height: 400 }, QWEN);
    expect(advice.notes[0]).toMatch(/^发送时将自动缩小到 \d+×\d+$/);
    expect(advice.warnings[0]).toMatch(/^最短边 \d+ px 小于 384 px$/);
  });

  it("没有可编码格式：格式问题照旧标黄", () => {
    expect(inputImageAdvice({ format: "webp", bytes: 1, width: 10, height: 10 }, rule({ formats: ["gif"], min_short_edge: null }))).toEqual({
      warnings: ["格式 WEBP 不受支持（支持 GIF）"],
      notes: [],
    });
  });
});
