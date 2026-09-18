import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_TABLE, findModel } from "./capabilities";
import {
  buildGenerationRequest,
  fetchResultImage,
  generate,
  GatewayError,
  listModels,
  parseGeneratedImages,
  type FetchLike,
  type GenerationInput,
} from "./gateway";

const FIXTURE_DIRS = [
  "2026-08-17-team-gateway",
  "2026-08-29-team-gateway-edit-json",
  "2026-08-31-team-gateway-edit-boundaries",
  "2026-09-16-team-gateway-multiturn-refs-mask",
];
const SEEDREAM_DIR = "2026-09-17-team-gateway-seedream";

interface Exchange {
  request: { method: string; path: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

const fixtureUrl = (dir: string, file = "") => new URL(`../../../contracts/fixtures/${dir}/${file}`, import.meta.url);

function loadFixture(dir: string, file: string): Exchange {
  return JSON.parse(readFileSync(fixtureUrl(dir, file), "utf8"));
}

const allExchanges = [...FIXTURE_DIRS, SEEDREAM_DIR].flatMap((dir) =>
  readdirSync(fixtureUrl(dir))
    .filter((f) => f.endsWith(".json") && f !== "manifest.json")
    .map((file) => ({ name: `${dir}/${file}`, exchange: loadFixture(dir, file) })),
);

// 1×1 PNG，用来替换夹具里脱敏掉的图片字节。
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

/** 把脱敏占位还原成可解码的内容，便于回放。 */
function unredact(value: unknown): unknown {
  if (value === "[REDACTED_IMAGE]") return PNG_BASE64;
  if (Array.isArray(value)) return value.map(unredact);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unredact(v)]));
  return value;
}

/** 夹具里的脱敏占位匹配任意实际值；其余逐项相等。 */
function expectMatchesFixture(actual: unknown, expected: unknown, path = "body"): void {
  if (expected === "[REDACTED_PROMPT]" || expected === "[REDACTED]") {
    expect(typeof actual, path).toBe("string");
    return;
  }
  if (typeof expected === "string" && expected.endsWith("[REDACTED_IMAGE]")) {
    expect(typeof actual, path).toBe("string");
    expect((actual as string).startsWith(expected.slice(0, -"[REDACTED_IMAGE]".length)), path).toBe(true);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, `${path}.length`).toBe(expected.length);
    expected.forEach((e, i) => expectMatchesFixture((actual as unknown[])[i], e, `${path}[${i}]`));
    return;
  }
  if (typeof expected === "object" && expected !== null) {
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [k, v] of Object.entries(expected)) expectMatchesFixture((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
    return;
  }
  expect(actual, path).toEqual(expected);
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function replay(exchange: Exchange, images: (url: string) => Uint8Array | undefined = () => undefined): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? null : JSON.parse(init.body) });
    const bytes = images(url);
    if (bytes) return { status: 200, headers: new Headers({ "Content-Type": "image/png" }), text: async () => "", arrayBuffer: async () => bytes.slice().buffer };
    const text = JSON.stringify(unredact(exchange.response.body));
    return {
      status: exchange.response.status,
      headers: new Headers(exchange.response.headers),
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
  };
  return { fetch, calls };
}

const qwenPro = findModel(BUILTIN_TABLE, "qwen-image-3.0-pro")!;
const seedreamPro = findModel(BUILTIN_TABLE, "doubao-seedream-5-0-pro-260628")!;
const seedreamLite = findModel(BUILTIN_TABLE, "doubao-seedream-5-0-lite-260128")!;
const png = { mediaType: "image/png", bytes: PNG_BYTES };

const textInput = (patch: Partial<GenerationInput> = {}): GenerationInput => ({
  model: qwenPro,
  text: "一只橘猫",
  nativeNegativePrompt: null,
  size: { width: 1024, height: 1024 },
  references: [],
  ...patch,
});

const BASE = "http://gateway.test:3001";

describe("网关适配器：请求载荷对照夹具", () => {
  it("文生图 POST /v1/images/generations，字段 model / prompt / negative_prompt / n / size(WxH) / fixed_params", async () => {
    const fixture = loadFixture("2026-08-17-team-gateway", "text-parameters-result.json");
    const { fetch, calls } = replay(fixture);
    await generate({ baseUrl: `${BASE}/`, apiKey: "sk-test", fetch }, textInput({ nativeNegativePrompt: "模糊" }));
    expect(calls[0].url).toBe(`${BASE}/v1/images/generations`);
    expect(calls[0].method).toBe("POST");
    expectMatchesFixture(calls[0].headers, fixture.request.headers, "headers");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
    // 出图数量整条取消，客户端固定传 1（夹具当时实测的是 n=2）。
    expectMatchesFixture(calls[0].body, { ...(fixture.request.body as object), n: 1 });
    expect(calls[0].body).toMatchObject({ size: "1024x1024", negative_prompt: "模糊", watermark: false, prompt: "一只橘猫" });
  });

  it("负向提示词为空时文生图不带 negative_prompt", () => {
    const { body } = buildGenerationRequest(textInput());
    expect(body).not.toHaveProperty("negative_prompt");
  });

  it("图片编辑 POST /v1/images/edits JSON：data-URL 参考图、末尾 text、size 星号、n 固定 1、fixed_params 合并", async () => {
    const fixture = loadFixture("2026-08-29-team-gateway-edit-json", "edit-json-single.json");
    const { fetch, calls } = replay(fixture);
    await generate({ baseUrl: BASE, apiKey: "sk-test", fetch }, textInput({ text: "本次提供 1 张参考图。\n一只橘猫", references: [png] }));
    expect(calls[0].url).toBe(`${BASE}/v1/images/edits`);
    expectMatchesFixture(calls[0].headers, fixture.request.headers, "headers");
    expectMatchesFixture(calls[0].body, fixture.request.body);
    const body = calls[0].body as { prompt: string; parameters: object; input: { messages: { content: { text?: string }[] }[] } };
    expect(body.parameters).toEqual({ size: "1024*1024", n: 1, watermark: false });
    expect(body.input.messages[0].content[1].text).toBe("本次提供 1 张参考图。\n一只橘猫");
    expect(body.prompt).toBe(body.input.messages[0].content[1].text);
  });

  it("三张参考图按序进入 content，发送文本原样放在末尾 text", () => {
    const fixture = loadFixture("2026-09-16-team-gateway-multiturn-refs-mask", "edit-ref-index-tu-3.json");
    const refs = [png, { mediaType: "image/jpeg", bytes: new Uint8Array([1]) }, { mediaType: "image/webp", bytes: new Uint8Array([2]) }];
    const { path, body } = buildGenerationRequest(textInput({ text: "本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图3的帽子戴到图1头上", references: refs }));
    expect(path).toBe("/v1/images/edits");
    const expected = fixture.request.body as { input: unknown };
    expectMatchesFixture((body as { input: unknown }).input, expected.input, "input");
    const content = (body as { input: { messages: { content: Record<string, string>[] }[] } }).input.messages[0].content;
    expect(content.map((c) => Object.keys(c)[0])).toEqual(["image", "image", "image", "text"]);
    expect(content[0].image.startsWith("data:image/png;base64,")).toBe(true);
    expect(content[1].image).toBe("data:image/jpeg;base64,AQ==");
    expect(content[2].image).toBe("data:image/webp;base64,Ag==");
    expect(content[3].text).toBe("本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图3的帽子戴到图1头上");
  });

  it("qwen 图片编辑的原生负向放进 input.negative_prompt（8-31 夹具已验证网关接受）", () => {
    const fixture = loadFixture("2026-08-31-team-gateway-edit-boundaries", "edit-json-native-negative.json");
    const { body } = buildGenerationRequest(textInput({ nativeNegativePrompt: "文字", references: [png] }));
    expect(Object.keys((fixture.request.body as { input: object }).input).sort()).toEqual(["messages", "negative_prompt"]);
    const b = body as { prompt: string; input: { negative_prompt?: string } };
    expect(b.input.negative_prompt).toBe("文字");
    expect(b.prompt).not.toContain("文字");
    expect((buildGenerationRequest(textInput({ references: [png] })).body as { input: object }).input).not.toHaveProperty("negative_prompt");
  });

  it("request_shape 未实现的模型拒绝构造请求", () => {
    const unknown = { ...qwenPro, request_shape: "unknown_shape" };
    expect(() => buildGenerationRequest(textInput({ model: unknown }))).toThrow(GatewayError);
  });

  it("模型发现 GET /v1/models 取 data[].id", async () => {
    const fixture = loadFixture("2026-08-17-team-gateway", "models-success.json");
    const { fetch, calls } = replay(fixture);
    const ids = await listModels({ baseUrl: BASE, apiKey: "k", fetch });
    expect(calls[0]).toMatchObject({ url: `${BASE}/v1/models`, method: "GET", body: null });
    expectMatchesFixture(calls[0].headers, fixture.request.headers, "headers");
    expect(ids).toContain("qwen-image-3.0-pro");
    expect(ids).toHaveLength(10);
  });
});

describe("网关适配器：Seedream 请求形态对照夹具", () => {
  /** 夹具的 image 整体脱敏成一个占位串；客户端发 data-URL 数组，单独断言。 */
  function expectSeedreamBody(actual: Record<string, unknown>, fixture: Exchange, imageCount: number): void {
    const { image: expectedImage, ...expected } = fixture.request.body as Record<string, unknown>;
    const { image, ...rest } = actual;
    expectMatchesFixture(rest, expected);
    if (expectedImage === undefined) {
      expect(image).toBeUndefined();
      return;
    }
    expect(Array.isArray(image)).toBe(true);
    expect((image as string[]).length).toBe(imageCount);
  }

  it("纯文生图 POST /v1/images/generations：顶层 model / prompt / size(WxH) / response_format:url + fixed_params，不带 image", async () => {
    const fixture = loadFixture(SEEDREAM_DIR, "lite-burst10-0.json");
    const { fetch, calls } = replay(fixture);
    await generate({ baseUrl: BASE, apiKey: "sk-test", fetch }, textInput({ model: seedreamLite, size: { width: 2048, height: 2048 } }));
    expect(calls[0].url).toBe(`${BASE}/v1/images/generations`);
    expectMatchesFixture(calls[0].headers, fixture.request.headers, "headers");
    expectSeedreamBody(calls[0].body as Record<string, unknown>, fixture, 0);
    expect(calls[0].body).toMatchObject({ prompt: "一只橘猫", size: "2048x2048", sequential_image_generation: "disabled" });
  });

  it("参考图按序进顶层 image（data-URL 数组），发送文本原样进顶层 prompt", () => {
    const fixture = loadFixture(SEEDREAM_DIR, "pro-refs-tu-3.json");
    const refs = [png, { mediaType: "image/jpeg", bytes: new Uint8Array([1]) }, { mediaType: "image/webp", bytes: new Uint8Array([2]) }];
    const { path, body } = buildGenerationRequest(textInput({ model: seedreamPro, text: "本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图3的帽子戴到图1头上", size: { width: 2048, height: 2048 }, references: refs }));
    expect(path).toBe("/v1/images/generations");
    expectSeedreamBody(body, fixture, 3);
    expect((body.image as string[])[0].startsWith("data:image/png;base64,")).toBe(true);
    expect((body.image as string[]).slice(1)).toEqual(["data:image/jpeg;base64,AQ==", "data:image/webp;base64,Ag=="]);
    expect(body.prompt).toBe("本次提供 3 张参考图，按顺序为图1、图2、图3。\n把图3的帽子戴到图1头上");
    expect(body).not.toHaveProperty("input");
    expect(body).not.toHaveProperty("parameters");
  });

  it("区域指示：叠加图紧随原图进顶层 image", () => {
    const fixture = loadFixture(SEEDREAM_DIR, "lite-region-overlay-1.json");
    const overlay = { mediaType: "image/png", bytes: new Uint8Array([9]) };
    const text = "本次提供 2 张参考图，按顺序为图1、图2。\n把紫色区域改成红色\n图2 是图1 的标注版";
    const { body } = buildGenerationRequest(textInput({ model: seedreamLite, text, size: { width: 3456, height: 1152 }, references: [png, overlay] }));
    expectSeedreamBody(body, fixture, 2);
    expect((body.image as string[])[1]).toBe("data:image/png;base64,CQ==");
    expect(body.prompt).toBe(text);
  });

  it("透明背景：pro 打开开关附带 background:transparent；关闭不带", () => {
    const fixture = loadFixture(SEEDREAM_DIR, "pro-transparent-1.json");
    const input = textInput({ model: seedreamPro, size: { width: 2048, height: 2048 }, references: [png], transparentBackground: true });
    const { body } = buildGenerationRequest(input);
    expectSeedreamBody(body, fixture, 1);
    expect(body.background).toBe("transparent");
    const ctl = loadFixture(SEEDREAM_DIR, "pro-transparent-ctl.json");
    const off = buildGenerationRequest({ ...input, transparentBackground: false }).body;
    expectSeedreamBody(off, ctl, 1);
  });

  it("无原生负向字段：不发 negative_prompt（负向已由发送计划拼进文本）", () => {
    const edit = buildGenerationRequest(textInput({ model: seedreamPro, text: "本次提供 1 张参考图。\n一只橘猫\n避免出现：模糊", references: [png] })).body;
    expect(edit.prompt).toBe("本次提供 1 张参考图。\n一只橘猫\n避免出现：模糊");
    expect(edit).not.toHaveProperty("negative_prompt");
    expect(buildGenerationRequest(textInput({ model: seedreamLite })).body).not.toHaveProperty("negative_prompt");
  });

  it("透明背景：能力表不支持的模型（lite、qwen）即使开关打开也不发 background", () => {
    expect(buildGenerationRequest(textInput({ model: seedreamLite, references: [png], transparentBackground: true })).body).not.toHaveProperty("background");
    expect(JSON.stringify(buildGenerationRequest(textInput({ references: [png], transparentBackground: true })).body)).not.toContain("transparent");
  });

  it("出图取顶层 data[].url，不看 metadata.output.choices", async () => {
    const fixture = loadFixture(SEEDREAM_DIR, "pro-region-overlay-1.json");
    const { fetch } = replay(fixture);
    const { images, requestId } = await generate({ baseUrl: BASE, apiKey: "k", fetch }, textInput({ model: seedreamPro, references: [png, png] }));
    expect(images).toEqual([{ kind: "url", url: "https://example.invalid/redacted" }]);
    expect(requestId).toBe(fixture.response.headers["X-Oneapi-Request-Id"]);
  });

  it("超参考图上限 HTTP 400 → 网关拒绝，带网关原文", async () => {
    const fixture = loadFixture(SEEDREAM_DIR, "pro-limit-11.json");
    const { fetch } = replay(fixture);
    const error = await generate({ baseUrl: BASE, apiKey: "k", fetch }, textInput({ model: seedreamPro, references: Array(11).fill(png) })).catch((e) => e);
    expect(error).toMatchObject({ category: "rejected", status: 400 });
    expect(error.message).toContain("number of reference images cannot exceed 10");
  });
});

/** 回放用输入：Seedream 夹具按文件名前缀选模型（响应按请求形态解析），其余按 qwen。 */
function replayInput(name: string, exchange: Exchange): GenerationInput {
  const body = exchange.request.body as Record<string, unknown>;
  if (name.startsWith(`${SEEDREAM_DIR}/`)) {
    return textInput({ model: name.includes("/lite-") ? seedreamLite : seedreamPro, references: "image" in body ? [png] : [] });
  }
  return textInput({ references: exchange.request.path === "/v1/images/edits" ? [png] : [] });
}

describe("网关适配器：夹具响应回放", () => {
  const expectations: Record<number, string> = { 400: "rejected", 401: "auth", 503: "server" };

  for (const { name, exchange } of allExchanges) {
    it(name, async () => {
      const { fetch } = replay(exchange, (url) => (url.startsWith("https://example.invalid/") ? PNG_BYTES : undefined));
      const config = { baseUrl: BASE, apiKey: "k", fetch };
      const run =
        exchange.request.path === "/v1/models"
          ? listModels(config)
          : generate(config, replayInput(name, exchange));
      if (exchange.response.status === 200) {
        const outcome = await run;
        if (exchange.request.path === "/v1/models") expect(outcome).toContain("qwen-image-3.0-pro");
        else expect(await fetchResultImage(fetch, (outcome as Awaited<ReturnType<typeof generate>>).images[0])).toEqual(PNG_BYTES);
      } else {
        const error = await run.then(
          () => null,
          (e) => e,
        );
        expect(error).toBeInstanceOf(GatewayError);
        expect(error.category).toBe(expectations[exchange.response.status]);
        expect(error.status).toBe(exchange.response.status);
        expect(error.requestId).toBe(exchange.response.headers["X-Oneapi-Request-Id"]);
      }
    });
  }
});

describe("出图解析与错误映射", () => {
  it("出图真源是 metadata.output.choices[].message.content[].image，不看顶层 data", () => {
    const body = {
      data: [{ url: "https://wrong.invalid/last" }],
      metadata: { output: { choices: [{ message: { content: [{ image: "https://right.invalid/first" }, { text: "x" }, { image: PNG_BASE64 }] } }] } },
    };
    const images = parseGeneratedImages(body);
    expect(images).toEqual([{ kind: "url", url: "https://right.invalid/first" }, { kind: "bytes", bytes: PNG_BYTES }]);
  });

  it("兼容 data URI 形式的 base64", () => {
    const images = parseGeneratedImages({ metadata: { output: { choices: [{ message: { content: [{ image: `data:image/png;base64,${PNG_BASE64}` }] } }] } } });
    expect(images).toEqual([{ kind: "bytes", bytes: PNG_BYTES }]);
  });

  it("200 但没有出图 → 响应无效", async () => {
    const fetch: FetchLike = async () => ({ status: 200, headers: new Headers(), text: async () => "{\"data\":[]}", arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(generate({ baseUrl: BASE, apiKey: "k", fetch }, textInput())).rejects.toMatchObject({ category: "invalid_response" });
  });

  it("429 → 限流；其他 4xx → 网关拒绝；5xx → 服务错误；fetch 抛错 → 网络不可达；只发一次", async () => {
    for (const [status, category] of [
      [429, "rate_limited"],
      [404, "rejected"],
      [502, "server"],
    ] as const) {
      let count = 0;
      const fetch: FetchLike = async () => {
        count++;
        return { status, headers: new Headers(), text: async () => "not json", arrayBuffer: async () => new ArrayBuffer(0) };
      };
      await expect(generate({ baseUrl: BASE, apiKey: "k", fetch }, textInput())).rejects.toMatchObject({ category, status });
      expect(count).toBe(1);
    }
    const offline: FetchLike = async () => {
      throw new TypeError("error sending request");
    };
    await expect(generate({ baseUrl: BASE, apiKey: "k", fetch: offline }, textInput())).rejects.toMatchObject({ category: "network", status: null });
  });

  it("未配置密钥或地址时不发请求", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("不应发出请求");
    };
    await expect(listModels({ baseUrl: BASE, apiKey: "", fetch })).rejects.toMatchObject({ category: "config" });
    await expect(listModels({ baseUrl: "", apiKey: "k", fetch })).rejects.toMatchObject({ category: "config" });
  });

  it("错误信息不带密钥", async () => {
    const fetch: FetchLike = async () => ({
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: "Invalid token sk-secret-123" } }),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const error = await listModels({ baseUrl: BASE, apiKey: "sk-secret-123", fetch }).catch((e) => e);
    expect(String(error.message)).not.toContain("sk-secret-123");
  });
});
