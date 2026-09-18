// 画板选取、编辑键与导航：左键拖框选 / Shift 加选、右键 / 中键拖平移、平移缩放、Esc 清选区、
// 方向键微移、Ctrl+J 原地偏移复制、Alt + 拖复制。React Flow 的相关配置与这些键位收在这里，BoardCanvas 只接线。
// 撤销 / 重做、复制粘贴的 Ctrl 键仍在 BoardCanvas（#105），两边键位不重叠。
import { SelectionMode, useReactFlow, useStoreApi, type Node, type ReactFlowProps } from "@xyflow/react";
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { Board } from "../core/board";
import { countLabel, MERGE_PAUSE_MS, type UserChange } from "../core/history";
import { PASTE_OFFSET } from "../core/iterate";
import { applySelection, duplicateNodes, isTrackpadPan, nudgeDelta, nudgeNodes, settleAltDrag, type SelectChange } from "../core/selection";

export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

type Ids = ReadonlySet<string>;

/** 画布的选区：节点与连线各一份。 */
export interface Selection {
  nodes: MutableRefObject<Ids>;
  edges: MutableRefObject<Ids>;
  setNodes: Dispatch<SetStateAction<Ids>>;
  setEdges: Dispatch<SetStateAction<Ids>>;
}

interface Options {
  wrapper: RefObject<HTMLDivElement | null>;
  boardRef: MutableRefObject<Board>;
  selection: Selection;
  /** 弹窗开着时画布键位不响应。 */
  dialogOpen: MutableRefObject<boolean>;
  updateBoard: (fn: (b: Board) => Board, change: UserChange) => void;
}

const ZOOM_DURATION = 200;
const NONE: { nodes: Ids; edges: Ids } = { nodes: new Set(), edges: new Set() };

/** 预先定好的新 id 序列：更新函数可能延后或重复执行，副本 id 要与立即切换的选区一致。 */
function idSequence(count: number): () => () => string {
  const fresh = Array.from({ length: count }, () => crypto.randomUUID());
  return () => {
    let i = 0;
    return () => fresh[i++];
  };
}

export function useCanvasInteraction({ wrapper, boardRef, selection, dialogOpen, updateBoard }: Options) {
  const flow = useReactFlow();
  const store = useStoreApi();

  // Shift + 框选：React Flow 框选开始时会先清空选区，按下时记下原选区并忽略对它的取消选中。
  const keep = useRef(NONE);
  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      const onPane = e.target instanceof Element && e.target.classList.contains("react-flow__pane");
      keep.current = e.shiftKey && onPane ? { nodes: selection.nodes.current, edges: selection.edges.current } : NONE;
    },
    [selection],
  );
  const onPointerUpCapture = useCallback(() => {
    keep.current = NONE;
  }, []);
  const selectNodes = useCallback((changes: SelectChange[]) => selection.setNodes((s) => applySelection(s, changes, keep.current.nodes)), [selection]);
  const selectEdges = useCallback((changes: SelectChange[]) => selection.setEdges((s) => applySelection(s, changes, keep.current.edges)), [selection]);

  // Alt + 拖：开始时在原处叠一份副本，松手时与原节点对调位置（被拖走的是副本）；复制、拖动、对调合为一步。
  const altDrag = useRef<{ pairs: [string, string][]; starts: Map<string, [number, number]>; change: UserChange } | null>(null);
  /** 拖动开始；返回这次拖动的步描述（非 Alt 复制为 null）。 */
  const startDrag = useCallback(
    (event: { altKey: boolean }, dragged: Node[], mergeKey: string): string | null => {
      altDrag.current = null;
      if (!event.altKey || !dragged.length) return null;
      const ids = dragged.map((n) => n.id);
      const sequence = idSequence(ids.length);
      const { pairs } = duplicateNodes(boardRef.current, ids, sequence(), 0);
      if (!pairs.length) return null;
      const starts = new Map<string, [number, number]>();
      for (const [orig] of pairs) {
        const n = boardRef.current.nodes.find((x) => x.id === orig);
        if (n && n.type !== "unknown") starts.set(orig, n.pos);
      }
      const change: UserChange = { label: countLabel("复制", pairs.length), merge: { key: mergeKey } };
      altDrag.current = { pairs, starts, change };
      updateBoard((b) => duplicateNodes(b, ids, sequence(), 0).board, change);
      return change.label;
    },
    [boardRef, updateBoard],
  );
  const stopDrag = useCallback(() => {
    const pending = altDrag.current;
    altDrag.current = null;
    if (!pending) return;
    updateBoard((b) => settleAltDrag(b, pending.pairs, pending.starts), pending.change);
    selection.setNodes(new Set(pending.pairs.map(([, copy]) => copy)));
    selection.setEdges(new Set());
  }, [updateBoard, selection]);

  // 触控板双指 = 平移（React Flow 默认滚轮一律缩放）。
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!isTrackpadPan(e) || (e.target instanceof Element && e.target.closest(".nowheel"))) return;
      e.preventDefault();
      e.stopPropagation();
      const vp = flow.getViewport();
      void flow.setViewport({ x: vp.x - e.deltaX, y: vp.y - e.deltaY, zoom: vp.zoom });
    };
    el.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [wrapper, flow]);

  useEffect(() => {
    const duplicateSelection = () => {
      const ids = [...selection.nodes.current];
      if (!ids.length) return;
      const sequence = idSequence(ids.length);
      const probe = duplicateNodes(boardRef.current, ids, sequence(), PASTE_OFFSET);
      if (!probe.ids.length) return;
      updateBoard((b) => duplicateNodes(b, ids, sequence(), PASTE_OFFSET).board, { label: countLabel("复制", probe.ids.length) });
      selection.setNodes(new Set(probe.ids));
      selection.setEdges(new Set());
    };
    const onKey = (e: KeyboardEvent) => {
      // 上下文菜单开着时它在捕获阶段吞掉 Esc（只关菜单），这里收不到。
      if (e.defaultPrevented || isTyping(e.target) || dialogOpen.current || !wrapper.current?.isConnected) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && !e.shiftKey) {
        const key = e.key.toLowerCase();
        if (key === "0") void flow.fitView({ duration: ZOOM_DURATION });
        else if (key === "1") void flow.zoomTo(1, { duration: ZOOM_DURATION });
        else if (key === "=" || key === "+") void flow.zoomIn({ duration: ZOOM_DURATION });
        else if (key === "-") void flow.zoomOut({ duration: ZOOM_DURATION });
        else if (key === "j") duplicateSelection();
        else return;
        e.preventDefault();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === "Escape") {
        if (store.getState().connection.inProgress) return;
        selection.setNodes(new Set());
        selection.setEdges(new Set());
        return;
      }
      const delta = nudgeDelta(e.key, e.shiftKey);
      const ids = [...selection.nodes.current].sort();
      if (!delta || !ids.length) return;
      e.preventDefault();
      updateBoard((b) => nudgeNodes(b, ids, delta), { label: countLabel("微移", ids.length), merge: { key: `nudge:${ids.join(",")}`, windowMs: MERGE_PAUSE_MS } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wrapper, flow, store, boardRef, selection, dialogOpen, updateBoard]);

  const flowProps: Partial<ReactFlowProps> = {
    selectionOnDrag: true,
    selectionMode: SelectionMode.Partial,
    // Shift 用于加选；框选靠左键拖空白，不另设框选键（按住框选键时 React Flow 在节点上也起框，Shift + 点节点会变成框选）。
    selectionKeyCode: null,
    multiSelectionKeyCode: "Shift",
    // 右键 / 中键拖平移。右键没拖动时 React Flow 在松手时才触发空白处上下文菜单，拖动过则不弹。
    panOnDrag: [1, 2],
    panActivationKeyCode: "Space",
    zoomOnScroll: true,
    zoomOnPinch: true,
    zoomOnDoubleClick: false,
    deleteKeyCode: ["Delete", "Backspace"],
    // 方向键微移由本模块处理（1 / 10px）；关掉 React Flow 自带的键盘移动（5px）。
    disableKeyboardA11y: true,
  };

  return { flowProps, selectNodes, selectEdges, startDrag, stopDrag, onPointerDownCapture, onPointerUpCapture };
}
