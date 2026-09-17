// 团队网关适配器（规格第 5 节，契约 docs/contracts/team-gateway-contract.md）。
// 路径、载荷与出图解析全部来自 contracts/fixtures 实测夹具；生成请求只发一次，不重发、不用幂等键、不查任务。
// HTTP 由调用方注入（壳里是 tauri-plugin-http 的 fetch，测试里是夹具回放）。
import type { ModelCapability } from "./capabilities";
import { promptLanguage, rewriteImageRefs, type PromptLanguage } from "./imageRefs";
import { rewriteRegionRefs } from "./region";

export const MODELS_PATH = "/v1/models";
export const TEXT_TO_IMAGE_PATH = "/v1/images/generations";
export const IMAGE_EDIT_PATH = "/v1/images/edits";

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
}

export type GatewayErrorCategory = "config" | "auth" | "rate_limited" | "rejected" | "server" | "network" | "invalid_response";

/** 脱敏错误类别：任务节点失败徽标上只显示这些。 */
export const ERROR_CATEGORY_LABELS: Record<GatewayErrorCategory, string> = {
  config: "未配置网关",
  auth: "鉴权失败",
  rate_limited: "网关限流",
  rejected: "网关拒绝",
  server: "服务错误",
  network: "网络不可达",
  invalid_response: "响应无效",
};

export class GatewayError extends Error {
  constructor(
    readonly category: GatewayErrorCategory,
    message: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export function categoryForStatus(status: number): GatewayErrorCategory {
  if (status === 401) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "rejected";
}

export interface ReferenceImage {
  mediaType: string;
  bytes: Uint8Array;
}

export interface GenerationInput {
  model: ModelCapability;
  prompt: string;
  negativePrompt: string;
  size: { width: number; height: number };
  /** 按参考图序号排列；0 张 = 文生图。 */
  references: ReferenceImage[];
  /** 区域指示固定句，追加在发送文本末尾。 */
  regionPhrases?: string[];
  /** 区域编号的颜色指代（区域N 取第 N 个），改写提示词里的「区域N」。 */
  regionNames?: string[];
}

export type GeneratedImage = ({ kind: "url"; url: string } | { kind: "bytes"; bytes: Uint8Array }) & {
  /** 图层信息（z_index / bounding_box 取自 content item，合成形状待 #83 确认）。 */
  layer?: { z_index: number; bounding_box: number[] };
};

// ---- 请求构造 ----

function referenceNote(count: number, language: PromptLanguage): string {
  if (language === "en") {
    if (count === 1) return "This request provides 1 reference image.";
    const ordered = Array.from({ length: count }, (_, i) => `Image ${i + 1}`).join(", ");
    return `This request provides ${count} reference images, in order: ${ordered}.`;
  }
  if (count <= 1) return `本次提供 ${count} 张参考图。`;
  const ordered = Array.from({ length: count }, (_, i) => `图${i + 1}`).join("、");
  return `本次提供 ${count} 张参考图，按顺序为${ordered}。`;
}

/**
 * 完整发送文本：二次确认弹窗展示、任务记录保存的都是它。
 * 提示词里的 @图N 按语言改写（只改发送文本）；文生图即改写后的提示词（负向走独立字段）；
 * 图片编辑注入数量顺序前缀，负向并入文本（契约「开放试用」一节）；区域指示固定句追加在末尾。
 */
export function composeSendText({
  prompt,
  negativePrompt,
  referenceCount,
  regionPhrases = [],
  regionNames = [],
}: {
  prompt: string;
  negativePrompt: string;
  referenceCount: number;
  /** 区域指示固定句（每个叠加参考图一句），逐句追加在末尾。 */
  regionPhrases?: string[];
  /** 区域编号的颜色指代，改写提示词里的「区域N」。 */
  regionNames?: string[];
}): string {
  const phrases = regionPhrases.length ? `\n${regionPhrases.join("\n")}` : "";
  const text = rewriteRegionRefs(rewriteImageRefs(prompt), regionNames);
  if (referenceCount === 0) return `${text}${phrases}`;
  const language = promptLanguage(prompt);
  const withNote = `${referenceNote(referenceCount, language)}\n${text}`;
  if (!negativePrompt) return `${withNote}${phrases}`;
  return `${withNote}\n${language === "en" ? "Avoid: " : "避免出现："}${negativePrompt}${phrases}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

type RequestShape = (input: GenerationInput) => { path: string; body: Record<string, unknown> };

/** qwen 系列：文生图顶层字段；图片编辑 JSON 透传（ADR 0006）。 */
const qwenImagesEdits: RequestShape = (input) => {
  const { model, prompt, negativePrompt, size, references } = input;
  if (references.length === 0) {
    const body: Record<string, unknown> = { model: model.model_id, prompt: composeSendText({ prompt, negativePrompt, referenceCount: 0 }) };
    if (negativePrompt) body.negative_prompt = negativePrompt;
    Object.assign(body, { n: 1, size: `${size.width}x${size.height}` }, model.fixed_params);
    return { path: TEXT_TO_IMAGE_PATH, body };
  }
  const text = composeSendText({ prompt, negativePrompt, referenceCount: references.length, regionPhrases: input.regionPhrases ?? [], regionNames: input.regionNames ?? [] });
  const content = [...references.map((r) => ({ image: `data:${r.mediaType};base64,${toBase64(r.bytes)}` })), { text }];
  return {
    path: IMAGE_EDIT_PATH,
    body: {
      model: model.model_id,
      // 顶层 prompt 是网关必填字段，即使已有 input。
      prompt: text,
      // 透传路径不做 x→* 转换，尺寸必须是「宽*高」。
      parameters: { size: `${size.width}*${size.height}`, n: 1, ...model.fixed_params },
      input: { messages: [{ role: "user", content }] },
    },
  };
};

/** 按能力表 request_shape 选择请求形态；Seedream 形态待 #83 确认后在此登记。 */
const REQUEST_SHAPES: Record<string, RequestShape> = {
  qwen_images_edits: qwenImagesEdits,
};

export function isRequestShapeImplemented(model: ModelCapability): boolean {
  return model.request_shape in REQUEST_SHAPES;
}

export function buildGenerationRequest(input: GenerationInput): { path: string; body: Record<string, unknown> } {
  const shape = REQUEST_SHAPES[input.model.request_shape];
  if (!shape) throw new GatewayError("config", `模型 ${input.model.display_name} 的请求形态（${input.model.request_shape}）尚未实现`);
  return shape(input);
}

// ---- 发送与错误映射 ----

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

async function send(config: GatewayConfig, method: string, path: string, body?: unknown): Promise<{ body: object; requestId: string | null }> {
  if (!config.baseUrl.trim()) throw new GatewayError("config", "未配置网关基础地址，请在高级设置中填写");
  if (!config.apiKey) throw new GatewayError("config", "未配置 API 密钥，请在高级设置中填写");
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${config.apiKey}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: FetchResponse;
  try {
    response = await config.fetch(endpoint(config.baseUrl, path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new GatewayError("network", redact(`无法连接网关：${e instanceof Error ? e.message : String(e)}`, config.apiKey));
  }
  const requestId = response.headers.get("X-Oneapi-Request-Id");
  const text = await response.text().catch(() => "");
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 错误响应可能不是 JSON，下面按状态码处理。
  }
  if (response.status >= 400) {
    const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
    // 网关原文可能回显请求内容：截短，只留定位问题所需的开头。
    const detail = typeof message === "string" && message ? `HTTP ${response.status}：${message.slice(0, 120)}` : `HTTP ${response.status}`;
    throw new GatewayError(categoryForStatus(response.status), redact(detail, config.apiKey), response.status, requestId);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new GatewayError("invalid_response", "网关返回了无法解析的响应", response.status, requestId);
  }
  return { body: parsed, requestId };
}

/** 连接测试与模型发现：GET /v1/models 的 data[].id。 */
export async function listModels(config: GatewayConfig): Promise<string[]> {
  const body = (await send(config, "GET", MODELS_PATH)).body as { data?: unknown };
  if (!Array.isArray(body.data)) throw new GatewayError("invalid_response", "模型列表响应缺少 data");
  return body.data.flatMap((m) => (typeof m?.id === "string" ? [m.id] : []));
}

function decodeBase64(value: string): Uint8Array | null {
  const token = value.startsWith("data:") ? value.slice(value.indexOf(";base64,") + ";base64,".length) : value;
  if (value.startsWith("data:") && !value.includes(";base64,")) return null;
  if (!/^[A-Za-z0-9+/\s]+=*$/.test(token)) return null;
  try {
    return Uint8Array.from(atob(token.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 出图真源 metadata.output.choices[].message.content[].image，兼容临时 URL 与 base64（契约「当前结论」）。 */
export function parseGeneratedImages(body: unknown): GeneratedImage[] {
  const choices = (body as { metadata?: { output?: { choices?: unknown } } })?.metadata?.output?.choices;
  if (!Array.isArray(choices)) return [];
  const out: GeneratedImage[] = [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const image = item?.image;
      if (typeof image !== "string" || !image) continue;
      // 图层字段的合成形状待 #83 确认：z_index 数字、bounding_box 数字数组，缺一不算图层。
      const zIndex = typeof item?.z_index === "number" ? item.z_index : null;
      const box = Array.isArray(item?.bounding_box) && item.bounding_box.every((n: unknown) => typeof n === "number") ? (item.bounding_box as number[]) : null;
      const layer = zIndex !== null && box !== null ? { z_index: zIndex, bounding_box: box } : undefined;
      if (/^https?:\/\//i.test(image)) out.push({ kind: "url", url: image, ...(layer ? { layer } : {}) });
      else {
        const bytes = decodeBase64(image);
        if (bytes) out.push({ kind: "bytes", bytes, ...(layer ? { layer } : {}) });
      }
    }
  }
  return out;
}

/** 提交一个生成任务；图层拆分时可能返回多张（首张为合成结果）。 */
export async function generate(config: GatewayConfig, input: GenerationInput): Promise<{ images: GeneratedImage[]; requestId: string | null }> {
  const { path, body } = buildGenerationRequest(input);
  const response = await send(config, "POST", path, body);
  const images = parseGeneratedImages(response.body);
  if (!images.length) throw new GatewayError("invalid_response", "网关没有返回图片", 200, response.requestId);
  return { images, requestId: response.requestId };
}

/** 取结果图字节；临时地址下载不带网关鉴权头。 */
export async function fetchResultImage(fetch: FetchLike, image: GeneratedImage): Promise<Uint8Array> {
  if (image.kind === "bytes") return image.bytes;
  let response: FetchResponse;
  try {
    response = await fetch(image.url, { method: "GET", headers: { Accept: "image/*" } });
  } catch (e) {
    // 不带原始错误：可能含临时签名地址。
    throw new GatewayError("network", "下载结果图失败：网络不可达");
  }
  if (response.status >= 400) throw new GatewayError(categoryForStatus(response.status), `下载结果图失败：HTTP ${response.status}`, response.status);
  return new Uint8Array(await response.arrayBuffer());
}
