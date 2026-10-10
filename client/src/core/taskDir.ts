// 任务目录：输出根目录/<UTC 日期>/<task_id>/（ADR 0010，任务目录是真源）。
// 派发时一次写入参考图快照与 task.json，之后不可变；成功后再写结果图，失败 / 取消时写结局记录。文件系统由调用方注入。
import type { CapabilityTable } from "./capabilities";
import type { FittedRecord } from "./fitImage";
import type { Board, LayerRecord, RegionRender } from "./board";
import { validLayerBox } from "./gateway";

export type { LayerRecord };
import type { ReferenceImage, OutputOptions } from "./gateway";
import { joinPath } from "./paths";
import type { SendPlan } from "./sendPlan";
import type { SizeSpec } from "./size";

export interface TaskFs {
  /** 原子写新文件；目标已存在时失败。 */
  writeNewFile(absPath: string, bytes: Uint8Array): Promise<void>;
  /** 读整个文件；不存在或读不了时失败。 */
  readFile(absPath: string): Promise<Uint8Array>;
}

/** 本地准备阶段的失败（读图、读写任务目录）。 */
export class LocalError extends Error {
  override name = "LocalError";
}

function readError(label: string, e: unknown): LocalError {
  return new LocalError(`读取${label}失败：${e instanceof Error ? e.message : String(e)}`);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `YYYYMMDDTHHMMSSZ-xxxxxxxx`：可按时间排序，随机段避免同秒冲突。 */
export function newTaskId(now: Date, random32: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${stamp}-${(random32() >>> 0).toString(16).padStart(8, "0")}`;
}

/** 相对输出根目录的任务目录，正斜杠；日期取提交时刻的 UTC 日期。 */
function taskDirOf(submittedAt: Date, taskId: string): string {
  return `${submittedAt.toISOString().slice(0, 10)}/${taskId}`;
}

/** 由 task_id 开头的 UTC 时间戳还原任务目录；不是本工具生成的编号时为 null。 */
export function taskDirOfTaskId(taskId: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T\d{6}Z-/.exec(taskId);
  return m ? `${m[1]}-${m[2]}-${m[3]}/${taskId}` : null;
}

/** 任务目录的第一层：UTC 日期目录。 */
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** 相对输出根目录的路径（正斜杠）落在 `<日期>/<task_id>/…` 里时返回任务目录，否则 null。 */
export function taskDirOfRelPath(rel: string): string | null {
  const parts = rel.split("/");
  return parts.length >= 3 && DATE_DIR.test(parts[0]) && parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

/** 任务目录里某个文件（相对任务目录，可含 `layers/` 这类子目录）的绝对路径；任务编号不是本工具生成的时为 null。 */
export function taskFilePath(outputRoot: string, taskId: string, file: string): string | null {
  const dir = taskDirOfTaskId(taskId);
  return dir ? taskPath(outputRoot, dir, file) : null;
}

export function sniffImage(bytes: Uint8Array): { ext: string; mediaType: string } | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (text: string, offset = 0) => starts([...text].map((c) => c.charCodeAt(0)), offset);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mediaType: "image/png" };
  if (starts([0xff, 0xd8, 0xff])) return { ext: "jpg", mediaType: "image/jpeg" };
  if (ascii("RIFF") && ascii("WEBP", 8)) return { ext: "webp", mediaType: "image/webp" };
  if (ascii("GIF87a") || ascii("GIF89a")) return { ext: "gif", mediaType: "image/gif" };
  if (ascii("ftyp", 4)) {
    const brands = [8, ...Array.from({ length: Math.max(0, Math.floor((Math.min(bytes.length, 64) - 16) / 4)) }, (_, i) => 16 + i * 4)];
    if (brands.some((offset) => ["heic", "heix", "hevc", "hevx"].some((brand) => ascii(brand, offset)))) return { ext: "heic", mediaType: "image/heic" };
    if (brands.some((offset) => ["mif1", "msf1"].some((brand) => ascii(brand, offset)))) return { ext: "heif", mediaType: "image/heif" };
  }
  if (ascii("BM")) return { ext: "bmp", mediaType: "image/bmp" };
  if (starts([0x49, 0x49, 0x2a, 0x00]) || starts([0x4d, 0x4d, 0x00, 0x2a])) return { ext: "tiff", mediaType: "image/tiff" };
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生效能力表（内置 + 覆盖合并后）的摘要，记入 task.json 便于追溯当时的能力判断。 */
export function tableDigest(table: CapabilityTable): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(table)));
}

export type ReferenceSource =
  | { kind: "reference"; path: string; sha256: string }
  | { kind: "result"; task_id: string; file: string; source_layer?: number | null }
  /** 区域叠加图：由第 of 张（1 起）参考图合成。 */
  | { kind: "overlay"; of: number };

/** 叠加参考图记录的区域：矩形（归一化）、渲染方式、原图端口序号。 */
export interface ReferenceRegion {
  rects: [number, number, number, number][];
  render: RegionRender;
  coordinate_kind?: "point" | "bbox";
  source_port: number;
}

export interface SubmissionPlan {
  taskId: string;
  submittedAt: Date;
  model: string;
  prompt: string;
  negativePrompt: string;
  /** 发送计划：task.json 的 workflow 与 send_text 取自这里，请求也发它的发送文本。 */
  send: SendPlan;
  sizeSpec: SizeSpec;
  size: { width: number; height: number };
  layerDecomposition: boolean;
  layerSize?: import("./gateway").LayerSize;
  transparentBackground: boolean;
  outputOptions?: OutputOptions;
  capabilityFormatVersion: number;
  capabilityTableSha256: string;
  /** 按参考图序号排列；叠加图紧随其原图。bytes 是发给模型的快照；fitted = 按模型规则处理过。 */
  references: { bytes: Uint8Array; source: ReferenceSource; region?: ReferenceRegion; fitted?: FittedRecord }[];
}

function taskPath(outputRoot: string, relDir: string, file: string): string {
  return joinPath(outputRoot, ...relDir.split("/"), file);
}

/** task.json 里的一条参考图记录。 */
export interface TaskRecordReference {
  /** 参考图快照文件名，相对任务目录。 */
  file: string;
  media_type: string;
  sha256: string;
  source: ReferenceSource;
  region?: ReferenceRegion;
  /** 发送前按模型规则处理过（#116）；#116 之前的任务目录没有，缺省即未处理。 */
  fitted?: FittedRecord;
}

/** 任务记录（task.json）：writeSubmission 写出、readSubmission 读回的同一份形状。 */
export interface TaskRecord {
  task_id: string;
  submitted_at: string;
  workflow: "image_edit" | "text_to_image";
  model: string;
  capability_format_version: number;
  capability_table_sha256: string;
  prompt: string;
  negative_prompt: string;
  /** 旧任务可能是旧口径（#113：叠加图占用户序号），仅供追溯；重新生成按当前规则重算。 */
  send_text: string;
  size_spec: SizeSpec;
  size: { width: number; height: number };
  layer_decomposition: boolean;
  layer_size?: import("./gateway").LayerSize;
  transparent_background: boolean;
  output_options?: OutputOptions;
  /** 按发送序号排列。 */
  references: TaskRecordReference[];
}

/** 写参考图快照 reference-N.ext 与 task.json；返回任务目录（相对输出根目录，正斜杠）与发给网关的参考图。 */
export async function writeSubmission(fs: Pick<TaskFs, "writeNewFile">, outputRoot: string, plan: SubmissionPlan): Promise<{ relDir: string; references: ReferenceImage[] }> {
  const kinds = plan.references.map((ref, i) => {
    const kind = sniffImage(ref.bytes);
    if (!kind) throw new Error(`图${i + 1} 不是可识别的图片格式`);
    return kind;
  });
  const dir = taskDirOf(plan.submittedAt, plan.taskId);
  const references: TaskRecordReference[] = [];
  for (const [i, ref] of plan.references.entries()) {
    const file = `reference-${i + 1}.${kinds[i].ext}`;
    await fs.writeNewFile(taskPath(outputRoot, dir, file), ref.bytes);
    references.push({ file, media_type: kinds[i].mediaType, sha256: await sha256Hex(ref.bytes), source: ref.source, ...(ref.region ? { region: ref.region } : {}), ...(ref.fitted ? { fitted: ref.fitted } : {}) });
  }
  const record: TaskRecord = {
    task_id: plan.taskId,
    submitted_at: plan.submittedAt.toISOString(),
    workflow: plan.send.workflow,
    model: plan.model,
    capability_format_version: plan.capabilityFormatVersion,
    capability_table_sha256: plan.capabilityTableSha256,
    prompt: plan.prompt,
    negative_prompt: plan.negativePrompt,
    send_text: plan.send.text,
    size_spec: plan.sizeSpec,
    size: plan.size,
    layer_decomposition: plan.layerDecomposition,
    ...(plan.layerSize ? { layer_size: plan.layerSize } : {}),
    ...(plan.outputOptions ? { output_options: plan.outputOptions } : {}),
    transparent_background: plan.transparentBackground,
    references,
  };
  await fs.writeNewFile(taskPath(outputRoot, dir, TASK_RECORD_FILE), new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`));
  return { relDir: dir, references: plan.references.map((ref, i) => ({ mediaType: kinds[i].mediaType, bytes: ref.bytes })) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** 快照文件名只能是任务目录里的普通文件名，不许带目录。 */
const isPlainFileName = (v: unknown): v is string => typeof v === "string" && v !== "" && !/[\\/]/.test(v) && v !== "." && v !== "..";

/** 解析 task.json；只校验重新生成必需的字段（model、prompt、size、references[].file / source），不合格即损坏。 */
function parseTaskRecord(bytes: Uint8Array): TaskRecord {
  const corrupt = () => new LocalError("上次任务的任务记录已损坏");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw corrupt();
  }
  const valid =
    isObject(raw) &&
    typeof raw.model === "string" &&
    typeof raw.prompt === "string" &&
    isObject(raw.size) &&
    typeof raw.size.width === "number" &&
    typeof raw.size.height === "number" &&
    Array.isArray(raw.references) &&
    raw.references.every(
      (ref) =>
        isObject(ref) &&
        isPlainFileName(ref.file) &&
        isObject(ref.source) &&
        typeof ref.source.kind === "string" &&
        (ref.region === undefined || (isObject(ref.region) && Array.isArray(ref.region.rects) && typeof ref.region.source_port === "number")),
    );
  if (!valid) throw corrupt();
  // 只校验重新生成读到的字段（model / prompt / size / references 的 file、source、region）；其余字段按写入口径信任，仅供追溯。
  return raw as unknown as TaskRecord;
}

/**
 * 读回一次提交：任务记录与全部参考图快照（references 与 record.references 同序），与 writeSubmission 对称。
 * 只校验重新生成必需的字段；未知字段忽略，fitted / region 缺省即旧口径。
 */
export async function readSubmission(fs: Pick<TaskFs, "readFile">, outputRoot: string, taskId: string): Promise<{ record: TaskRecord; references: Uint8Array[] }> {
  const dir = taskDirOfTaskId(taskId);
  if (!dir) throw new LocalError(`上次任务的任务编号无效：${taskId}`);
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(taskPath(outputRoot, dir, TASK_RECORD_FILE));
  } catch (e) {
    throw readError("上次任务的任务记录", e);
  }
  const record = parseTaskRecord(bytes);
  const references: Uint8Array[] = [];
  for (const [i, ref] of record.references.entries()) {
    try {
      references.push(await fs.readFile(taskPath(outputRoot, dir, ref.file)));
    } catch (e) {
      throw readError(`上次任务的图${i + 1}`, e);
    }
  }
  return { record, references };
}

/** 写结果图 result.<ext>；返回文件名与相对输出根目录的路径（画板结果节点的主引用）。 */
export async function saveResult(fs: Pick<TaskFs, "writeNewFile">, outputRoot: string, relDir: string, bytes: Uint8Array): Promise<{ file: string; path: string }> {
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("结果不是可识别的图片");
  const file = `result.${kind.ext}`;
  await fs.writeNewFile(taskPath(outputRoot, relDir, file), bytes);
  return { file, path: `${relDir}/${file}` };
}

export interface LayerImage {
  bytes: Uint8Array;
  zIndex: number;
  boundingBox: LayerRecord["bounding_box"];
  name?: string;
  description?: string;
}

/** 图层文件名（相对任务目录）：layers/<两位序号>.<ext>，序号 1 起、按 z_index 升序。 */
export function layerFileName(index: number, ext = "png"): string {
  return `layers/${pad(index)}.${ext}`;
}

/** 拆分图层落盘：按 z_index 升序写 layers/01.<ext>…；返回写盘后的图层记录。 */
export async function saveLayers(fs: Pick<TaskFs, "writeNewFile">, outputRoot: string, relDir: string, layers: LayerImage[], metadata?: { base: { z_index: 0; name?: string; description?: string } }): Promise<LayerRecord[]> {
  const ordered = [...layers].sort((a, b) => a.zIndex - b.zIndex);
  const out: LayerRecord[] = [];
  for (const [i, layer] of ordered.entries()) {
    const kind = sniffImage(layer.bytes);
    if (!kind) throw new Error(`图层${i + 1} 不是可识别的图片`);
    const file = layerFileName(i + 1, kind.ext);
    await fs.writeNewFile(taskPath(outputRoot, relDir, file), layer.bytes);
    out.push({ file, z_index: layer.zIndex, bounding_box: layer.boundingBox, ...(layer.name !== undefined ? { name: layer.name } : {}), ...(layer.description !== undefined ? { description: layer.description } : {}) });
  }
  await fs.writeNewFile(taskPath(outputRoot, relDir, "layers.json"), new TextEncoder().encode(layersExportJson(out, metadata?.base)));
  return out;
}

export async function readLayers(fs: Pick<TaskFs, "readFile">, outputRoot: string, taskId: string): Promise<LayerRecord[] | null> {
  const path = taskFilePath(outputRoot, taskId, "layers.json");
  if (!path) return null;
  let bytes: Uint8Array;
  try { bytes = await fs.readFile(path); } catch { return null; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new LocalError("图层元数据损坏"); }
  const layers = (raw as { layers?: unknown })?.layers;
  if (!Array.isArray(layers) || layers.length > 16 || layers.some((l, i) => !isObject(l) || l.z_index !== i + 1 || typeof l.file !== "string" || !/^layers\/\d{2}\.png$/.test(l.file) || !validLayerBox(l.bounding_box) || (l.name !== undefined && typeof l.name !== "string") || (l.description !== undefined && typeof l.description !== "string"))) throw new LocalError("图层元数据损坏");
  return layers as LayerRecord[];
}

/** 打开时恢复任务目录真源；旧普通结果没有 layers.json，保持兼容。 */
export async function restoreResultLayers(fs: Pick<TaskFs, "readFile">, outputRoot: string, board: Board): Promise<Board> {
  const nodes = await Promise.all(board.nodes.map(async (node) => {
    if (node.type !== "result" || node.record.model !== "doubao-seedream-5-0-flash-260915") return node;
    const layers = await readLayers(fs, outputRoot, node.task_id);
    return layers === null ? node : { ...node, layer_count: layers.length, record: { ...node.record, layers } };
  }));
  return { ...board, nodes };
}

/** 导出用 layers.json 内容：与结果记录里的 layers 一致。 */
export function layersExportJson(layers: LayerRecord[], base?: { z_index: 0; name?: string; description?: string }): string {
  return `${JSON.stringify({ ...(base ? { base } : {}), layers }, null, 2)}\n`;
}

/** 没有结果图的任务的结局；没有记录 = 上次进行中时程序异常退出（已中断）。 */
export type TaskOutcome = { kind: "failed"; label: string } | { kind: "cancelled"; gatewayMayContinue: boolean };

/** 任务记录与结局记录的文件名（相对任务目录）。 */
export const TASK_RECORD_FILE = "task.json";
export const OUTCOME_FILE = "outcome.json";

/** 写结局记录 outcome.json：只含脱敏的错误类别，不含提示词、密钥与网关原文。 */
export async function writeOutcome(fs: Pick<TaskFs, "writeNewFile">, outputRoot: string, relDir: string, outcome: TaskOutcome): Promise<void> {
  const record = outcome.kind === "failed" ? { outcome: "failed", label: outcome.label } : { outcome: "cancelled", gateway_may_continue: outcome.gatewayMayContinue };
  await fs.writeNewFile(taskPath(outputRoot, relDir, OUTCOME_FILE), new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`));
}

/** 按任务编号读结局记录；没有记录、读不了或读不懂都为 null（无缓存，缓存归调用方）。 */
export async function readOutcome(fs: Pick<TaskFs, "readFile">, outputRoot: string, taskId: string): Promise<TaskOutcome | null> {
  const path = taskFilePath(outputRoot, taskId, OUTCOME_FILE);
  return path ? fs.readFile(path).then(parseOutcome, () => null) : null;
}

export function parseOutcome(bytes: Uint8Array): TaskOutcome | null {
  let raw: { outcome?: unknown; label?: unknown; gateway_may_continue?: unknown };
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (raw?.outcome === "failed" && typeof raw.label === "string") return { kind: "failed", label: raw.label };
  if (raw?.outcome === "cancelled") return { kind: "cancelled", gatewayMayContinue: raw.gateway_may_continue !== false };
  return null;
}
