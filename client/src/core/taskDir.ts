// 任务目录：输出根目录/<UTC 日期>/<task_id>/（ADR 0010，任务目录是真源）。
// 派发时一次写入参考图快照与 task.json，之后不可变；成功后再写结果图，失败 / 取消时写结局记录。文件系统由调用方注入。
import type { CapabilityTable } from "./capabilities";
import type { FittedRecord } from "./fitImage";
import type { LayerRecord, RegionRender } from "./board";

export type { LayerRecord };
import type { ReferenceImage } from "./gateway";
import { joinPath } from "./paths";
import type { SizeSpec } from "./size";

export interface TaskFs {
  /** 原子写新文件；目标已存在时失败。 */
  writeNewFile(absPath: string, bytes: Uint8Array): Promise<void>;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `YYYYMMDDTHHMMSSZ-xxxxxxxx`：可按时间排序，随机段避免同秒冲突。 */
export function newTaskId(now: Date, random32: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${stamp}-${(random32() >>> 0).toString(16).padStart(8, "0")}`;
}

/** 相对输出根目录的任务目录，正斜杠。 */
export function taskDirOf(submittedAt: Date, taskId: string): string {
  return `${submittedAt.toISOString().slice(0, 10)}/${taskId}`;
}

/** 由 task_id 开头的 UTC 时间戳还原任务目录；不是本工具生成的编号时为 null。 */
export function taskDirOfTaskId(taskId: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T\d{6}Z-/.exec(taskId);
  return m ? `${m[1]}-${m[2]}-${m[3]}/${taskId}` : null;
}

export function sniffImage(bytes: Uint8Array): { ext: string; mediaType: string } | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  const ascii = (text: string, offset = 0) => starts([...text].map((c) => c.charCodeAt(0)), offset);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mediaType: "image/png" };
  if (starts([0xff, 0xd8, 0xff])) return { ext: "jpg", mediaType: "image/jpeg" };
  if (ascii("RIFF") && ascii("WEBP", 8)) return { ext: "webp", mediaType: "image/webp" };
  if (ascii("GIF87a") || ascii("GIF89a")) return { ext: "gif", mediaType: "image/gif" };
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
  source_port: number;
}

export interface SubmissionPlan {
  taskId: string;
  submittedAt: Date;
  model: string;
  prompt: string;
  negativePrompt: string;
  sendText: string;
  /** 区域指示固定句（每个叠加参考图一句），追加在发送文本末尾。 */
  regionPhrases: string[];
  /** 区域编号的颜色指代（区域N 取第 N 个）；只参与发送文本，不单独落盘。 */
  regionNames?: string[];
  /** 用户序号 → 发送序号；只参与发送文本，不单独落盘（task.json 的 references[] 足以还原）。 */
  imageRefMap?: number[];
  sizeSpec: SizeSpec;
  size: { width: number; height: number };
  layerDecomposition: boolean;
  transparentBackground: boolean;
  capabilityFormatVersion: number;
  capabilityTableSha256: string;
  /** 按参考图序号排列；叠加图紧随其原图。bytes 是发给模型的快照；fitted = 按模型规则处理过。 */
  references: { bytes: Uint8Array; source: ReferenceSource; region?: ReferenceRegion; fitted?: FittedRecord }[];
}

function taskPath(outputRoot: string, relDir: string, file: string): string {
  return joinPath(outputRoot, ...relDir.split("/"), file);
}

/** 写参考图快照 reference-N.ext 与 task.json；返回发给网关的参考图。 */
export async function writeSubmission(fs: TaskFs, outputRoot: string, plan: SubmissionPlan): Promise<ReferenceImage[]> {
  const kinds = plan.references.map((ref, i) => {
    const kind = sniffImage(ref.bytes);
    if (!kind) throw new Error(`图${i + 1} 不是可识别的图片格式`);
    return kind;
  });
  const dir = taskDirOf(plan.submittedAt, plan.taskId);
  const references = [];
  for (const [i, ref] of plan.references.entries()) {
    const file = `reference-${i + 1}.${kinds[i].ext}`;
    await fs.writeNewFile(taskPath(outputRoot, dir, file), ref.bytes);
    references.push({ file, media_type: kinds[i].mediaType, sha256: await sha256Hex(ref.bytes), source: ref.source, ...(ref.region ? { region: ref.region } : {}), ...(ref.fitted ? { fitted: ref.fitted } : {}) });
  }
  const record = {
    task_id: plan.taskId,
    submitted_at: plan.submittedAt.toISOString(),
    workflow: plan.references.length ? "image_edit" : "text_to_image",
    model: plan.model,
    capability_format_version: plan.capabilityFormatVersion,
    capability_table_sha256: plan.capabilityTableSha256,
    prompt: plan.prompt,
    negative_prompt: plan.negativePrompt,
    send_text: plan.sendText,
    size_spec: plan.sizeSpec,
    size: plan.size,
    layer_decomposition: plan.layerDecomposition,
    transparent_background: plan.transparentBackground,
    references,
  };
  await fs.writeNewFile(taskPath(outputRoot, dir, "task.json"), new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`));
  return plan.references.map((ref, i) => ({ mediaType: kinds[i].mediaType, bytes: ref.bytes }));
}

/** 写结果图 result.<ext>；返回文件名与相对输出根目录的路径（画板结果节点的主引用）。 */
export async function saveResult(fs: TaskFs, outputRoot: string, relDir: string, bytes: Uint8Array): Promise<{ file: string; path: string }> {
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("结果不是可识别的图片");
  const file = `result.${kind.ext}`;
  await fs.writeNewFile(taskPath(outputRoot, relDir, file), bytes);
  return { file, path: `${relDir}/${file}` };
}

export interface LayerImage {
  bytes: Uint8Array;
  zIndex: number;
  boundingBox: number[];
}

/** 拆分图层落盘：按 z_index 升序写 layers/01.<ext>…；返回写盘后的图层记录。 */
export async function saveLayers(fs: TaskFs, outputRoot: string, relDir: string, layers: LayerImage[]): Promise<LayerRecord[]> {
  const ordered = [...layers].sort((a, b) => a.zIndex - b.zIndex);
  const out: LayerRecord[] = [];
  for (const [i, layer] of ordered.entries()) {
    const kind = sniffImage(layer.bytes);
    if (!kind) throw new Error(`图层${i + 1} 不是可识别的图片`);
    const file = `layers/${pad(i + 1)}.${kind.ext}`;
    await fs.writeNewFile(taskPath(outputRoot, relDir, file), layer.bytes);
    out.push({ file, z_index: layer.zIndex, bounding_box: layer.boundingBox });
  }
  return out;
}

/** 导出用 layers.json 内容：与结果记录里的 layers 一致。 */
export function layersExportJson(layers: LayerRecord[]): string {
  return `${JSON.stringify({ layers }, null, 2)}\n`;
}

/** 没有结果图的任务的结局；没有记录 = 上次进行中时程序异常退出（已中断）。 */
export type TaskOutcome = { kind: "failed"; label: string } | { kind: "cancelled"; gatewayMayContinue: boolean };

export const OUTCOME_FILE = "outcome.json";

/** 写结局记录 outcome.json：只含脱敏的错误类别，不含提示词、密钥与网关原文。 */
export async function writeOutcome(fs: TaskFs, outputRoot: string, relDir: string, outcome: TaskOutcome): Promise<void> {
  const record = outcome.kind === "failed" ? { outcome: "failed", label: outcome.label } : { outcome: "cancelled", gateway_may_continue: outcome.gatewayMayContinue };
  await fs.writeNewFile(taskPath(outputRoot, relDir, OUTCOME_FILE), new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`));
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
