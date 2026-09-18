// 单个画板的画布：React Flow 视图完全由画板文件模型派生；选中、测量尺寸只在本地，不落盘。
import { ask, open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Background,
  Controls,
  MiniMap,
  NodeToolbar,
  Position,
  ReactFlow,
  useConnection,
  useReactFlow,
  type ConnectionState,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BOARD_EXTENSION, type Board, type BoardEdge, type KnownNode, type ReferenceNode } from "../core/board";
import { findModel, modelsByTier, type CapabilityTable, type InputImageRule } from "../core/capabilities";
import type { TaskStatus } from "../core/run";
import { availableModels, defaultTaskModel, modelAvailabilityIssue, type Discovery } from "../core/settings";
import {
  canConnect,
  connect,
  disconnect,
  firstRegionOfEdge,
  forkPrompt,
  hasDownstreamRecords,
  imageEdges,
  imagePortIndex,
  imagePortSlots,
  moveImagePort,
  removeNodes,
  syncImagePorts,
  taskIssues,
  taskPorts,
  transparentAlphaIssue,
  workflowOf,
  type Connection,
} from "../core/graph";
import { menuItems, selectionForMenu, actionBarItems, type BoardAction, type MenuFacts, type MenuItem, type MenuTarget } from "../core/contextMenu";
import { attachReferences, cardDropConnection, dragCreateItems, newTask } from "../core/dragCreate";
import { edgeHoverInfo, textHoverInfo, type HoverInfo } from "../core/hoverInfo";
import { connectablePorts, dragKind, edgeClassName, nodeClassName, promptPortKind, type DragFrom, type DragState } from "../core/ports";
import { countLabel, nodeEditChange, type Change, type UserChange } from "../core/history";
import { addAsReference, addAsReferenceTarget, continueEditing, copySelection, lineage, LOCKED_HINT, pasteClip, PASTE_OFFSET, producerOf, type Clip, type Outcome } from "../core/iterate";
import { PROMPT_NODE_SIZE } from "../core/layout";
import { IMAGE_NODE_WIDTH, imageNodeSize, renderedImageSize } from "../core/nodeSize";
import { placePreset, type Preset } from "../core/presets";
import { basename, dirname, joinPath, resolveFromRoot, toRootRelative } from "../core/paths";
import { effectiveRegionRender, setEdgeRegion } from "../core/region";
import { findReferenceFile, findResultFile, IMAGE_EXTENSIONS, type RelocateFs } from "../core/relocate";
import { imageRefProblems, imageSources, type SnapshotImage } from "../core/submission";
import { ipc } from "../shell/ipc";
import { logEvent } from "../shell/log";
import { saveCopyAs } from "../shell/saveFile";
import { ActionBar } from "./ActionBar";
import { ContextMenu } from "./ContextMenu";
import { PresetDialog } from "./PresetDialog";
import { BoardContext, primeImageInfo, useImageInfos, useMissingImages, useStoredStatuses, type BoardActions } from "./context";
import { edgeTypes } from "./edges";
import { HoverButton, HoverProvider, useHoverLayer } from "./hoverInfo";
import { ModelOptions, nodeTypes, type ImagePortInfo, type ImageSlotInfo } from "./nodes";
import { DragContext } from "./ports";
import { PreviewDialog, type PreviewRequest, type RegionTarget } from "./PreviewDialog";
import { isTyping, useCanvasInteraction, type Selection } from "./useCanvasInteraction";
import { isActive } from "./useRunner";

const relocateFs: RelocateFs = {
  listDir: ipc.listDir,
  isFile: ipc.isFile,
  sha256: async (path) => (await ipc.inspectImage(path)).sha256,
};

/** 复制粘贴的剪贴板：应用内共享，可粘到另一个画板（只带节点之间的连线，不跨画板连线）。 */
let clipboard: Clip | null = null;

interface Props {
  board: Board;
  /** 画板文件名，只用于日志。 */
  boardFile: string;
  table: CapabilityTable;
  outputRoot: string;
  /** 画板变更；change = 步描述（用户步）或 system / view（不进撤销历史）。 */
  update: (fn: (board: Board) => Board, change: Change) => void;
  /** 撤销 / 重做一步：传排队 / 执行中的任务节点 id（按当前状态保留）。 */
  onUndo: (locked: ReadonlySet<string>) => void;
  onRedo: (locked: ReadonlySet<string>) => void;
  /** 可撤销 / 可重做的那一步的描述；无则为 null。 */
  undoLabel: string | null;
  redoLabel: string | null;
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
  /** 任务节点「查看发送文本」。 */
  onViewSendText: (taskId: string) => void;
  /** 导出本画板为画板包。 */
  onExportPack: () => void;
  /** 运行指示跳转：居中并选中该节点；nonce 变化即再跳一次。 */
  focus: { nodeId: string; nonce: number } | null;
}

const edgeId = (e: BoardEdge) => `${e.from.join(":")}->${e.to.join(":")}`;
const dims = (w: number | undefined, h: number | undefined) => ({ width: w, height: h });

function defaultModel(table: CapabilityTable): string | null {
  return modelsByTier(table)[0]?.models[0]?.model_id ?? null;
}

export function BoardCanvas({
  board,
  boardFile,
  table,
  outputRoot,
  update,
  onUndo,
  onRedo,
  undoLabel,
  redoLabel,
  openBoardPath,
  toast,
  discovery,
  statuses,
  handled,
  onRun,
  onCancelTask,
  onRegenerate,
  onViewSendText,
  onExportPack,
  focus,
}: Props) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(new Set());
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [measured, setMeasured] = useState<Record<string, { width?: number; height?: number }>>({});

  const updateBoard = useCallback((fn: (b: Board) => Board, change: UserChange) => update((b) => syncImagePorts(fn(b)), change), [update]);

  /** 应用一次可能被拒的画板变更；被拒时提示原因。返回是否已应用（会话不可编辑时也为 false）。 */
  const applyOutcome = useCallback(
    (fn: (b: Board) => Outcome, change: UserChange) => {
      let applied = false;
      let problem: string | null = null;
      updateBoard((b) => {
        const r = fn(b);
        if (!r.ok) {
          problem = r.reason;
          return b;
        }
        applied = true;
        return r.board;
      }, change);
      if (problem) toast(problem);
      return applied;
    },
    [updateBoard, toast],
  );

  const boardRef = useRef(board);
  boardRef.current = board;
  const selectedRef = useRef(selectedNodes);
  selectedRef.current = selectedNodes;
  // 撤销 / 重做会让选中的节点消失：丢掉不在画板上的选中，免得「运行选中」与复制落在空集上。
  useEffect(() => {
    const present = new Set(board.nodes.map((n) => n.id));
    setSelectedNodes((s) => ([...s].every((id) => present.has(id)) ? s : new Set([...s].filter((id) => present.has(id)))));
  }, [board.nodes]);
  const selectedEdgesRef = useRef(selectedEdges);
  selectedEdgesRef.current = selectedEdges;
  const [focusPrompt, setFocusPrompt] = useState<string | null>(null);
  const missing = useMissingImages(board, outputRoot);
  const [preview, setPreview] = useState<{ req: PreviewRequest; nonce: number } | null>(null);
  // 上下文菜单：client = 弹出处的窗口坐标，at = 同一点的画布坐标（新建节点落点）。
  const [menu, setMenu] = useState<{ target: MenuTarget; client: { x: number; y: number }; at: { x: number; y: number } } | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    setDragMenu(null);
  }, []);
  /** 拖线建节点多候选时弹的菜单（目前三种起点均为单候选，此路径预留）。 */
  const [dragMenu, setDragMenu] = useState<{ from: DragFrom; items: MenuItem[]; client: { x: number; y: number }; at: { x: number; y: number } } | null>(null);
  // 预设 / 预览弹窗、上下文菜单开着时快捷键不作用于背后的画板（菜单自己处理 Esc）。
  const dialogOpen = presetsOpen || preview !== null || menu !== null || dragMenu !== null;
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = dialogOpen;
  /** 设置原地展开的任务节点：只在本地，不存盘。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const hover = useHoverLayer();
  // 撤销 / 删除后不在画板上的任务不留展开状态。
  useEffect(() => {
    const present = new Set(board.nodes.map((n) => n.id));
    setExpanded((s) => ([...s].every((id) => present.has(id)) ? s : new Set([...s].filter((id) => present.has(id)))));
  }, [board.nodes]);
  const selection = useMemo<Selection>(() => ({ nodes: selectedRef, edges: selectedEdgesRef, setNodes: setSelectedNodes, setEdges: setSelectedEdges }), []);
  const nav = useCanvasInteraction({ wrapper, boardRef, selection, dialogOpen: dialogOpenRef, updateBoard });
  const previewNonce = useRef(0);

  // 每个图片源节点的透明通道（导入 / 定位时已有缓存，未读的批量补读）；未知不进入 Map。
  const imageNodes = useMemo(() => board.nodes.filter((n) => n.type === "reference" || n.type === "result"), [board.nodes]);
  const imageAbsPaths = useMemo(() => imageNodes.map((n) => resolveFromRoot(outputRoot, n.path)), [imageNodes, outputRoot]);
  const imageInfos = useImageInfos(imageAbsPaths);
  const alphaByNode = useMemo(() => {
    const map = new Map<string, boolean>();
    imageNodes.forEach((n, i) => {
      const info = imageInfos.get(imageAbsPaths[i]);
      if (info) map.set(n.id, info.has_alpha);
    });
    return map;
  }, [imageNodes, imageAbsPaths, imageInfos]);

  /** 参考图 / 结果节点扇出到「支持区域指示」任务的图片线，作为弹窗里可编辑区域的目标。 */
  const regionTargetsOf = useCallback(
    (nodeId: string): RegionTarget[] =>
      boardRef.current.edges.flatMap((e) => {
        if (e.from[0] !== nodeId || imagePortIndex(e.to[1]) === null) return [];
        const task = boardRef.current.nodes.find((n) => n.id === e.to[0]);
        if (task?.type !== "task") return [];
        const render = effectiveRegionRender(findModel(table, task.model));
        if (!render) return [];
        const port = imagePortIndex(e.to[1])! + 1;
        const modelName = findModel(table, task.model)?.display_name ?? task.model;
        const firstRegion = firstRegionOfEdge(boardRef.current, task.id, e.to[1]);
        return [{ label: `${modelName} 的图${port}`, edgeRef: { from: e.from, to: e.to }, rects: e.region?.rects ?? [], render, firstRegion }];
      }),
    [table],
  );

  const openNodePreview = useCallback(
    (nodeId: string) => {
      const node = boardRef.current.nodes.find((n) => n.id === nodeId);
      if (node?.type !== "reference" && node?.type !== "result") return;
      const abs = resolveFromRoot(outputRoot, node.path);
      const recordLayers = node.type === "result" ? (node.record.layers ?? []) : [];
      // 本次编辑用到的区域轮廓：产出任务的提交快照（任务已删 / 快照无区域 = 没有可回显的轮廓）。
      const producer = node.type === "result" ? producerOf(boardRef.current, node.id) : undefined;
      const snapshotImages = (producer?.last_submitted as { images?: SnapshotImage[] } | null)?.images ?? [];
      const regionOutlines = snapshotImages.flatMap((img) => img.region?.rects ?? []);
      const req: PreviewRequest = {
        title: node.type === "reference" ? node.display_name : node.file,
        absPath: abs,
        layers: recordLayers.map((record) => ({ record, absPath: joinPath(dirname(abs), record.file) })),
        resultId: node.type === "result" ? node.id : undefined,
        regionTargets: regionTargetsOf(nodeId),
        regionOutlines,
      };
      setPreview({ req, nonce: ++previewNonce.current });
    },
    [outputRoot, regionTargetsOf],
  );

  const stored = useStoredStatuses(board, boardFile, outputRoot, handled);
  const statusOf = useCallback((taskId: string): TaskStatus | null => statuses.get(taskId) ?? stored.get(taskId) ?? null, [statuses, stored]);
  // 排队 / 执行中的任务节点：参数与连线锁定，上游提示词仍可编辑（经三选）。
  const locked = useMemo(() => new Set([...statuses].filter(([, st]) => isActive(st)).map(([id]) => id)), [statuses]);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // perform 依赖每次渲染重建的新建类函数，经 ref 取最新一版，actions 保持稳定。
  const performRef = useRef<BoardActions["perform"]>(() => {});
  const actions = useMemo<BoardActions>(
    () => ({
      perform: (action, target, at) => performRef.current(action, target, at),
      table,
      outputRoot,
      availableModels: availableModels(table, discovery),
      setTaskModel: (id, modelId) =>
        !lockedRef.current.has(id) &&
        updateBoard(
          (b) => ({
            ...b,
            last_model: modelId,
            nodes: b.nodes.map((n) => (n.id === id && n.type === "task" ? { ...n, model: modelId } : n)),
          }),
          { label: "切换模型" },
        ),
      updateNode: (id, patch) =>
        updateBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === id && n.type !== "unknown" ? ({ ...n, ...patch } as KnownNode) : n)) }), nodeEditChange(id, patch)),
      moveImagePort: (taskId, from, to) =>
        !lockedRef.current.has(taskId) && updateBoard((b) => ({ ...b, edges: moveImagePort(b, taskId, from, to) }), { label: "调整图片顺序" }),
      forkPrompt: (promptId, text) => updateBoard((b) => forkPrompt(b, promptId, { newNodeId: crypto.randomUUID(), text }), { label: "分叉提示词" }),
      continueEditing: (nodeId, sourceLayer = null, at) => {
        const selected = selectedRef.current;
        // 拖线建节点（带 at）只拖出一根线，只接这一张图；按钮 / 菜单发起时在选区内沿用多选。
        const sources = !at && selected.has(nodeId) ? [...selected] : [nodeId];
        const ids = { taskId: crypto.randomUUID(), promptId: crypto.randomUUID() };
        const sourceLayers = sourceLayer === null ? null : new Map([[nodeId, sourceLayer]]);
        const taskAt = at ? posOf(at) : null;
        if (!applyOutcome((b) => continueEditing(b, table, discovery, sources, nodeId, ids, sourceLayers, taskAt), { label: "以此继续编辑" })) return;
        setSelectedNodes(new Set([ids.promptId]));
        setFocusPrompt(ids.promptId);
      },
      addAsReference: (resultId, sourceLayer = null) => {
        const target = addAsReferenceTarget(boardRef.current, [...selectedRef.current]);
        if (!target.ok) return toast(target.reason);
        if (lockedRef.current.has(target.taskId)) return toast(LOCKED_HINT);
        applyOutcome((b) => addAsReference(b, table, resultId, target.taskId, sourceLayer), { label: "加为参考图" });
      },
      setEdgeRegion: (ref, region) => {
        if (lockedRef.current.has(ref.to[0])) return toast(LOCKED_HINT);
        updateBoard((b) => setEdgeRegion(b, ref, region), { label: region ? "框选修改区域" : "清除修改区域" });
      },
      previewNode: openNodePreview,
      editRegion: (taskId, ref) => {
        if (lockedRef.current.has(taskId)) return toast(LOCKED_HINT);
        const target = regionTargetsOf(ref.from[0]).find((t) => t.edgeRef.to[0] === taskId && t.edgeRef.to[1] === ref.to[1]);
        if (!target) return toast("当前模型不支持框选修改区域");
        const src = boardRef.current.nodes.find((n) => n.id === ref.from[0]);
        if (src?.type !== "reference" && src?.type !== "result") return;
        const name = src.type === "reference" ? src.display_name : src.file;
        const req: PreviewRequest = {
          title: `框选修改区域 · ${name}`,
          absPath: resolveFromRoot(outputRoot, src.path),
          edit: target,
          regionTargets: [target],
        };
        setPreview({ req, nonce: ++previewNonce.current });
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
          const logRelocate = (outcome: { ok: true } | { ok: false; reason: "not_found" | "unreadable" }) =>
            logEvent("relocate", { board_file: boardFile, node_id: nodeId, node_type: node.type, mode, ...outcome });
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
            if (!abs) {
              logRelocate({ ok: false, reason: "not_found" });
              return toast(`在输出根目录内没有找到 ${node.type === "result" ? node.file : node.display_name}，可改为手动选择文件`);
            }
          }
          const found = abs;
          try {
            const info = await ipc.inspectImage(found);
            primeImageInfo(found, info);
            const path = toRootRelative(outputRoot, found);
            // 参考图换了文件即换了身份（哈希变了，下游任务随之变脏）；结果的身份是 task_id + 文件名，只改路径。
            const patch = node.type === "reference" ? { path, sha256: info.sha256, display_name: mode === "pick" ? basename(found) : node.display_name } : { path };
            update((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === nodeId && n.type === node.type ? ({ ...n, ...patch } as KnownNode) : n)) }), {
              label: "重新定位图片",
            });
            logRelocate({ ok: true });
          } catch (e) {
            logRelocate({ ok: false, reason: "unreadable" });
            toast(`无法读取 ${basename(found)}：${e instanceof Error ? e.message : String(e)}`);
          }
        })(),
    }),
    [table, boardFile, outputRoot, discovery, update, updateBoard, applyOutcome, onCancelTask, onRegenerate, toast, openNodePreview, regionTargetsOf],
  );

  // 选中任一节点即高亮其谱系。
  const highlighted = useMemo(() => lineage(board, [...selectedNodes]), [board, selectedNodes]);

  const menuFacts = useCallback(
    (selected: ReadonlySet<string>): MenuFacts => ({ board, table, selected, locked, expanded, undoLabel, redoLabel }),
    [board, table, locked, expanded, undoLabel, redoLabel],
  );

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

  // 拖线态：起点来自 useConnection，合法落点与 isValidConnection 同一判定。
  const dragFrom = useConnection(dragFromOf);
  const drag = useMemo<DragState | null>(() => (dragFrom ? { from: dragFrom, ports: connectablePorts(board, dragFrom, isValidConnection) } : null), [dragFrom, board, isValidConnection]);

  const nodes = useMemo<Node[]>(() => {
    const fallback = defaultModel(table);
    const labelOf = (id: string): ImagePortInfo => {
      const src = board.nodes.find((n) => n.id === id);
      if (src?.type === "reference") return { label: src.display_name, absPath: resolveFromRoot(outputRoot, src.path) };
      if (src?.type === "result") return { label: src.file, absPath: resolveFromRoot(outputRoot, src.path) };
      return { label: "?", absPath: null };
    };
    const downstreamModels = (id: string) => {
      const tasks = board.edges.filter((e) => e.from[0] === id).map((e) => board.nodes.find((t) => t.id === e.to[0]));
      return [...new Set(tasks.flatMap((t) => (t?.type === "task" ? [t.model] : [])))];
    };
    const rulesOf = (modelIds: string[]): InputImageRule[] => modelIds.flatMap((id) => findModel(table, id)?.input_image_rule ?? []);
    return board.nodes.flatMap((n): Node[] => {
      if (n.type === "unknown") return [];
      const base = {
        id: n.id,
        position: { x: n.pos[0], y: n.pos[1] },
        selected: selectedNodes.has(n.id),
        measured: measured[n.id],
        className: nodeClassName(n.id, { lineage: highlighted.nodes.has(n.id), selecting: selectedNodes.size > 0, drag }) || undefined,
      };
      // 图片节点按存的宽度与图片比例显示（不回写 size）；缺图时高度随占位内容。
      const imageBox = (path: string) => {
        const [width, height] = renderedImageSize(n.size, imageInfos.get(resolveFromRoot(outputRoot, path)));
        return missing.has(n.id) ? { width } : { width, height };
      };
      switch (n.type) {
        case "prompt":
          return [{ ...base, type: "prompt", data: { node: n, recorded: hasDownstreamRecords(board, n.id), autoFocus: focusPrompt === n.id, portKind: promptPortKind(board, n.id) } }];
        case "result":
          // 结果回灌到任务上才按下游模型规则提示；没接任务不提示。
          return [{ ...base, ...imageBox(n.path), type: "result", data: { node: n, rules: rulesOf(downstreamModels(n.id)), missing: missing.has(n.id) } }];
        case "reference": {
          const modelIds = downstreamModels(n.id);
          const rules = rulesOf(modelIds.length ? modelIds : fallback ? [fallback] : []);
          return [{ ...base, ...imageBox(n.path), type: "reference", data: { node: n, rules, missing: missing.has(n.id) } }];
        }
        case "task": {
          const refs = imageRefProblems(board, table, n.id);
          const missingImages = imageSources(board, n.id, outputRoot).flatMap((src, i) => (missing.has(src.nodeId) ? [`图${i + 1} 图片缺失：${src.label}`] : []));
          const taskEdges = imageEdges(board, n.id);
          const render = effectiveRegionRender(findModel(table, n.model));
          const slots: ImageSlotInfo[] = imagePortSlots(board, table, n.id).map((s) => {
            const src = labelOf(s.edge.from[0]);
            return s.kind === "overlay"
              ? { kind: "overlay" as const, port: s.port, userPort: s.userPort, label: src.label, absPath: null, handleIndex: null, rects: [], firstRegion: 0, edgeRef: null }
              : {
                  kind: "image" as const,
                  port: s.port,
                  userPort: s.userPort,
                  label: src.label,
                  absPath: src.absPath,
                  handleIndex: imagePortIndex(s.edge.to[1]),
                  rects: s.edge.region?.rects ?? [],
                  firstRegion: firstRegionOfEdge(board, n.id, s.edge.to[1]),
                  edgeRef: { from: s.edge.from, to: s.edge.to },
                };
          });
          const alphaIssue = transparentAlphaIssue(board, n.id, taskEdges.length === 1 ? alphaByNode.get(taskEdges[0].from[0]) : undefined);
          return [
            {
              ...base,
              type: "task",
              data: {
                node: n,
                ports: taskPorts(board, table, n.id),
                issues: [
                  ...withAvailability(taskIssues(board, table, n.id), modelAvailabilityIssue(table, discovery, n.model)),
                  ...(alphaIssue ? [alphaIssue] : []),
                  ...refs.issues,
                  ...missingImages,
                ],
                warnings: refs.warnings,
                unreferenced: refs.unreferenced,
                locked: locked.has(n.id),
                workflow: workflowOf(board, n.id),
                images: taskEdges.map((e) => labelOf(e.from[0])),
                slots,
                regionRender: render,
                hasPositive: board.edges.some((e) => e.to[0] === n.id && e.to[1] === "positive"),
                status: statusOf(n.id),
                expanded: expanded.has(n.id),
                run: menuItems({ kind: "node", nodeId: n.id }, menuFacts(new Set([n.id]))).find((i) => i.action === "run")!,
              },
            },
          ];
        }
      }
    });
  }, [board, table, outputRoot, selectedNodes, measured, statusOf, locked, discovery, highlighted, missing, focusPrompt, alphaByNode, imageInfos, expanded, menuFacts, drag]);

  const dragging = drag !== null;
  const edges = useMemo<Edge[]>(
    () =>
      board.edges.map((e) => ({
        id: edgeId(e),
        source: e.from[0],
        sourceHandle: e.from[1],
        target: e.to[0],
        targetHandle: e.to[1],
        selected: selectedEdges.has(edgeId(e)),
        label: (e.region?.rects.length ?? 0) > 0 ? `${e.region!.rects.length} 区域` : undefined,
        deletable: !e.system,
        selectable: !e.system,
        className: edgeClassName(e, { lineage: highlighted.edges.has(e), selecting: selectedNodes.size > 0, dragging: dragging }),
        data: { hover: edgeHoverInfo(e) },
      })),
    [board.edges, selectedEdges, selectedNodes, highlighted, dragging],
  );

  /** 进行中的拖动编号（0 = 没在拖）；每次拖动一个新合并键。 */
  const activeDrag = useRef(0);
  const dragCounter = useRef(0);
  /** Alt + 拖复制时这次拖动的步描述（复制与移动合为一步）。 */
  const dragLabel = useRef<string | null>(null);
  const onDragStart = useCallback(
    (event: MouseEvent | TouchEvent | React.MouseEvent, ...rest: [Node, Node[]] | [Node[]]) => {
      activeDrag.current = ++dragCounter.current;
      dragLabel.current = nav.startDrag(event, rest.length === 2 ? rest[1] : rest[0], `drag:${activeDrag.current}`);
    },
    [nav.startDrag],
  );
  const onDragStop = useCallback(() => {
    nav.stopDrag();
    activeDrag.current = 0;
    dragLabel.current = null;
  }, [nav.stopDrag]);

  /** 进行中的拖角缩放编号（0 = 没在缩放）；一次缩放从按下到松开合为一步。 */
  const activeResize = useRef(0);
  const resizeCounter = useRef(0);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const moves = new Map<string, { x: number; y: number }>();
      const resized = new Map<string, { width: number; height: number }>();
      nav.selectNodes(changes.flatMap((c) => (c.type === "select" ? [c] : [])));
      for (const c of changes) {
        if (c.type === "position" && c.position) moves.set(c.id, c.position);
        else if (c.type === "dimensions" && c.dimensions) {
          const { width, height } = c.dimensions;
          setMeasured((m) => (m[c.id]?.width === width && m[c.id]?.height === height ? m : { ...m, [c.id]: dims(width, height) }));
          // NodeResizer 拖动中带 resizing: true，松开时报一次 resizing: false；普通测量不带 resizing。
          if (c.resizing) resized.set(c.id, c.dimensions);
          else if (c.resizing === false) activeResize.current = 0;
        }
        // remove 由 onBeforeDelete / onDelete 统一处理。
      }
      if (resized.size) {
        // 从左 / 上角缩放时同一批带位置变更：与尺寸一起写，不另算移动。
        activeResize.current ||= ++resizeCounter.current;
        const at = new Map([...resized.keys()].flatMap((id) => (moves.has(id) ? [[id, moves.get(id)!] as const] : [])));
        resized.forEach((_, id) => moves.delete(id));
        update((b) => {
          let changed = false;
          const nodes = b.nodes.map((n) => {
            const box = resized.get(n.id);
            if (!box || n.type === "unknown") return n;
            const p = at.get(n.id);
            const pos: [number, number] = p ? [Math.round(p.x), Math.round(p.y)] : n.pos;
            const size = imageNodeSize(box.width, box.height / box.width);
            if (pos[0] === n.pos[0] && pos[1] === n.pos[1] && size[0] === n.size[0] && size[1] === n.size[1]) return n;
            changed = true;
            return { ...n, pos, size };
          });
          return changed ? { ...b, nodes } : b;
        }, { label: countLabel("缩放", resized.size), merge: { key: `resize:${activeResize.current}` } });
      }
      if (moves.size) {
        // 一次拖动（含多选、Alt + 拖复制）从开始到 onNodeDragStop 合为一步；方向键微移不经这里（useCanvasInteraction）。
        const drag = activeDrag.current;
        const change: UserChange = drag
          ? { label: dragLabel.current ?? countLabel("移动", moves.size), merge: { key: `drag:${drag}` } }
          : { label: countLabel("移动", moves.size) };
        update((b) => {
          let changed = false;
          const nodes = b.nodes.map((n) => {
            const p = n.type !== "unknown" && moves.get(n.id);
            if (!p || (n.pos[0] === Math.round(p.x) && n.pos[1] === Math.round(p.y))) return n;
            changed = true;
            return { ...n, pos: [Math.round(p.x), Math.round(p.y)] as [number, number] };
          });
          return changed ? { ...b, nodes } : b;
        }, change);
      }
    },
    [update, nav.selectNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => nav.selectEdges(changes.flatMap((c) => (c.type === "select" ? [c] : []))),
    [nav.selectEdges],
  );

  const onConnect = useCallback(
    (c: { source: string; sourceHandle: string | null; target: string; targetHandle: string | null }) => {
      const conn = toConnection(c);
      updateBoard((b) => {
        const verdict = canConnect(b, table, conn);
        if (!verdict.ok || lockedRef.current.has(conn.target)) return b;
        // 提示词连正向 / 负向即确定其角色；角色由连线端口体现，无需另存字段。
        return { ...b, edges: connect(b, conn) };
      }, { label: "连线" });
    },
    [table, updateBoard],
  );

  const performDragCreateRef = useRef<(action: BoardAction, from: DragFrom, at: { x: number; y: number }) => void>(() => {});

  // 松手：落在端口上却不合法时告诉原因；落在任务卡片上（非端口）接到下一个空端口；落在空白处建节点（拖线建节点）。
  const onConnectEnd = useCallback<OnConnectEnd>(
    (event, state) => {
      if (state.isValid || !state.fromHandle) return;
      if (state.toHandle && state.fromNode && state.toNode) {
        const [src, dst] = state.fromHandle.type === "source" ? [state.fromHandle, state.toHandle] : [state.toHandle, state.fromHandle];
        if (locked.has(dst.nodeId)) return toast(LOCKED_HINT);
        const verdict = canConnect(board, table, { source: src.nodeId, sourceHandle: src.id ?? "", target: dst.nodeId, targetHandle: dst.id ?? "" });
        if (!verdict.ok) toast(verdict.reason);
        return;
      }
      const from: DragFrom = { nodeId: state.fromHandle.nodeId, handleId: state.fromHandle.id ?? "", type: state.fromHandle.type };
      const client = clientPointOf(event);
      const hit = dropTargetAt(client);
      if (hit?.kind === "node") {
        const r = cardDropConnection(board, table, from, hit.nodeId, locked);
        if (!r) return;
        if (!r.ok) return toast(r.reason);
        return onConnect(r.connection);
      }
      if (hit?.kind !== "pane") return;
      const items = dragCreateItems(board, from);
      const at = flow.screenToFlowPosition(client);
      if (items.length === 1) performDragCreateRef.current(items[0].action, from, at);
      else if (items.length > 1) setDragMenu({ from, items, client, at });
    },
    [board, table, toast, locked, flow, onConnect],
  );

  const onBeforeDelete = useCallback(
    async ({ nodes: ns, edges: es }: { nodes: Node[]; edges: Edge[] }) => {
      const ids = ns.map((n) => n.id);
      // 删除不设禁删、一般不弹确认（靠撤销兜底），只有删排队 / 执行中的任务节点要确认先取消；gone 含级联删除的结果列。
      const gone = new Set(removeNodes(board, ids).removedIds);
      // 系统连线只能随节点一起消失，用户不能单独删。
      const userEdges = es.filter((e) => e.deletable !== false || gone.has(e.source) || gone.has(e.target));
      // 锁定任务的输入连线不能动（运行期锁定；任务本身一起删除除外），级联断开的也算。
      const seversLocked = board.edges.some((e) => !e.system && gone.has(e.from[0]) && locked.has(e.to[0]) && !gone.has(e.to[0]));
      if (seversLocked || userEdges.some((e) => locked.has(e.target) && !gone.has(e.target))) {
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
      const nodeIds = ns.map((n) => n.id);
      // React Flow 报来的连线含与被删节点相连的；toast 的节点数与断开条数按删除前的画板只数节点删除。
      const removal = removeNodes(boardRef.current, nodeIds);
      const removed = removal.removedIds.length;
      const label = ns.length ? countLabel("删除", removed) : countLabel("断开", es.length, "条连线");
      updateBoard((b) => {
        const userRemoved = b.edges.filter((e) => removedIds.has(edgeId(e)) && !e.system);
        const next = userRemoved.length ? { ...b, edges: disconnect(b, userRemoved) } : b;
        return nodeIds.length ? removeNodes(next, nodeIds).board : next;
      }, { label });
      if (ns.length) toast(`已删除 ${removed} 个节点${removal.severed ? `、断开 ${removal.severed} 条连线` : ""}，Ctrl+Z 撤销`);
      setSelectedNodes(new Set());
      setSelectedEdges(new Set());
    },
    [updateBoard, toast],
  );

  const onMoveEnd = useCallback(
    (_: unknown, vp: Viewport) => {
      update((b) =>
        b.viewport.x === vp.x && b.viewport.y === vp.y && b.viewport.zoom === vp.zoom ? b : { ...b, viewport: { x: vp.x, y: vp.y, zoom: vp.zoom } },
        "view",
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
    (node: KnownNode, change: UserChange) => {
      update((b) => ({ ...b, nodes: [...b.nodes, node] }), change);
      setSelectedNodes(new Set([node.id]));
    },
    [update],
  );

  // 新建类动作：at = 节点左上角的画布坐标（上下文菜单的点击处）；缺省 = 视口中央（工具栏）。
  const addPrompt = (at = centerPosition()) =>
    addNode({ type: "prompt", id: crypto.randomUUID(), pos: posOf(at), size: PROMPT_NODE_SIZE, text: "", extra: {} }, { label: "新建提示词" });

  const applyPreset = (preset: Preset) => {
    // 先在空画板上落好节点再并入：更新函数可能延后执行，选中的 id 要先定下来。
    const { board: placed, nodeIds } = placePreset({ ...board, nodes: [] }, preset, posOf(centerPosition()), () => crypto.randomUUID());
    update((b) => ({ ...b, nodes: [...b.nodes, ...placed.nodes] }), { label: `使用预设「${preset.name}」` });
    setSelectedNodes(new Set(nodeIds));
    setPresetsOpen(false);
  };

  /** promptId = 从该提示词拖出（拖线建节点），接新任务的正向端口，与建节点同一步。 */
  const addTask = (at = centerPosition(), promptId?: string) => {
    const id = crypto.randomUUID();
    if (applyOutcome((b) => newTask(b, table, discovery, id, posOf(at), promptId), { label: "新建生成任务" })) setSelectedNodes(new Set([id]));
  };

  /**
   * 导入参考图。attach = 同时接到该任务的下一个空图片端口（拖线建节点 / OS 文件拖到任务卡片上），
   * place 见 attachReferences；建节点与接线同一步。
   */
  const importReferences = useCallback(
    async (paths: string[], at: { x: number; y: number }, attach?: { taskId: string; place: "asIs" | "left" }) => {
      // 先逐张读取，再一次加到画板：一次导入是一步，张数只算读取成功的，读取期间的其他操作不会把它拆开。
      const nodes: ReferenceNode[] = [];
      for (const abs of paths) {
        try {
          const info = await ipc.inspectImage(abs);
          primeImageInfo(abs, info);
          const offset = 32 * nodes.length;
          nodes.push({
            type: "reference",
            id: crypto.randomUUID(),
            pos: posOf({ x: at.x + offset, y: at.y + offset }),
            size: imageNodeSize(IMAGE_NODE_WIDTH, info.width > 0 ? info.height / info.width : 1),
            path: toRootRelative(outputRoot, abs),
            sha256: info.sha256,
            display_name: basename(abs),
            extra: {},
          });
        } catch (e) {
          toast(`无法导入 ${basename(abs)}：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!nodes.length) return;
      const change = { label: countLabel("添加", nodes.length, "张参考图") };
      if (attach) {
        let problem: string | null = null;
        updateBoard((b) => {
          const r = attachReferences(b, table, nodes, attach.taskId, lockedRef.current, attach.place);
          problem = r.reason;
          return r.board;
        }, change);
        if (problem) toast(problem);
      } else {
        update((b) => ({ ...b, nodes: [...b.nodes, ...nodes] }), change);
      }
      setSelectedNodes(new Set([nodes[nodes.length - 1].id]));
    },
    [update, updateBoard, table, outputRoot, toast],
  );

  /** attachTo = 任务节点 id：只选一张，接到该任务的空图片端口（从图片端口反向拖线建节点）。 */
  const pickReferences = async (at?: { x: number; y: number }, attachTo?: string) => {
    const picked = await open({ multiple: !attachTo, filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }] });
    if (!picked) return;
    await importReferences(Array.isArray(picked) ? picked : [picked], at ?? centerPosition(), attachTo ? { taskId: attachTo, place: "asIs" } : undefined);
  };

  // 撤销 / 重做（供工具栏与上下文菜单）：锁定任务按当前状态保留。
  const undo = useCallback(() => onUndo(lockedRef.current), [onUndo]);
  const redo = useCallback(() => onRedo(lockedRef.current), [onRedo]);

  // 通用复制粘贴：Ctrl/⌘+C 复制选中节点，Ctrl/⌘+V 粘贴（新节点整体偏移、从未提交过）。
  // Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z、Ctrl/⌘+Y 重做；文本框聚焦时交给原生撤销。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || isTyping(e.target) || !wrapper.current?.isConnected) return;
      const key = e.key.toLowerCase();
      if (key === "z" || (key === "y" && !e.shiftKey)) {
        e.preventDefault();
        if (dialogOpenRef.current) return;
        if (key === "z" && !e.shiftKey) undo();
        else redo();
        return;
      }
      if (e.shiftKey || dialogOpenRef.current) return;
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
        }, { label: countLabel("粘贴", clip.nodes.length) });
        // 连续粘贴逐次错开。
        clipboard = { ...clip, nodes: clip.nodes.map((n) => ({ ...n, pos: [n.pos[0] + PASTE_OFFSET, n.pos[1] + PASTE_OFFSET] as [number, number] })) };
        setSelectedNodes(new Set(pasted));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [updateBoard, undo, redo]);

  const openMenu = (e: ReactMouseEvent | MouseEvent, target: MenuTarget) => {
    e.preventDefault();
    if (target.kind === "node") {
      const next = selectionForMenu(selectedRef.current, target.nodeId);
      if (next !== selectedRef.current) setSelectedNodes(new Set(next));
    }
    const client = { x: e.clientX, y: e.clientY };
    setMenu({ target, client, at: flow.screenToFlowPosition(client) });
  };

  /** 按 action 执行：与工具栏 / 节点按钮同一套逻辑（删除、断开走 React Flow 删除流程，规则同 Delete 键）。 */
  const saveNodeAs = async (nodeId: string) => {
    const node = boardRef.current.nodes.find((n) => n.id === nodeId);
    if (node?.type !== "reference" && node?.type !== "result") return;
    try {
      const saved = await saveCopyAs(resolveFromRoot(outputRoot, node.path));
      if (saved) toast(`已保存：${saved}`);
    } catch (e) {
      toast(`另存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const performAction = (action: BoardAction, target: MenuTarget, at?: { x: number; y: number }) => {
    if (action === "newPrompt") addPrompt(at);
    else if (action === "newTask") addTask(at);
    else if (action === "addReferences") void pickReferences(at);
    else if (action === "undo") undo();
    else if (action === "redo") redo();
    else if (action === "exportPack") onExportPack();
    else if (target.kind === "node") {
      const id = target.nodeId;
      if (action === "preview") actions.previewNode(id);
      else if (action === "saveAs") void saveNodeAs(id);
      else if (action === "continueEditing") actions.continueEditing(id);
      else if (action === "addAsReference") actions.addAsReference(id);
      else if (action === "generateVariant") actions.generateVariant(id);
      else if (action === "run") onRun([id]);
      else if (action === "cancel") onCancelTask(id);
      else if (action === "regenerate") onRegenerate(id);
      else if (action === "viewSendText") onViewSendText(id);
      else if (action === "toggleSettings") setExpanded((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
      else if (action === "delete") void flow.deleteElements({ nodes: [...selectionForMenu(selectedRef.current, id)].map((n) => ({ id: n })) });
    } else if (target.kind === "edge") {
      const { edge } = target;
      if (action === "disconnect") void flow.deleteElements({ edges: [{ id: edgeId(edge) }] });
      else if (action === "editRegion") actions.editRegion(edge.to[0], { from: edge.from, to: edge.to });
    }
  };

  performRef.current = performAction;

  /** 拖线建节点：at = 松手处的画布坐标，新节点左上角落在这里。 */
  performDragCreateRef.current = (action, from, at) => {
    if (action === "continueEditing") actions.continueEditing(from.nodeId, null, at);
    else if (action === "newTask") addTask(at, from.nodeId);
    else if (action === "addReferences") {
      if (lockedRef.current.has(from.nodeId)) return toast(LOCKED_HINT);
      void pickReferences(at, from.nodeId);
    }
  };

  const menuEntries = menu ? menuItems(menu.target, menuFacts(menu.target.kind === "node" ? selectionForMenu(selectedNodes, menu.target.nodeId) : selectedNodes)) : [];

  // 悬浮动作条：光标在图片节点或动作条上时显示；从节点移到动作条之间留一点宽限。
  const [hovered, setHovered] = useState<string | null>(null);
  const unhoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** id = 显示该节点的动作条；null = 只取消待收起。 */
  const showActionBar = (id: string | null) => {
    if (unhoverTimer.current !== null) clearTimeout(unhoverTimer.current);
    unhoverTimer.current = null;
    if (id !== null) setHovered(id);
  };
  const hideActionBarSoon = () => {
    showActionBar(null);
    unhoverTimer.current = setTimeout(() => setHovered(null), 150);
  };
  useEffect(() => () => showActionBar(null), []);
  const hoveredPresent = hovered !== null && board.nodes.some((n) => n.id === hovered);
  const barItems = hoveredPresent && !menu ? actionBarItems(hovered, menuFacts(selectedNodes)) : [];
  // 悬浮在多选内的节点上：选区上方只出一条。
  const barNodes = hoveredPresent ? (selectedNodes.size > 1 && selectedNodes.has(hovered) ? [...selectedNodes] : [hovered]) : [];

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
        if (!images.length) return;
        // 落在任务节点卡片上：建参考图节点（任务左侧就近空位）并接到下一个空图片端口；其余落点照常导入到松手处。
        const hit = dropTargetAt({ x: position.x / scale, y: position.y / scale });
        const card = hit?.kind === "node" ? boardRef.current.nodes.find((n) => n.id === hit.nodeId) : undefined;
        void importReferences(images, at, card?.type === "task" ? { taskId: card.id, place: "left" } : undefined);
      })
      .then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flow, importReferences, openBoardPath]);

  return (
    <BoardContext.Provider value={actions}>
      <HoverProvider value={hover.controller}>
      <DragContext.Provider value={drag}>
      {/* 画布内屏蔽 WebView 默认右键菜单；可编辑元素保留原生菜单（复制粘贴）。 */}
      <div
        className={["canvas", drag ? "connecting" : ""].join(" ").trim()}
        ref={wrapper}
        onContextMenu={(e) => !isTyping(e.target) && e.preventDefault()}
        onPointerDownCapture={nav.onPointerDownCapture}
        onPointerUpCapture={nav.onPointerUpCapture}
      >
        <div className="toolbar">
          <button onClick={() => setPresetsOpen(true)}>项目预设…</button>
          {/* 新建生成任务用的模型（board.last_model）：是偏好不是画板编辑，不进撤销。 */}
          <select
            className="toolbar-model"
            value={defaultTaskModel(table, discovery, board.last_model) ?? ""}
            onChange={(e) => {
              const modelId = e.target.value;
              update((b) => ({ ...b, last_model: modelId }), "view");
            }}
            aria-label="新建任务模型"
          >
            <ModelOptions table={table} available={actions.availableModels} />
          </select>
          <HoverButton onClick={undo} disabled={!undoLabel} info={textHoverInfo(undoLabel ? `撤销 ${undoLabel}（Ctrl+Z）` : "没有可撤销的操作")} aria-label="撤销">
            ↶
          </HoverButton>
          <HoverButton onClick={redo} disabled={!redoLabel} info={textHoverInfo(redoLabel ? `重做 ${redoLabel}（Ctrl+Shift+Z）` : "没有可重做的操作")} aria-label="重做">
            ↷
          </HoverButton>
          <HoverButton className="primary" onClick={() => onRun([...selectedNodes])} info={textHoverInfo("有选中时只运行选中子图，否则运行整个画板中需要运行的任务")}>
            ▶ 运行{selectedNodes.size > 0 ? "选中" : ""}
          </HoverButton>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          proOptions={{ hideAttribution: true }}
          edgeTypes={edgeTypes}
          {...nav.flowProps}
          deleteKeyCode={dialogOpen ? null : nav.flowProps.deleteKeyCode}
          defaultViewport={board.viewport}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          isValidConnection={isValidConnection}
          connectionLineStyle={drag ? { stroke: `var(--port-${dragKind(board, drag.from)})` } : undefined}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onBeforeDelete={onBeforeDelete}
          onDelete={onDelete}
          onMoveStart={closeMenu}
          onMoveEnd={onMoveEnd}
          onPaneContextMenu={(e) => openMenu(e, { kind: "pane" })}
          onNodeContextMenu={(e, n) => !isTyping(e.target) && openMenu(e, { kind: "node", nodeId: n.id })}
          onSelectionContextMenu={(e, ns) => ns[0] && openMenu(e, { kind: "node", nodeId: ns[0].id })}
          onEdgeContextMenu={(e, fe) => {
            const target = board.edges.find((be) => edgeId(be) === fe.id);
            if (target) openMenu(e, { kind: "edge", edge: target });
          }}
          onNodeMouseEnter={(_, n) => (n.type === "reference" || n.type === "result" ? showActionBar(n.id) : undefined)}
          onNodeMouseLeave={hideActionBarSoon}
          onEdgeMouseMove={(e, fe) => {
            if (fe.data && e.buttons === 0) hover.controller.move(`edge:${fe.id}`, fe.data.hover as HoverInfo, e.clientX, e.clientY);
          }}
          onEdgeMouseLeave={(_, fe) => hover.controller.leave(`edge:${fe.id}`)}
          onNodeDragStart={onDragStart}
          onNodeDragStop={onDragStop}
          onSelectionDragStart={onDragStart}
          onSelectionDragStop={onDragStop}
          minZoom={0.1}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
          {barItems.length > 0 && (
            <NodeToolbar nodeId={barNodes} isVisible position={Position.Top}>
              <ActionBar
                items={barItems}
                onPick={(action) => performAction(action, { kind: "node", nodeId: hovered! })}
                onPointerEnter={() => showActionBar(hovered)}
                onPointerLeave={hideActionBarSoon}
              />
            </NodeToolbar>
          )}
        </ReactFlow>
        {menu && menuEntries.length > 0 && (
          <ContextMenu at={menu.client} items={menuEntries} onPick={(action) => performAction(action, menu.target, menu.at)} onClose={closeMenu} />
        )}
        {dragMenu && (
          <ContextMenu
            at={dragMenu.client}
            items={dragMenu.items}
            onPick={(action) => performDragCreateRef.current(action, dragMenu.from, dragMenu.at)}
            onClose={() => setDragMenu(null)}
          />
        )}
        {presetsOpen && <PresetDialog onUse={applyPreset} onClose={() => setPresetsOpen(false)} />}
        {preview && <PreviewDialog key={preview.nonce} req={preview.req} toast={toast} onClose={() => setPreview(null)} />}
        {hover.layer}
      </div>
      </DragContext.Provider>
      </HoverProvider>
    </BoardContext.Provider>
  );
}

/** useConnection 选择器：只取拖线起点，指针移动不触发重渲染（浅比较）。 */
function dragFromOf(c: ConnectionState): DragFrom | null {
  if (!c.inProgress) return null;
  return { nodeId: c.fromHandle.nodeId, handleId: c.fromHandle.id ?? "", type: c.fromHandle.type };
}

/** 指针事件的窗口坐标（鼠标或触控）。 */
function clientPointOf(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("changedTouches" in event) {
    const t = event.changedTouches[0];
    return { x: t?.clientX ?? 0, y: t?.clientY ?? 0 };
  }
  return { x: event.clientX, y: event.clientY };
}

/** 窗口坐标处的落点：节点卡片、画布空白（含连线），其余（工具栏、小地图、控件、动作条等）为 null。 */
function dropTargetAt(client: { x: number; y: number }): { kind: "node"; nodeId: string } | { kind: "pane" } | null {
  const el = document.elementFromPoint(client.x, client.y);
  const node = el?.closest(".react-flow__node");
  const nodeId = node?.getAttribute("data-id");
  if (nodeId) return { kind: "node", nodeId };
  if (!el?.closest(".react-flow") || el.closest(".react-flow__panel, .react-flow__node-toolbar")) return null;
  return { kind: "pane" };
}

function withAvailability(issues: string[], unavailable: string | null): string[] {
  return unavailable ? [...issues, unavailable] : issues;
}

function posOf(p: { x: number; y: number }): [number, number] {
  return [Math.round(p.x), Math.round(p.y)];
}
