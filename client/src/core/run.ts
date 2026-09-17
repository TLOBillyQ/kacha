// 单个任务从提交到出结果：读参考图（提交）→ 写任务目录（派发，不可变）→ 调网关 → 存结果图 → 画板加结果节点。
// 副作用全部由调用方注入，状态与队列在界面层。
import type { Board, ResultRecord } from "./board";
import { findModel, type CapabilityTable, type ModelCapability } from "./capabilities";
import { composeSendText, ERROR_CATEGORY_LABELS, fetchResultImage, GatewayError, generate, type FetchLike, type GenerationInput } from "./gateway";
import { workflowOf } from "./graph";
import { addResultNode } from "./layout";
import { resolveSize } from "./size";
import { imageSources, snapshotOf, withSubmitted } from "./submission";
import { joinPath } from "./paths";
import type { SizeSpec } from "./size";
import { newTaskId, saveResult, sniffImage, taskDirOf, taskDirOfTaskId, writeSubmission, type ReferenceSource, type SubmissionPlan, type TaskFs } from "./taskDir";

/** 任务目录 task.json 里重新生成要用的字段。 */
interface TaskJson {
  model: string;
  prompt: string;
  negative_prompt: string;
  send_text: string;
  size_spec: SizeSpec;
  size: { width: number; height: number };
  layer_decomposition: boolean;
  transparent_background: boolean;
  references: { file: string; source: ReferenceSource }[];
}

export type TaskStatus =
  | { kind: "queued" }
  | { kind: "running"; startedAt: number }
  /** 429 退避中，到 retryAt（毫秒）后回到派发。 */
  | { kind: "backoff"; retryAt: number }
  | { kind: "failed"; label: string }
  /** 已取消；gatewayMayContinue = 请求已发出，网关侧可能仍在计算（限流退避中取消则不会）。 */
  | { kind: "cancelled"; gatewayMayContinue: boolean }
  /** 上次程序非正常退出时仍在排队 / 执行；重开时推导，不持久化。 */
  | { kind: "interrupted" };

export interface RunDeps extends TaskFs {
  readBytes(absPath: string): Promise<Uint8Array>;
  fetch: FetchLike;
  now(): Date;
}

export interface PreparedJob {
  taskNodeId: string;
  taskId: string;
  relDir: string;
  /** 派发时写入任务目录的内容；排队中取消不留痕迹。 */
  plan: SubmissionPlan;
  /** writeJob 之后 references 才填上。 */
  input: GenerationInput;
  record: ResultRecord;
}

/** 本地准备阶段的失败（读图、写任务目录）。 */
export class LocalError extends Error {
  override name = "LocalError";
}

/** 执行中被取消：不存结果、不加结果节点。 */
export class CancelledError extends Error {
  override name = "CancelledError";
}

export function failureLabel(error: unknown): string {
  if (error instanceof GatewayError) return ERROR_CATEGORY_LABELS[error.category];
  return "本地文件错误";
}

function readError(label: string, e: unknown): LocalError {
  return new LocalError(`读取${label}失败：${e instanceof Error ? e.message : String(e)}`);
}

/**
 * 提交：读参考图、组装任务目录内容（快照在此固化于内存，与上游节点脱钩），返回写好 last_submitted 的画板。调用前应已通过二次确认（任务无标红）。
 * 不写盘：任务目录与画板上的 last_submitted 都在派发时落地，排队中取消不留痕迹。
 */
export async function prepareJob(
  deps: RunDeps,
  args: { board: Board; table: CapabilityTable; tableSha256: string; outputRoot: string; taskNodeId: string },
): Promise<{ job: PreparedJob; board: Board }> {
  const { board, table, outputRoot, taskNodeId } = args;
  const task = board.nodes.find((n) => n.id === taskNodeId);
  const snapshot = snapshotOf(board, taskNodeId);
  const model = task?.type === "task" ? findModel(table, task.model) : undefined;
  if (task?.type !== "task" || !snapshot || !model) throw new LocalError("任务节点或模型不存在");
  const size = resolveSize(model.workflows[workflowOf(board, taskNodeId)].size_rule, task.size_spec);
  if (!size) throw new LocalError("生成尺寸不在模型尺寸表内");

  const sources = imageSources(board, taskNodeId, outputRoot);
  const references: SubmissionPlan["references"] = [];
  for (const [i, src] of sources.entries()) {
    const image = snapshot.images[i];
    let bytes: Uint8Array;
    try {
      bytes = await deps.readBytes(src.absPath);
    } catch (e) {
      throw readError(`图${i + 1}（${src.label}）`, e);
    }
    const source: ReferenceSource =
      image.kind === "reference" ? { kind: "reference", path: image.path, sha256: image.sha256 } : { kind: "result", task_id: image.task_id, file: image.file };
    references.push({ bytes, source });
  }

  const submittedAt = deps.now();
  const taskId = newTaskId(submittedAt);
  const plan: SubmissionPlan = {
    taskId,
    submittedAt,
    model: model.model_id,
    prompt: snapshot.prompt,
    negativePrompt: snapshot.negative_prompt,
    sendText: composeSendText({ prompt: snapshot.prompt, negativePrompt: snapshot.negative_prompt, referenceCount: references.length }),
    sizeSpec: snapshot.size_spec,
    size,
    layerDecomposition: snapshot.layer_decomposition,
    transparentBackground: snapshot.transparent_background,
    capabilityFormatVersion: table.format_version,
    capabilityTableSha256: args.tableSha256,
    references,
  };
  return { job: jobOf(taskNodeId, plan, model), board: withSubmitted(board, taskNodeId, taskId) };
}

function jobOf(taskNodeId: string, plan: SubmissionPlan, model: ModelCapability): PreparedJob {
  return {
    taskNodeId,
    taskId: plan.taskId,
    relDir: taskDirOf(plan.submittedAt, plan.taskId),
    plan,
    input: { model, prompt: plan.prompt, negativePrompt: plan.negativePrompt, size: plan.size, references: [] },
    record: {
      model: plan.model,
      prompt: plan.prompt,
      negative_prompt: plan.negativePrompt,
      size_spec: plan.sizeSpec,
      submitted_at: plan.submittedAt.toISOString(),
    },
  };
}

/**
 * 重新生成：按任务节点上次提交的任务目录（task.json 与参考图快照）同参数再提交一次，
 * 不看画板当前内容。新任务、新结果节点；不写盘，同 prepareJob。
 * 生成变体：fromTaskId = 该结果的任务编号，按那次提交的任务目录重跑，新结果仍进本任务节点的结果列；
 * 不改 last_submitted，之后的「重新生成」仍重跑节点最近一次提交。
 */
export async function prepareRegenerate(
  deps: RunDeps,
  args: { board: Board; table: CapabilityTable; tableSha256: string; outputRoot: string; taskNodeId: string; fromTaskId?: string },
): Promise<{ job: PreparedJob; board: Board }> {
  const { board, outputRoot, taskNodeId } = args;
  const task = board.nodes.find((n) => n.id === taskNodeId);
  const last = task?.type === "task" ? task.last_submitted : null;
  const fromTaskId = args.fromTaskId ?? last?.task_id;
  const oldDir = typeof fromTaskId === "string" ? taskDirOfTaskId(fromTaskId) : null;
  if (!last || !oldDir) throw new LocalError("任务节点没有可重新生成的提交");
  const path = (file: string) => joinPath(outputRoot, ...oldDir.split("/"), file);

  let previous: TaskJson;
  try {
    previous = JSON.parse(new TextDecoder().decode(await deps.readBytes(path("task.json"))));
  } catch (e) {
    throw readError("上次任务的 task.json", e);
  }
  const model = findModel(args.table, previous.model);
  if (!model) throw new LocalError(`模型 ${previous.model} 已不在能力表内`);
  const references: SubmissionPlan["references"] = [];
  for (const [i, ref] of previous.references.entries()) {
    try {
      references.push({ bytes: await deps.readBytes(path(ref.file)), source: ref.source });
    } catch (e) {
      throw readError(`上次任务的图${i + 1}`, e);
    }
  }

  const submittedAt = deps.now();
  const taskId = newTaskId(submittedAt);
  const plan: SubmissionPlan = {
    taskId,
    submittedAt,
    model: previous.model,
    prompt: previous.prompt,
    negativePrompt: previous.negative_prompt,
    sendText: previous.send_text,
    sizeSpec: previous.size_spec,
    size: previous.size,
    layerDecomposition: previous.layer_decomposition,
    transparentBackground: previous.transparent_background,
    capabilityFormatVersion: args.table.format_version,
    capabilityTableSha256: args.tableSha256,
    references,
  };
  if (args.fromTaskId !== undefined) return { job: jobOf(taskNodeId, plan, model), board };
  const nextBoard: Board = {
    ...board,
    nodes: board.nodes.map((n) => (n.id === taskNodeId && n.type === "task" ? { ...n, last_submitted: { ...last, task_id: taskId } } : n)),
  };
  return { job: jobOf(taskNodeId, plan, model), board: nextBoard };
}

/** 派发时写任务目录（不可变）；返回带参考图的任务。429 重试不重写。 */
export async function writeJob(deps: RunDeps, outputRoot: string, job: PreparedJob): Promise<PreparedJob> {
  try {
    const references = await writeSubmission(deps, outputRoot, job.plan);
    return { ...job, input: { ...job.input, references } };
  } catch (e) {
    throw new LocalError(`写任务目录失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 调网关并存结果图；返回把结果节点加到画板上的更新函数。生成请求只发一次。 */
export async function executeJob(
  deps: RunDeps,
  args: { job: PreparedJob; outputRoot: string; baseUrl: string; apiKey: string; newNodeId: string; signal?: AbortSignal },
): Promise<(board: Board) => Board> {
  const { job, signal } = args;
  // 网关侧的计算停不下来；取消只是不再等待、不落结果。
  const { image } = await generate({ baseUrl: args.baseUrl, apiKey: args.apiKey, fetch: deps.fetch }, job.input);
  if (signal?.aborted) throw new CancelledError();
  const bytes = await fetchResultImage(deps.fetch, image);
  if (signal?.aborted) throw new CancelledError();
  if (!sniffImage(bytes)) throw new GatewayError("invalid_response", "结果不是可识别的图片");
  let saved: { file: string; path: string };
  try {
    saved = await saveResult(deps, args.outputRoot, job.relDir, bytes);
  } catch (e) {
    throw new LocalError(`保存结果图失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return (board) =>
    addResultNode(board, { id: args.newNodeId, taskId: job.taskNodeId, submittedTaskId: job.taskId, file: saved.file, path: saved.path, record: job.record });
}
