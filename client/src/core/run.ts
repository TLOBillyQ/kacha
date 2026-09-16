// 单个任务从提交到出结果：读参考图 → 写任务目录（不可变）→ 调网关 → 存结果图 → 画板加结果节点。
// 副作用全部由调用方注入，状态与队列在界面层。
import type { Board, ResultRecord } from "./board";
import { findModel, type CapabilityTable } from "./capabilities";
import { composeSendText, ERROR_CATEGORY_LABELS, fetchResultImage, GatewayError, generate, type FetchLike, type GenerationInput } from "./gateway";
import { workflowOf } from "./graph";
import { addResultNode } from "./layout";
import { resolveSize } from "./size";
import { imageSources, snapshotOf, withSubmitted } from "./submission";
import { newTaskId, saveResult, sniffImage, taskDirOf, writeSubmission, type ReferenceSource, type TaskFs } from "./taskDir";

export type TaskStatus = { kind: "queued" } | { kind: "running"; startedAt: number } | { kind: "failed"; label: string };

export interface RunDeps extends TaskFs {
  readBytes(absPath: string): Promise<Uint8Array>;
  fetch: FetchLike;
  now(): Date;
}

export interface PreparedJob {
  taskNodeId: string;
  taskId: string;
  relDir: string;
  input: GenerationInput;
  record: ResultRecord;
}

/** 本地准备阶段的失败（读图、写任务目录）。 */
export class LocalError extends Error {
  override name = "LocalError";
}

export function failureLabel(error: unknown): string {
  if (error instanceof GatewayError) return ERROR_CATEGORY_LABELS[error.category];
  return "本地文件错误";
}

/**
 * 提交：写任务目录并返回已写入 last_submitted 的画板。调用前应已通过二次确认（任务无标红）。
 * 任务目录写成功才算提交；失败时画板不变。
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
  const references: { bytes: Uint8Array; source: ReferenceSource }[] = [];
  for (const [i, src] of sources.entries()) {
    const image = snapshot.images[i];
    let bytes: Uint8Array;
    try {
      bytes = await deps.readBytes(src.absPath);
    } catch (e) {
      throw new LocalError(`读取图${i + 1}（${src.label}）失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const source: ReferenceSource =
      image.kind === "reference" ? { kind: "reference", path: image.path, sha256: image.sha256 } : { kind: "result", task_id: image.task_id, file: image.file };
    references.push({ bytes, source });
  }

  const submittedAt = deps.now();
  const taskId = newTaskId(submittedAt);
  const input = { model, prompt: snapshot.prompt, negativePrompt: snapshot.negative_prompt, size, references: [] as GenerationInput["references"] };
  const sendText = composeSendText({ prompt: snapshot.prompt, negativePrompt: snapshot.negative_prompt, referenceCount: references.length });
  try {
    input.references = await writeSubmission(deps, outputRoot, {
      taskId,
      submittedAt,
      model: model.model_id,
      prompt: snapshot.prompt,
      negativePrompt: snapshot.negative_prompt,
      sendText,
      sizeSpec: snapshot.size_spec,
      size,
      layerDecomposition: snapshot.layer_decomposition,
      transparentBackground: snapshot.transparent_background,
      capabilityFormatVersion: table.format_version,
      capabilityTableSha256: args.tableSha256,
      references,
    });
  } catch (e) {
    throw new LocalError(`写任务目录失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const record: ResultRecord = {
    model: model.model_id,
    prompt: snapshot.prompt,
    negative_prompt: snapshot.negative_prompt,
    size_spec: snapshot.size_spec,
    submitted_at: submittedAt.toISOString(),
  };
  return {
    job: { taskNodeId, taskId, relDir: taskDirOf(submittedAt, taskId), input, record },
    board: withSubmitted(board, taskNodeId, taskId),
  };
}

/** 调网关并存结果图；返回把结果节点加到画板上的更新函数。生成请求只发一次。 */
export async function executeJob(
  deps: RunDeps,
  args: { job: PreparedJob; outputRoot: string; baseUrl: string; apiKey: string; newNodeId: string },
): Promise<(board: Board) => Board> {
  const { job } = args;
  const { image } = await generate({ baseUrl: args.baseUrl, apiKey: args.apiKey, fetch: deps.fetch }, job.input);
  const bytes = await fetchResultImage(deps.fetch, image);
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
