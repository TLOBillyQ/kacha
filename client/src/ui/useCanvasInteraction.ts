// 画板选取、编辑键与导航：左键拖框选 / Shift 加选、右键 / 中键拖平移、平移缩放、Esc 清选区、
// 方向键微移、Ctrl+J 原地偏移复制、Alt + 拖复制。React Flow 的相关配置与这些键位收在这里，BoardCanvas 只接线。
// 撤销 / 重做、复制粘贴的 Ctrl 键仍在 BoardCanvas（#105），两边键位不重叠。
import { SelectionMode, useReactFlow, useStoreApi, type Node, type ReactFlowProps } from "@xyflow/react";
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { Board } from "../core/board";
import type { BoardChange, EditResult } from "../core/edit";
import { copySelection } from "../core/iterate";
import { applySelection, isTrackpadPan, nudgeDelta, type SelectChange } from "../core/selection";

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
  /** 画板写入（见 core/edit），由调用方照建议选中切换选区。 */
  apply: (change: BoardChange) => EditResult | null;
}

const ZOOM_DURATION = 200;
const NONE: { nodes: Ids; edges: Ids } = { nodes: new Set(), edges: new Set() };

export function useCanvasInteraction({ wrapper, boardRef, selection, dialogOpen, apply }: Options) {
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
  const altDrag = useRef<{ pairs: [string, string][]; starts: [string, [number, number]][] } | null>(null);
  /** 拖动开始；dragId = 这次拖动的编号（归并键）。返回 Alt + 拖复制出的节点数（非 Alt 复制为 0）。 */
  const startDrag = useCallback(
    (event: { altKey: boolean }, dragged: Node[], dragId: number): number => {
      altDrag.current = null;
      if (!event.altKey || !dragged.length) return 0;
      const before = boardRef.current;
      const ids = dragged.map((n) => n.id);
      // 副本按复制顺序追加在节点末尾，与 copySelection 选出的原节点一一对应。
      const originals = copySelection(before, ids).nodes;
      if (!originals.length) return 0;
      const r = apply({ kind: "duplicate", ids, drag: { id: dragId, copies: originals.length } });
      if (!r?.step) return 0;
      const had = new Set(before.nodes.map((n) => n.id));
      const copies = r.board.nodes.filter((n) => !had.has(n.id)).map((n) => n.id);
      altDrag.current = { pairs: originals.map((n, i) => [n.id, copies[i]]), starts: originals.map((n) => [n.id, n.pos]) };
      return originals.length;
    },
    [boardRef, apply],
  );
  const stopDrag = useCallback(
    (dragId: number) => {
      const pending = altDrag.current;
      altDrag.current = null;
      if (!pending) return;
      apply({ kind: "settleDrag", drag: { id: dragId, copies: pending.pairs.length }, pairs: pending.pairs, starts: pending.starts });
    },
    [apply],
  );

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
      apply({ kind: "duplicate", ids: [...selection.nodes.current], drag: null });
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
      const ids = [...selection.nodes.current];
      if (!delta || !ids.length) return;
      e.preventDefault();
      apply({ kind: "nudge", ids, delta });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wrapper, flow, store, selection, dialogOpen, apply]);

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
