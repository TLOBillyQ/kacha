// 节点图规则：连线合法性、任务节点按能力露出的端口与开关、提示词与图片来源。
// 全部是 Board → 结果的纯函数；换模型绝不自动删线或改设置。不可运行原因见 taskView。
import type { Board, BoardEdge, TaskNode } from "./board";
import {
  findModel,
  isSupported,
  workflowFor,
  type CapabilityTable,
  type InputImageRule,
  type WorkflowName,
} from "./capabilities";
import { resolveFromRoot } from "./paths";
import { effectiveRegionRender, expandImageEdges, type PortSlot } from "./region";
import { layerFileName } from "./taskDir";

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

/** 该图片线第一个区域的区域编号（0 起）：排在它前面的图片线上的区域都先编号。 */
export function firstRegionOfEdge(board: Board, taskId: string, toPort: string): number {
  const index = imagePortIndex(toPort) ?? 0;
  return imageEdges(board, taskId)
    .filter((e) => imagePortIndex(e.to[1])! < index)
    .reduce((n, e) => n + (e.region?.rects.length ?? 0), 0);
}

/** 工作流由连线推导：图片端口 0 条线 = 文生图，≥1 条 = 图片编辑。 */
export function workflowOf(board: Board, taskId: string): WorkflowName {
  return workflowFor(imageEdges(board, taskId).length);
}

/** 任务的图片连线按当前模型渲染方式展开后的槽位（区域叠加图紧随原图，占发送序名额）。 */
export function imagePortSlots(board: Board, table: CapabilityTable, taskId: string): PortSlot[] {
  const task = findTask(board, taskId);
  const model = task && findModel(table, task.model);
  return expandImageEdges(imageEdges(board, taskId), effectiveRegionRender(model));
}

/** 接到任务某提示词端口的提示词文本；未接为空串。 */
export function promptText(board: Board, taskId: string, port: "positive" | "negative"): string {
  const edge = board.edges.find((e) => e.to[0] === taskId && e.to[1] === port);
  const node = edge && board.nodes.find((n) => n.id === edge.from[0]);
  return node?.type === "prompt" ? node.text : "";
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
        const file = src.record.layers?.[e.source_layer - 1]?.file ?? layerFileName(e.source_layer);
        const dir = src.path.slice(0, src.path.length - src.file.length);
        return [{ nodeId: src.id, label: `${src.file} 图层${e.source_layer}`, absPath: resolveFromRoot(outputRoot, `${dir}${file}`) }];
      }
      return [{ nodeId: src.id, label: src.file, absPath: resolveFromRoot(outputRoot, src.path) }];
    }
    return [];
  });
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
    // 名额按展开后序号算：区域叠加图也占 1 个参考图名额。
    if (imagePortSlots(board, table, target.id).length >= ports.maxReferences) {
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

export interface Removal {
  board: Board;
  /** 实际删除的节点 id，按画板顺序（含级联的结果列）。 */
  removedIds: string[];
  /** 断开的通往保留节点的用户连线数（下游任务因此变脏）。 */
  severed: number;
}

/**
 * 删除节点：不设禁删，删任务节点级联删除其结果列（系统连线指向的结果节点），
 * 连带删除相关连线（含系统连线），受影响任务的图片端口序号紧凑。删排队 / 执行中任务前的「先取消再删」确认由界面负责。
 */
export function removeNodes(board: Board, ids: string[]): Removal {
  const gone = new Set(ids.filter((id) => board.nodes.some((n) => n.id === id)));
  for (const e of board.edges) {
    if (e.system && gone.has(e.from[0]) && board.nodes.find((n) => n.id === e.to[0])?.type === "result") gone.add(e.to[0]);
  }
  const nodes = board.nodes.filter((n) => !gone.has(n.id));
  const touched = board.edges.filter((e) => gone.has(e.from[0]) || gone.has(e.to[0]));
  let edges = board.edges.filter((e) => !touched.includes(e));
  const severed = touched.filter((e) => !e.system && gone.has(e.from[0]) && !gone.has(e.to[0])).length;
  const tasks = new Set(touched.filter((e) => !gone.has(e.to[0]) && imagePortIndex(e.to[1]) !== null).map((e) => e.to[0]));
  for (const taskId of tasks) edges = renumber(edges, taskId, imageEdges({ ...board, edges }, taskId));
  const removedIds = board.nodes.filter((n) => gone.has(n.id)).map((n) => n.id);
  return { board: syncImagePorts({ ...board, nodes, edges }), removedIds, severed };
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
  const expanded = expandImageEdges(imageEdges(board, taskId), effectiveRegionRender(model)).length;
  return {
    negative: isSupported(wf.supports_negative_prompt) || hasNegativeEdge,
    // 空位露出同样按展开后名额：区域叠加图占满后不再给新空位。
    imageSlots: expanded < maxReferences ? count + 1 : count,
    maxReferences,
    layerDecomposition: isSupported(wf.layer_decomposition) || task.layer_decomposition,
    transparentBackground: isSupported(model.transparent_background) || task.transparent_background,
  };
}

// ---- 编辑已提交过的提示词节点 ----

/** 提示词节点直接下游的任务里有已提交过的（有 last_submitted）。 */
function recordedTasks(board: Board, promptId: string): Set<string> {
  return new Set(
    board.edges.filter((e) => e.from[0] === promptId && findTask(board, e.to[0])?.last_submitted).map((e) => e.to[0]),
  );
}

export function hasDownstreamRecords(board: Board, promptId: string): boolean {
  return recordedTasks(board, promptId).size > 0;
}

const FORK_GAP = 24;

/** 断开并分叉：旧文本进新提示词节点（落在被编辑节点下方）接回有执行记录的任务，新文本留在被编辑节点。 */
export function forkPrompt(board: Board, promptId: string, fork: { newNodeId: string; text: string }): Board {
  const prompt = board.nodes.find((n) => n.id === promptId);
  if (prompt?.type !== "prompt") return board;
  const recorded = recordedTasks(board, promptId);
  // 旧文本在原位新建节点，被编辑节点让到下方。
  const old = { ...prompt, id: fork.newNodeId, extra: {} };
  const moved = { ...prompt, text: fork.text, pos: [prompt.pos[0], prompt.pos[1] + prompt.size[1] + FORK_GAP] as [number, number] };
  return {
    ...board,
    nodes: [...board.nodes.map((n) => (n.id === promptId ? moved : n)), old],
    edges: board.edges.map((e) => (e.from[0] === promptId && recorded.has(e.to[0]) ? { ...e, from: [fork.newNodeId, e.from[1]] } : e)),
  };
}

// ---- 参考图输入规则 ----

export interface ImageFacts {
  /** 小写格式名：png / jpeg / webp …；未知为空串。 */
  format: string;
  bytes: number;
  width: number;
  height: number;
}

export const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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
