// 自动宽高比：处于自动状态的生成任务，宽高比跟随参考图推测并缓存在任务节点上。
// Board → Board 的纯函数；图片像素宽高由界面经 dims 提供（读不到 = undefined，保留上次算出的值）。
import type { Board, TaskNode } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import { imageEdges, imagePortIndex, workflowOf } from "./graph";
import { autoSizeSpec, isAutoRatio, type SizeSpec } from "./size";

/** 节点 id → 图片像素 [宽, 高]；来源图层的连线也按节点（底图）取。 */
export type ImageDims = (nodeId: string) => [number, number] | undefined;

/** 跟随的参考图：用户端口中序号最前的带区域指示的，没有区域指示时为图1；没有参考图为 null。区域端口 / 叠加图不是连线，不参与。 */
export function followedImage(board: Board, taskId: string): { image: number; nodeId: string } | null {
  const edges = imageEdges(board, taskId);
  const edge = edges.find((e) => (e.region?.rects.length ?? 0) > 0) ?? edges[0];
  return edge ? { image: imagePortIndex(edge.to[1])! + 1, nodeId: edge.from[0] } : null;
}

const sameSpec = (a: SizeSpec, b: SizeSpec) => JSON.stringify(a) === JSON.stringify(b);

function synced(board: Board, table: CapabilityTable, task: TaskNode, dims: ImageDims): TaskNode {
  const spec = task.size_spec;
  const rule = findModel(table, task.model)?.workflows[workflowOf(board, task.id)].size_rule;
  // 模型或分辨率档不认识时不动：沿用「（不支持）」标红，等用户选定后再算。
  if (!isAutoRatio(spec) || !rule || spec.tier === null || !(spec.tier in rule.tiers)) return task;
  const followed = followedImage(board, task.id);
  const source = followed ? (dims(followed.nodeId) ?? spec.auto_ratio?.source ?? null) : null;
  // 有图但从没读到过：宽高比保持原值，只更新「图N」。
  const next =
    followed && source === null
      ? { ...spec, auto_ratio: { ratio: spec.ratio!, image: followed.image, source: null } }
      : autoSizeSpec(rule, spec.tier, followed?.image ?? null, source, spec);
  return sameSpec(next, spec) ? task : { ...task, size_spec: next };
}

/**
 * 重算画板上所有自动宽高比（图1 接入 / 更换 / 改接线、区域指示增删、换模型或分辨率档之后调用）。
 * 与触发它的用户操作在同一次画板变更里完成，不单独构成撤销步；skip = 锁定的任务节点。无变化时返回原画板。
 */
export function syncAutoRatios(board: Board, table: CapabilityTable, dims: ImageDims, skip: ReadonlySet<string> = new Set()): Board {
  let changed = false;
  const nodes = board.nodes.map((n) => {
    if (n.type !== "task" || skip.has(n.id)) return n;
    const next = synced(board, table, n, dims);
    if (next !== n) changed = true;
    return next;
  });
  return changed ? { ...board, nodes } : board;
}
