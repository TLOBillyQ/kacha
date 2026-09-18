// 自动落位：任务右侧结果列自上而下累积；迭代动作新建的节点落在触发节点旁。
// 只找就近空位，不推开、不重排，用户摆过的位置永远不动。
import type { Board, ResultNode, ResultRecord } from "./board";
import { IMAGE_NODE_WIDTH, imageNodeSize, sizeSpecAspect } from "./nodeSize";
import type { LayerRecord } from "./taskDir";

/** 结果节点未知比例时的占位尺寸；实际新建按尺寸设置的比例（addResultNode）。 */
export const RESULT_NODE_SIZE: [number, number] = [IMAGE_NODE_WIDTH, IMAGE_NODE_WIDTH];
export const TASK_NODE_SIZE: [number, number] = [280, 260];
export const PROMPT_NODE_SIZE: [number, number] = [240, 140];
export const COLUMN_GAP = 60;
export const ROW_GAP = 24;

type Rect = { x: number; y: number; w: number; h: number };

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export interface Placed {
  pos: [number, number];
  size: [number, number];
}

/** 从期望位置起找空位：被占住就让到挡路节点下方；extra = 同一动作里刚放下、还没进画板的节点。 */
export function placeNear(board: Board, desired: [number, number], size: [number, number], extra: Placed[] = []): [number, number] {
  const others: Rect[] = [...board.nodes.flatMap((n) => (n.type === "unknown" ? [] : [n])), ...extra].map((n) => ({ x: n.pos[0], y: n.pos[1], w: n.size[0], h: n.size[1] }));
  let [x, y] = desired;
  // 每次让到挡路节点下方；节点数有限，最多让 others.length 次。
  for (let i = 0; i <= others.length; i++) {
    const candidate = { x, y, w: size[0], h: size[1] };
    const blocker = others.find((o) => overlaps(candidate, o));
    if (!blocker) break;
    y = blocker.y + blocker.h + ROW_GAP;
  }
  return [Math.round(x), Math.round(y)];
}

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
  return placeNear(board, [x, y], size);
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
  /** 拆分图层（已按 z_index 升序落盘）；有则写进记录并作为 layer_count。 */
  layers?: LayerRecord[];
}

/** 一次运行落盘的结果：节点 id 由画板编辑分配。 */
export type RunResult = Omit<NewResult, "id">;

/** 加结果节点与系统连线；任务节点已被删除时原样返回。 */
export function addResultNode(board: Board, result: NewResult): Board {
  const size = imageNodeSize(IMAGE_NODE_WIDTH, sizeSpecAspect(result.record.size_spec));
  const pos = placeResult(board, result.taskId, size);
  if (!pos) return board;
  const node: ResultNode = {
    id: result.id,
    type: "result",
    pos,
    size,
    extra: {},
    task_id: result.submittedTaskId,
    file: result.file,
    path: result.path,
    layer_count: result.layers?.length ?? 0,
    record: result.layers?.length ? { ...result.record, layers: result.layers } : result.record,
  };
  return {
    ...board,
    nodes: [...board.nodes, node],
    edges: [...board.edges, { from: [result.taskId, "result"], to: [result.id, "in"], source_layer: null, region: null, system: true, extra: {} }],
  };
}
