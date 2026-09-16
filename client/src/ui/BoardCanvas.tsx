// 单个画板的画布：React Flow 视图完全由画板文件模型派生；选中、测量尺寸只在本地，不落盘。
import { ask, open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BOARD_EXTENSION, type Board, type BoardEdge, type KnownNode, type TaskNode } from "../core/board";
import { findModel, modelsByTier, type CapabilityTable, type InputImageRule } from "../core/capabilities";
import type { TaskStatus } from "../core/run";
import { availableModels, defaultTaskModel, modelAvailabilityIssue, type Discovery } from "../core/settings";
import {
  canConnect,
  connect,
  chainDepth,
  deletionBlocker,
  disconnect,
  forkPrompt,
  hasDownstreamRecords,
  imageEdges,
  moveImagePort,
  removeNodes,
  syncImagePorts,
  taskIssues,
  taskPorts,
  workflowOf,
  type Connection,
} from "../core/graph";
import { addAsReference, addAsReferenceTarget, continueEditing, copySelection, lineage, pasteClip, producerOf, type Clip } from "../core/iterate";
import { PROMPT_NODE_SIZE, TASK_NODE_SIZE } from "../core/layout";
import { basename, resolveFromRoot, toRootRelative } from "../core/paths";
import { findReferenceFile, findResultFile, IMAGE_EXTENSIONS, type RelocateFs } from "../core/relocate";
import { defaultSizeSpec } from "../core/size";
import { imageRefProblems, imageSources } from "../core/submission";
import { ipc } from "../shell/ipc";
import { BoardContext, primeImageInfo, useMissingImages, useStoredStatuses, type BoardActions } from "./context";
import { nodeTypes, type ImagePortInfo } from "./nodes";
import { isActive } from "./useRunner";

const relocateFs: RelocateFs = {
  listDir: ipc.listDir,
  exists: ipc.pathExists,
  sha256: async (path) => (await ipc.inspectImage(path)).sha256,
};

/** 复制粘贴的剪贴板：应用内共享，可粘到另一个画板（只带节点之间的连线，不跨画板连线）。 */
let clipboard: Clip | null = null;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

interface Props {
  board: Board;
  table: CapabilityTable;
  outputRoot: string;
  update: (fn: (board: Board) => Board) => void;
  openBoardPath: (path: string) => void;
  toast: (message: string) => void;
  discovery: Discovery;
  statuses: ReadonlyMap<string, TaskStatus>;
  /** 本次程序运行期间队列经手过的提交；其余无结果的提交按任务目录推导失败 / 已取消 / 已中断。 */
  handled: ReadonlySet<string>;
  /** 点「运行」：传当前选中的节点 id。 */
  onRun: (selectedIds: string[]) => void;
  onCancelTask: (taskId: string) => void;
  /** fromTaskId：生成变体时按该结果的任务目录重跑；缺省 = 按上次提交。 */
  onRegenerate: (taskId: string, fromTaskId?: string) => void;
  /** 运行指示跳转：居中并选中该节点；nonce 变化即再跳一次。 */
  focus: { nodeId: string; nonce: number } | null;
}

const LOCKED_HINT = "任务排队 / 执行中：模型、尺寸、开关、图片端口与连线已锁定";

const edgeId = (e: BoardEdge) => `${e.from.join(":")}->${e.to.join(":")}`;
const dims = (w: number | undefined, h: number | undefined) => ({ width: w, height: h });

function defaultModel(table: CapabilityTable): string | null {
  return modelsByTier(table)[0]?.models[0]?.model_id ?? null;
}

export function BoardCanvas({ board, table, outputRoot, update, openBoardPath, toast, discovery, statuses, handled, onRun, onCancelTask, onRegenerate, focus }: Props) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [measured, setMeasured] = useState<Record<string, { width?: number; height?: number }>>({});

  const updateBoard = useCallback((fn: (b: Board) => Board) => update((b) => syncImagePorts(fn(b))), [update]);

  const boardRef = useRef(board);
  boardRef.current = board;
  const selectedRef = useRef(selectedNodes);
  selectedRef.current = selectedNodes;
  const [focusPrompt, setFocusPrompt] = useState<string | null>(null);
  const missing = useMissingImages(board, outputRoot);

  const stored = useStoredStatuses(board, outputRoot, handled);
  const statusOf = useCallback((taskId: string): TaskStatus | null => statuses.get(taskId) ?? stored.get(taskId) ?? null, [statuses, stored]);
  // 排队 / 执行中的任务节点：参数与连线锁定，上游提示词仍可编辑（经三选）。
  const locked = useMemo(() => new Set([...statuses].filter(([, st]) => isActive(st)).map(([id]) => id)), [statuses]);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const actions = useMemo<BoardActions>(
    () => ({
      table,
      outputRoot,
      availableModels: availableModels(table, discovery),
      setTaskModel: (id, modelId) =>
        !lockedRef.current.has(id) &&
        updateBoard((b) => ({
          ...b,
          last_model: modelId,
          nodes: b.nodes.map((n) => (n.id === id && n.type === "task" ? { ...n, model: modelId } : n)),
        })),
      updateNode: (id, patch) =>
        updateBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === id && n.type !== "unknown" ? ({ ...n, ...patch } as KnownNode) : n)) })),
      moveImagePort: (taskId, from, to) => !lockedRef.current.has(taskId) && updateBoard((b) => ({ ...b, edges: moveImagePort(b, taskId, from, to) })),
      forkPrompt: (promptId, text) => updateBoard((b) => forkPrompt(b, promptId, { newNodeId: crypto.randomUUID(), text })),
      cancelTask: onCancelTask,
      regenerate: onRegenerate,
      continueEditing: (nodeId) => {
        const selected = selectedRef.current;
        const sources = selected.has(nodeId) ? [...selected] : [nodeId];
        const ids = { taskId: crypto.randomUUID(), promptId: crypto.randomUUID() };
        let problem: string | null = null;
        updateBoard((b) => {
          const r = continueEditing(b, table, discovery, sources, ids);
          if (r.ok) return r.board;
          problem = r.reason;
          return b;
        });
        if (problem) return toast(problem);
        setSelectedNodes(new Set([ids.promptId]));
        setFocusPrompt(ids.promptId);
      },
      addAsReference: (resultId) => {
        const target = addAsReferenceTarget(boardRef.current, [...selectedRef.current]);
        if (!target.ok) return toast(target.reason);
        if (lockedRef.current.has(target.taskId)) return toast(LOCKED_HINT);
        let problem: string | null = null;
        updateBoard((b) => {
          const r = addAsReference(b, table, resultId, target.taskId);
          if (r.ok) return r.board;
          problem = r.reason;
          return b;
        });
        if (problem) toast(problem);
      },
      generateVariant: (resultId) => {
        const b = boardRef.current;
        const result = b.nodes.find((n) => n.id === resultId);
        const parent = producerOf(b, resultId);
        if (result?.type !== "result" || !parent) return toast("父任务已删除，无法生成变体");
        onRegenerate(parent.id, result.task_id);
      },
      relocate: (nodeId, mode) =>
        void (async () => {
          const node = boardRef.current.nodes.find((n) => n.id === nodeId);
          if (node?.type !== "reference" && node?.type !== "result") return;
          let abs: string | null;
          if (mode === "pick") {
            const picked = await open({ multiple: false, filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }] });
            if (!picked) return;
            abs = picked;
          } else {
            abs =
              node.type === "result"
                ? await findResultFile(relocateFs, outputRoot, { task_id: node.task_id, file: node.file })
                : await findReferenceFile(relocateFs, outputRoot, { sha256: node.sha256, display_name: node.display_name });
            if (!abs) return toast(`在输出根目录内没有找到 ${node.type === "result" ? node.file : node.display_name}，可改为手动选择文件`);
          }
          const found = abs;
          try {
            const info = await ipc.inspectImage(found);
            primeImageInfo(found, info);
            const path = toRootRelative(outputRoot, found);
            // 参考图换了文件即换了身份（哈希变了，下游任务随之变脏）；结果的身份是 task_id + 文件名，只改路径。
            const patch = node.type === "reference" ? { path, sha256: info.sha256, display_name: mode === "pick" ? basename(found) : node.display_name } : { path };
            update((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId && n.type === node.type ? ({ ...n, ...patch } as KnownNode) : n)) }));
          } catch (e) {
            toast(`无法读取 ${basename(found)}：${e instanceof Error ? e.message : String(e)}`);
          }
        })(),
    }),
    [table, outputRoot, discovery, update, updateBoard, onCancelTask, onRegenerate, toast],
  );

  // 选中任一节点即高亮其谱系。
  const highlighted = useMemo(() => lineage(board, [...selectedNodes]), [board, selectedNodes]);

  const nodes = useMemo<Node[]>(() => {
    const fallback = defaultModel(table);
    const referenceTarget = addAsReferenceTarget(board, [...selectedNodes]);
    const labelOf = (id: string): ImagePortInfo => {
      const src = board.nodes.find((n) => n.id === id);
      if (src?.type === "reference") return { label: src.display_name, absPath: resolveFromRoot(outputRoot, src.path) };
      if (src?.type === "result") return { label: src.file, absPath: resolveFromRoot(outputRoot, src.path) };
      return { label: "?", absPath: null };
    };
    return board.nodes.flatMap((n): Node[] => {
      if (n.type === "unknown") return [];
      const base = {
        id: n.id,
        position: { x: n.pos[0], y: n.pos[1] },
        selected: selectedNodes.has(n.id),
        measured: measured[n.id],
        className: highlighted.nodes.has(n.id) ? "in-lineage" : undefined,
      };
      switch (n.type) {
        case "prompt":
          return [{ ...base, type: "prompt", data: { node: n, recorded: hasDownstreamRecords(board, n.id), autoFocus: focusPrompt === n.id } }];
        case "result": {
          const parent = producerOf(board, n.id);
          const variantBlocker = !parent ? "父任务已删除" : locked.has(parent.id) ? "父任务正在排队 / 执行" : null;
          return [{ ...base, type: "result", data: { node: n, missing: missing.has(n.id), referenceTarget, variantBlocker } }];
        }
        case "reference": {
          const downstream = board.edges.filter((e) => e.from[0] === n.id).map((e) => board.nodes.find((t) => t.id === e.to[0]));
          const modelIds = downstream.flatMap((t) => (t?.type === "task" ? [t.model] : []));
          const ids = modelIds.length ? [...new Set(modelIds)] : fallback ? [fallback] : [];
          const rules: InputImageRule[] = ids.flatMap((id) => {
            const rule = findModel(table, id)?.input_image_rule;
            return rule ? [rule] : [];
          });
          return [{ ...base, type: "reference", data: { node: n, rules, missing: missing.has(n.id) } }];
        }
        case "task": {
          const refs = imageRefProblems(board, n.id);
          const missingImages = imageSources(board, n.id, outputRoot).flatMap((src, i) => (missing.has(src.nodeId) ? [`图${i + 1} 图片缺失：${src.label}`] : []));
          return [
            {
              ...base,
              type: "task",
              data: {
                node: n,
                ports: taskPorts(board, table, n.id),
                issues: [...withAvailability(taskIssues(board, table, n.id), modelAvailabilityIssue(table, discovery, n.model)), ...refs.issues, ...missingImages],
                warnings: refs.warnings,
                unreferenced: refs.unreferenced,
                chainDepth: chainDepth(board, n.id),
                locked: locked.has(n.id),
                workflow: workflowOf(board, n.id),
                images: imageEdges(board, n.id).map((e) => labelOf(e.from[0])),
                hasPositive: board.edges.some((e) => e.to[0] === n.id && e.to[1] === "positive"),
                status: statusOf(n.id),
              },
            },
          ];
        }
      }
    });
  }, [board, table, outputRoot, selectedNodes, measured, statusOf, locked, discovery, highlighted, missing, focusPrompt]);

  const edges = useMemo<Edge[]>(
    () =>
      board.edges.map((e) => ({
        id: edgeId(e),
        source: e.from[0],
        sourceHandle: e.from[1],
        target: e.to[0],
        targetHandle: e.to[1],
        selected: selectedEdges.has(edgeId(e)),
        deletable: !e.system,
        selectable: !e.system,
        className: [e.system ? "edge-system" : e.to[1] === "negative" ? "edge-negative" : "", highlighted.edges.has(e) ? "edge-lineage" : ""].join(" ").trim() || undefined,
      })),
    [board.edges, selectedEdges, highlighted],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves = new Map<string, { x: number; y: number }>();
      for (const c of changes) {
        if (c.type === "position" && c.position) moves.set(c.id, c.position);
        else if (c.type === "dimensions" && c.dimensions) {
          const { width, height } = c.dimensions;
          setMeasured((m) => (m[c.id]?.width === width && m[c.id]?.height === height ? m : { ...m, [c.id]: dims(width, height) }));
        } else if (c.type === "select") {
          setSelectedNodes((s) => {
            if (s.has(c.id) === c.selected) return s;
            const next = new Set(s);
            if (c.selected) next.add(c.id);
            else next.delete(c.id);
            return next;
          });
        }
        // remove 由 onBeforeDelete / onDelete 统一处理。
      }
      if (moves.size) {
        update((b) => ({
          ...b,
          nodes: b.nodes.map((n) => {
            const p = n.type !== "unknown" && moves.get(n.id);
            return p ? { ...n, pos: [Math.round(p.x), Math.round(p.y)] as [number, number] } : n;
          }),
        }));
      }
    },
    [update],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const c of changes) {
      if (c.type !== "select") continue;
      setSelectedEdges((s) => {
        if (s.has(c.id) === c.selected) return s;
        const next = new Set(s);
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
        return next;
      });
    }
  }, []);

  const toConnection = (c: { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }): Connection => ({
    source: c.source,
    sourceHandle: c.sourceHandle ?? "",
    target: c.target,
    targetHandle: c.targetHandle ?? "",
  });

  const isValidConnection = useCallback(
    (c: Edge | { source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }) =>
      !locked.has(c.target) && canConnect(board, table, toConnection(c)).ok,
    [board, table, locked],
  );

  const onConnect = useCallback(
    (c: { source: string; sourceHandle: string | null; target: string; targetHandle: string | null }) => {
      const conn = toConnection(c);
      updateBoard((b) => {
        const verdict = canConnect(b, table, conn);
        if (!verdict.ok || lockedRef.current.has(conn.target)) return b;
        // 提示词连正向 / 负向即确定其角色；角色由连线端口体现，无需另存字段。
        return { ...b, edges: connect(b, conn) };
      });
    },
    [table, updateBoard],
  );

  // 拖到端口上却不合法时，告诉用户原因。
  const onConnectEnd = useCallback<OnConnectEnd>(
    (_event, state) => {
      if (state.isValid || !state.fromHandle || !state.toHandle || !state.fromNode || !state.toNode) return;
      const [src, dst] = state.fromHandle.type === "source" ? [state.fromHandle, state.toHandle] : [state.toHandle, state.fromHandle];
      if (locked.has(dst.nodeId)) return toast(LOCKED_HINT);
      const verdict = canConnect(board, table, { source: src.nodeId, sourceHandle: src.id ?? "", target: dst.nodeId, targetHandle: dst.id ?? "" });
      if (!verdict.ok) toast(verdict.reason);
    },
    [board, table, toast, locked],
  );

  const onBeforeDelete = useCallback(
    async ({ nodes: ns, edges: es }: { nodes: Node[]; edges: Edge[] }) => {
      const ids = ns.map((n) => n.id);
      const blocker = deletionBlocker(board, ids);
      if (blocker) {
        toast(blocker);
        return false;
      }
      const gone = new Set(ids);
      // 系统连线只能随节点一起消失，用户不能单独删。
      const userEdges = es.filter((e) => e.deletable !== false || gone.has(e.source) || gone.has(e.target));
      // 锁定任务的连线不能动（任务本身一起删除除外）。
      if (userEdges.some((e) => locked.has(e.target) && !gone.has(e.target))) {
        toast(LOCKED_HINT);
        return false;
      }
      const running = ids.filter((id) => locked.has(id));
      if (running.length) {
        const confirmed = await ask(`${running.length} 个任务正在排队 / 执行。先取消再删除？\n已在执行的只停止本地等待，网关侧计算可能仍在继续。`, {
          title: "删除任务节点",
          kind: "warning",
          okLabel: "取消并删除",
          cancelLabel: "不删除",
        });
        if (!confirmed) return false;
        running.forEach(onCancelTask);
      }
      return { nodes: ns, edges: userEdges };
    },
    [board, toast, locked, onCancelTask],
  );

  const onDelete = useCallback(
    ({ nodes: ns, edges: es }: { nodes: Node[]; edges: Edge[] }) => {
      const removedIds = new Set(es.map((e) => e.id));
      updateBoard((b) => {
        let next = b;
        const userRemoved = next.edges.filter((e) => removedIds.has(edgeId(e)) && !e.system);
        if (userRemoved.length) next = { ...next, edges: disconnect(next, userRemoved) };
        if (ns.length) next = removeNodes(next, ns.map((n) => n.id));
        return next;
      });
      setSelectedNodes(new Set());
      setSelectedEdges(new Set());
    },
    [updateBoard],
  );

  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      update((b) =>
        b.viewport.x === vp.x && b.viewport.y === vp.y && b.viewport.zoom === vp.zoom ? b : { ...b, viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } },
      );
    },
    [update],
  );

  useEffect(() => {
    if (!focus) return;
    const node = board.nodes.find((n) => n.id === focus.nodeId);
    if (!node || node.type === "unknown") return;
    const size = measured[node.id];
    void flow.setCenter(node.pos[0] + (size?.width ?? node.size[0]) / 2, node.pos[1] + (size?.height ?? node.size[1]) / 2, { zoom: Math.max(flow.getZoom(), 0.8), duration: 300 });
    setSelectedNodes(new Set([node.id]));
    // 只在跳转请求变化时执行。
  }, [focus]);

  const centerPosition = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2 - 120, y: rect.top + rect.height / 2 - 80 });
  }, [flow]);

  const addNode = useCallback(
    (node: KnownNode) => {
      update((b) => ({ ...b, nodes: [...b.nodes, node] }));
      setSelectedNodes(new Set([node.id]));
    },
    [update],
  );

  const addPrompt = () =>
    addNode({ type: "prompt", id: crypto.randomUUID(), pos: posOf(centerPosition()), size: PROMPT_NODE_SIZE, text: "", extra: {} });

  const addTask = () => {
    const modelId = defaultTaskModel(table, discovery, board.last_model);
    const model = modelId ? findModel(table, modelId) : undefined;
    if (!model) return toast("能力表中没有上架模型");
    const node: TaskNode = {
      type: "task",
      id: crypto.randomUUID(),
      pos: posOf(centerPosition()),
      size: TASK_NODE_SIZE,
      model: model.model_id,
      size_spec: defaultSizeSpec(model.workflows.text_to_image.size_rule),
      image_ports: 0,
      layer_decomposition: false,
      transparent_background: false,
      last_submitted: null,
      extra: {},
    };
    update((b) => ({ ...b, last_model: model.model_id, nodes: [...b.nodes, node] }));
    setSelectedNodes(new Set([node.id]));
  };

  const importReferences = useCallback(
    async (paths: string[], at: { x: number; y: number }) => {
      let offset = 0;
      for (const abs of paths) {
        try {
          const info = await ipc.inspectImage(abs);
          primeImageInfo(abs, info);
          addNode({
            type: "reference",
            id: crypto.randomUUID(),
            pos: posOf({ x: at.x + offset, y: at.y + offset }),
            size: [200, 220],
            path: toRootRelative(outputRoot, abs),
            sha256: info.sha256,
            display_name: basename(abs),
            extra: {},
          });
          offset += 32;
        } catch (e) {
          toast(`无法导入 ${basename(abs)}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
    [addNode, outputRoot, toast],
  );

  const pickReferences = async () => {
    const picked = await open({ multiple: true, filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }] });
    if (picked) await importReferences(Array.isArray(picked) ? picked : [picked], centerPosition());
  };

  // 通用复制粘贴：Ctrl/⌘+C 复制选中节点，Ctrl/⌘+V 粘贴（新节点整体偏移、从未提交过）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || isTyping(e.target) || !wrapper.current?.isConnected) return;
      const key = e.key.toLowerCase();
      if (key === "c" && selectedRef.current.size) {
        clipboard = copySelection(boardRef.current, [...selectedRef.current]);
      } else if (key === "v" && clipboard?.nodes.length) {
        e.preventDefault();
        const clip = clipboard;
        let pasted: string[] = [];
        updateBoard((b) => {
          const r = pasteClip(b, clip, () => crypto.randomUUID());
          pasted = r.ids;
          return r.board;
        });
        // 连续粘贴逐次错开。
        clipboard = { ...clip, nodes: clip.nodes.map((n) => ({ ...n, pos: [n.pos[0] + 40, n.pos[1] + 40] as [number, number] })) };
        setSelectedNodes(new Set(pasted));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [updateBoard]);

  // 从资源管理器拖入：画板文件打开为标签页，其余当参考图导入。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const { paths, position } = event.payload;
        const scale = window.devicePixelRatio || 1;
        const at = flow.screenToFlowPosition({ x: position.x / scale, y: position.y / scale });
        const boards = paths.filter((p) => p.toLowerCase().endsWith(BOARD_EXTENSION));
        boards.forEach(openBoardPath);
        const images = paths.filter((p) => !boards.includes(p));
        if (images.length) void importReferences(images, at);
      })
      .then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flow, importReferences, openBoardPath]);

  return (
    <BoardContext.Provider value={actions}>
      <div className="canvas" ref={wrapper}>
        <div className="toolbar">
          <button onClick={addPrompt}>＋ 提示词</button>
          <button onClick={addTask}>＋ 生成任务</button>
          <button onClick={() => void pickReferences()}>＋ 参考图…</button>
          <button className="primary" onClick={() => onRun([...selectedNodes])} title="有选中时只运行选中子图，否则运行整个画板中需要运行的任务">
            ▶ 运行{selectedNodes.size > 0 ? "选中" : ""}
          </button>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={board.viewport}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          isValidConnection={isValidConnection}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onBeforeDelete={onBeforeDelete}
          onDelete={onDelete}
          onMoveEnd={onMoveEnd}
          deleteKeyCode={["Delete", "Backspace"]}
          minZoom={0.1}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </BoardContext.Provider>
  );
}

function withAvailability(issues: string[], unavailable: string | null): string[] {
  return unavailable ? [...issues, unavailable] : issues;
}

function posOf(p: { x: number; y: number }): [number, number] {
  return [Math.round(p.x), Math.round(p.y)];
}
