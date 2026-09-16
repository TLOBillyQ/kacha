// 节点图规则：连线合法性、任务节点按能力露出的端口与开关、换模型后的标红原因（规格第 3、10.4 节）。
// 全部是 Board → 结果的纯函数；换模型绝不自动删线或改设置，只报告问题。
import type { Board, BoardEdge, TaskNode } from "./board";
import {
  findModel,
  isSupported,
  type CapabilityTable,
  type InputImageRule,
  type WorkflowName,
} from "./capabilities";
import { resolveSize } from "./size";

export const IMAGE_PORT_PREFIX = "image:";

export interface Connection {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const no = (reason: string): Verdict => ({ ok: false, reason });

export function imagePortIndex(handle: string): number | null {
  if (!handle.startsWith(IMAGE_PORT_PREFIX)) return null;
  const index = Number(handle.slice(IMAGE_PORT_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function findTask(board: Board, id: string): TaskNode | undefined {
  const node = board.nodes.find((n) => n.id === id);
  return node?.type === "task" ? node : undefined;
}

/** 某任务节点的图片连线，按端口序号升序（= 参考图序号）。 */
export function imageEdges(board: Board, taskId: string): BoardEdge[] {
  return board.edges
    .filter((e) => e.to[0] === taskId && imagePortIndex(e.to[1]) !== null)
    .sort((a, b) => imagePortIndex(a.to[1])! - imagePortIndex(b.to[1])!);
}

/** 工作流由连线推导：图片端口 0 条线 = 文生图，≥1 条 = 图片编辑。 */
export function workflowOf(board: Board, taskId: string): WorkflowName {
  return imageEdges(board, taskId).length > 0 ? "image_edit" : "text_to_image";
}

function reachable(board: Board, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of board.edges) if (e.from[0] === id) stack.push(e.to[0]);
  }
  return false;
}

export function canConnect(board: Board, table: CapabilityTable, c: Connection): Verdict {
  if (c.source === c.target) return no("不能连到自身");
  const source = board.nodes.find((n) => n.id === c.source);
  const target = findTask(board, c.target);
  if (!source || source.type === "unknown") return no("来源节点不存在");
  if (source.type === "task") return no("结果连线由系统建立");
  if (c.sourceHandle !== "out") return no("来源端口无效");
  if (!target) return no("只能连到生成任务节点");

  const ports = taskPorts(board, table, target.id);
  const imageIndex = imagePortIndex(c.targetHandle);
  if (c.targetHandle === "positive" || c.targetHandle === "negative") {
    if (source.type !== "prompt") return no("提示词端口只接提示词节点");
    if (c.targetHandle === "negative" && !ports.negative) return no("模型不支持负向提示词");
  } else if (imageIndex !== null) {
    if (source.type === "prompt") return no("图片端口只接参考图或结果节点");
    const count = imageEdges(board, target.id).length;
    if (count >= ports.maxReferences) {
      return no(ports.maxReferences === 0 ? "模型不支持图片编辑" : `参考图已达模型上限 ${ports.maxReferences} 张`);
    }
    if (imageIndex !== count) return no("该端口已有连线");
  } else {
    return no("目标端口无效");
  }
  if (board.edges.some((e) => e.to[0] === c.target && e.to[1] === c.targetHandle)) return no("该端口已有连线");
  if (reachable(board, c.target, c.source)) return no("不能形成环");
  return { ok: true };
}

/** 追加一条用户连线（调用前应先 canConnect）；图片线总是落在下一个空端口。 */
export function connect(board: Board, c: Connection): BoardEdge[] {
  const toPort = imagePortIndex(c.targetHandle) === null ? c.targetHandle : `${IMAGE_PORT_PREFIX}${imageEdges(board, c.target).length}`;
  return [...board.edges, { from: [c.source, c.sourceHandle], to: [c.target, toPort], source_layer: null, region: null, system: false, extra: {} }];
}

function renumber(edges: BoardEdge[], taskId: string, ordered: BoardEdge[]): BoardEdge[] {
  const index = new Map(ordered.map((e, i) => [e, i]));
  return edges.map((e) => (index.has(e) ? { ...e, to: [taskId, `${IMAGE_PORT_PREFIX}${index.get(e)}`] } : e));
}

/** 删除用户连线（系统连线忽略），并让受影响任务的图片端口序号保持紧凑。 */
export function disconnect(board: Board, removed: BoardEdge[]): BoardEdge[] {
  const drop = new Set(removed.filter((e) => !e.system));
  let edges = board.edges.filter((e) => !drop.has(e));
  const tasks = new Set([...drop].filter((e) => imagePortIndex(e.to[1]) !== null).map((e) => e.to[0]));
  for (const taskId of tasks) {
    edges = renumber(edges, taskId, imageEdges({ ...board, edges }, taskId));
  }
  return edges;
}

/** 把第 from 个图片端口拖到第 to 个位置，其余顺延。 */
export function moveImagePort(board: Board, taskId: string, from: number, to: number): BoardEdge[] {
  const ordered = imageEdges(board, taskId);
  if (from < 0 || from >= ordered.length || to < 0 || to >= ordered.length || from === to) return board.edges;
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  return renumber(board.edges, taskId, ordered);
}

/** 任务节点的 image_ports 与实际图片连线数保持一致（落盘字段）。 */
export function syncImagePorts(board: Board): Board {
  let changed = false;
  const nodes = board.nodes.map((n) => {
    if (n.type !== "task") return n;
    const count = imageEdges(board, n.id).length;
    if (n.image_ports === count) return n;
    changed = true;
    return { ...n, image_ports: count };
  });
  return changed ? { ...board, nodes } : board;
}

/** 删除节点及其全部连线（含系统连线），受影响任务的图片端口序号紧凑。 */
export function removeNodes(board: Board, ids: string[]): Board {
  const gone = new Set(ids);
  const nodes = board.nodes.filter((n) => !gone.has(n.id));
  const touched = board.edges.filter((e) => gone.has(e.from[0]) || gone.has(e.to[0]));
  let edges = board.edges.filter((e) => !touched.includes(e));
  const tasks = new Set(touched.filter((e) => !gone.has(e.to[0]) && imagePortIndex(e.to[1]) !== null).map((e) => e.to[0]));
  for (const taskId of tasks) edges = renumber(edges, taskId, imageEdges({ ...board, edges }, taskId));
  return syncImagePorts({ ...board, nodes, edges });
}

/** 结果节点被（不一同删除的）下游图片端口引用时禁止删除。 */
export function deletionBlocker(board: Board, ids: string[]): string | null {
  const gone = new Set(ids);
  const referenced = board.edges.some((e) => {
    const source = board.nodes.find((n) => n.id === e.from[0]);
    return source?.type === "result" && gone.has(source.id) && !gone.has(e.to[0]) && imagePortIndex(e.to[1]) !== null;
  });
  return referenced ? "结果已被下游生成任务引用，请先断开连线" : null;
}

export interface TaskPorts {
  /** 负向端口是否露出：模型支持，或已有连线（保留以便标红）。 */
  negative: boolean;
  /** 露出的图片端口行数：已接线数 + 未达上限时 1 个空位。 */
  imageSlots: number;
  maxReferences: number;
  /** 开关是否露出：能力支持，或已打开（保留以便标红）。 */
  layerDecomposition: boolean;
  transparentBackground: boolean;
}

export function taskPorts(board: Board, table: CapabilityTable, taskId: string): TaskPorts {
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  const count = imageEdges(board, taskId).length;
  const hasNegativeEdge = board.edges.some((e) => e.to[0] === taskId && e.to[1] === "negative");
  if (!task || !model) {
    return { negative: hasNegativeEdge, imageSlots: count, maxReferences: 0, layerDecomposition: !!task?.layer_decomposition, transparentBackground: !!task?.transparent_background };
  }
  const wf = model.workflows[workflowOf(board, taskId)];
  const maxReferences = model.workflows.image_edit.max_references;
  return {
    negative: isSupported(wf.supports_negative_prompt) || hasNegativeEdge,
    imageSlots: count < maxReferences ? count + 1 : count,
    maxReferences,
    layerDecomposition: isSupported(wf.layer_decomposition) || task.layer_decomposition,
    transparentBackground: isSupported(model.transparent_background) || task.transparent_background,
  };
}

/** 任务节点不可运行的原因；空数组 = 可运行。 */
export function taskIssues(board: Board, table: CapabilityTable, taskId: string): string[] {
  const task = findTask(board, taskId);
  if (!task) return [];
  const issues: string[] = [];
  const hasEdge = (port: string) => board.edges.some((e) => e.to[0] === taskId && e.to[1] === port);
  if (!hasEdge("positive")) issues.push("正向提示词未连接");

  const model = findModel(table, task.model);
  if (!model) return [...issues, `模型 ${task.model} 不在能力表内`];
  if (model.tier === null) issues.push(`模型 ${model.display_name} 未上架`);

  const images = imageEdges(board, taskId).length;
  const workflow = workflowOf(board, taskId);
  const wf = model.workflows[workflow];
  const max = model.workflows.image_edit.max_references;
  if (images > 0 && max === 0) issues.push("模型不支持图片编辑");
  else if (images > max) issues.push(`参考图 ${images} 张超出模型上限 ${max} 张`);
  if (hasEdge("negative") && !isSupported(wf.supports_negative_prompt)) issues.push("模型不支持负向提示词");
  if (resolveSize(wf.size_rule, task.size_spec) === null) {
    const s = task.size_spec;
    issues.push(s.tier === null ? `自定义尺寸 ${s.width}×${s.height} 超出模型范围` : `生成尺寸 ${s.tier} · ${s.ratio} 不在模型尺寸表内`);
  }
  if (task.layer_decomposition && !isSupported(wf.layer_decomposition)) issues.push("模型不支持拆分图层");
  if (task.transparent_background) {
    if (!isSupported(model.transparent_background)) issues.push("模型不支持透明背景");
    else if (images !== 1) issues.push("透明背景需要恰好一条图片线");
  }
  return issues;
}

// ---- 参考图输入规则 ----

export interface ImageFacts {
  /** 小写格式名：png / jpeg / webp …；未知为空串。 */
  format: string;
  bytes: number;
  width: number;
  height: number;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 按模型 input_image_rule 预校验参考图，逐项给出说明；违反时参考图节点标黄。 */
export function imageRuleViolations(image: ImageFacts, rule: InputImageRule): string[] {
  const out: string[] = [];
  if (!rule.formats.includes(image.format)) {
    out.push(`格式 ${image.format.toUpperCase() || "未知"} 不受支持（支持 ${rule.formats.map((f) => f.toUpperCase()).join(" / ")}）`);
  }
  if (rule.max_bytes !== null && image.bytes > rule.max_bytes) out.push(`文件 ${mb(image.bytes)} 超过上限 ${mb(rule.max_bytes)}`);
  if (image.width > 0 && image.height > 0) {
    const total = image.width * image.height;
    if (rule.min_total_pixels !== null && total < rule.min_total_pixels) out.push(`总像素 ${total} 低于下限 ${rule.min_total_pixels}`);
    if (rule.max_total_pixels !== null && total > rule.max_total_pixels) out.push(`总像素 ${total} 超过上限 ${rule.max_total_pixels}`);
    const short = Math.min(image.width, image.height);
    if (rule.min_short_edge !== null && short < rule.min_short_edge) out.push(`最短边 ${short} px 小于 ${rule.min_short_edge} px`);
    const ratio = image.width / image.height;
    const lo = rule.min_aspect_ratio;
    const hi = rule.max_aspect_ratio;
    if ((lo !== null && ratio < lo) || (hi !== null && ratio > hi)) {
      out.push(`宽高比 ${ratio.toFixed(2)} 超出 ${lo === null ? "0" : lo.toFixed(2)}～${hi === null ? "∞" : hi.toFixed(2)}`);
    }
  }
  return out;
}
