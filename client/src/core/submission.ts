// 提交前的纯函数：脏判据快照、运行范围、二次确认清单。
import type { OutputOptions } from "./gateway";
import { outputOptions } from "./gateway";
import type { Board, Region, TaskNode } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import { imageEdges, imageSources, promptText } from "./graph";
import type { SendPlan } from "./sendPlan";
import type { SizeSpec } from "./size";
import { readOutcome, type TaskFs, type TaskOutcome } from "./taskDir";
import { sendPlanOf, taskView, type TaskFacts, type UnrunnableReason } from "./taskView";

export type SnapshotImage =
  | { kind: "reference"; path: string; sha256: string; region: Region | null }
  | { kind: "result"; task_id: string; file: string; source_layer: number | null; region: Region | null };

/** 与 last_submitted 比较的字段（画板文件格式第 9.3 节，去掉 task_id）。 */
export interface Snapshot {
  prompt: string;
  negative_prompt: string;
  model: string;
  size_spec: SizeSpec;
  layer_decomposition: boolean;
  transparent_background: boolean;
  output_options?: OutputOptions;
  layer_size?: import("./gateway").LayerSize;
  images: SnapshotImage[];
}

function findTask(board: Board, id: string): TaskNode | undefined {
  const node = board.nodes.find((n) => n.id === id);
  return node?.type === "task" ? node : undefined;
}

export function snapshotOf(board: Board, taskId: string): Snapshot | null {
  const task = findTask(board, taskId);
  if (!task) return null;
  const images = imageEdges(board, taskId).flatMap((e): SnapshotImage[] => {
    const src = board.nodes.find((n) => n.id === e.from[0]);
    if (src?.type === "reference") return [{ kind: "reference", path: src.path, sha256: src.sha256, region: e.region }];
    if (src?.type === "result") return [{ kind: "result", task_id: src.task_id, file: src.file, source_layer: e.source_layer, region: e.region }];
    return [];
  });
  return {
    prompt: promptText(board, taskId, "positive"),
    negative_prompt: promptText(board, taskId, "negative"),
    model: task.model,
    size_spec: { tier: task.size_spec.tier, ratio: task.size_spec.ratio, width: task.size_spec.width, height: task.size_spec.height },
    layer_decomposition: task.layer_decomposition,
    ...(task.layer_decomposition && task.model === "doubao-seedream-5-0-flash-260915" ? { layer_size: task.layer_size ?? "auto" } : {}),
    ...(task.model === "doubao-seedream-5-0-flash-260915" ? { output_options: outputOptions(task.output_options) } : {}),
    transparent_background: task.transparent_background,
    images,
  };
}

/** 键序无关的 JSON，用于快照比较。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SNAPSHOT_KEYS: (keyof Snapshot)[] = ["prompt", "negative_prompt", "model", "size_spec", "layer_decomposition", "layer_size", "transparent_background", "output_options", "images"];

export function isDirty(board: Board, taskId: string): boolean {
  const task = findTask(board, taskId);
  const current = snapshotOf(board, taskId);
  if (!task || !current) return false;
  const last = task.last_submitted;
  if (last === null) return true;
  // size_spec 只比四个已知字段，未来加进来的字段不让旧快照全部变脏。
  const pick = (s: Record<string, unknown>) =>
    SNAPSHOT_KEYS.map((k) => {
      const v = s[k];
      if (k !== "size_spec" || typeof v !== "object" || v === null) return v;
      const spec = v as Record<string, unknown>;
      return { tier: spec.tier, ratio: spec.ratio, width: spec.width, height: spec.height };
    });
  return canonical(pick(current as unknown as Record<string, unknown>)) !== canonical(pick(last));
}

/** 提交时写入 last_submitted 快照。 */
export function withSubmitted(board: Board, taskId: string, submittedTaskId: string): Board {
  const snapshot = snapshotOf(board, taskId);
  if (!snapshot) return board;
  return {
    ...board,
    nodes: board.nodes.map((n) => (n.id === taskId && n.type === "task" ? { ...n, last_submitted: { task_id: submittedTaskId, ...snapshot } } : n)),
  };
}

/** 已执行 = 上次提交产出了画板上的结果节点；失败或中断的提交没有结果，仍需运行。 */
function hasExecuted(board: Board, task: TaskNode): boolean {
  const submitted = task.last_submitted?.task_id;
  return typeof submitted === "string" && board.nodes.some((n) => n.type === "result" && n.task_id === submitted);
}

/**
 * 候选的已中断：提交过、画板上没有结果，且本次程序运行期间队列没经手过这次提交。
 * 界面再读任务目录的结局记录：有失败 / 取消记录的按记录显示，没有才是已中断。不持久化到画板。
 */
export function isInterrupted(board: Board, taskId: string, handled: ReadonlySet<string>): boolean {
  const task = findTask(board, taskId);
  const submitted = task?.last_submitted?.task_id;
  return !!task && typeof submitted === "string" && !handled.has(submitted) && !hasExecuted(board, task);
}

/** 画板上已中断的候选：[任务节点 id, 提交的 task_id]。 */
export function interruptedCandidates(board: Board, handled: ReadonlySet<string>): [nodeId: string, taskId: string][] {
  return board.nodes.flatMap((n) =>
    n.type === "task" && typeof n.last_submitted?.task_id === "string" && isInterrupted(board, n.id, handled) ? [[n.id, n.last_submitted.task_id] as [string, string]] : [],
  );
}

/** 重开后推导出的任务状态：有结局记录按记录，没有 = 已中断。 */
export type StoredStatus = TaskOutcome | { kind: "interrupted" };

/** 推导出已中断时要记的日志事件（task 类别）；「每个 task_id 只记一次」的去重见 createInterruptedLog。 */
export interface InterruptedEvent {
  task_id: string;
  board_file: string;
  task_node_id: string;
  from_status: "running";
  to_status: "interrupted";
}

/**
 * 已存状态（#128）：对已中断的候选读任务目录的结局记录——失败 / 已取消按记录，没有记录 = 已中断，
 * 并为每个已中断产出一条 running → interrupted 的日志事件。读结局的缓存归调用方（经 fs 注入）。
 */
export async function storedStatuses(
  fs: Pick<TaskFs, "readFile">,
  board: Board,
  handled: ReadonlySet<string>,
  outputRoot: string,
  boardFile: string,
): Promise<{ statuses: Map<string, StoredStatus>; interruptedEvents: InterruptedEvent[] }> {
  const interruptedEvents: InterruptedEvent[] = [];
  const entries = await Promise.all(
    interruptedCandidates(board, handled).map(async ([nodeId, taskId]) => {
      const outcome = await readOutcome(fs, outputRoot, taskId);
      if (!outcome) interruptedEvents.push({ task_id: taskId, board_file: boardFile, task_node_id: nodeId, from_status: "running", to_status: "interrupted" });
      return [nodeId, outcome ?? { kind: "interrupted" as const }] as const;
    }),
  );
  return { statuses: new Map(entries), interruptedEvents };
}

/** 已中断日志的去重：本次运行里每个 task_id 只记一次（跨画板共用，一个应用实例一份）。 */
export interface InterruptedLog {
  /** 返回其中本次运行首次出现的 task_id 对应的事件（同一批里重复的只留首次），并记下这些 task_id。 */
  take(events: readonly InterruptedEvent[]): InterruptedEvent[];
}

export function createInterruptedLog(): InterruptedLog {
  const logged = new Set<string>();
  return {
    take: (events) =>
      events.filter((event) => {
        if (logged.has(event.task_id)) return false;
        logged.add(event.task_id);
        return true;
      }),
  };
}

/** 有选中时只跑选中子图（选中的任务 + 选中节点直接下游的任务），否则整个画板；跳过不脏的已执行任务与正在排队 / 执行的。 */
export function runScope(board: Board, selectedIds: string[], busy: ReadonlySet<string> = new Set()): string[] {
  const selected = new Set(selectedIds);
  const downstream = new Set(board.edges.filter((e) => selected.has(e.from[0])).map((e) => e.to[0]));
  return board.nodes
    .filter((n): n is TaskNode => n.type === "task")
    .filter((n) => selected.size === 0 || selected.has(n.id) || downstream.has(n.id))
    .filter((n) => !busy.has(n.id) && (isDirty(board, n.id) || !hasExecuted(board, n)))
    .map((n) => n.id);
}

export interface ConfirmItem {
  taskId: string;
  modelName: string;
  firstLine: string;
  /** 当前会发给模型的内容；模型不在能力表内时为 null（任务本就标红、不可运行）。 */
  send: SendPlan | null;
  /** 生成任务视图的不可运行原因（两类都拦）；非空 = 不可勾选。 */
  reasons: UnrunnableReason[];
  /** 生成任务视图的警告：仅提示，不阻断。 */
  warnings: string[];
}

/** 运行前探测参考图的端口（壳层 inspectImage）。 */
export interface ImageProbe {
  inspectImage(absPath: string): Promise<{ has_alpha: boolean }>;
}

/**
 * 运行前事实采集（#128）：逐张探测这些任务的图片输入。探测抛任何错都算缺失（含文件在但不可解码）；
 * 成功则记透明通道。与运行时相同的上下文，供 buildConfirmItems 使用。
 */
export async function collectRunFacts(
  probe: ImageProbe,
  board: Board,
  taskIds: string[],
  outputRoot: string,
): Promise<{ missingNodes: Set<string>; alphaByNode: Map<string, boolean> }> {
  const missingNodes = new Set<string>();
  const alphaByNode = new Map<string, boolean>();
  await Promise.all(
    taskIds
      .flatMap((id) => {
        const edges = imageEdges(board, id);
        return imageSources(board, id, outputRoot).map((src, i) => ({ ...src, alphaKey: edges[i]?.source_layer == null ? src.nodeId : `${src.nodeId}:layer:${edges[i].source_layer}` }));
      })
      .map((src) =>
        probe.inspectImage(src.absPath).then(
          (info) => void alphaByNode.set(src.alphaKey, info.has_alpha),
          () => void missingNodes.add(src.nodeId),
        ),
      ),
  );
  return { missingNodes, alphaByNode };
}

/** 任务视图 + 发送计划 → 二次确认项；原因与警告原样取自任务视图，节点上显示的与这里拦下的是同一份。 */
export function buildConfirmItems(board: Board, table: CapabilityTable, taskIds: string[], facts: TaskFacts): ConfirmItem[] {
  return taskIds.flatMap((taskId) => {
    const task = findTask(board, taskId);
    const view = taskView(board, table, taskId, facts);
    if (!task || !view) return [];
    const prompt = promptText(board, taskId, "positive");
    return [
      {
        taskId,
        modelName: findModel(table, task.model)?.display_name ?? task.model,
        firstLine: prompt.split("\n").find((line) => line.trim())?.trim() ?? "",
        send: sendPlanOf(board, table, taskId),
        reasons: view.reasons,
        warnings: view.warnings,
      },
    ];
  });
}

/** 点「运行」后的分派：空 / 单项干净 / 单项标红不弹窗；单项仅有警告或两项及以上才弹二次确认。 */
export type RunDispatch = { kind: "toast"; message: string } | { kind: "submit"; taskId: string } | { kind: "confirm" };

export function runDispatch(items: ConfirmItem[]): RunDispatch {
  if (items.length === 0) return { kind: "toast", message: "没有需要运行的任务" };
  if (items.length > 1) return { kind: "confirm" };
  const [item] = items;
  if (item.reasons.length > 0) {
    const more = item.reasons.length > 1 ? ` 等另外 ${item.reasons.length - 1} 项` : "";
    return { kind: "toast", message: `无法运行：${item.reasons[0].text}${more}` };
  }
  return item.warnings.length > 0 ? { kind: "confirm" } : { kind: "submit", taskId: item.taskId };
}
