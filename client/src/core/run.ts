// 单个任务从提交到出结果：读参考图（提交）→ 写任务目录（派发，不可变）→ 调网关 → 存结果图 → 画板加结果节点。
// 副作用全部由调用方注入，状态与队列在界面层。
import type { Board, ResultRecord } from "./board";
import { findModel, type CapabilityTable, type ModelCapability } from "./capabilities";
import { composeSendText, ERROR_CATEGORY_LABELS, fetchResultImage, GatewayError, generate, type FetchLike, type GenerationInput } from "./gateway";
import { imagePortSlots, workflowOf } from "./graph";
import { promptLanguage } from "./imageRefs";
import { addResultNode } from "./layout";
import { firstRegionOf, imageRefMap, overlayPhrases, regionNames, type SlotRef } from "./region";
import { resolveSize } from "./size";
import { imageSources, snapshotOf, withSubmitted } from "./submission";
import { joinPath } from "./paths";
import type { SizeSpec } from "./size";
import { newTaskId, saveLayers, saveResult, sniffImage, taskDirOf, taskDirOfTaskId, writeSubmission, type LayerRecord, type ReferenceRegion, type ReferenceSource, type SubmissionPlan, type TaskFs } from "./taskDir";

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
  references: { file: string; source: ReferenceSource; region?: ReferenceRegion }[];
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
  /** 把区域矩形以高亮叠加画到源图上，返回编码后的图片（壳层 canvas 实现）；有区域任务时必须注入。 */
  composeOverlay?(image: Uint8Array, rects: [number, number, number, number][], firstRegion: number): Promise<Uint8Array>;
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
  const slots = imagePortSlots(board, table, taskNodeId);
  // 先按用户连线读全部源图，再按展开槽组装：叠加槽由其原图合成。
  const sourceBytes: Uint8Array[] = [];
  for (const [i, src] of sources.entries()) {
    try {
      sourceBytes.push(await deps.readBytes(src.absPath));
    } catch (e) {
      throw readError(`图${i + 1}（${src.label}）`, e);
    }
  }
  const references: SubmissionPlan["references"] = [];
  const firstRegion = firstRegionOf(slots);
  let imageIndex = 0;
  for (const slot of slots) {
    if (slot.kind === "image") {
      const i = imageIndex++;
      const image = snapshot.images[i];
      const source: ReferenceSource =
        image.kind === "reference"
          ? { kind: "reference", path: image.path, sha256: image.sha256 }
          : { kind: "result", task_id: image.task_id, file: image.file, ...(image.source_layer !== null ? { source_layer: image.source_layer } : {}) };
      references.push({ bytes: sourceBytes[i], source });
    } else {
      if (!deps.composeOverlay) throw new LocalError("框选修改区域需要叠加合成能力，当前环境不支持");
      const sourcePort = slot.sourcePort!;
      const region = slot.edge.region!;
      const bytes = await deps.composeOverlay(sourceBytes[sourcePort - 1], region.rects, firstRegion.get(slot.port)!);
      references.push({ bytes, source: { kind: "overlay", of: sourcePort }, region: { rects: region.rects, render: "highlight_overlay", source_port: sourcePort } });
    }
  }
  const regionPhrases = overlayPhrases(model, slots, promptLanguage(snapshot.prompt));
  const names = regionNames(slots, promptLanguage(snapshot.prompt));
  const refMap = imageRefMap(slots);

  const submittedAt = deps.now();
  const taskId = newTaskId(submittedAt);
  const plan: SubmissionPlan = {
    taskId,
    submittedAt,
    model: model.model_id,
    prompt: snapshot.prompt,
    negativePrompt: snapshot.negative_prompt,
    sendText: composeSendText({ prompt: snapshot.prompt, negativePrompt: snapshot.negative_prompt, referenceCount: references.length, regionPhrases, regionNames: names, imageRefMap: refMap }),
    regionPhrases,
    regionNames: names,
    imageRefMap: refMap,
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
    input: { model, prompt: plan.prompt, negativePrompt: plan.negativePrompt, size: plan.size, references: [], regionPhrases: plan.regionPhrases, regionNames: plan.regionNames, imageRefMap: plan.imageRefMap, transparentBackground: plan.transparentBackground },
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
      references.push({ bytes: await deps.readBytes(path(ref.file)), source: ref.source, ...(ref.region ? { region: ref.region } : {}) });
    } catch (e) {
      throw readError(`上次任务的图${i + 1}`, e);
    }
  }
  // 固定句按当前能力表模板重建：请求文本由请求形态现场组装，不能只用 task.json 里的 send_text。
  // 用户序号：按顺序给非叠加条目编 1..k；叠加条目紧随原图，沿用原图的用户序号。
  let userPort = 0;
  const slots: SlotRef[] = previous.references.map((ref, i) =>
    ref.source.kind === "overlay" && ref.region
      ? { kind: "overlay", port: i + 1, userPort, sourcePort: ref.region.source_port, regionCount: ref.region.rects.length }
      : { kind: "image", port: i + 1, userPort: ++userPort, sourcePort: null, regionCount: 0 },
  );
  const regionPhrases = overlayPhrases(model, slots, promptLanguage(previous.prompt));
  const names = regionNames(slots, promptLanguage(previous.prompt));
  const refMap = imageRefMap(slots);

  const submittedAt = deps.now();
  const taskId = newTaskId(submittedAt);
  const plan: SubmissionPlan = {
    taskId,
    submittedAt,
    model: previous.model,
    prompt: previous.prompt,
    negativePrompt: previous.negative_prompt,
    // 按当前规则重算：旧任务的 send_text 可能按「叠加图占用户序号」的旧口径存（#113）。
    sendText: composeSendText({ prompt: previous.prompt, negativePrompt: previous.negative_prompt, referenceCount: references.length, regionPhrases, regionNames: names, imageRefMap: refMap }),
    regionPhrases,
    regionNames: names,
    imageRefMap: refMap,
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
  args: {
    job: PreparedJob;
    outputRoot: string;
    baseUrl: string;
    apiKey: string;
    newNodeId: string;
    signal?: AbortSignal;
    /** 结果图下载结束（日志用）；取消不回调。 */
    onDownload?: (result: { ok: true; images: number } | { ok: false; error: unknown }) => void;
  },
): Promise<(board: Board) => Board> {
  const { job, signal } = args;
  // 网关侧的计算停不下来；取消只是不再等待、不落结果。
  const { images } = await generate({ baseUrl: args.baseUrl, apiKey: args.apiKey, fetch: deps.fetch }, job.input);
  if (signal?.aborted) throw new CancelledError();
  const fetched: { bytes: Uint8Array; layer?: { z_index: number; bounding_box: number[] } }[] = [];
  try {
    for (const image of images) {
      const bytes = await fetchResultImage(deps.fetch, image);
      if (signal?.aborted) throw new CancelledError();
      if (!sniffImage(bytes)) throw new GatewayError("invalid_response", "结果不是可识别的图片");
      fetched.push({ bytes, layer: image.layer });
    }
  } catch (e) {
    if (!(e instanceof CancelledError)) args.onDownload?.({ ok: false, error: e });
    throw e;
  }
  args.onDownload?.({ ok: true, images: fetched.length });
  let saved: { file: string; path: string };
  let layers: LayerRecord[] | undefined;
  try {
    saved = await saveResult(deps, args.outputRoot, job.relDir, fetched[0].bytes);
    // 图层拆分：首张是合成结果，其余按 z_index 升序落盘 layers/01.<ext>…（无上架模型可跑，按契约夹具验收）。
    if (job.plan.layerDecomposition && fetched.length > 1) {
      layers = await saveLayers(
        deps,
        args.outputRoot,
        job.relDir,
        fetched.slice(1).map((f, i) => ({ bytes: f.bytes, zIndex: f.layer?.z_index ?? i + 1, boundingBox: f.layer?.bounding_box ?? [] })),
      );
    }
  } catch (e) {
    throw new LocalError(`保存结果图失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return (board) =>
    addResultNode(board, { id: args.newNodeId, taskId: job.taskNodeId, submittedTaskId: job.taskId, file: saved.file, path: saved.path, record: job.record, layers });
}
