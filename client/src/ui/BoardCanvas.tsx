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
import { countLabel, MERGE_PAUSE_MS, type Change, type UserChange } from "../core/history";
import { addAsReference, addAsReferenceTarget, continueEditing, copySelection, lineage, pasteClip, PASTE_OFFSET, producerOf, type Clip, type Outcome } from "../core/iterate";
import { PROMPT_NODE_SIZE, TASK_NODE_SIZE } from "../core/layout";
import { placePreset, type Preset } from "../core/presets";
import { basename, dirname, joinPath, resolveFromRoot, toRootRelative } from "../core/paths";
import { effectiveRegionRender, setEdgeRegion } from "../core/region";
import { findReferenceFile, findResultFile, IMAGE_EXTENSIONS, type RelocateFs } from "../core/relocate";
import { defaultSizeSpec } from "../core/size";
import { imageRefProblems, imageSources, type SnapshotImage } from "../core/submission";
import { ipc } from "../shell/ipc";
import { logEvent } from "../shell/log";
import { PresetDialog } from "./PresetDialog";
import { BoardContext, primeImageInfo, useImageInfos, useMissingImages, useStoredStatuses, type BoardActions } from "./context";
import { nodeTypes, type ImagePortInfo, type ImageSlotInfo } from "./nodes";
import { PreviewDialog, type PreviewRequest, type RegionTarget } from "./PreviewDialog";
import { isActive } from "./useRunner";

const relocateFs: RelocateFs = {
  listDir: ipc.listDir,
  isFile: ipc.isFile,
  sha256: async (path) => (await ipc.inspectImage(path)).sha256,
};

/** 复制粘贴的剪贴板：应用内共享，可粘到另一个画板（只带节点之间的连线，不跨画板连线）。 */
let clipboard: Clip | null = null;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

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
  /** 运行指示跳转：居中并选中该节点；nonce 变化即再跳一次。 */
  focus: { nodeId: string; nonce: number } | null;
}

const LOCKED_HINT = "任务排队 / 执行中：模型、尺寸、开关、图片端口与连线已锁定";

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
  focus,
}: Props) {
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
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
  const [focusPrompt, setFocusPrompt] = useState<string | null>(null);
  const missing = useMissingImages(board, outputRoot);
  const [preview, setPreview] = useState<{ req: PreviewRequest; nonce: number } | null>(null);
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
        return [{ label: `${modelName} 的图${port}`, edgeRef: { from: e.from, to: e.to }, rects: e.region?.rects ?? [], render }];
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

  const actions = useMemo<BoardActions>(
    () => ({
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
        updateBoard((b) => ({ ...b, nodes: b.nodes.map((n) => (n.id === id && n.type !== "unknown" ? ({ ...n, ...patch } as KnownNode) : n)) }), patchChange(id, patch)),
      moveImagePort: (taskId, from, to) =>
        !lockedRef.current.has(taskId) && updateBoard((b) => ({ ...b, edges: moveImagePort(b, taskId, from, to) }), { label: "调整图片顺序" }),
      forkPrompt: (promptId, text) => updateBoard((b) => forkPrompt(b, promptId, { newNodeId: crypto.randomUUID(), text }), { label: "分叉提示词" }),
      cancelTask: onCancelTask,
      regenerate: onRegenerate,
      continueEditing: (nodeId, sourceLayer = null) => {
        const selected = selectedRef.current;
        const sources = selected.has(nodeId) ? [...selected] : [nodeId];
        const ids = { taskId: crypto.randomUUID(), promptId: crypto.randomUUID() };
        const sourceLayers = sourceLayer === null ? null : new Map([[nodeId, sourceLayer]]);
        if (!applyOutcome((b) => continueEditing(b, table, discovery, sources, nodeId, ids, sourceLayers), { label: "以此继续编辑" })) return;
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
          const refs = imageRefProblems(board, table, n.id);
          const missingImages = imageSources(board, n.id, outputRoot).flatMap((src, i) => (missing.has(src.nodeId) ? [`图${i + 1} 图片缺失：${src.label}`] : []));
          const taskEdges = imageEdges(board, n.id);
          const render = effectiveRegionRender(findModel(table, n.model));
          const slots: ImageSlotInfo[] = imagePortSlots(board, table, n.id).map((s) => {
            const src = labelOf(s.edge.from[0]);
            return s.kind === "overlay"
              ? { kind: "overlay" as const, port: s.port, label: src.label, absPath: null, handleIndex: null, rects: [], edgeRef: null }
              : {
                  kind: "image" as const,
                  port: s.port,
                  label: src.label,
                  absPath: src.absPath,
                  handleIndex: imagePortIndex(s.edge.to[1]),
                  rects: s.edge.region?.rects ?? [],
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
                chainDepth: chainDepth(board, n.id),
                locked: locked.has(n.id),
                workflow: workflowOf(board, n.id),
                images: taskEdges.map((e) => labelOf(e.from[0])),
                slots,
                regionRender: render,
                hasPositive: board.edges.some((e) => e.to[0] === n.id && e.to[1] === "positive"),
                status: statusOf(n.id),
              },
            },
          ];
        }
      }
    });
  }, [board, table, outputRoot, selectedNodes, measured, statusOf, locked, discovery, highlighted, missing, focusPrompt, alphaByNode]);

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
        className: [e.system ? "edge-system" : e.to[1] === "negative" ? "edge-negative" : "", highlighted.edges.has(e) ? "edge-lineage" : ""].join(" ").trim() || undefined,
      })),
    [board.edges, selectedEdges, highlighted],
  );

  /** 进行中的拖动编号（0 = 没在拖）；每次拖动一个新合并键。 */
  const activeDrag = useRef(0);
  const dragCounter = useRef(0);
  const onDragStart = useCallback(() => {
    activeDrag.current = ++dragCounter.current;
  }, []);
  const onDragStop = useCallback(() => {
    activeDrag.current = 0;
  }, []);

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
        // 一次拖动（含多选）从开始到 onNodeDragStop 合为一步；拖动之外的位置变更（方向键微移）连按合为一步。
        const drag = activeDrag.current;
        const change: UserChange = drag
          ? { label: countLabel("移动", moves.size), merge: { key: `drag:${drag}` } }
          : { label: countLabel("微移", moves.size), merge: { key: `nudge:${[...moves.keys()].sort().join(",")}`, windowMs: MERGE_PAUSE_MS } };
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
      }, { label: "连线" });
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
      const label = ns.length ? countLabel("删除", ns.length) : countLabel("断开", es.length, "条连线");
      updateBoard((b) => {
        let next = b;
        const userRemoved = next.edges.filter((e) => removedIds.has(edgeId(e)) && !e.system);
        if (userRemoved.length) next = { ...next, edges: disconnect(next, userRemoved) };
        if (ns.length) next = removeNodes(next, ns.map((n) => n.id));
        return next;
      }, { label });
      setSelectedNodes(new Set());
      setSelectedEdges(new Set());
    },
    [updateBoard],
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

  const addPrompt = () =>
    addNode({ type: "prompt", id: crypto.randomUUID(), pos: posOf(centerPosition()), size: PROMPT_NODE_SIZE, text: "", extra: {} }, { label: "新建提示词" });

  const applyPreset = (preset: Preset) => {
    // 先在空画板上落好节点再并入：更新函数可能延后执行，选中的 id 要先定下来。
    const { board: placed, nodeIds } = placePreset({ ...board, nodes: [] }, preset, posOf(centerPosition()), () => crypto.randomUUID());
    update((b) => ({ ...b, nodes: [...b.nodes, ...placed.nodes] }), { label: `使用预设「${preset.name}」` });
    setSelectedNodes(new Set(nodeIds));
    setPresetsOpen(false);
  };

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
    update((b) => ({ ...b, last_model: model.model_id, nodes: [...b.nodes, node] }), { label: "新建生成任务" });
    setSelectedNodes(new Set([node.id]));
  };

  const importReferences = useCallback(
    async (paths: string[], at: { x: number; y: number }) => {
      let offset = 0;
      // 一次导入的多张参考图合为一步。
      const change: UserChange = { label: countLabel("添加", paths.length, "张参考图"), merge: { key: `import:${crypto.randomUUID()}` } };
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
          }, change);
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

  // 撤销 / 重做（供工具栏与上下文菜单）：锁定任务按当前状态保留。
  const undo = useCallback(() => onUndo(lockedRef.current), [onUndo]);
  const redo = useCallback(() => onRedo(lockedRef.current), [onRedo]);
  // 预设 / 预览弹窗开着时快捷键不撤销背后的画板。
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = presetsOpen || preview !== null;

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
      if (e.shiftKey) return;
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
          <button onClick={() => setPresetsOpen(true)}>＋ 从预设…</button>
          <button onClick={undo} disabled={!undoLabel} title={undoLabel ? `撤销 ${undoLabel}（Ctrl+Z）` : "没有可撤销的操作"} aria-label="撤销">
            ↶
          </button>
          <button onClick={redo} disabled={!redoLabel} title={redoLabel ? `重做 ${redoLabel}（Ctrl+Shift+Z）` : "没有可重做的操作"} aria-label="重做">
            ↷
          </button>
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
          onNodeDragStart={onDragStart}
          onNodeDragStop={onDragStop}
          onSelectionDragStart={onDragStart}
          onSelectionDragStop={onDragStop}
          deleteKeyCode={["Delete", "Backspace"]}
          minZoom={0.1}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
        {presetsOpen && <PresetDialog onUse={applyPreset} onClose={() => setPresetsOpen(false)} />}
        {preview && <PreviewDialog key={preview.nonce} req={preview.req} toast={toast} onClose={() => setPreview(null)} />}
      </div>
    </BoardContext.Provider>
  );
}

const TOGGLE_LABELS: Partial<Record<string, string>> = {
  size_spec: "修改尺寸",
  layer_decomposition: "切换图层拆分",
  transparent_background: "切换透明背景",
};

/** 节点字段编辑的步描述；提示词连续输入停顿不超过 MERGE_PAUSE_MS 合为一步。 */
function patchChange(id: string, patch: Partial<KnownNode>): UserChange {
  if ("text" in patch) return { label: "编辑提示词", merge: { key: `text:${id}`, windowMs: MERGE_PAUSE_MS } };
  const field = Object.keys(patch)[0];
  return { label: TOGGLE_LABELS[field] ?? "修改节点" };
}

function withAvailability(issues: string[], unavailable: string | null): string[] {
  return unavailable ? [...issues, unavailable] : issues;
}

function posOf(p: { x: number; y: number }): [number, number] {
  return [Math.round(p.x), Math.round(p.y)];
}
