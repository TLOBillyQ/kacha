// 画板文件：输出根目录/画板/<标题>.ugcboard.json。
// 任务目录是真源、画板只是视图；本模块只负责文件格式的读写、版本与未知字段保留、文件名派生。
import { outputOptions, type OutputOptions } from "./gateway";
import type { AutoRatio, SizeSpec } from "./size";

export const BOARD_FORMAT_VERSION = 1;
export const BOARD_EXTENSION = ".ugcboard.json";
export const DEFAULT_BOARD_TITLE = "未命名画板";

type Json = Record<string, unknown>;
type Vec2 = [number, number];

/** 区域指示的渲染方式：画板区域记录与能力表 region_hint 共用。 */
export type RegionRender = "highlight_overlay" | "marked_image" | "bbox_tag";
export interface Region {
  rects: [number, number, number, number][];
  render: RegionRender;
  /** 坐标表达以矩形中心为 point 或矩形边界为 bbox；提示坐标为0–999。 */
  coordinate_kind?: "point" | "bbox";
}

interface NodeBase {
  id: string;
  pos: Vec2;
  size: Vec2;
  /** 本版本不认识的字段，写回时原样保留。 */
  extra: Json;
}

export interface PromptNode extends NodeBase {
  type: "prompt";
  text: string;
}

export interface ReferenceNode extends NodeBase {
  type: "reference";
  /** 输出根目录内为相对路径，根目录外为绝对路径。 */
  path: string;
  sha256: string;
  display_name: string;
}

export interface TaskNode extends NodeBase {
  type: "task";
  model: string;
  size_spec: SizeSpec;
  image_ports: number;
  layer_decomposition: boolean;
  transparent_background: boolean;
  /** 缺省沿用 url/png/false；仅适用于 Flash。 */
  output_options?: OutputOptions;
  /** 脏判据快照；未提交过为 null。本切片只读写不解释。 */
  last_submitted: Json | null;
}

export interface LayerRecord {
  /** 相对任务目录，形如 layers/01.png（按 z_index 升序编号）。 */
  file: string;
  z_index: number;
  /** Flash 图层为 { absolute, normalized }；旧结果为旧版四元数组。 */
  bounding_box: number[] | import("./gateway").LayerBoundingBox;
  /** 可选元数据（官方按可选返回，不臆造）。 */
  name?: string;
  description?: string;
}

export interface ResultRecord {
  model: string;
  prompt: string;
  negative_prompt: string;
  size_spec: SizeSpec;
  submitted_at: string;
  /** 拆分图层（有图层时写入）。 */
  layers?: LayerRecord[];
  [key: string]: unknown;
}

export interface ResultNode extends NodeBase {
  type: "result";
  task_id: string;
  file: string;
  /** 相对输出根目录，主引用。 */
  path: string;
  layer_count: number;
  record: ResultRecord;
}

/** 本版本不认识的节点类型：整条原样保留，不渲染。 */
export interface UnknownNode {
  type: "unknown";
  id: string;
  raw: Json;
}

export type BoardNode = PromptNode | ReferenceNode | TaskNode | ResultNode | UnknownNode;
export type KnownNode = Exclude<BoardNode, UnknownNode>;

export type PortRef = [string, string];

export interface BoardEdge {
  from: PortRef;
  to: PortRef;
  source_layer: number | null;
  region: Region | null;
  system: boolean;
  extra: Json;
}

export interface Board {
  format_version: number;
  title: string;
  viewport: { zoom: number; x: number; y: number };
  nodes: BoardNode[];
  edges: BoardEdge[];
  /** 画板级最近选择的模型，新建任务节点默认用它；缺省 = 从未选过。 */
  last_model?: string | null;
  extra: Json;
}

export type ParsedBoard =
  | { kind: "ok"; board: Board }
  | { kind: "newer"; version: number }
  | { kind: "corrupt"; reason: string };

export function newBoard(title = DEFAULT_BOARD_TITLE): Board {
  return {
    format_version: BOARD_FORMAT_VERSION,
    title,
    viewport: { zoom: 1, x: 0, y: 0 },
    nodes: [],
    edges: [],
    extra: {},
  };
}

// ---- 读 ----

class Corrupt extends Error {}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function need<T>(ok: boolean, value: unknown, what: string): T {
  if (!ok) throw new Corrupt(what);
  return value as T;
}
const str = (o: Json, k: string) => need<string>(typeof o[k] === "string", o[k], `${k} 必须是字符串`);
const num = (o: Json, k: string) => need<number>(typeof o[k] === "number" && Number.isFinite(o[k]), o[k], `${k} 必须是数字`);
const bool = (o: Json, k: string) => need<boolean>(typeof o[k] === "boolean", o[k], `${k} 必须是布尔值`);
const vec2 = (o: Json, k: string) =>
  need<Vec2>(Array.isArray(o[k]) && (o[k] as unknown[]).length === 2 && (o[k] as unknown[]).every((n) => typeof n === "number"), o[k], `${k} 必须是 [x, y]`);
const obj = (o: Json, k: string) => need<Json>(isObject(o[k]), o[k], `${k} 必须是对象`);
const nullableObj = (o: Json, k: string) => need<Json | null>(o[k] === null || isObject(o[k]), o[k], `${k} 必须是对象或 null`);

function extraOf(raw: Json, known: readonly string[]): Json {
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !known.includes(k)));
}

function sizeSpec(o: Json, k: string): SizeSpec {
  const s = obj(o, k);
  const nullableStr = (key: string) => need<string | null>(s[key] === null || typeof s[key] === "string", s[key], `${k}.${key} 无效`);
  const nullableNum = (key: string) => need<number | null>(s[key] === null || typeof s[key] === "number", s[key], `${k}.${key} 无效`);
  // 保留 size_spec 内未知字段：直接沿用原对象。
  const spec: SizeSpec = { ...s, tier: nullableStr("tier"), ratio: nullableStr("ratio"), width: nullableNum("width"), height: nullableNum("height") };
  // 自动宽高比标记：没有（0.2.0 及更早的画板）或格式不对 = 手动。
  if ("auto_ratio" in s) spec.auto_ratio = autoRatio(s.auto_ratio);
  return spec;
}

function autoRatio(raw: unknown): AutoRatio | null {
  if (!isObject(raw) || typeof raw.ratio !== "string") return null;
  const image = typeof raw.image === "number" && Number.isInteger(raw.image) && raw.image > 0 ? raw.image : null;
  const src = raw.source;
  const source = Array.isArray(src) && src.length === 2 && src.every((n) => typeof n === "number" && n > 0) ? (src as [number, number]) : null;
  return { ratio: raw.ratio, image, source };
}

const NODE_KEYS = {
  prompt: ["id", "type", "pos", "size", "text"],
  reference: ["id", "type", "pos", "size", "path", "sha256", "display_name"],
  task: ["id", "type", "pos", "size", "model", "size_spec", "image_ports", "layer_decomposition", "transparent_background", "output_options", "last_submitted"],
  result: ["id", "type", "pos", "size", "task_id", "file", "path", "layer_count", "record"],
} as const;

function parseNode(raw: unknown): BoardNode {
  const o = need<Json>(isObject(raw), raw, "节点必须是对象");
  const id = str(o, "id");
  const type = str(o, "type");
  if (!(type in NODE_KEYS)) return { type: "unknown", id, raw: o };
  const base = { id, pos: vec2(o, "pos"), size: vec2(o, "size"), extra: extraOf(o, NODE_KEYS[type as keyof typeof NODE_KEYS]) };
  switch (type) {
    case "prompt":
      return { ...base, type, text: str(o, "text") };
    case "reference":
      return { ...base, type, path: str(o, "path"), sha256: str(o, "sha256"), display_name: str(o, "display_name") };
    case "task":
      return {
        ...base,
        type,
        model: str(o, "model"),
        size_spec: sizeSpec(o, "size_spec"),
        image_ports: num(o, "image_ports"),
        layer_decomposition: bool(o, "layer_decomposition"),
        transparent_background: bool(o, "transparent_background"),
        ...(o.output_options === undefined ? {} : { output_options: outputOptions(o.output_options as OutputOptions) }),
        last_submitted: nullableObj(o, "last_submitted"),
      };
    default: {
      const record = obj(o, "record");
      return {
        ...base,
        type: "result",
        task_id: str(o, "task_id"),
        file: str(o, "file"),
        path: str(o, "path"),
        layer_count: num(o, "layer_count"),
        record: {
          ...record,
          model: str(record, "model"),
          prompt: str(record, "prompt"),
          negative_prompt: str(record, "negative_prompt"),
          size_spec: sizeSpec(record, "size_spec"),
          submitted_at: str(record, "submitted_at"),
        },
      };
    }
  }
}

function portRef(o: Json, k: string): PortRef {
  const v = o[k];
  return need<PortRef>(Array.isArray(v) && v.length === 2 && v.every((s) => typeof s === "string"), v, `${k} 必须是 [节点, 端口]`);
}

const EDGE_KEYS = ["from", "to", "source_layer", "region", "system"];

function parseEdge(raw: unknown): BoardEdge {
  const o = need<Json>(isObject(raw), raw, "连线必须是对象");
  const layer = o.source_layer ?? null;
  const region = o.region ?? null;
  return {
    from: portRef(o, "from"),
    to: portRef(o, "to"),
    source_layer: need<number | null>(layer === null || typeof layer === "number", layer, "source_layer 无效"),
    region: need<Region | null>(region === null || (isObject(region) && Array.isArray(region.rects) && typeof region.render === "string"), region, "region 无效"),
    system: o.system === true,
    extra: extraOf(o, EDGE_KEYS),
  };
}

const BOARD_KEYS = ["format_version", "title", "viewport", "nodes", "edges", "last_model"];

export function parseBoard(text: string): ParsedBoard {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt", reason: "不是有效的 JSON" };
  }
  try {
    const o = need<Json>(isObject(raw), raw, "顶层必须是对象");
    const version = o.format_version;
    if (!Number.isInteger(version) || (version as number) < 1) throw new Corrupt("format_version 必须是正整数");
    if ((version as number) > BOARD_FORMAT_VERSION) return { kind: "newer", version: version as number };
    const viewport = obj(o, "viewport");
    const board: Board = {
      format_version: version as number,
      title: str(o, "title"),
      viewport: { ...viewport, zoom: num(viewport, "zoom"), x: num(viewport, "x"), y: num(viewport, "y") },
      nodes: need<unknown[]>(Array.isArray(o.nodes), o.nodes, "nodes 必须是数组").map(parseNode),
      edges: need<unknown[]>(Array.isArray(o.edges), o.edges, "edges 必须是数组").map(parseEdge),
      extra: extraOf(o, BOARD_KEYS),
    };
    if (o.last_model !== undefined && o.last_model !== null) board.last_model = str(o, "last_model");
    return { kind: "ok", board };
  } catch (error) {
    if (error instanceof Corrupt || (error instanceof Error && error.message === "输出选项无效")) return { kind: "corrupt", reason: error.message };
    throw error;
  }
}

export type OpenedBoard =
  | { kind: "ok"; board: Board; recoveredFromBak: boolean }
  | { kind: "newer"; version: number }
  | { kind: "corrupt"; reason: string };

/** 主文件损坏（或缺失）时回退 .bak；主文件是更新版本时拒开、不碰 .bak。 */
export function openBoard(mainText: string | null, bakText: string | null): OpenedBoard {
  const main = mainText === null ? null : parseBoard(mainText);
  if (main?.kind === "ok") return { kind: "ok", board: main.board, recoveredFromBak: false };
  if (main?.kind === "newer") return main;
  const bak = bakText === null ? null : parseBoard(bakText);
  if (bak?.kind === "ok") return { kind: "ok", board: bak.board, recoveredFromBak: true };
  if (bak?.kind === "newer") return bak;
  return { kind: "corrupt", reason: main?.kind === "corrupt" ? main.reason : "画板文件不存在" };
}

// ---- 写 ----

function serializeNode(node: BoardNode): Json {
  if (node.type === "unknown") return node.raw;
  const { extra, ...known } = node;
  return { ...known, ...extra };
}

function serializeEdge(edge: BoardEdge): Json {
  if (edge.system) return { from: edge.from, to: edge.to, system: true, ...edge.extra };
  return { from: edge.from, to: edge.to, source_layer: edge.source_layer, region: edge.region, ...edge.extra };
}

/** UTF-8 缩进 JSON。不写选中状态、运行状态、撤销栈——它们根本不在 Board 里。 */
export function serializeBoard(board: Board): string {
  const out = {
    format_version: board.format_version,
    title: board.title,
    viewport: board.viewport,
    nodes: board.nodes.map(serializeNode),
    edges: board.edges.map(serializeEdge),
    ...(board.last_model ? { last_model: board.last_model } : {}),
    ...board.extra,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

// ---- 文件名 ----

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function fileStem(title: string): string {
  // 去 Windows / macOS 非法字符与控制字符；Windows 不允许结尾空格和点。
  // eslint-disable-next-line no-control-regex
  let stem = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim().replace(/[. ]+$/, "");
  if (!stem) stem = DEFAULT_BOARD_TITLE;
  if (WINDOWS_RESERVED.test(stem)) stem = `${stem}_`;
  return stem;
}

export function boardFileName(title: string): string {
  return `${fileStem(title)}${BOARD_EXTENSION}`;
}

/** 重名加 ` (2)`、` (3)`…；比较不区分大小写（Windows / macOS 默认文件系统），`self` 为当前文件名时不算重名。 */
export function uniqueBoardFileName(title: string, existing: string[], self?: string): string {
  const taken = new Set(existing.filter((n) => n !== self).map((n) => n.toLowerCase()));
  const stem = fileStem(title);
  for (let i = 1; ; i++) {
    const name = `${stem}${i === 1 ? "" : ` (${i})`}${BOARD_EXTENSION}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
