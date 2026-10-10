// 生成任务视图：一个生成任务按当前画板、能力表与界面采集的事实，能不能运行、为什么、节点上显示什么。
// 生成任务节点与二次确认（buildConfirmItems）消费同一份，「节点标红 ≡ 运行被拦」由构造保证。
// 换模型绝不自动删线或改设置，只报告原因。
import type { Board, TaskNode } from "./board";
import { findModel, isSupported, type CapabilityTable, type ModelCapability } from "./capabilities";
import { flashFeatureImplemented, isRequestShapeImplemented } from "./gateway";
import { imageEdges, imagePortSlots, imageSources, promptText, workflowOf } from "./graph";
import { MAX_REGIONS } from "./overlay";
import { effectiveRegionRender, expandImageEdges } from "./region";
import { planSend, promptLanguage, referenceProblemsOf, type ReferenceProblems, type SendPlan } from "./sendPlan";
import { availableModels, modelAvailabilityIssue, type Discovery } from "./settings";
import { isAutoRatio, ratioRangeText, ratioValue, resolveSize, sizeTiersOf, withinRatioRange } from "./size";

/** 不可运行原因的种类（封闭）。 */
export type ReasonKind =
  | "positiveMissing"
  | "positiveEmpty"
  | "modelUnknown"
  | "modelUnshelved"
  | "modelNotFromGateway"
  | "requestShapeMissing"
  | "imageEditUnsupported"
  | "tooManyReferences"
  | "regionUnsupported"
  | "tooManyRegions"
  | "negativeUnsupported"
  | "sizeUnsupported"
  | "layerUnsupported"
  | "transparentUnsupported"
  | "transparentNeedsOneImage"
  | "transparentNoAlpha"
  | "transparentNeedsPng"
  | "referenceOutOfRange"
  | "sourceLayerInvalid"
  | "imageMissing";

/** 未就绪 = 还没填完（节点不标红）；错误 = 其余（节点标红）。两类都阻止提交。 */
export type ReasonCategory = "notReady" | "error";

export interface UnrunnableReason {
  kind: ReasonKind;
  category: ReasonCategory;
  text: string;
}

/** 界面采集的事实；透明背景必须明确确认 alpha，其余未知按各项规则处理。 */
export interface TaskFacts {
  /** 图片文件缺失的参考图 / 结果节点 id。 */
  missingNodes: ReadonlySet<string>;
  /** 节点 id → 是否带透明通道；不在 Map 里 = 未知。 */
  alphaByNode: ReadonlyMap<string, boolean>;
  discovery: Discovery;
}

/** 任务开关能不能打开；hint 为不能打开的简短说明，能打开时为空串。已打开的开关不受它约束（条件变坏保留 + 标红，绝不自动关）。 */
export interface ToggleAvailability {
  canEnable: boolean;
  hint: string;
}

/** 模型标签 4 态：正常 / 能力表里没有 / 已发现模型列表但网关没有 / 不在上架清单。 */
export type ModelLabelState = "ok" | "unknown" | "notFromGateway" | "unshelved";

export interface TaskView {
  /** 不可运行原因；空 = 可运行。节点标红只看 category 为 error 的。 */
  reasons: UnrunnableReason[];
  /** 黄色提示，不阻断。 */
  warnings: string[];
  /** 有线但提示词没引用的用户序号（从 1 起）。 */
  unreferenced: number[];
  model: { state: ModelLabelState; label: string };
  /** 最终发送的像素（与提交时同一换算）；发不出去或模型缺失时为 null。 */
  size: { width: number; height: number } | null;
  /** 手动的宽高比在当前模型 / 分辨率档下发不出去（档位本身在尺寸表内）。 */
  ratioUnsupported: boolean;
  toggles: { transparentBackground: ToggleAvailability; layerDecomposition: ToggleAvailability };
}

const NOT_READY: ReadonlySet<ReasonKind> = new Set(["positiveMissing", "positiveEmpty"]);

const reason = (kind: ReasonKind, text: string): UnrunnableReason => ({ kind, category: NOT_READY.has(kind) ? "notReady" : "error", text });

function findTask(board: Board, id: string): TaskNode | undefined {
  const node = board.nodes.find((n) => n.id === id);
  return node?.type === "task" ? node : undefined;
}

export function taskView(board: Board, table: CapabilityTable, taskId: string, facts: TaskFacts): TaskView | null {
  const task = findTask(board, taskId);
  if (!task) return null;
  const model = findModel(table, task.model);
  const refs = imageRefProblems(board, table, taskId);
  const transparent = transparentBlock(board, model, taskId, facts);
  const layer = model && !flashFeatureImplemented(model, "layers") ? "Flash 图层拆分通路尚未实现" : model && !isSupported(model.workflows[workflowOf(board, taskId)].layer_decomposition) ? "模型不支持拆分图层" : null;
  const reasons = [
    ...promptReasons(board, taskId),
    ...(model ? [...availabilityReasons(table, facts.discovery, model), ...modelReasons(board, model, task)] : [reason("modelUnknown", `模型 ${task.model} 不在能力表内`)]),
    ...(task.layer_decomposition && layer ? [reason("layerUnsupported", layer)] : []),
    ...(task.transparent_background && transparent ? [reason(transparent.kind, transparent.text)] : []),
    ...refs.issues.map((text) => reason("referenceOutOfRange", text)),
    ...imageSources(board, taskId, "").flatMap((src, i) => {
      if (src.absPath === null) return [reason("sourceLayerInvalid", `图${i + 1} 来源图层无效：${src.label}`)];
      // 缺图按来源分键：图层线只看自己那层，底图线只看底图，互不株连。
      const key = src.sourceLayer === null ? src.nodeId : `${src.nodeId}:layer:${src.sourceLayer}`;
      return facts.missingNodes.has(key) ? [reason("imageMissing", `图${i + 1} 图片缺失：${src.label}`)] : [];
    }),
  ];
  const edgeCount = imageEdges(board, taskId).length;
  const englishUnverified = !!model && edgeCount > 0 && promptLanguage(promptText(board, taskId, "positive")) === "en" && model.reference_phrasing.en_verified === "untested";
  const rule = model?.workflows[workflowOf(board, taskId)].size_rule;
  const size = rule ? resolveSize(rule, task.size_spec) : null;
  const { tier, ratio } = task.size_spec;
  return {
    reasons: dedupe(reasons),
    warnings: [...refs.warnings, ...(englishUnverified ? ["该模型英文序号未验证"] : [])],
    unreferenced: refs.unreferenced,
    model: modelLabel(table, facts.discovery, task.model),
    size,
    ratioUnsupported: !!rule && !isAutoRatio(task.size_spec) && tier !== null && sizeTiersOf(rule).includes(tier) && ratio !== null && size === null,
    toggles: {
      transparentBackground: { canEnable: transparent === null, hint: transparent?.hint ?? "" },
      layerDecomposition: { canEnable: model !== undefined && layer === null, hint: layer ?? "" },
    },
  };
}

function modelLabel(table: CapabilityTable, discovery: Discovery, modelId: string): TaskView["model"] {
  const model = findModel(table, modelId);
  if (!model) return { state: "unknown", label: `${modelId}（未知模型）` };
  if (availableModels(table, discovery).some((m) => m.model_id === modelId)) return { state: "ok", label: model.display_name };
  return model.tier !== null ? { state: "notFromGateway", label: `${model.display_name}（网关未提供）` } : { state: "unshelved", label: `${model.display_name}（未上架）` };
}

/**
 * 透明背景按展开后的实际参考图数、所选文件的 alpha 与输出格式校验，开关和不可运行原因共用规则。
 * 透明通道未知时阻止启用；模型缺失时由「不在能力表内」拦。
 */
function transparentBlock(board: Board, model: ModelCapability | undefined, taskId: string, facts: TaskFacts): { kind: ReasonKind; text: string; hint: string } | null {
  if (!model) return null;
  if (!flashFeatureImplemented(model, "transparent")) return { kind: "transparentUnsupported", text: "Flash 透明背景通路尚未实现", hint: "通路尚未实现" };
  if (!isSupported(model.transparent_background)) return { kind: "transparentUnsupported", text: "模型不支持透明背景", hint: "模型不支持透明背景" };
  const edges = imageEdges(board, taskId);
  if (expandImageEdges(edges, effectiveRegionRender(model)).length !== 1) {
    const text = model.request_shape === "seedream_flash_images_generations" ? "需要恰好一张实际参考图" : "需要恰好一条图片线";
    return { kind: "transparentNeedsOneImage", text: `透明背景${text}`, hint: text };
  }
  const task = findTask(board, taskId)!;
  if (model.request_shape === "seedream_flash_images_generations" && task.output_options?.output_format === "jpeg") return { kind: "transparentNeedsPng", text: "透明背景输出必须为 PNG", hint: "输出必须为 PNG" };
  const edge = edges[0];
  const alpha = facts.alphaByNode.get(edge.source_layer === null ? edge.from[0] : `${edge.from[0]}:layer:${edge.source_layer}`);
  return alpha === true ? null : { kind: "transparentNoAlpha", text: alpha === false ? "该图不带透明通道" : "参考图透明通道尚未确认", hint: alpha === false ? "该图不带透明通道" : "透明通道尚未确认" };
}

/** 按画板当前内容的发送计划；模型不在能力表内时没有发送计划。 */
export function sendPlanOf(board: Board, table: CapabilityTable, taskId: string): SendPlan | null {
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  if (!model) return null;
  return planSend(model, imagePortSlots(board, table, taskId), promptText(board, taskId, "positive"), promptText(board, taskId, "negative"));
}

/** 「图N」「区域N」的引用越界与未引用，取自发送计划；没有发送计划（模型缺失）时按无固定句算。 */
function imageRefProblems(board: Board, table: CapabilityTable, taskId: string): ReferenceProblems {
  const plan = sendPlanOf(board, table, taskId);
  return plan ? plan.referenceProblems : referenceProblemsOf(undefined, imagePortSlots(board, table, taskId), promptText(board, taskId, "positive"));
}

/** 同一种类、同一文案只留一条。 */
function dedupe(reasons: UnrunnableReason[]): UnrunnableReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.kind}\u0000${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasEdge(board: Board, taskId: string, port: string): boolean {
  return board.edges.some((e) => e.to[0] === taskId && e.to[1] === port);
}

function promptReasons(board: Board, taskId: string): UnrunnableReason[] {
  if (!hasEdge(board, taskId, "positive")) return [reason("positiveMissing", "正向提示词未连接")];
  return promptText(board, taskId, "positive").trim() ? [] : [reason("positiveEmpty", "正向提示词为空")];
}

/** 模型能不能用：上架、网关是否提供（已发现模型列表时）、请求形态是否已接入。 */
function availabilityReasons(table: CapabilityTable, discovery: Discovery, model: ModelCapability): UnrunnableReason[] {
  const out: UnrunnableReason[] = [];
  if (model.tier === null) out.push(reason("modelUnshelved", `模型 ${model.display_name} 未上架`));
  const unavailable = modelAvailabilityIssue(table, discovery, model.model_id);
  if (unavailable) out.push(reason("modelNotFromGateway", unavailable));
  if (!isRequestShapeImplemented(model)) out.push(reason("requestShapeMissing", `模型 ${model.display_name} 的请求形态尚未接入`));
  return out;
}

/** 按能力表判断的原因：参考图名额、区域、负向、尺寸。 */
function modelReasons(board: Board, model: ModelCapability, task: TaskNode): UnrunnableReason[] {
  const out: UnrunnableReason[] = [];
  const edges = imageEdges(board, task.id);
  const wf = model.workflows[workflowOf(board, task.id)];
  const max = model.workflows.image_edit.max_references;
  const render = effectiveRegionRender(model);
  const expanded = expandImageEdges(edges, render).length;
  if (edges.length > 0 && max === 0) out.push(reason("imageEditUnsupported", "模型不支持图片编辑"));
  else if (expanded > max) out.push(reason("tooManyReferences", `参考图 ${expanded} 张超出模型上限 ${max} 张`));
  const regions = edges.reduce((n, e) => n + (e.region?.rects.length ?? 0), 0);
  if (render === null && regions > 0) out.push(reason("regionUnsupported", "模型不支持框选修改区域"));
  if (render !== null && regions > MAX_REGIONS) out.push(reason("tooManyRegions", `框选了 ${regions} 个区域，最多 ${MAX_REGIONS} 个`));
  if (hasEdge(board, task.id, "negative") && !isSupported(wf.supports_negative_prompt)) out.push(reason("negativeUnsupported", "模型不支持负向提示词"));
  if (resolveSize(wf.size_rule, task.size_spec) === null) {
    const s = task.size_spec;
    const value = ratioValue(s.ratio);
    // 只有宽高比本身越界才报范围；分辨率档不认识、或没有 custom 范围的模型仍按「不在尺寸表内」。
    const range = s.tier !== null && s.tier in wf.size_rule.tiers && value !== null && !withinRatioRange(wf.size_rule, value) ? ratioRangeText(wf.size_rule) : null;
    const text =
      s.tier === null ? `自定义尺寸 ${s.width}×${s.height} 超出模型范围` : range !== null ? `宽高比 ${s.ratio} 超出模型范围 ${range}` : `生成尺寸 ${s.tier} · ${s.ratio} 不在模型尺寸表内`;
    out.push(reason("sizeUnsupported", text));
  }
  return out;
}
