// 结果节点自动落位（规格第 3.4 节「布局」）：任务右侧结果列，自上而下累积；只找就近空位，不推开、不重排。
import type { Board, ResultNode, ResultRecord } from "./board";

export const RESULT_NODE_SIZE: [number, number] = [220, 300];
const COLUMN_GAP = 60;
const ROW_GAP = 24;

type Rect = { x: number; y: number; w: number; h: number };

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 下一个结果节点的位置；任务节点不存在时为 null。 */
export function placeResult(board: Board, taskId: string, size: [number, number] = RESULT_NODE_SIZE): [number, number] | null {
  const task = board.nodes.find((n) => n.id === taskId);
  if (task?.type !== "task") return null;
  const x = task.pos[0] + task.size[0] + COLUMN_GAP;
  const ownResults = new Set(board.edges.filter((e) => e.system && e.from[0] === taskId).map((e) => e.to[0]));
  let y = task.pos[1];
  for (const n of board.nodes) {
    if (n.type !== "unknown" && ownResults.has(n.id)) y = Math.max(y, n.pos[1] + n.size[1] + ROW_GAP);
  }
  const others: Rect[] = board.nodes.flatMap((n) => (n.type === "unknown" ? [] : [{ x: n.pos[0], y: n.pos[1], w: n.size[0], h: n.size[1] }]));
  // 每次让到挡路节点下方；节点数有限，最多让 nodes.length 次。
  for (let i = 0; i <= others.length; i++) {
    const candidate = { x, y, w: size[0], h: size[1] };
    const blocker = others.find((o) => overlaps(candidate, o));
    if (!blocker) break;
    y = blocker.y + blocker.h + ROW_GAP;
  }
  return [Math.round(x), Math.round(y)];
}

export interface NewResult {
  /** 画板节点 id。 */
  id: string;
  /** 产出它的任务节点 id。 */
  taskId: string;
  submittedTaskId: string;
  file: string;
  path: string;
  record: ResultRecord;
}

/** 加结果节点与系统连线；任务节点已被删除时原样返回。 */
export function addResultNode(board: Board, result: NewResult): Board {
  const pos = placeResult(board, result.taskId);
  if (!pos) return board;
  const node: ResultNode = {
    id: result.id,
    type: "result",
    pos,
    size: RESULT_NODE_SIZE,
    extra: {},
    task_id: result.submittedTaskId,
    file: result.file,
    path: result.path,
    layer_count: 0,
    record: result.record,
  };
  return {
    ...board,
    nodes: [...board.nodes, node],
    edges: [...board.edges, { from: [result.taskId, "result"], to: [result.id, "in"], source_layer: null, region: null, system: true, extra: {} }],
  };
}
