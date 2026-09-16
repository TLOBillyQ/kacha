// 高级设置与模型发现（规格第 12 节）。settings.json 在 app-data 目录，只前向迁移；API 密钥不在这里（系统凭据库）。
import { type CapabilityTable, type ModelCapability, modelsByTier } from "./capabilities";

export const SETTINGS_FORMAT_VERSION = 1;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 5;

type Json = Record<string, unknown>;

export interface Settings {
  format_version: number;
  base_url: string;
  /** null = 跟随默认输出根目录（图片目录下）。 */
  output_root: string | null;
  /** 全局队列的并发上限。 */
  concurrency: number;
  extra: Json;
}

export const DEFAULT_SETTINGS: Settings = {
  format_version: SETTINGS_FORMAT_VERSION,
  base_url: "http://lzxsvn:3001",
  output_root: null,
  concurrency: 3,
  extra: {},
};

export type LoadedSettings =
  | { kind: "ok"; settings: Settings }
  | { kind: "newer"; version: number; settings: Settings }
  | { kind: "corrupt"; reason: string; settings: Settings };

const KNOWN_KEYS = ["format_version", "base_url", "output_root", "concurrency"];
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function corrupt(reason: string): LoadedSettings {
  return { kind: "corrupt", reason, settings: DEFAULT_SETTINGS };
}

/** 缺失字段取默认值；字段类型错误整份按损坏处理。 */
export function parseSettings(text: string | null): LoadedSettings {
  if (text === null) return { kind: "ok", settings: DEFAULT_SETTINGS };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return corrupt("不是有效的 JSON");
  }
  if (!isObject(raw)) return corrupt("顶层必须是对象");
  const version = raw.format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return corrupt("format_version 必须是正整数");
  if ((version as number) > SETTINGS_FORMAT_VERSION) return { kind: "newer", version: version as number, settings: DEFAULT_SETTINGS };
  const baseUrl = raw.base_url ?? DEFAULT_SETTINGS.base_url;
  const outputRoot = raw.output_root ?? null;
  const concurrency = raw.concurrency ?? DEFAULT_SETTINGS.concurrency;
  if (typeof baseUrl !== "string") return corrupt("base_url 必须是字符串");
  if (outputRoot !== null && (typeof outputRoot !== "string" || !outputRoot)) return corrupt("output_root 必须是非空字符串或 null");
  if (!Number.isInteger(concurrency) || (concurrency as number) < MIN_CONCURRENCY || (concurrency as number) > MAX_CONCURRENCY) {
    return corrupt(`concurrency 必须是 ${MIN_CONCURRENCY}～${MAX_CONCURRENCY} 的整数`);
  }
  const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !KNOWN_KEYS.includes(k)));
  return {
    kind: "ok",
    settings: { format_version: SETTINGS_FORMAT_VERSION, base_url: baseUrl, output_root: outputRoot as string | null, concurrency: concurrency as number, extra },
  };
}

export function serializeSettings(settings: Settings): string {
  const { extra, ...known } = settings;
  return `${JSON.stringify({ ...known, format_version: SETTINGS_FORMAT_VERSION, ...extra }, null, 2)}\n`;
}

/** 返回错误说明；合法为 null。 */
export function validateBaseUrl(value: string): string | null {
  const text = value.trim();
  if (!text) return "请填写网关基础地址";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "地址格式无效，应形如 http://主机:端口";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "只支持 http:// 或 https:// 地址";
  if (!url.hostname) return "地址缺少主机名";
  return null;
}

/** ADR 0003：明文 HTTP 仅限可信网络，设置面板保留风险提示。 */
export function isPlainHttp(value: string): boolean {
  return /^http:\/\//i.test(value.trim());
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

// ---- 模型发现 ----

export interface ModelsCache {
  base_url: string;
  fetched_at: string;
  model_ids: string[];
}

export type Discovery = { source: "live" | "cached"; ids: string[]; fetchedAt: string } | { source: "none" };

export function parseModelsCache(text: string | null): ModelsCache | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text);
    if (!isObject(raw) || typeof raw.base_url !== "string" || typeof raw.fetched_at !== "string") return null;
    if (!Array.isArray(raw.model_ids) || !raw.model_ids.every((id) => typeof id === "string")) return null;
    return { base_url: raw.base_url, fetched_at: raw.fetched_at, model_ids: raw.model_ids };
  } catch {
    return null;
  }
}

export function serializeModelsCache(cache: ModelsCache): string {
  return `${JSON.stringify(cache, null, 2)}\n`;
}

/** 离线时用上次成功发现的缓存；缓存属于别的网关地址时不用。 */
export function discoveryFromCache(cache: ModelsCache | null, baseUrl: string): Discovery {
  if (!cache || normalizeBaseUrl(cache.base_url) !== normalizeBaseUrl(baseUrl)) return { source: "none" };
  return { source: "cached", ids: cache.model_ids, fetchedAt: cache.fetched_at };
}

function shelved(table: CapabilityTable): ModelCapability[] {
  return modelsByTier(table).flatMap((g) => g.models);
}

/** 任务节点模型列表 = 发现结果 ∩ 上架清单；从未发现过时退回上架清单。 */
export function availableModels(table: CapabilityTable, discovery: Discovery): ModelCapability[] {
  if (discovery.source === "none") return shelved(table);
  const ids = new Set(discovery.ids);
  return shelved(table).filter((m) => ids.has(m.model_id));
}

/** 已发现模型列表但网关没有该模型时的标红原因。 */
export function modelAvailabilityIssue(table: CapabilityTable, discovery: Discovery, modelId: string): string | null {
  if (discovery.source === "none" || discovery.ids.includes(modelId)) return null;
  const name = table.models.find((m) => m.model_id === modelId)?.display_name ?? modelId;
  return `网关未提供模型 ${name}`;
}

/** 新建任务节点的模型：画板级最近选择（仍可用时）→ 可用列表第一个 → 上架清单第一个；都没有为 null。 */
export function defaultTaskModel(table: CapabilityTable, discovery: Discovery, lastModel: string | null | undefined): string | null {
  const available = availableModels(table, discovery);
  if (lastModel && available.some((m) => m.model_id === lastModel)) return lastModel;
  return available[0]?.model_id ?? shelved(table)[0]?.model_id ?? null;
}
