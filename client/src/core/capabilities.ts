// 模型能力表：模型决定能力，能力决定生成任务节点上露出的端口、开关与档位。
// 内置 JSON + 同 schema 覆盖文件，按 model_id 整条合并；不按模型名猜能力。
import builtinJson from "./capabilities.builtin.json";

export const CAPABILITY_FORMAT_VERSION = 1;

/** 三态：待测在 UI 上等同不支持，仅在模型说明浮层列出。 */
export type TriState = "supported" | "unsupported" | "untested";
export type Tier = "flagship" | "economy";
export type WorkflowName = "text_to_image" | "image_edit";
export type RegionHintKind = "highlight_overlay" | "marked_image" | "bbox_tag";

export const TIER_LABELS: Record<Tier, string> = { flagship: "旗舰", economy: "经济" };

export interface InputImageRule {
  formats: string[];
  max_bytes: number | null;
  min_total_pixels: number | null;
  max_total_pixels: number | null;
  min_short_edge: number | null;
  min_aspect_ratio: number | null;
  max_aspect_ratio: number | null;
}

export interface PixelRange {
  min_total_pixels: number | null;
  max_total_pixels: number | null;
  min_aspect_ratio: number | null;
  max_aspect_ratio: number | null;
}

export interface SizeRule {
  /** 档位 → 比例 → [宽, 高]；对象键顺序即下拉顺序。 */
  tiers: Record<string, Record<string, [number, number]>>;
  custom: PixelRange | null;
}

export interface WorkflowCapability {
  supports_negative_prompt: TriState;
  min_references: number;
  max_references: number;
  size_rule: SizeRule;
  layer_decomposition: TriState;
}

export interface ModelCapability {
  model_id: string;
  display_name: string;
  tier: Tier | null;
  help_url: string | null;
  request_shape: string;
  fixed_params: Record<string, unknown>;
  input_image_rule: InputImageRule;
  reference_phrasing: { en_verified: TriState };
  region_hint: Record<RegionHintKind, TriState>;
  region_hint_phrasing: Partial<Record<RegionHintKind, { zh: string; en: string }>>;
  native_mask: TriState;
  transparent_background: TriState;
  workflows: Record<WorkflowName, WorkflowCapability>;
}

export interface CapabilityTable {
  format_version: number;
  models: ModelCapability[];
}

export type ParseResult = { ok: true; table: CapabilityTable } | { ok: false; errors: string[] };

export function isSupported(value: TriState): boolean {
  return value === "supported";
}

export function findModel(table: CapabilityTable, modelId: string): ModelCapability | undefined {
  return table.models.find((m) => m.model_id === modelId);
}

/** 模型选择器：只按档位分组展示上架模型（有档位 = 上架，ADR 0005）。 */
export function modelsByTier(table: CapabilityTable): { tier: Tier; models: ModelCapability[] }[] {
  return (["flagship", "economy"] as const)
    .map((tier) => ({ tier, models: table.models.filter((m) => m.tier === tier) }))
    .filter((group) => group.models.length > 0);
}

const REGION_LABELS: Record<RegionHintKind, string> = {
  highlight_overlay: "区域指示：高亮叠加参考图",
  marked_image: "区域指示：图上标记",
  bbox_tag: "区域指示：坐标标签",
};
const WORKFLOW_LABELS: Record<WorkflowName, string> = { text_to_image: "文生图", image_edit: "图片编辑" };

/** 模型说明浮层列出的「待测」能力。 */
export function untestedCapabilities(model: ModelCapability): string[] {
  const out: string[] = [];
  if (model.reference_phrasing.en_verified === "untested") out.push("英文序号措辞");
  for (const kind of Object.keys(REGION_LABELS) as RegionHintKind[]) {
    if (model.region_hint[kind] === "untested") out.push(REGION_LABELS[kind]);
  }
  if (model.native_mask === "untested") out.push("原生蒙版");
  if (model.transparent_background === "untested") out.push("透明背景");
  for (const wf of Object.keys(WORKFLOW_LABELS) as WorkflowName[]) {
    if (model.workflows[wf].supports_negative_prompt === "untested") out.push(`负向提示词（${WORKFLOW_LABELS[wf]}）`);
  }
  for (const wf of Object.keys(WORKFLOW_LABELS) as WorkflowName[]) {
    if (model.workflows[wf].layer_decomposition === "untested") out.push(`拆分图层（${WORKFLOW_LABELS[wf]}）`);
  }
  return out;
}

/** 覆盖文件按模型合并：同 model_id 整条替换内置，新模型追加。 */
export function mergeOverride(builtin: CapabilityTable, override: CapabilityTable): CapabilityTable {
  const byId = new Map(override.models.map((m) => [m.model_id, m]));
  const models = builtin.models.map((m) => byId.get(m.model_id) ?? m);
  const known = new Set(builtin.models.map((m) => m.model_id));
  models.push(...override.models.filter((m) => !known.has(m.model_id)));
  return { format_version: builtin.format_version, models };
}

// ---- schema 校验 ----

const TRI_STATES = new Set(["supported", "unsupported", "untested"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkTri(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !TRI_STATES.has(value)) errors.push(`${path} 必须是 supported / unsupported / untested`);
}

function checkNullableNumber(value: unknown, path: string, errors: string[]): void {
  if (value !== null && (typeof value !== "number" || !(value > 0))) errors.push(`${path} 必须是正数或 null`);
}

function checkPixelRange(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  for (const key of ["min_total_pixels", "max_total_pixels", "min_aspect_ratio", "max_aspect_ratio"]) {
    checkNullableNumber(value[key] ?? null, `${path}.${key}`, errors);
  }
}

function checkWorkflow(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  checkTri(value.supports_negative_prompt, `${path}.supports_negative_prompt`, errors);
  checkTri(value.layer_decomposition, `${path}.layer_decomposition`, errors);
  const min = value.min_references;
  const max = value.max_references;
  if (!Number.isInteger(min) || (min as number) < 0) errors.push(`${path}.min_references 必须是非负整数`);
  if (!Number.isInteger(max) || (max as number) < (min as number)) errors.push(`${path}.max_references 必须是不小于 min 的整数`);
  const size = value.size_rule;
  if (!isObject(size) || !isObject(size.tiers)) return void errors.push(`${path}.size_rule.tiers 必须是对象`);
  for (const [tier, ratios] of Object.entries(size.tiers)) {
    if (!isObject(ratios)) {
      errors.push(`${path}.size_rule.tiers.${tier} 必须是对象`);
      continue;
    }
    for (const [ratio, px] of Object.entries(ratios)) {
      if (!Array.isArray(px) || px.length !== 2 || !px.every((n) => Number.isInteger(n) && n > 0)) {
        errors.push(`${path}.size_rule.tiers.${tier}.${ratio} 必须是两个正整数`);
      }
    }
  }
  if (size.custom != null) checkPixelRange(size.custom, `${path}.size_rule.custom`, errors);
}

function checkModel(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) return void errors.push(`${path} 必须是对象`);
  if (typeof value.model_id !== "string" || !value.model_id) errors.push(`${path}.model_id 必须是非空字符串`);
  if (typeof value.display_name !== "string") errors.push(`${path}.display_name 必须是字符串`);
  if (value.tier !== null && value.tier !== "flagship" && value.tier !== "economy") errors.push(`${path}.tier 必须是 flagship / economy / null`);
  if (value.help_url !== null && typeof value.help_url !== "string") errors.push(`${path}.help_url 必须是字符串或 null`);
  if (typeof value.request_shape !== "string") errors.push(`${path}.request_shape 必须是字符串`);
  if (!isObject(value.fixed_params)) errors.push(`${path}.fixed_params 必须是对象`);
  const rule = value.input_image_rule;
  if (!isObject(rule) || !Array.isArray(rule.formats)) {
    errors.push(`${path}.input_image_rule.formats 必须是数组`);
  } else {
    for (const key of ["max_bytes", "min_total_pixels", "max_total_pixels", "min_short_edge", "min_aspect_ratio", "max_aspect_ratio"]) {
      checkNullableNumber(rule[key] ?? null, `${path}.input_image_rule.${key}`, errors);
    }
  }
  checkTri(isObject(value.reference_phrasing) ? value.reference_phrasing.en_verified : undefined, `${path}.reference_phrasing.en_verified`, errors);
  const hint = isObject(value.region_hint) ? value.region_hint : {};
  for (const kind of ["highlight_overlay", "marked_image", "bbox_tag"]) checkTri(hint[kind], `${path}.region_hint.${kind}`, errors);
  if (!isObject(value.region_hint_phrasing)) errors.push(`${path}.region_hint_phrasing 必须是对象`);
  checkTri(value.native_mask, `${path}.native_mask`, errors);
  checkTri(value.transparent_background, `${path}.transparent_background`, errors);
  const workflows = isObject(value.workflows) ? value.workflows : {};
  checkWorkflow(workflows.text_to_image, `${path}.workflows.text_to_image`, errors);
  checkWorkflow(workflows.image_edit, `${path}.workflows.image_edit`, errors);
}

export function parseCapabilityTable(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, errors: ["能力表必须是 JSON 对象"] };
  const version = raw.format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return { ok: false, errors: ["format_version 必须是正整数"] };
  if ((version as number) > CAPABILITY_FORMAT_VERSION) {
    return { ok: false, errors: [`能力表 format_version ${version} 高于本应用支持的 ${CAPABILITY_FORMAT_VERSION}，请升级应用`] };
  }
  if (!Array.isArray(raw.models)) return { ok: false, errors: ["models 必须是数组"] };
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.models.forEach((model, index) => {
    checkModel(model, `models[${index}]`, errors);
    const id = isObject(model) ? model.model_id : undefined;
    if (typeof id === "string") {
      if (seen.has(id)) errors.push(`models[${index}].model_id 重复：${id}`);
      seen.add(id);
    }
  });
  return errors.length ? { ok: false, errors } : { ok: true, table: raw as unknown as CapabilityTable };
}

function loadBuiltin(): CapabilityTable {
  const result = parseCapabilityTable(builtinJson);
  if (!result.ok) throw new Error(`内置能力表无效：${result.errors.join("；")}`);
  return result.table;
}

export const BUILTIN_TABLE: CapabilityTable = loadBuiltin();

/** 读入覆盖文件文本并与内置表合并；覆盖文件无效时整份忽略并返回错误。 */
export function effectiveTable(overrideText: string | null): { table: CapabilityTable; error: string | null } {
  if (overrideText === null) return { table: BUILTIN_TABLE, error: null };
  let raw: unknown;
  try {
    raw = JSON.parse(overrideText);
  } catch {
    return { table: BUILTIN_TABLE, error: "能力表覆盖文件不是有效 JSON，已忽略" };
  }
  const result = parseCapabilityTable(raw);
  if (!result.ok) return { table: BUILTIN_TABLE, error: `能力表覆盖文件已忽略：${result.errors.join("；")}` };
  return { table: mergeOverride(BUILTIN_TABLE, result.table), error: null };
}
