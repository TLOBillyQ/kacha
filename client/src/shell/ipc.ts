// Rust 壳命令的类型化封装；命令实现见 src-tauri/src/lib.rs。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { FetchLike } from "../core/gateway";
import type { MergeOutcome, MergeUnit, PackExportSpec } from "../core/boardPack";
import type { DirEntry } from "../core/relocate";

export interface AppPaths {
  default_output_root: string;
  app_data_dir: string;
}

export interface BoardTexts {
  main: string | null;
  bak: string | null;
}

export interface ImageInfo {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  has_alpha: boolean;
}

export interface PackageEntry {
  name: string;
  description: string;
  size: number;
  optional: boolean;
  contains_prompt: boolean;
}

/** 与 src-tauri/src/board_pack.rs 的 CANCELLED 一致：取消时命令以此 reject。 */
export const PACK_CANCELLED = "已取消";

export const ipc = {
  appPaths: () => invoke<AppPaths>("app_paths"),
  startupArgs: () => invoke<string[]>("startup_args"),
  readBoard: (path: string) => invoke<BoardTexts>("read_board", { path }),
  writeBoard: (path: string, text: string) => invoke<void>("write_board", { path, text }),
  renameBoard: (from: string, to: string) => invoke<void>("rename_board", { from, to }),
  listBoardNames: (dir: string) => invoke<string[]>("list_board_names", { dir }),
  readUiState: () => invoke<string | null>("read_ui_state"),
  writeUiState: (text: string) => invoke<void>("write_ui_state", { text }),
  readCapabilityOverride: () => invoke<string | null>("read_capability_override"),
  inspectImage: (path: string) => invoke<ImageInfo>("inspect_image", { path }),
  readSettings: () => invoke<string | null>("read_settings"),
  writeSettings: (text: string) => invoke<void>("write_settings", { text }),
  readModelsCache: () => invoke<string | null>("read_models_cache"),
  writeModelsCache: (text: string) => invoke<void>("write_models_cache", { text }),
  readPresets: () => invoke<string | null>("read_presets"),
  writePresets: (text: string) => invoke<void>("write_presets", { text }),
  logEvent: (kind: string, fields: Record<string, unknown>) => invoke<void>("log_event", { kind, fields }),
  diagnosticsPreview: (outputRoot: string | null, openBoards: string[]) => invoke<PackageEntry[]>("diagnostics_preview", { outputRoot, openBoards }),
  diagnosticsExport: (outputRoot: string | null, openBoards: string[], target: string, include: string[]) =>
    invoke<PackageEntry[]>("diagnostics_export", { outputRoot, openBoards, target, include }),
  boardPackExport: (outputRoot: string, target: string, spec: PackExportSpec) =>
    invoke<{ task_dirs: number; bytes: number }>("board_pack_export", { outputRoot, target, spec }),
  boardPackEntries: (pack: string) => invoke<string[]>("board_pack_entries", { pack }),
  boardPackReadTexts: (pack: string, names: string[]) => invoke<Record<string, string>>("board_pack_read_texts", { pack, names }),
  boardPackImport: (pack: string, outputRoot: string, units: MergeUnit[]) =>
    invoke<{ outcomes: { path: string; outcome: MergeOutcome }[]; bytes: number }>("board_pack_import", { pack, outputRoot, units }),
  /** 置取消标记；开始导出 / 导入前先以 false 复位。 */
  boardPackCancel: (cancelled: boolean) => invoke<void>("board_pack_cancel", { cancelled }),
  /** 系统凭据库；不可用时 reject（调用方退回会话内存）。 */
  secretGet: () => invoke<string | null>("secret_get"),
  secretSet: (key: string) => invoke<void>("secret_set", { key }),
  secretDelete: () => invoke<void>("secret_delete"),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  /** 任意文件的 sha256（流式，不要求是图片）。 */
  fileSha256: (path: string) => invoke<string>("file_sha256", { path }),
  isFile: (path: string) => invoke<boolean>("is_file", { path }),
  readFileBytes: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path })),
  /** 只新建不覆盖：目标已存在时 reject。 */
  writeNewFile: (path: string, bytes: Uint8Array) => invoke<void>("write_new_file", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
};

/** 网关请求走 Rust 侧 HTTP（不受 WebView CORS 限制）。 */
export const httpFetch: FetchLike = (url, init) => tauriFetch(url, init);

export const fileUrl = (absPath: string) => convertFileSrc(absPath);
