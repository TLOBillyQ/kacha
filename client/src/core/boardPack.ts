// 画板包（ADR 0013）：把一块画板连同它直接引用的任务目录与图片打成单个 .ugcpack，供另一台机器导入。
// 包格式的全部规则在这里：导出计划（带哪些任务目录 / 参考图、画板路径改写）、清单、导入前的版本与布局判定、
// 合并单元（任务目录按 task.json 比对，参考图按整文件比对）与结果文案。
// Rust 壳（src-tauri/src/board_pack.rs）只按给定条目与合并单元搬字节。文件系统由调用方注入。
import { parseBoard, serializeBoard, type Board, type BoardNode } from "./board";
import { BOARDS_DIR_NAME, basename, resolveFromRoot, toRootRelative } from "./paths";
import { TASK_RECORD_FILE, taskDirOfRelPath } from "./taskDir";

export const PACK_FORMAT_VERSION = 1;
export const PACK_EXTENSION = ".ugcpack";
/** 系统对话框的扩展名过滤器。 */
export const PACK_FILE_FILTER = { name: "画板包", extensions: [PACK_EXTENSION.slice(1)] };
export const PACK_MANIFEST = "manifest.json";
/** 不在任务目录里的参考图在包内（及导入后根目录内）的位置：导入参考图/<sha256>.<ext>。 */
export const IMPORTED_REFERENCES_DIR = "导入参考图";

export interface PackFs {
  isFile(absPath: string): Promise<boolean>;
  /** 任意文件的 sha256（不要求是可解码的图片）。 */
  sha256(absPath: string): Promise<string>;
}

export interface ExportPlan {
  /** 写进包里的画板：任务目录外的参考图已改写为导入参考图下的相对路径。 */
  board: Board;
  /** 整目录带上的任务目录，相对根目录（`<UTC 日期>/<task_id>`），去重排序。 */
  taskDirs: string[];
  /** 单独带上的参考图：本机绝对路径 → 包内路径。 */
  files: { source: string; entry: string }[];
  /** 缺图节点：照常导出，导入后仍为缺图占位。 */
  missing: { nodeId: string; path: string }[];
}

const isAbsolute = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "png";
}

export async function planExport(board: Board, outputRoot: string, fs: PackFs): Promise<ExportPlan> {
  const taskDirs = new Set<string>();
  const files = new Map<string, string>();
  const missing: ExportPlan["missing"] = [];
  const nodes: BoardNode[] = [];
  for (const node of board.nodes) {
    if (node.type !== "result" && node.type !== "reference") {
      nodes.push(node);
      continue;
    }
    const rel = toRootRelative(outputRoot, node.path);
    const absPath = resolveFromRoot(outputRoot, rel);
    const dir = isAbsolute(rel) ? null : taskDirOfRelPath(rel);
    if (dir) {
      taskDirs.add(dir);
      if (!(await fs.isFile(absPath).catch(() => false))) missing.push({ nodeId: node.id, path: node.path });
      nodes.push(rel === node.path ? node : { ...node, path: rel });
      continue;
    }
    // 任务目录外的图（根目录内外都算）：按 sha256 放进导入参考图；读不到（缺图）时原样保留。
    const sha256 = await fs.sha256(absPath).catch(() => null);
    if (sha256 === null) {
      missing.push({ nodeId: node.id, path: node.path });
      nodes.push(node);
      continue;
    }
    const entry = `${IMPORTED_REFERENCES_DIR}/${sha256}.${extensionOf(rel)}`;
    if (![...files.values()].includes(entry)) files.set(absPath, entry);
    nodes.push({ ...node, path: entry, ...(node.type === "reference" ? { sha256 } : {}) });
  }
  return {
    board: { ...board, nodes },
    taskDirs: [...taskDirs].sort(),
    files: [...files].map(([source, entry]) => ({ source, entry })),
    missing,
  };
}

// ---- 清单与导出规格 ----

const packBoardEntry = (boardFileName: string) => `${BOARDS_DIR_NAME}/${boardFileName}`;

export function buildManifest(appVersion: string, boards: string[]): string {
  return `${JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION, app_version: appVersion, boards }, null, 2)}\n`;
}

/** 交给壳的导出规格：文本条目直接写入，任务目录整目录、参考图逐个流式写入。 */
export interface PackExportSpec {
  texts: { entry: string; text: string }[];
  task_dirs: string[];
  files: { source: string; entry: string }[];
}

export function buildExportSpec(appVersion: string, boardFileName: string, plan: ExportPlan): PackExportSpec {
  const entry = packBoardEntry(boardFileName);
  return {
    texts: [
      { entry: PACK_MANIFEST, text: buildManifest(appVersion, [entry]) },
      { entry, text: serializeBoard(plan.board) },
    ],
    task_dirs: plan.taskDirs,
    files: plan.files,
  };
}

// ---- 导入前判定 ----

/** 合并单元：`identity` 为目录内用来判定「同一份」的文件；为 null 时单元本身是文件，按整文件比对。 */
export interface MergeUnit {
  path: string;
  identity: string | null;
}

type PackBoard = { entry: string; board: Board };
type Rejected = { kind: "newer"; message: string } | { kind: "corrupt"; reason: string };
export type PackCheck = { kind: "ok"; boards: PackBoard[]; units: MergeUnit[] } | Rejected;

const UPGRADE = "请升级本工具后再导入";

/** 版本判定：包格式版本或包内画板版本高于本机时拒绝（此时还没写任何文件）。 */
export function checkPack(manifestText: string | null, boardTexts: Record<string, string>): { kind: "ok"; boards: PackBoard[] } | Rejected {
  if (manifestText === null) return { kind: "corrupt", reason: `缺少 ${PACK_MANIFEST}` };
  let manifest: { pack_format_version?: unknown; app_version?: unknown; boards?: unknown };
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { kind: "corrupt", reason: `${PACK_MANIFEST} 不是有效的 JSON` };
  }
  const version = manifest?.pack_format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return { kind: "corrupt", reason: `${PACK_MANIFEST} 缺少包格式版本` };
  if ((version as number) > PACK_FORMAT_VERSION) {
    const by = typeof manifest.app_version === "string" ? `（由 ${manifest.app_version} 导出）` : "";
    return { kind: "newer", message: `该画板包的格式版本 ${version} 高于本机支持的 ${PACK_FORMAT_VERSION}${by}，${UPGRADE}` };
  }
  if (typeof manifest.app_version !== "string" || !Array.isArray(manifest.boards) || !manifest.boards.every((b) => typeof b === "string")) {
    return { kind: "corrupt", reason: `${PACK_MANIFEST} 格式无效` };
  }
  const boards: PackBoard[] = [];
  for (const entry of manifest.boards as string[]) {
    const text = boardTexts[entry];
    if (text === undefined) return { kind: "corrupt", reason: `包内缺少画板 ${entry}` };
    const parsed = parseBoard(text);
    if (parsed.kind === "newer") return { kind: "newer", message: `包内画板 ${basename(entry)} 由更新版本保存（format_version ${parsed.version}），${UPGRADE}` };
    if (parsed.kind === "corrupt") return { kind: "corrupt", reason: `包内画板 ${basename(entry)} 已损坏：${parsed.reason}` };
    boards.push({ entry, board: parsed.board });
  }
  return { kind: "ok", boards };
}

const isSafeSegment = (s: string) => s !== "" && s !== "." && s !== ".." && !/[\\:\p{Cc}]/u.test(s);

/**
 * 导入前检查：只读清单与画板文本判版本，再按条目名判布局。包内只允许清单、`画板/<文件>`、
 * `<日期>/<task_id>/…`（须含 task.json）与 `导入参考图/<文件>`；其他一律判为损坏，不解压任何内容。
 */
export async function inspectPack(entries: string[], readTexts: (names: string[]) => Promise<Record<string, string>>): Promise<PackCheck> {
  const isBoardEntry = (name: string) => {
    const parts = name.split("/");
    return parts.length === 2 && parts[0] === BOARDS_DIR_NAME;
  };
  const texts = await readTexts(entries.filter((name) => name === PACK_MANIFEST || isBoardEntry(name)));
  const versions = checkPack(texts[PACK_MANIFEST] ?? null, texts);
  if (versions.kind !== "ok") return versions;

  const taskDirs = new Set<string>();
  const references: string[] = [];
  const names = new Set(entries);
  for (const name of entries) {
    const parts = name.split("/");
    if (!parts.every(isSafeSegment)) return { kind: "corrupt", reason: `包内路径无效：${name}` };
    if (name === PACK_MANIFEST || isBoardEntry(name)) continue;
    const dir = taskDirOfRelPath(name);
    if (dir) taskDirs.add(dir);
    else if (parts.length === 2 && parts[0] === IMPORTED_REFERENCES_DIR) references.push(name);
    else return { kind: "corrupt", reason: `包内含无法识别的路径：${name}` };
  }
  for (const dir of taskDirs) {
    if (!names.has(`${dir}/${TASK_RECORD_FILE}`)) return { kind: "corrupt", reason: `任务目录 ${dir} 缺少 ${TASK_RECORD_FILE}` };
  }
  const units: MergeUnit[] = [
    ...[...taskDirs].sort().map((path) => ({ path, identity: TASK_RECORD_FILE })),
    ...references.sort().map((path) => ({ path, identity: null })),
  ];
  return { kind: "ok", boards: versions.boards, units };
}

// ---- 导入结果 ----

/** 壳对每个合并单元的处理：移入、本机已有且一致（跳过）、本机已有但不一致（冲突，不覆盖）。 */
export type MergeOutcome = "moved" | "identical" | "conflict";

export interface ImportSummary {
  /** 移入的任务目录数。 */
  imported: number;
  /** 本机已有且 task.json 一致、跳过的任务目录数。 */
  skipped: number;
  /** 不一致、未覆盖的包内路径（任务目录与参考图）。 */
  conflicts: string[];
  message: string;
}

export function importSummary(units: MergeUnit[], outcomes: { path: string; outcome: MergeOutcome }[]): ImportSummary {
  const taskDirs = new Set(units.filter((u) => u.identity !== null).map((u) => u.path));
  const count = (outcome: MergeOutcome) => outcomes.filter((o) => o.outcome === outcome && taskDirs.has(o.path)).length;
  const imported = count("moved");
  const skipped = count("identical");
  const conflicts = outcomes.filter((o) => o.outcome === "conflict").map((o) => o.path);
  const conflictText = conflicts.length ? `，${conflicts.length} 项冲突未覆盖` : "";
  return { imported, skipped, conflicts, message: `导入 ${imported} 个任务，跳过 ${skipped} 个${conflictText}` };
}
