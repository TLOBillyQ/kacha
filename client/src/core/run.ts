// 单个任务从提交到出结果的内部件：读参考图（提交）→ 写任务目录（派发，不可变）→ 调网关 → 存结果图。
// 副作用全部由调用方注入；调用顺序与状态由任务运行器（runner.ts）负责，界面不直接调用。
import type { Board, ResultRecord, TaskNode } from "./board";
import { findModel, type CapabilityTable, type InputImageRule, type ModelCapability } from "./capabilities";
import { fitImage, type FittedBytes, type ImageCodec } from "./fitImage";
import { ERROR_CATEGORY_LABELS, fetchResultImage, GatewayError, generate, type FetchLike, type GenerationInput } from "./gateway";
import { imagePortSlots, imageSources, imageRuleViolations, workflowOf } from "./graph";
import type { RunResult } from "./layout";
import { firstRegionOf, slotsFromReferences } from "./region";
import { planSend } from "./sendPlan";
import { isAutoRatio, resolveSize } from "./size";
import { snapshotOf } from "./submission";
import { LocalError, newTaskId, readSubmission, taskDirOfTaskId, saveLayers, saveResult, sniffImage, writeSubmission, type LayerRecord, type ReferenceSource, type SubmissionPlan, type TaskFs } from "./taskDir";

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

/** readFile 兼读画板上的源图与任务目录。 */
export interface RunDeps extends TaskFs {
  fetch: FetchLike;
  now(): Date;
  /** 定时：ms 毫秒后调 fn，返回取消函数。运行器不直接调 setTimeout。 */
  schedule(ms: number, fn: () => void): () => void;
  /** 把区域矩形以高亮叠加画到源图上，返回编码后的图片（壳层 canvas 实现）；有区域任务时必须注入。 */
  composeOverlay?(image: Uint8Array, rects: [number, number, number, number][], firstRegion: number): Promise<Uint8Array>;
  /** 按模型输入规则缩放 / 转码参考图快照用的解码 / 编码（壳层 canvas 实现）；未注入时原样发送。 */
  imageCodec?: ImageCodec;
}

export interface PreparedJob {
  taskNodeId: string;
  taskId: string;
  /** 派发时写入任务目录的内容；排队中取消不留痕迹。 */
  plan: SubmissionPlan;
  /** writeJob 之后 references 才填上。 */
  input: GenerationInput;
  record: ResultRecord;
}

/** 任务目录已写的任务；relDir 由写提交带出（相对输出根目录）。 */
export interface WrittenJob extends PreparedJob {
  relDir: string;
}

/** 执行中被取消：不存结果、不加结果节点。 */
export class CancelledError extends Error {
  override name = "CancelledError";
}

export function failureLabel(error: unknown): string {
  if (error instanceof GatewayError) return ERROR_CATEGORY_LABELS[error.category];
  return "本地文件错误";
}

/** 发给模型的那份按规则处理；画板上的原文件不动。 */
async function fitForModel(deps: RunDeps, bytes: Uint8Array, model: ModelCapability): Promise<FittedBytes> {
  const rule = model.input_image_rule;
  const fitted = deps.imageCodec ? await fitImage(bytes, rule, deps.imageCodec) : { bytes };
  if (model.request_shape === "seedream_flash_images_generations") await validateFlashReference(deps, fitted.bytes, rule);
  return fitted;
}

async function validateFlashReference(deps: RunDeps, bytes: Uint8Array, rule: InputImageRule): Promise<void> {
  if (!deps.imageCodec) throw new LocalError("Flash 参考图需要实际图片解码校验");
  const kind = sniffImage(bytes);
  if (!kind) throw new LocalError("Flash 参考图格式无法识别");
  let decoded;
  try { decoded = await deps.imageCodec.decode(bytes); }
  catch { throw new LocalError("Flash 参考图无法解码"); }
  try {
    if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width <= 0 || decoded.height <= 0) throw new LocalError("Flash 参考图尺寸无效");
    const violations = imageRuleViolations({ format: kind.ext === "jpg" ? "jpeg" : kind.ext, bytes: bytes.length, width: decoded.width, height: decoded.height }, rule);
    if (violations.length) throw new LocalError(`Flash 参考图不合规：${violations.join("；")}`);
  } finally { decoded.close(); }
}

async function validateFlashOrdinaryOutput(deps: RunDeps, bytes: Uint8Array): Promise<void> {
  if (!deps.imageCodec) throw new GatewayError("invalid_response", "Flash 结果需要实际图片解码校验");
  let decoded;
  try { decoded = await deps.imageCodec.decode(bytes); }
  catch { throw new GatewayError("invalid_response", "Flash 结果图片无法解码"); }
  try {
    if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height) || decoded.width <= 0 || decoded.height <= 0) throw new GatewayError("invalid_response", "Flash 结果图片尺寸无效");
  } finally { decoded.close(); }
}

function readError(label: string, e: unknown): LocalError {
  return new LocalError(`读取${label}失败：${e instanceof Error ? e.message : String(e)}`);
}

/** 准备好的任务与派发时要写到任务节点上的 last_submitted；undefined = 不改（生成变体）。 */
export interface Prepared {
  job: PreparedJob;
  lastSubmitted: TaskNode["last_submitted"] | undefined;
}

/**
 * 提交：读参考图、组装任务目录内容（快照在此固化于内存，与上游节点脱钩），返回派发时要写的 last_submitted。调用前应已通过二次确认（任务无标红）。
 * 不写盘：任务目录与画板上的 last_submitted 都在派发时落地，排队中取消不留痕迹。
 */
export async function prepareJob(
  deps: RunDeps,
  args: { board: Board; table: CapabilityTable; tableSha256: string; outputRoot: string; taskNodeId: string },
): Promise<Prepared> {
  const { board, table, outputRoot, taskNodeId } = args;
  const task = board.nodes.find((n) => n.id === taskNodeId);
  const snapshot = snapshotOf(board, taskNodeId);
  const model = task?.type === "task" ? findModel(table, task.model) : undefined;
  if (task?.type !== "task" || !snapshot || !model) throw new LocalError("任务节点或模型不存在");
  const size = resolveSize(model.workflows[workflowOf(board, taskNodeId)].size_rule, task.size_spec);
  if (!size) throw new LocalError("生成尺寸不在模型尺寸表内");

  const sources = imageSources(board, taskNodeId, outputRoot);
  const slots = imagePortSlots(board, table, taskNodeId);
  const send = planSend(model, slots, snapshot.prompt, snapshot.negative_prompt);
  if (model.request_shape === "seedream_flash_images_generations" && send.referenceProblems.issues.length) throw new LocalError(send.referenceProblems.issues.join("；"));
  if (model.request_shape === "seedream_flash_images_generations" && slots.length > 10) throw new LocalError("Flash 参考图最多 10 张");
  // 先按用户连线读全部源图，再按展开槽组装：叠加槽由其原图合成。
  // 读到即按该任务模型的输入规则处理成参考图快照；叠加图从处理后的快照合成，两者尺寸一致。
  const sourceBytes: FittedBytes[] = [];
  for (const [i, src] of sources.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = await deps.readFile(src.absPath);
    } catch (e) {
      throw readError(`图${i + 1}（${src.label}）`, e);
    }
    sourceBytes.push(await fitForModel(deps, bytes, model));
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
      references.push({ ...sourceBytes[i], source, ...(slot.coordinateRegion ? { region: { ...slot.coordinateRegion, source_port: slot.port } } : {}) });
    } else {
      if (!deps.composeOverlay) throw new LocalError("框选修改区域需要叠加合成能力，当前环境不支持");
      const sourcePort = slot.sourcePort!;
      const region = slot.edge.region!;
      const composed = await deps.composeOverlay(sourceBytes[slot.userPort - 1].bytes, region.rects, firstRegion.get(slot.port)!);
      const overlay = await fitForModel(deps, composed, model);
      references.push({ ...overlay, source: { kind: "overlay", of: sourcePort }, region: { rects: region.rects, render: "highlight_overlay", source_port: sourcePort } });
    }
  }
  const submittedAt = deps.now();
  const taskId = newTaskId(submittedAt);
  const plan: SubmissionPlan = {
    taskId,
    submittedAt,
    model: model.model_id,
    prompt: snapshot.prompt,
    negativePrompt: snapshot.negative_prompt,
    send,
    sizeSpec: snapshot.size_spec,
    size,
    layerDecomposition: snapshot.layer_decomposition,
    ...(snapshot.output_options ? { outputOptions: snapshot.output_options } : {}),
    transparentBackground: snapshot.transparent_background,
    capabilityFormatVersion: table.format_version,
    capabilityTableSha256: args.tableSha256,
    references,
  };
  return { job: jobOf(taskNodeId, plan, model), lastSubmitted: { task_id: taskId, ...snapshot } };
}

function jobOf(taskNodeId: string, plan: SubmissionPlan, model: ModelCapability): PreparedJob {
  if (model.request_shape === "seedream_flash_images_generations" && (plan.layerDecomposition || plan.transparentBackground)) throw new LocalError("Flash 透明背景与图层拆分通路尚未实现");
  return {
    taskNodeId,
    taskId: plan.taskId,
    plan,
    input: { model, text: plan.send.text, nativeNegativePrompt: plan.send.nativeNegativePrompt, size: plan.size, references: [], outputOptions: plan.outputOptions, transparentBackground: plan.transparentBackground },
    record: {
      model: plan.model,
      prompt: plan.prompt,
      negative_prompt: plan.negativePrompt,
      size_spec: plan.sizeSpec,
      ...(plan.outputOptions ? { output_options: plan.outputOptions } : {}),
      submitted_at: plan.submittedAt.toISOString(),
    },
  };
}

/**
 * 重新生成：按任务节点上次提交的任务目录（task.json 与参考图快照）同参数再提交一次，
 * 不看画板当前内容；例外是自动宽高比——任务记录里不存「自动」，节点当前是自动时生成尺寸取节点当前算出的值。
 * 新任务、新结果节点；不写盘，同 prepareJob。
 * 生成变体：fromTaskId = 该结果的任务编号，按那次提交的任务目录重跑，新结果仍进本任务节点的结果列；
 * 不改 last_submitted，之后的「重新生成」仍重跑节点最近一次提交。
 */
export async function prepareRegenerate(
  deps: RunDeps,
  args: { board: Board; table: CapabilityTable; tableSha256: string; outputRoot: string; taskNodeId: string; fromTaskId?: string },
): Promise<Prepared> {
  const { board, outputRoot, taskNodeId } = args;
  const task = board.nodes.find((n) => n.id === taskNodeId);
  const last = task?.type === "task" ? task.last_submitted : null;
  const fromTaskId = args.fromTaskId ?? last?.task_id;
  if (!last || typeof fromTaskId !== "string" || !taskDirOfTaskId(fromTaskId)) throw new LocalError("任务节点没有可重新生成的提交");

  const { record: previous, references: snapshots } = await readSubmission(deps, outputRoot, fromTaskId);
  const model = findModel(args.table, previous.model);
  if (!model) throw new LocalError(`模型 ${previous.model} 已不在能力表内`);
  // 快照已按规则处理过，原样重发，不再处理；本次没处理，新任务记录不带 fitted。
  const references: SubmissionPlan["references"] = previous.references.map((ref, i) => ({ bytes: snapshots[i], source: ref.source, ...(ref.region ? { region: ref.region } : {}) }));
  if (model.request_shape === "seedream_flash_images_generations") {
    if (references.length > 10) throw new LocalError("Flash 参考图最多 10 张");
    for (const ref of references) await validateFlashReference(deps, ref.bytes, model.input_image_rule);
  }
  // 按当前规则重算发送计划，不重放 task.json 里的 send_text：旧任务可能按「叠加图占用户序号」的旧口径存（#113），
  // 固定句也要按当前能力表模板重建。
  const send = planSend(model, slotsFromReferences(previous.references), previous.prompt, previous.negative_prompt);
  if (model.request_shape === "seedream_flash_images_generations" && send.referenceProblems.issues.length) throw new LocalError(send.referenceProblems.issues.join("；"));

  // 自动宽高比（仅重新生成，生成变体始终按那次提交）：按节点当前的分辨率档与算出的宽高比；换算不出时仍按上次提交。
  const current = args.fromTaskId === undefined && task?.type === "task" && isAutoRatio(task.size_spec) ? task.size_spec : null;
  const currentSize = current && resolveSize(model.workflows[send.workflow].size_rule, current);
  const sized: Pick<SubmissionPlan, "sizeSpec" | "size"> =
    current && currentSize
      ? { sizeSpec: { tier: current.tier, ratio: current.ratio, width: current.width, height: current.height }, size: currentSize }
      : { sizeSpec: previous.size_spec, size: previous.size };

  const submittedAt = deps.now();
  const taskId = newTaskId(submittedAt);
  const plan: SubmissionPlan = {
    taskId,
    submittedAt,
    model: previous.model,
    prompt: previous.prompt,
    negativePrompt: previous.negative_prompt,
    send,
    ...sized,
    layerDecomposition: previous.layer_decomposition,
    ...(previous.output_options ? { outputOptions: previous.output_options } : {}),
    transparentBackground: previous.transparent_background,
    capabilityFormatVersion: args.table.format_version,
    capabilityTableSha256: args.tableSha256,
    references,
  };
  const lastSubmitted = args.fromTaskId !== undefined ? undefined : { ...last, task_id: taskId, size_spec: sized.sizeSpec };
  return { job: jobOf(taskNodeId, plan, model), lastSubmitted };
}

/** 派发时写任务目录（不可变）；返回带任务目录与参考图的任务。429 重试不重写。 */
export async function writeJob(deps: RunDeps, outputRoot: string, job: PreparedJob): Promise<WrittenJob> {
  try {
    const { relDir, references } = await writeSubmission(deps, outputRoot, job.plan);
    return { ...job, relDir, input: { ...job.input, references } };
  } catch (e) {
    throw new LocalError(`写任务目录失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 调网关并存结果图；返回落盘的结果（由画板编辑加成结果节点）。生成请求只发一次。 */
export async function executeJob(
  deps: RunDeps,
  args: {
    job: WrittenJob;
    outputRoot: string;
    baseUrl: string;
    apiKey: string;
    signal?: AbortSignal;
    /** 结果图下载结束（日志用）；取消不回调。 */
    onDownload?: (result: { ok: true; images: number } | { ok: false; error: unknown }) => void;
  },
): Promise<RunResult> {
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
      if (job.input.model.request_shape === "seedream_flash_images_generations" && !job.plan.layerDecomposition && !job.plan.transparentBackground) await validateFlashOrdinaryOutput(deps, bytes);
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
  return { taskId: job.taskNodeId, submittedTaskId: job.taskId, file: saved.file, path: saved.path, record: job.record, layers };
}
