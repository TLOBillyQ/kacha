// 画板撤销 / 重做：整张画板快照，每个撤销步对应用户一个意图（规格 4.1、ADR 0012）。
// 系统写入（结果节点产出、last_submitted）不进历史；回到快照时把它们按当前状态合并回去。只在内存，不写画板文件。
import type { Board, BoardEdge, BoardNode } from "./board";

export const HISTORY_LIMIT = 100;
/** 连续输入 / 连按微移：两次变更间隔不超过它即合为一步。 */
export const MERGE_PAUSE_MS = 500;

/** 用户步：label 供按钮 / 菜单文案；merge.key 相同（且在时间窗内，缺省 = 不限）的相邻变更合为一步。 */
export interface UserChange {
  label: string;
  merge?: { key: string; windowMs?: number };
}

/** system = 队列 / 提交写入；view = 视口平移缩放。两者都不进历史。 */
export type Change = UserChange | "system" | "view";

export interface Snapshot {
  board: Board;
  label: string;
}

export interface History {
  /** 栈顶在末尾：撤销回到 undo 末项。 */
  undo: Snapshot[];
  redo: Snapshot[];
  /** 最近一步的合并键与最后一次变更时间；撤销 / 重做后清空。 */
  open: { key: string; at: number } | null;
}

export function emptyHistory(): History {
  return { undo: [], redo: [], open: null };
}

export const undoLabel = (h: History): string | null => h.undo.at(-1)?.label ?? null;
export const redoLabel = (h: History): string | null => h.redo.at(-1)?.label ?? null;

/** 「删除 3 个节点」式步描述。 */
export const countLabel = (verb: string, count: number, unit = "个节点") => `${verb} ${count} ${unit}`;

const capped = (stack: Snapshot[]) => (stack.length > HISTORY_LIMIT ? stack.slice(stack.length - HISTORY_LIMIT) : stack);

/** 记录一次画板变更；before = 变更前的画板。 */
export function recordChange(h: History, before: Board, change: Change, now: number): History {
  if (change === "system" || change === "view") return h;
  const { merge, label } = change;
  const open = h.open;
  if (merge && open?.key === merge.key && h.undo.length && (merge.windowMs === undefined || now - open.at <= merge.windowMs)) {
    const top = h.undo[h.undo.length - 1];
    return { undo: [...h.undo.slice(0, -1), { ...top, label }], redo: [], open: { key: merge.key, at: now } };
  }
  return { undo: capped([...h.undo, { board: before, label }]), redo: [], open: merge ? { key: merge.key, at: now } : null };
}

export interface Travel {
  history: History;
  board: Board;
}

/** 撤销一步；无可撤时为 null。locked = 排队 / 执行中的任务节点 id。 */
export function undo(h: History, current: Board, locked: ReadonlySet<string>): Travel | null {
  const top = h.undo.at(-1);
  if (!top) return null;
  return {
    history: { undo: h.undo.slice(0, -1), redo: capped([...h.redo, { board: current, label: top.label }]), open: null },
    board: mergeSystemState(top.board, current, locked),
  };
}

export function redo(h: History, current: Board, locked: ReadonlySet<string>): Travel | null {
  const top = h.redo.at(-1);
  if (!top) return null;
  return {
    history: { undo: capped([...h.undo, { board: current, label: top.label }]), redo: h.redo.slice(0, -1), open: null },
    board: mergeSystemState(top.board, current, locked),
  };
}

const sameEdge = (a: BoardEdge, b: BoardEdge) => a.from[0] === b.from[0] && a.from[1] === b.from[1] && a.to[0] === b.to[0] && a.to[1] === b.to[1];

/**
 * 回到快照 target，同时保留 current 里系统写入的状态：
 * - 快照里没有、父任务在（合并后的）画板里的结果节点及其系统连线；父任务不在的随之消失；
 * - 任务节点的 last_submitted；
 * - 锁定任务的参数与输入连线（位置仍按快照），快照里没有的锁定任务连同其输入源节点一起保留；
 * - 视口与标题（不属于撤销步）。
 */
export function mergeSystemState(target: Board, current: Board, locked: ReadonlySet<string>): Board {
  const now = new Map(current.nodes.map((n) => [n.id, n]));
  const nodes: BoardNode[] = target.nodes.map((n) => {
    const cur = now.get(n.id);
    if (n.type !== "task" || cur?.type !== "task") return n;
    if (locked.has(n.id)) return { ...cur, pos: n.pos, size: n.size };
    return cur.last_submitted === n.last_submitted ? n : { ...n, last_submitted: cur.last_submitted };
  });
  const present = new Set(nodes.map((n) => n.id));
  const add = (n: BoardNode | undefined) => {
    if (!n || present.has(n.id)) return;
    nodes.push(n);
    present.add(n.id);
  };

  const lockedHere = current.nodes.filter((n) => n.type === "task" && locked.has(n.id)).map((n) => n.id);
  const lockedSet = new Set(lockedHere);
  const lockedInputs = current.edges.filter((e) => lockedSet.has(e.to[0]) && !e.system);
  lockedHere.forEach((id) => add(now.get(id)));
  lockedInputs.forEach((e) => add(now.get(e.from[0])));

  for (const e of current.edges) {
    if (e.system && present.has(e.from[0]) && now.get(e.to[0])?.type === "result") add(now.get(e.to[0]));
  }

  const edges = [...target.edges.filter((e) => !lockedSet.has(e.to[0]) || e.system), ...lockedInputs];
  for (const e of current.edges) {
    if (e.system && present.has(e.from[0]) && present.has(e.to[0]) && !edges.some((x) => sameEdge(x, e))) edges.push(e);
  }
  return { ...target, title: current.title, viewport: current.viewport, nodes, edges };
}
