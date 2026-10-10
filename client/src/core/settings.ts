// 高级设置与模型发现。settings.json 在 app-data 目录，只前向迁移；API 密钥不在这里（系统凭据库）。
import { type CapabilityTable, type ModelCapability, modelsByTier } from "./capabilities";
import { ERROR_CATEGORY_LABELS, GatewayError, listModels, type FetchLike } from "./gateway";

export const SETTINGS_FORMAT_VERSION = 1;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 10;

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
  concurrency: 4,
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

export type Discovery = { source: "live" | "cached"; ids: string[]; fetchedAt: string } | { source: "none"; failed?: boolean };

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
  if (discovery.source === "none") return discovery.failed ? [] : shelved(table);
  const ids = new Set(discovery.ids);
  return shelved(table).filter((m) => ids.has(m.model_id));
}

/** 已发现模型列表但网关没有该模型时的标红原因。 */
export function modelAvailabilityIssue(table: CapabilityTable, discovery: Discovery, modelId: string): string | null {
  if (modelId === PREFERRED_TASK_MODEL && (discovery.source === "none" ? discovery.failed : !discovery.ids.includes(modelId))) return "Flash 不可用，请刷新模型列表或手动选择其它可用模型";
  if (discovery.source === "none") return discovery.failed ? "模型发现失败，请刷新模型列表" : null;
  if (discovery.ids.includes(modelId)) return null;
  const name = table.models.find((m) => m.model_id === modelId)?.display_name ?? modelId;
  return `网关未提供模型 ${name}`;
}

/** 画板没有最近选择时的首选模型。 */
export const PREFERRED_TASK_MODEL = "doubao-seedream-5-0-flash-260915";

/** 新建任务节点沿用有效最近选择，否则保留 Flash 身份；不可用由任务视图明确阻止，不自动替代。 */
export function defaultTaskModel(table: CapabilityTable, discovery: Discovery, lastModel: string | null | undefined): string | null {
  const available = availableModels(table, discovery);
  if (lastModel && available.some((m) => m.model_id === lastModel)) return lastModel;
  return PREFERRED_TASK_MODEL;
}

/** 迭代动作用的默认编辑模型：工具栏模型（支持图片编辑时）→ 可用列表里第一个支持图片编辑的 → 上架清单里第一个；都没有为 null。 */
export function defaultEditModel(table: CapabilityTable, discovery: Discovery, lastModel: string | null | undefined): ModelCapability | null {
  const canEdit = (m: ModelCapability) => m.workflows.image_edit.max_references > 0;
  const toolbar = table.models.find((m) => m.model_id === defaultTaskModel(table, discovery, lastModel));
  if (toolbar && canEdit(toolbar)) return toolbar;
  return availableModels(table, discovery).find(canEdit) ?? shelved(table).find(canEdit) ?? null;
}

// ---- 载入 / 保存 / 模型刷新（#128）：经端口注入的无状态函数，不弹窗、不含文案；React 状态与提示在 ui/useSettings.ts ----

/** persisted = 已存入系统凭据库；session = 凭据库不可用，只在本次运行的内存里。 */
export type KeyPersistence = "persisted" | "session";

export interface SettingsPorts {
  readSettings(): Promise<string | null>;
  writeSettings(text: string): Promise<void>;
  readModelsCache(): Promise<string | null>;
  writeModelsCache(text: string): Promise<void>;
  /** 系统凭据库；不可用时抛错。 */
  secretGet(): Promise<string | null>;
  secretSet(key: string): Promise<void>;
  secretDelete(): Promise<void>;
  fetch: FetchLike;
  now(): Date;
  log(kind: "connection", fields: Record<string, unknown>): void;
}

/** 保存前的现状：决定写不写 settings.json、要不要碰凭据库。 */
export interface SaveBaseline {
  fileKind: LoadedSettings["kind"];
  apiKey: string;
  keyPersistence: KeyPersistence;
}

export type SaveResult = { ok: true; settingsWritten: boolean; keyPersistence: KeyPersistence } | { ok: false; error: string };

export interface InitialSettings {
  file: LoadedSettings;
  apiKey: string;
  keyPersistence: KeyPersistence;
  cache: ModelsCache | null;
}

/** 读 settings.json、模型缓存与凭据库密钥；读文件失败按缺失处理，凭据库抛错退回 session。 */
export async function loadSettings(ports: SettingsPorts): Promise<InitialSettings> {
  const file = parseSettings(await ports.readSettings().catch(() => null));
  const cache = parseModelsCache(await ports.readModelsCache().catch(() => null));
  try {
    return { file, apiKey: (await ports.secretGet()) ?? "", keyPersistence: "persisted", cache };
  } catch {
    return { file, apiKey: "", keyPersistence: "session", cache };
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 保存设置与密钥。newer 时不覆盖 settings.json 但仍存密钥；密钥变了或当前为 session 才写凭据库，凭据库抛错退回 session。 */
export async function saveSettings(ports: SettingsPorts, current: SaveBaseline, next: Settings, apiKey: string): Promise<SaveResult> {
  const settingsWritten = current.fileKind !== "newer";
  if (settingsWritten) {
    try {
      await ports.writeSettings(serializeSettings(next));
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }
  let keyPersistence: KeyPersistence = "persisted";
  if (apiKey !== current.apiKey || current.keyPersistence === "session") {
    try {
      if (apiKey) await ports.secretSet(apiKey);
      else await ports.secretDelete();
    } catch {
      keyPersistence = "session";
    }
  }
  return { ok: true, settingsWritten, keyPersistence };
}

export type RefreshResult =
  | { ok: true; cache: ModelsCache; discovery: Discovery }
  /** message：网关错误的可展示说明（「类别文案：网关原文」，类别与失败徽标同口径）；非网关错误为 null（由 ui 给兜底文案）。 */
  | { ok: false; message: string | null; discovery: Discovery };

/** 模型发现：成功写缓存（写失败不影响结果）；失败回落到同 base_url 的缓存。两种结局都记一条 connection 日志。 */
export async function refreshModels(ports: SettingsPorts, baseUrl: string, apiKey: string, cache: ModelsCache | null): Promise<RefreshResult> {
  try {
    const ids = await listModels({ baseUrl, apiKey, fetch: ports.fetch });
    const fresh: ModelsCache = { base_url: normalizeBaseUrl(baseUrl), fetched_at: ports.now().toISOString(), model_ids: ids };
    await ports.writeModelsCache(serializeModelsCache(fresh)).catch(() => undefined);
    ports.log("connection", { stage: "list_models", ok: true, models: ids.length });
    return { ok: true, cache: fresh, discovery: { source: "live", ids, fetchedAt: fresh.fetched_at } };
  } catch (e) {
    const gateway = e instanceof GatewayError ? e : null;
    ports.log("connection", { stage: "list_models", ok: false, category: gateway?.category ?? "unknown", status_code: gateway?.status, message: gateway?.message ?? String(e) });
    const message = gateway ? `${ERROR_CATEGORY_LABELS[gateway.category]}：${gateway.message}` : null;
    const cached = discoveryFromCache(cache, baseUrl);
    return { ok: false, message, discovery: cached.source === "none" ? { source: "none", failed: true } : cached };
  }
}
