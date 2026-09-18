// 拖线建节点：从端口拖线落空白建节点并接上；拖线落在任务节点卡片上接到下一个空端口。
// 全部是纯函数；画布负责命中检测、文件对话框与写入画板（一次拖线 = 一个撤销步）。
import type { Board, ReferenceNode, TaskNode } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import type { MenuItem } from "./contextMenu";
import { canConnect, connect, IMAGE_PORT_PREFIX, imageEdges, imagePortIndex, syncImagePorts, type Connection, type Verdict } from "./graph";
import { LOCKED_HINT, userEdge, type Outcome } from "./iterate";
import { COLUMN_GAP, placeNear, TASK_NODE_SIZE } from "./layout";
import { defaultTaskModel, type Discovery } from "./settings";
import { defaultSizeSpec } from "./size";
import type { DragFrom } from "./ports";

/**
 * 从起点端口拖到空白处可建的节点（候选动作）。单候选松手即建，多候选经上下文菜单选；空 = 什么也不做。
 * 图片输出 → 以此继续编辑；提示词输出 → 新建生成任务接正向；任务的空图片端口反向 → 添加参考图并接该端口。
 */
export function dragCreateItems(board: Board, from: DragFrom): MenuItem[] {
  const node = board.nodes.find((n) => n.id === from.nodeId);
  if (!node) return [];
  if (from.type === "source") {
    if (from.handleId !== "out") return [];
    if (node.type === "reference" || node.type === "result") return [{ action: "continueEditing", label: "以此继续编辑", disabledReason: null }];
    if (node.type === "prompt") return [{ action: "newTask", label: "新建生成任务", disabledReason: null }];
    return [];
  }
  if (node.type === "task" && imagePortIndex(from.handleId) === imageEdges(board, node.id).length) {
    return [{ action: "addReferences", label: "添加参考图…", disabledReason: null }];
  }
  return [];
}

/**
 * 拖线落在节点卡片上（非端口）要接的连线：图片线 → 下一个空图片端口，提示词线 → 正向端口。
 * null = 落点无效、不提示（非任务节点、反向拖线）；不可接时给原因（锁定任务 = LOCKED_HINT）。
 */
export function cardDropConnection(
  board: Board,
  table: CapabilityTable,
  from: DragFrom,
  cardId: string,
  locked: ReadonlySet<string>,
): { ok: true; connection: Connection } | Extract<Verdict, { ok: false }> | null {
  if (from.type !== "source" || board.nodes.find((n) => n.id === cardId)?.type !== "task") return null;
  const source = board.nodes.find((n) => n.id === from.nodeId);
  const targetHandle = source?.type === "prompt" ? "positive" : source?.type === "reference" || source?.type === "result" ? `${IMAGE_PORT_PREFIX}${imageEdges(board, cardId).length}` : null;
  if (targetHandle === null) return null;
  if (locked.has(cardId)) return { ok: false, reason: LOCKED_HINT };
  const connection: Connection = { source: from.nodeId, sourceHandle: from.handleId, target: cardId, targetHandle };
  const verdict = canConnect(board, table, connection);
  return verdict.ok ? { ok: true, connection } : verdict;
}

/**
 * 新建生成任务节点（工具栏、上下文菜单、拖线建节点共用）：模型同工具栏默认（画板最近选择优先），左上角落在 pos，
 * 并记为画板最近选择；promptId = 从该提示词拖出，接新任务的正向端口。
 */
export function newTask(board: Board, table: CapabilityTable, discovery: Discovery, taskId: string, pos: [number, number], promptId?: string): Outcome {
  const modelId = defaultTaskModel(table, discovery, board.last_model);
  const model = modelId ? findModel(table, modelId) : undefined;
  if (!model) return { ok: false, reason: "能力表中没有上架模型" };
  const task: TaskNode = {
    type: "task",
    id: taskId,
    pos,
    size: TASK_NODE_SIZE,
    model: model.model_id,
    size_spec: defaultSizeSpec(model.workflows.text_to_image.size_rule),
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
    extra: {},
  };
  const edges = promptId ? [...board.edges, userEdge(promptId, "out", taskId, "positive")] : board.edges;
  return { ok: true, board: { ...board, last_model: model.model_id, nodes: [...board.nodes, task], edges } };
}

/**
 * 新导入的参考图节点加到画板，并依次接到任务的下一个空图片端口（一次变更 = 一个撤销步）。
 * place：asIs = 保留节点自带位置（松手处）；left = 落在任务左侧就近空位。
 * 节点总是加上（导入不因接不上而丢）；接不上时停止接线并给出原因（锁定任务 = LOCKED_HINT）。
 */
export function attachReferences(
  board: Board,
  table: CapabilityTable,
  refs: ReferenceNode[],
  taskId: string,
  locked: ReadonlySet<string>,
  place: "asIs" | "left",
): { board: Board; reason: string | null } {
  const task = board.nodes.find((n) => n.id === taskId);
  const placed: ReferenceNode[] = [];
  for (const ref of refs) {
    const pos: [number, number] =
      place === "left" && task?.type === "task" ? placeNear(board, [task.pos[0] - ref.size[0] - COLUMN_GAP, task.pos[1]], ref.size, placed) : ref.pos;
    placed.push({ ...ref, pos });
  }
  let next: Board = { ...board, nodes: [...board.nodes, ...placed] };
  if (locked.has(taskId)) return { board: next, reason: LOCKED_HINT };
  for (const ref of placed) {
    const c: Connection = { source: ref.id, sourceHandle: "out", target: taskId, targetHandle: `${IMAGE_PORT_PREFIX}${imageEdges(next, taskId).length}` };
    const verdict = canConnect(next, table, c);
    if (!verdict.ok) return { board: syncImagePorts(next), reason: verdict.reason };
    next = { ...next, edges: connect(next, c) };
  }
  return { board: syncImagePorts(next), reason: null };
}
