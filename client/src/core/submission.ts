// 提交前的纯函数：脏判据快照、运行范围、二次确认清单。
import type { Board, Region, TaskNode } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import { composeSendText, inlinesNegativePrompt, isRequestShapeImplemented } from "./gateway";
import { imageEdges, imagePortSlots, taskIssues, transparentAlphaIssue } from "./graph";
import { checkImageRefs, promptLanguage } from "./imageRefs";
import { resolveFromRoot } from "./paths";
import { imageRefMap, overlayPhrases, referencedRegions, regionNames } from "./region";
import { modelAvailabilityIssue, type Discovery } from "./settings";
import type { SizeSpec } from "./size";

export type SnapshotImage =
  | { kind: "reference"; path: string; sha256: string; region: Region | null }
  | { kind: "result"; task_id: string; file: string; source_layer: number | null; region: Region | null };

/** 与 last_submitted 比较的字段（画板文件格式第 9.3 节，去掉 task_id）。 */
export interface Snapshot {
  prompt: string;
  negative_prompt: string;
  model: string;
  size_spec: SizeSpec;
  layer_decomposition: boolean;
  transparent_background: boolean;
  images: SnapshotImage[];
}

function findTask(board: Board, id: string): TaskNode | undefined {
  const node = board.nodes.find((n) => n.id === id);
  return node?.type === "task" ? node : undefined;
}

function promptText(board: Board, taskId: string, port: "positive" | "negative"): string {
  const edge = board.edges.find((e) => e.to[0] === taskId && e.to[1] === port);
  const node = edge && board.nodes.find((n) => n.id === edge.from[0]);
  return node?.type === "prompt" ? node.text : "";
}

export function snapshotOf(board: Board, taskId: string): Snapshot | null {
  const task = findTask(board, taskId);
  if (!task) return null;
  const images = imageEdges(board, taskId).flatMap((e): SnapshotImage[] => {
    const src = board.nodes.find((n) => n.id === e.from[0]);
    if (src?.type === "reference") return [{ kind: "reference", path: src.path, sha256: src.sha256, region: e.region }];
    if (src?.type === "result") return [{ kind: "result", task_id: src.task_id, file: src.file, source_layer: e.source_layer, region: e.region }];
    return [];
  });
  return {
    prompt: promptText(board, taskId, "positive"),
    negative_prompt: promptText(board, taskId, "negative"),
    model: task.model,
    size_spec: { tier: task.size_spec.tier, ratio: task.size_spec.ratio, width: task.size_spec.width, height: task.size_spec.height },
    layer_decomposition: task.layer_decomposition,
    transparent_background: task.transparent_background,
    images,
  };
}

/** 键序无关的 JSON，用于快照比较。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SNAPSHOT_KEYS: (keyof Snapshot)[] = ["prompt", "negative_prompt", "model", "size_spec", "layer_decomposition", "transparent_background", "images"];

export function isDirty(board: Board, taskId: string): boolean {
  const task = findTask(board, taskId);
  const current = snapshotOf(board, taskId);
  if (!task || !current) return false;
  const last = task.last_submitted;
  if (last === null) return true;
  // size_spec 只比四个已知字段，未来加进来的字段不让旧快照全部变脏。
  const pick = (s: Record<string, unknown>) =>
    SNAPSHOT_KEYS.map((k) => {
      const v = s[k];
      if (k !== "size_spec" || typeof v !== "object" || v === null) return v;
      const spec = v as Record<string, unknown>;
      return { tier: spec.tier, ratio: spec.ratio, width: spec.width, height: spec.height };
    });
  return canonical(pick(current as unknown as Record<string, unknown>)) !== canonical(pick(last));
}

/** 提交时写入 last_submitted 快照。 */
export function withSubmitted(board: Board, taskId: string, submittedTaskId: string): Board {
  const snapshot = snapshotOf(board, taskId);
  if (!snapshot) return board;
  return {
    ...board,
    nodes: board.nodes.map((n) => (n.id === taskId && n.type === "task" ? { ...n, last_submitted: { task_id: submittedTaskId, ...snapshot } } : n)),
  };
}

/** 已执行 = 上次提交产出了画板上的结果节点；失败或中断的提交没有结果，仍需运行。 */
function hasExecuted(board: Board, task: TaskNode): boolean {
  const submitted = task.last_submitted?.task_id;
  return typeof submitted === "string" && board.nodes.some((n) => n.type === "result" && n.task_id === submitted);
}

/**
 * 候选的已中断：提交过、画板上没有结果，且本次程序运行期间队列没经手过这次提交。
 * 界面再读任务目录的结局记录：有失败 / 取消记录的按记录显示，没有才是已中断。不持久化到画板。
 */
export function isInterrupted(board: Board, taskId: string, handled: ReadonlySet<string>): boolean {
  const task = findTask(board, taskId);
  const submitted = task?.last_submitted?.task_id;
  return !!task && typeof submitted === "string" && !handled.has(submitted) && !hasExecuted(board, task);
}

/** 有选中时只跑选中子图（选中的任务 + 选中节点直接下游的任务），否则整个画板；跳过不脏的已执行任务与正在排队 / 执行的。 */
export function runScope(board: Board, selectedIds: string[], busy: ReadonlySet<string> = new Set()): string[] {
  const selected = new Set(selectedIds);
  const downstream = new Set(board.edges.filter((e) => selected.has(e.from[0])).map((e) => e.to[0]));
  return board.nodes
    .filter((n): n is TaskNode => n.type === "task")
    .filter((n) => selected.size === 0 || selected.has(n.id) || downstream.has(n.id))
    .filter((n) => !busy.has(n.id) && (isDirty(board, n.id) || !hasExecuted(board, n)))
    .map((n) => n.id);
}

export interface ImageSource {
  nodeId: string;
  label: string;
  absPath: string;
}

/** 任务的参考图来源，按端口顺序；结果节点回灌的是文件本身，不带会话参数。 */
export function imageSources(board: Board, taskId: string, outputRoot: string): ImageSource[] {
  return imageEdges(board, taskId).flatMap((e) => {
    const src = board.nodes.find((n) => n.id === e.from[0]);
    if (src?.type === "reference") return [{ nodeId: src.id, label: src.display_name, absPath: resolveFromRoot(outputRoot, src.path) }];
    if (src?.type === "result") {
      // 接了某一图层：路径指向 layers/NN.<ext>（文件名以结果记录为准），标签点明图层序号。
      if (e.source_layer !== null) {
        const file = src.record.layers?.[e.source_layer - 1]?.file ?? `layers/${String(e.source_layer).padStart(2, "0")}.png`;
        const dir = src.path.slice(0, src.path.length - src.file.length);
        return [{ nodeId: src.id, label: `${src.file} 图层${e.source_layer}`, absPath: resolveFromRoot(outputRoot, `${dir}${file}`) }];
      }
      return [{ nodeId: src.id, label: src.file, absPath: resolveFromRoot(outputRoot, src.path) }];
    }
    return [];
  });
}

export interface ConfirmItem {
  taskId: string;
  modelName: string;
  firstLine: string;
  negativePrompt: string;
  /** 负向已拼进 sendText（模型无原生负向字段，如 Seedream）；否则走原生字段，弹窗另列。 */
  negativeInlined: boolean;
  /** 完整发送文本：有参考图时含数量顺序前缀；negativeInlined 时含「避免出现：」一行。 */
  sendText: string;
  referenceCount: number;
  /** 非空 = 标红，不可勾选。 */
  issues: string[];
  /** 仅提示，不阻断。 */
  warnings: string[];
}

/** 「图N」实时角标：红 = 引用越界（不可运行），黄 = 有线未被引用。任务节点与二次确认共用。 */
export function imageRefProblems(board: Board, table: CapabilityTable, taskId: string): { issues: string[]; warnings: string[]; unreferenced: number[] } {
  const prompt = promptText(board, taskId, "positive");
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  // 按用户序号判断：区域叠加图不占「图N」；固定句按发送序号书写，换回用户序号再算引用。
  const slots = imagePortSlots(board, table, taskId);
  const map = imageRefMap(slots);
  const count = map.length;
  const check = checkImageRefs(prompt, count, {
    injected: model ? overlayPhrases(model, slots, promptLanguage(prompt)) : [],
    imageRefMap: map,
  });
  // 只有区域真的生效（叠加槽存在）时才校验「区域N」；没有框选时这两个字是普通文字。
  const regions = regionNames(slots, promptLanguage(prompt)).length;
  const regionIssues = regions > 0 ? referencedRegions(prompt).filter((n) => n < 1 || n > regions).map((n) => `提示词引用了区域${n}，但只框选了 ${regions} 个区域`) : [];
  return {
    issues: [...check.outOfRange.map((n) => `提示词引用了图${n}，但只接了 ${count} 张参考图`), ...regionIssues],
    warnings: check.unreferenced.map((n) => `图${n} 已接线但提示词未引用`),
    unreferenced: check.unreferenced,
  };
}

export interface ConfirmContext {
  discovery: Discovery;
  /** 图片文件缺失的参考图 / 结果节点 id。 */
  missingNodes: ReadonlySet<string>;
  /** 节点 id → 是否带透明通道（导入时检测；缺省 = 未知，不拦）。 */
  alphaByNode?: ReadonlyMap<string, boolean>;
}

export function buildConfirmItems(board: Board, table: CapabilityTable, taskIds: string[], ctx: ConfirmContext): ConfirmItem[] {
  return taskIds.flatMap((taskId) => {
    const task = findTask(board, taskId);
    if (!task) return [];
    const model = findModel(table, task.model);
    const prompt = promptText(board, taskId, "positive");
    const negativePrompt = promptText(board, taskId, "negative");
    const images = imageSources(board, taskId, "");
    const issues = taskIssues(board, table, taskId);
    const hasPositive = board.edges.some((e) => e.to[0] === taskId && e.to[1] === "positive");
    if (hasPositive && !prompt.trim()) issues.push("正向提示词为空");
    if (model && !isRequestShapeImplemented(model)) issues.push(`模型 ${model.display_name} 的请求形态尚未接入`);
    const unavailable = model && modelAvailabilityIssue(table, ctx.discovery, model.model_id);
    if (unavailable) issues.push(unavailable);
    const refs = imageRefProblems(board, table, taskId);
    issues.push(...refs.issues);
    const warnings = [...refs.warnings];
    if (model && images.length > 0 && promptLanguage(prompt) === "en" && model.reference_phrasing.en_verified === "untested") {
      warnings.push("该模型英文序号未验证");
    }
    images.forEach((img, i) => {
      if (ctx.missingNodes.has(img.nodeId)) issues.push(`图${i + 1} 图片缺失：${img.label}`);
    });
    const edges = imageEdges(board, taskId);
    const alphaIssue = transparentAlphaIssue(board, taskId, edges.length === 1 ? ctx.alphaByNode?.get(edges[0].from[0]) : undefined);
    if (alphaIssue) issues.push(alphaIssue);
    const slots = imagePortSlots(board, table, taskId);
    const regionPhrases = model ? overlayPhrases(model, slots, promptLanguage(prompt)) : [];
    const names = regionNames(slots, promptLanguage(prompt));
    const negativeInlined = model ? inlinesNegativePrompt(model, slots.length) : false;
    return [
      {
        taskId,
        modelName: model?.display_name ?? task.model,
        firstLine: prompt.split("\n").find((line) => line.trim())?.trim() ?? "",
        negativePrompt,
        negativeInlined,
        sendText: composeSendText({ prompt, negativePrompt, referenceCount: slots.length, inlineNegative: negativeInlined, regionPhrases, regionNames: names, imageRefMap: imageRefMap(slots) }),
        referenceCount: slots.length,
        issues: [...new Set(issues)],
        warnings,
      },
    ];
  });
}

/** 点「运行」后的分派：空 / 单项干净 / 单项标红不弹窗；单项仅有警告或两项及以上才弹二次确认。 */
export type RunDispatch = { kind: "toast"; message: string } | { kind: "submit"; taskId: string } | { kind: "confirm" };

export function runDispatch(items: ConfirmItem[]): RunDispatch {
  if (items.length === 0) return { kind: "toast", message: "没有需要运行的任务" };
  if (items.length > 1) return { kind: "confirm" };
  const [item] = items;
  if (item.issues.length > 0) {
    const more = item.issues.length > 1 ? ` 等另外 ${item.issues.length - 1} 项` : "";
    return { kind: "toast", message: `无法运行：${item.issues[0]}${more}` };
  }
  return item.warnings.length > 0 ? { kind: "confirm" } : { kind: "submit", taskId: item.taskId };
}
