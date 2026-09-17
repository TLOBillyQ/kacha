// 画板选取、编辑键与导航的纯逻辑（规格 4.1「导航」「选取与编辑键」）：框选命中合并、方向键微移、原地复制与 Alt + 拖复制、滚轮 / 触控板判别。
import type { Board } from "./board";
import { copySelection, pasteClip } from "./iterate";

export interface SelectChange {
  id: string;
  selected: boolean;
}

/**
 * 把 React Flow 的选中变更并入选区。keep = Shift + 框选开始前的选区：框选过程中对它们的取消选中一律忽略，
 * 于是框内命中是加选。无变化时返回原集合。
 */
export function applySelection(current: ReadonlySet<string>, changes: SelectChange[], keep: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const c of changes) {
    const set = next ?? current;
    if (set.has(c.id) === c.selected || (!c.selected && keep.has(c.id))) continue;
    next ??= new Set(current);
    if (c.selected) next.add(c.id);
    else next.delete(c.id);
  }
  return next ?? current;
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

/** 方向键微移量：1px，Shift 10px；非方向键为 null。 */
export function nudgeDelta(key: string, shift: boolean): [number, number] | null {
  const dir = ARROWS[key];
  if (!dir) return null;
  const step = shift ? 10 : 1;
  return [dir[0] * step, dir[1] * step];
}

export function nudgeNodes(board: Board, ids: readonly string[], [dx, dy]: [number, number]): Board {
  const picked = new Set(ids);
  if (!board.nodes.some((n) => picked.has(n.id))) return board;
  return { ...board, nodes: board.nodes.map((n) => (picked.has(n.id) && n.type !== "unknown" ? { ...n, pos: [n.pos[0] + dx, n.pos[1] + dy] as [number, number] } : n)) };
}

/** 复制选中节点（规则同复制粘贴：结果节点不复制）并按 offset 错开；Ctrl+J 用 PASTE_OFFSET，Alt + 拖用 0。pairs = [原节点, 副本]。 */
export function duplicateNodes(
  board: Board,
  ids: readonly string[],
  newId: () => string,
  offset: number,
): { board: Board; ids: string[]; pairs: [string, string][] } {
  const clip = copySelection(board, [...ids]);
  const pasted = pasteClip(board, clip, newId, offset);
  return { ...pasted, pairs: clip.nodes.map((n, i) => [n.id, pasted.ids[i]]) };
}

/**
 * Alt + 拖松手：拖动开始时副本已叠在原处、原节点被拖走；松手时对调——原节点（带连线与结果列）回到起点，
 * 副本落在松手处，于是被拖走的是副本。starts = 原节点拖动前的位置。
 */
export function settleAltDrag(board: Board, pairs: [string, string][], starts: ReadonlyMap<string, [number, number]>): Board {
  const dropped = new Map<string, [number, number]>();
  for (const [orig, copy] of pairs) {
    const n = board.nodes.find((x) => x.id === orig);
    if (n && n.type !== "unknown") dropped.set(copy, n.pos);
  }
  return {
    ...board,
    nodes: board.nodes.map((n) => {
      if (n.type === "unknown") return n;
      const pos = starts.get(n.id) ?? dropped.get(n.id);
      return pos ? { ...n, pos } : n;
    }),
  };
}

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 = 像素；1 / 2 = 行 / 页（只有鼠标滚轮会给）。 */
  deltaMode: number;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * 滚轮事件是否当作触控板双指平移：浏览器不区分设备，按增量特征推断——
 * 带横向分量或像素增量非整数视为触控板；捏合（浏览器合成 ctrlKey）、Ctrl / Alt + 滚轮一律缩放。
 */
export function isTrackpadPan(e: WheelLike): boolean {
  if (e.ctrlKey || e.altKey || e.deltaMode !== 0) return false;
  return e.deltaX !== 0 || !Number.isInteger(e.deltaY);
}
