// 画板包（ADR 0013）：把一块画板连同它直接引用的任务目录与图片打成单个 .ugcpack，供另一台机器导入。
// 本模块只管包格式：导出计划（带哪些任务目录 / 文件、画板路径改写）、清单、导入前的版本判定与结果文案。
// zip 读写、解压与原子移入在 Rust 壳（src-tauri/src/board_pack.rs）。文件系统由调用方注入。
import { parseBoard, type Board, type BoardNode } from "./board";
import { BOARDS_DIR_NAME, basename, resolveFromRoot, toRootRelative } from "./paths";

export const PACK_FORMAT_VERSION = 1;
export const PACK_EXTENSION = ".ugcpack";
/** 输出根目录外的参考图在包内（及导入后根目录内）的位置：导入参考图/<sha256>.<ext>。 */
export const IMPORTED_REFERENCES_DIR = "导入参考图";

export interface PackFs {
  isFile(absPath: string): Promise<boolean>;
  sha256(absPath: string): Promise<string>;
}

export interface ExportPlan {
  /** 写进包里的画板：根目录外参考图已改写为相对路径。 */
  board: Board;
  /** 整目录带上的任务目录，相对根目录（`<UTC 日期>/<task_id>`），去重排序。 */
  taskDirs: string[];
  /** 单独带上的文件：本机绝对路径 → 包内路径。 */
  files: { source: string; entry: string }[];
  /** 缺图节点：照常导出，导入后仍为缺图占位。 */
  missing: { nodeId: string; path: string }[];
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const isAbsolute = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

/** 相对路径落在 `<日期>/<task_id>/…` 里时返回任务目录。 */
function taskDirOfRelPath(rel: string): string | null {
  const parts = rel.split("/");
  return parts.length >= 3 && DATE_DIR.test(parts[0]) && parts[1] ? `${parts[0]}/${parts[1]}` : null;
}

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
    if (isAbsolute(rel)) {
      // 根目录外的图：按 sha256 带上文件并改写为相对路径；读不到（缺图）时原样保留。
      const sha256 = await fs.sha256(absPath).catch(() => null);
      if (sha256 === null) {
        missing.push({ nodeId: node.id, path: node.path });
        nodes.push(node);
        continue;
      }
      const entry = `${IMPORTED_REFERENCES_DIR}/${sha256}.${extensionOf(rel)}`;
      if (![...files.values()].includes(entry)) files.set(absPath, entry);
      nodes.push({ ...node, path: entry, ...(node.type === "reference" ? { sha256 } : {}) });
      continue;
    }
    const present = await fs.isFile(absPath).catch(() => false);
    if (!present) missing.push({ nodeId: node.id, path: node.path });
    const dir = taskDirOfRelPath(rel);
    if (dir) taskDirs.add(dir);
    else if (present) files.set(absPath, rel);
    nodes.push(rel === node.path ? node : { ...node, path: rel });
  }
  return {
    board: { ...board, nodes },
    taskDirs: [...taskDirs].sort(),
    files: [...files].map(([source, entry]) => ({ source, entry })),
    missing,
  };
}

// ---- 清单 ----

export const packBoardEntry = (boardFileName: string) => `${BOARDS_DIR_NAME}/${boardFileName}`;

export function buildManifest(appVersion: string, boards: string[]): string {
  return `${JSON.stringify({ pack_format_version: PACK_FORMAT_VERSION, app_version: appVersion, boards }, null, 2)}\n`;
}

export type PackCheck =
  | { kind: "ok"; boards: { entry: string; board: Board }[] }
  | { kind: "newer"; message: string }
  | { kind: "corrupt"; reason: string };

const UPGRADE = "请升级本工具后再导入";

/** 导入前的判定：包格式版本或包内画板版本高于本机时拒绝（此时还没写任何文件）。 */
export function checkPack(manifestText: string | null, boardTexts: Record<string, string>): PackCheck {
  if (manifestText === null) return { kind: "corrupt", reason: "缺少 manifest.json" };
  let manifest: { pack_format_version?: unknown; app_version?: unknown; boards?: unknown };
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { kind: "corrupt", reason: "manifest.json 不是有效的 JSON" };
  }
  const version = manifest?.pack_format_version;
  if (!Number.isInteger(version) || (version as number) < 1) return { kind: "corrupt", reason: "manifest.json 缺少包格式版本" };
  if ((version as number) > PACK_FORMAT_VERSION) {
    const by = typeof manifest.app_version === "string" ? `（由 ${manifest.app_version} 导出）` : "";
    return { kind: "newer", message: `该画板包的格式版本 ${version} 高于本机支持的 ${PACK_FORMAT_VERSION}${by}，${UPGRADE}` };
  }
  if (typeof manifest.app_version !== "string" || !Array.isArray(manifest.boards) || !manifest.boards.every((b) => typeof b === "string")) {
    return { kind: "corrupt", reason: "manifest.json 格式无效" };
  }
  const boards: { entry: string; board: Board }[] = [];
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

// ---- 导入结果 ----

export interface ImportReport {
  /** 移入的任务目录数。 */
  imported: number;
  /** 本机已有且 task.json 一致、跳过的任务目录数。 */
  skipped: number;
  /** 本机已有但内容不一致、未覆盖的包内路径。 */
  conflicts: string[];
}

export function importSummary(report: ImportReport): { message: string; conflicts: string[] } {
  const conflictText = report.conflicts.length ? `，${report.conflicts.length} 项冲突未覆盖` : "";
  return { message: `导入 ${report.imported} 个任务，跳过 ${report.skipped} 个${conflictText}`, conflicts: report.conflicts };
}
