// 端口与连线的视觉推导（规格 4.1「端口与连线」）：拖线态合法端口集合、端口 / 连线的类型与类名。
import type { Board, BoardEdge } from "./board";
import { imageEdges, imagePortIndex, IMAGE_PORT_PREFIX, type Connection } from "./graph";

/** 端口 / 连线的类型色；系统连线另有灰虚线。 */
export type PortKind = "image" | "positive" | "negative";

/** 端口在画布上的唯一键：节点 id + 端口 id。 */
export const portKey = (nodeId: string, handleId: string) => `${nodeId}|${handleId}`;

/** 拖线起点（React Flow useConnection 的 fromHandle）。 */
export interface DragFrom {
  nodeId: string;
  handleId: string;
  type: "source" | "target";
}

/**
 * 拖线时所有合法的落点端口。isValid 必须与画布的 isValidConnection 同一判定（含锁定），
 * 这样发光的端口与松手能连上的端口一致。
 */
export function connectablePorts(board: Board, from: DragFrom, isValid: (c: Connection) => boolean): ReadonlySet<string> {
  const keys = new Set<string>();
  if (from.type === "source") {
    for (const n of board.nodes) {
      if (n.type !== "task") continue;
      const images = imageEdges(board, n.id).length;
      const handles = ["positive", "negative", ...Array.from({ length: images + 1 }, (_, i) => `${IMAGE_PORT_PREFIX}${i}`)];
      for (const h of handles) {
        if (isValid({ source: from.nodeId, sourceHandle: from.handleId, target: n.id, targetHandle: h })) keys.add(portKey(n.id, h));
      }
    }
  } else {
    for (const n of board.nodes) {
      if (n.type === "task" || n.type === "unknown") continue;
      if (isValid({ source: n.id, sourceHandle: "out", target: from.nodeId, targetHandle: from.handleId })) keys.add(portKey(n.id, "out"));
    }
  }
  return keys;
}

/** 拖线态：起点与合法落点集合；未拖线为 null。 */
export interface DragState {
  from: DragFrom;
  ports: ReadonlySet<string>;
}

/** 端口的拖线态类名：起点保持原样，合法端口放大发光，其余端口去强调。 */
export function portDragClassName(drag: DragState | null, nodeId: string, handleId: string): "" | "port-origin" | "port-valid" | "port-invalid" {
  if (!drag) return "";
  if (drag.from.nodeId === nodeId && drag.from.handleId === handleId) return "port-origin";
  return drag.ports.has(portKey(nodeId, handleId)) ? "port-valid" : "port-invalid";
}

/** 端口键拆回节点 id（端口 id 不含分隔符，从最后一个分隔符切）。 */
const nodeOfKey = (key: string) => key.slice(0, key.lastIndexOf("|"));

/**
 * 节点类名：谱系发光 + 去强调。未拖线时有选中则非谱系去强调；
 * 拖线中改按拖线态：既非起点、也没有合法落点的节点去强调。
 */
export function nodeClassName(nodeId: string, state: { lineage: boolean; selecting: boolean; drag: DragState | null }): string {
  const { drag } = state;
  const classes = state.lineage ? ["in-lineage"] : [];
  const dimmed = drag
    ? drag.from.nodeId !== nodeId && ![...drag.ports].some((key) => nodeOfKey(key) === nodeId)
    : state.selecting && !state.lineage;
  if (dimmed) classes.push("dimmed");
  return classes.join(" ");
}

/** 连线的类型：按目标端口（与源端口色一致）。 */
export function edgeKind(edge: BoardEdge): PortKind | "system" {
  if (edge.system) return "system";
  if (edge.to[1] === "positive" || edge.to[1] === "negative") return edge.to[1];
  return imagePortIndex(edge.to[1]) !== null ? "image" : "system";
}

/**
 * 连线类名：类型色 + 谱系高亮（加粗外发光，不改色）+ 去强调。
 * selecting = 画布有选中节点；dragging = 正在拖线（所有连线去强调）。
 */
export function edgeClassName(edge: BoardEdge, state: { lineage: boolean; selecting: boolean; dragging: boolean }): string {
  const classes = [`edge-${edgeKind(edge)}`];
  if (state.lineage) classes.push("edge-lineage");
  if (state.dragging || (state.selecting && !state.lineage)) classes.push("dimmed");
  return classes.join(" ");
}

/** 提示词输出端口的类型色：只连负向端口的提示词为负向色，其余（含未连）为正向色。 */
export function promptPortKind(board: Board, promptId: string): "positive" | "negative" {
  const out = board.edges.filter((e) => e.from[0] === promptId);
  return out.length > 0 && out.every((e) => e.to[1] === "negative") ? "negative" : "positive";
}

/** 拖线起点端口的类型色（拖线中的连线用它着色）。 */
export function dragKind(board: Board, from: DragFrom): PortKind {
  if (from.type === "target") return from.handleId === "positive" || from.handleId === "negative" ? from.handleId : "image";
  return board.nodes.find((n) => n.id === from.nodeId)?.type === "prompt" ? promptPortKind(board, from.nodeId) : "image";
}
