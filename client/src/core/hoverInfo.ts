// 悬浮信息的内容：只读摘要，按行给出；弹出、摆放与样式在 ui/hoverInfo。
// 结果 = 模型、提示词全文（限 6 行）、尺寸、时间、任务号、透明 / 图层数、缺图原因；参考图 = 文件名与路径、像素尺寸、透明、警告原因；
// 参考图与作为任务输入的结果另带发送时的自动处理说明与不可修复的警告（按下游模型的输入规则）；
// 任务 = 模型、尺寸、不可运行原因、状态详情；连线 = 区域数、来源图层；置灰动作 = 不可用原因。提示词节点无。
import type { BoardEdge, ReferenceNode, ResultNode } from "./board";
import type { MenuItem } from "./contextMenu";
import { imagePortIndex } from "./graph";
import type { TaskStatus } from "./run";
import type { SizeSpec } from "./size";

export interface HoverLine {
  /** 行首字段名；null = 整行是一句话（原因、提示）。 */
  label: string | null;
  text: string;
  tone?: "error" | "warn";
  /** 最多显示的行数。 */
  clamp?: number;
  mono?: boolean;
}

export type HoverInfo = HoverLine[];

export const PROMPT_CLAMP_LINES = 6;
export const CANCELLED_HINT = "已取消本地等待，网关侧计算可能仍在继续";
export const INTERRUPTED_HINT = "上次程序异常退出时仍在执行，可重新生成";

/** 悬浮信息用到的图片信息子集；undefined = 未读到，null = 读取失败。 */
type ImageFacts = { width: number; height: number; has_alpha?: boolean } | null | undefined;

const line = (label: string | null, text: string, extra: Partial<HoverLine> = {}): HoverLine => ({ label, text, ...extra });
const missingLine = (path: string) => line(null, `图片缺失：${path}，可重新定位或选文件`, { tone: "error" });
const alphaLines = (image: ImageFacts) => (image?.has_alpha ? [line("透明", "带透明通道")] : []);
/** 发送时的自动处理说明（不标黄）在前，不可修复的警告在后。 */
const adviceLines = (notes: string[], warnings: string[]) => [...notes.map((n) => line(null, n)), ...warnings.map((w) => line(null, w, { tone: "warn" as const }))];

export function sizeSpecText(spec: SizeSpec): string {
  return spec.tier !== null ? `${spec.tier} · ${spec.ratio ?? "?"}` : `${spec.width ?? "?"}×${spec.height ?? "?"}`;
}

export function resultHoverInfo({
  node,
  modelName,
  image,
  missing,
  notes = [],
  warnings = [],
  formatTime = (d) => d.toLocaleString(),
}: {
  node: ResultNode;
  modelName: string;
  image: ImageFacts;
  missing: boolean;
  notes?: string[];
  warnings?: string[];
  formatTime?: (d: Date) => string;
}): HoverInfo {
  const { record } = node;
  const time = new Date(record.submitted_at);
  return [
    ...(missing ? [missingLine(node.path)] : []),
    line("模型", modelName),
    line("提示词", record.prompt, { clamp: PROMPT_CLAMP_LINES }),
    line("尺寸", sizeSpecText(record.size_spec)),
    line("时间", Number.isNaN(time.getTime()) ? record.submitted_at : formatTime(time)),
    line("任务", node.task_id, { mono: true }),
    ...alphaLines(image),
    ...(node.layer_count > 0 ? [line("图层", `${node.layer_count} 个图层`)] : []),
    ...adviceLines(notes, warnings),
  ];
}

export function referenceHoverInfo({
  node,
  image,
  missing,
  warnings,
  notes = [],
}: {
  node: ReferenceNode;
  image: ImageFacts;
  missing: boolean;
  warnings: string[];
  notes?: string[];
}): HoverInfo {
  return [
    ...(missing ? [missingLine(node.path)] : []),
    line("文件", node.display_name),
    line("路径", node.path, { mono: true }),
    ...(image ? [line("像素", `${image.width}×${image.height}`)] : []),
    ...alphaLines(image),
    ...adviceLines(notes, warnings),
  ];
}

function statusLine(status: TaskStatus): HoverLine {
  switch (status.kind) {
    case "queued":
      return line("状态", "排队中");
    case "running":
      return line("状态", "执行中");
    case "backoff":
      return line("状态", "网关限流，等待重试");
    case "failed":
      return line("状态", `失败：${status.label}`, { tone: "error" });
    case "cancelled":
      return line("状态", status.gatewayMayContinue ? `已取消：${CANCELLED_HINT}` : "已取消");
    case "interrupted":
      return line("状态", `已中断：${INTERRUPTED_HINT}`);
  }
}

/** 任务节点的尺寸一行：「2K · 自动（16:9 · 图1）」；ratioNote 为宽高比的显示文本，没有时按原值。 */
export function taskSizeText(sizeSpec: SizeSpec, ratioNote: string | null): string {
  return ratioNote !== null && sizeSpec.tier !== null ? `${sizeSpec.tier} · ${ratioNote}` : sizeSpecText(sizeSpec);
}

export function taskHoverInfo({
  modelName,
  sizeSpec,
  ratioNote = null,
  issues,
  warnings,
  status,
}: {
  modelName: string;
  sizeSpec: SizeSpec;
  /** 宽高比的显示文本（自动状态为「自动（16:9 · 图1）」）；缺省按 size_spec 原样。 */
  ratioNote?: string | null;
  /** 不可运行原因。 */
  issues: string[];
  warnings: string[];
  status: TaskStatus | null;
}): HoverInfo {
  return [
    line("模型", modelName),
    line("尺寸", taskSizeText(sizeSpec, ratioNote)),
    ...(status ? [statusLine(status)] : []),
    ...issues.map((i) => line(null, i, { tone: "error" })),
    ...warnings.map((w) => line(null, w, { tone: "warn" })),
  ];
}

/** 用户图片线才有：区域数与来源图层；提示词线、系统连线为空。 */
export function edgeHoverInfo(edge: BoardEdge): HoverInfo {
  if (edge.system || imagePortIndex(edge.to[1]) === null) return [];
  const rects = edge.region?.rects.length ?? 0;
  return [line("区域", rects ? `${rects} 个修改区域` : "未框选"), line("来源", edge.source_layer === null ? "合成图" : `图层 ${edge.source_layer}`)];
}

/** 动作条 / 菜单条目：动作名，置灰时加不可用原因。 */
export function actionHoverInfo(item: MenuItem): HoverInfo {
  return [line(null, item.label), ...(item.disabledReason ? [line(null, item.disabledReason, { tone: "error" })] : [])];
}

/** 单句说明（替换画布上原生 title 的说明文字）。 */
export const textHoverInfo = (text: string): HoverInfo => [line(null, text)];

/** 任务端口行缩略图：文件名 + 点击行为。 */
export const portThumbHoverInfo = (fileName: string, click: string): HoverInfo => [line("文件", fileName), line(null, `点击：${click}`)];
