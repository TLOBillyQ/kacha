// 迭代动作（规格第 4 节）：以此继续编辑、加为参考图；以及谱系高亮与通用复制粘贴。
// 全部是 Board → Board 的纯函数；「生成变体」只是父任务按该结果的任务目录重跑，见 run.ts。
import type { Board, BoardEdge, BoardNode, PromptNode, ResultNode, TaskNode } from "./board";
import { findModel, isSupported, type CapabilityTable, type ModelCapability } from "./capabilities";
import { canConnect, connect, IMAGE_PORT_PREFIX, imageEdges, syncImagePorts, type Verdict } from "./graph";
import { COLUMN_GAP, placeNear, PROMPT_NODE_SIZE, ROW_GAP, TASK_NODE_SIZE } from "./layout";
import { defaultEditModel, type Discovery } from "./settings";
import { defaultSizeSpec, resolveSize, type SizeSpec } from "./size";

export type Outcome = { ok: true; board: Board } | Extract<Verdict, { ok: false }>;

const userEdge = (from: string, fromPort: string, to: string, toPort: string): BoardEdge => ({
  from: [from, fromPort],
  to: [to, toPort],
  source_layer: null,
  region: null,
  system: false,
  extra: {},
});

/** 产出某结果节点的任务节点（系统连线的起点）；已删除为 undefined。 */
export function producerOf(board: Board, resultId: string): TaskNode | undefined {
  const from = board.edges.find((e) => e.system && e.to[0] === resultId)?.from[0];
  const node = board.nodes.find((n) => n.id === from);
  return node?.type === "task" ? node : undefined;
}

const isImageNode = (n: BoardNode | undefined): n is Extract<BoardNode, { type: "reference" | "result" }> => n?.type === "reference" || n?.type === "result";

/**
 * 以此继续编辑：新任务节点按选中顺序接入触发节点的图片，新空提示词节点接正向，负向扇出复用源任务的。
 * 模型 / 尺寸继承第一个触发节点的源任务（产出任务已删则按结果记录）；源模型不支持编辑或触发于参考图时用默认编辑模型。不带区域指示。
 */
export function continueEditing(
  board: Board,
  table: CapabilityTable,
  discovery: Discovery,
  sourceIds: string[],
  ids: { taskId: string; promptId: string },
): Outcome {
  const sources = sourceIds.map((id) => board.nodes.find((n) => n.id === id)).filter(isImageNode);
  if (!sources.length) return { ok: false, reason: "先选中结果或参考图节点" };

  const first = sources[0];
  const producer = first.type === "result" ? producerOf(board, first.id) : undefined;
  const inherited: { model: string; size_spec: SizeSpec } | null =
    first.type === "reference" ? null : producer ? { model: producer.model, size_spec: producer.size_spec } : { model: first.record.model, size_spec: first.record.size_spec };
  const inheritedModel = inherited && findModel(table, inherited.model);
  const model: ModelCapability | null = inheritedModel && inheritedModel.workflows.image_edit.max_references > 0 ? inheritedModel : defaultEditModel(table, discovery);
  if (!model) return { ok: false, reason: "上架清单中没有支持图片编辑的模型" };
  const rule = model.workflows.image_edit.size_rule;
  const size_spec = inherited && resolveSize(rule, inherited.size_spec) ? { ...inherited.size_spec } : defaultSizeSpec(rule);
  const limit = model.workflows.image_edit.max_references;
  if (sources.length > limit) return { ok: false, reason: `${model.display_name} 最多接 ${limit} 张参考图，选中了 ${sources.length} 张` };

  const right = Math.max(...sources.map((n) => n.pos[0] + n.size[0]));
  const taskPos = placeNear(board, [right + COLUMN_GAP, first.pos[1]], TASK_NODE_SIZE);
  const task: TaskNode = {
    id: ids.taskId,
    type: "task",
    pos: taskPos,
    size: TASK_NODE_SIZE,
    extra: {},
    model: model.model_id,
    size_spec,
    image_ports: 0,
    layer_decomposition: false,
    transparent_background: false,
    last_submitted: null,
  };
  const promptPos = placeNear(
    board,
    [taskPos[0] - PROMPT_NODE_SIZE[0] - COLUMN_GAP, taskPos[1] - PROMPT_NODE_SIZE[1] - ROW_GAP],
    PROMPT_NODE_SIZE,
    [task],
  );
  const prompt: PromptNode = { id: ids.promptId, type: "prompt", pos: promptPos, size: PROMPT_NODE_SIZE, extra: {}, text: "" };

  const edges = [
    ...board.edges,
    userEdge(prompt.id, "out", task.id, "positive"),
    ...sources.map((s, i) => userEdge(s.id, "out", task.id, `${IMAGE_PORT_PREFIX}${i}`)),
  ];
  const negative = producer && board.edges.find((e) => e.to[0] === producer.id && e.to[1] === "negative");
  if (negative && isSupported(model.workflows.image_edit.supports_negative_prompt)) edges.push(userEdge(negative.from[0], negative.from[1], task.id, "negative"));

  return { ok: true, board: syncImagePorts({ ...board, nodes: [...board.nodes, prompt, task], edges }) };
}

/** 加为参考图的目标：选中节点里恰好一个生成任务节点。 */
export function addAsReferenceTarget(board: Board, selectedIds: string[]): { ok: true; taskId: string } | Extract<Verdict, { ok: false }> {
  const tasks = selectedIds.filter((id) => board.nodes.some((n) => n.id === id && n.type === "task"));
  return tasks.length === 1 ? { ok: true, taskId: tasks[0] } : { ok: false, reason: "先选一个生成任务" };
}

/** 加为参考图：结果节点接到目标任务的下一个空图片端口；不新增节点、不改参数（目标因图片端口集合变化而变脏）。 */
export function addAsReference(board: Board, table: CapabilityTable, resultId: string, taskId: string): Outcome {
  if (board.nodes.find((n) => n.id === resultId)?.type !== "result") return { ok: false, reason: "只能把结果节点加为参考图" };
  const c = { source: resultId, sourceHandle: "out", target: taskId, targetHandle: `${IMAGE_PORT_PREFIX}${imageEdges(board, taskId).length}` };
  const verdict = canConnect(board, table, c);
  if (!verdict.ok) return verdict;
  return { ok: true, board: syncImagePorts({ ...board, edges: connect(board, c) }) };
}

/** 谱系：选中节点沿连线的上游全链与下游全链（并集），不含兄弟旁支。 */
export function lineage(board: Board, ids: string[]): { nodes: Set<string>; edges: Set<BoardEdge> } {
  const nodes = new Set<string>(ids.filter((id) => board.nodes.some((n) => n.id === id)));
  const edges = new Set<BoardEdge>();
  const walk = (next: (e: BoardEdge) => [string, string]) => {
    const seen = new Set<string>();
    const stack = [...nodes];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of board.edges) {
        const [here, there] = next(e);
        if (here !== id) continue;
        edges.add(e);
        stack.push(there);
      }
    }
    return seen;
  };
  const up = walk((e) => [e.to[0], e.from[0]]);
  const down = walk((e) => [e.from[0], e.to[0]]);
  return { nodes: new Set([...up, ...down]), edges };
}

// ---- 通用复制粘贴 ----

export interface Clip {
  nodes: Exclude<BoardNode, ResultNode | { type: "unknown" }>[];
  edges: BoardEdge[];
}

export const PASTE_OFFSET = 40;

/** 复制：提示词 / 参考图 / 任务节点及其之间的用户连线；结果节点由系统产出，不复制。存快照。 */
export function copySelection(board: Board, ids: string[]): Clip {
  const picked = new Set(ids);
  const nodes = board.nodes.filter((n): n is Clip["nodes"][number] => picked.has(n.id) && (n.type === "prompt" || n.type === "reference" || n.type === "task"));
  const kept = new Set(nodes.map((n) => n.id));
  return structuredClone({ nodes, edges: board.edges.filter((e) => !e.system && kept.has(e.from[0]) && kept.has(e.to[0])) });
}

/** 粘贴：新 id、整体偏移；任务节点的提交记录清空（新节点从未提交过）。 */
export function pasteClip(board: Board, clip: Clip, newId: () => string): { board: Board; ids: string[] } {
  const idMap = new Map(clip.nodes.map((n) => [n.id, newId()]));
  const nodes = clip.nodes.map((n): BoardNode => {
    const copy = { ...structuredClone(n), id: idMap.get(n.id)!, pos: [n.pos[0] + PASTE_OFFSET, n.pos[1] + PASTE_OFFSET] as [number, number] };
    return copy.type === "task" ? { ...copy, last_submitted: null } : copy;
  });
  const edges = clip.edges.map((e) => ({ ...structuredClone(e), from: [idMap.get(e.from[0])!, e.from[1]] as [string, string], to: [idMap.get(e.to[0])!, e.to[1]] as [string, string] }));
  // 图片端口序号在复制子集里可能不连续，按原顺序紧凑。
  let next: Board = { ...board, nodes: [...board.nodes, ...nodes], edges: [...board.edges, ...edges] };
  for (const taskId of new Set(edges.map((e) => e.to[0]))) {
    const ordered = imageEdges(next, taskId);
    const index = new Map(ordered.map((e, i) => [e, i]));
    next = { ...next, edges: next.edges.map((e) => (index.has(e) ? { ...e, to: [taskId, `${IMAGE_PORT_PREFIX}${index.get(e)}`] as [string, string] } : e)) };
  }
  return { board: syncImagePorts(next), ids: [...idMap.values()] };
}
