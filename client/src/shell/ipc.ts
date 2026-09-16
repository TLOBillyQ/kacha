// Rust 壳命令的类型化封装；命令实现见 src-tauri/src/lib.rs。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { FetchLike } from "../core/gateway";

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
  /** 系统凭据库；不可用时 reject（调用方退回会话内存）。 */
  secretGet: () => invoke<string | null>("secret_get"),
  secretSet: (key: string) => invoke<void>("secret_set", { key }),
  secretDelete: () => invoke<void>("secret_delete"),
  listDir: (path: string) => invoke<{ name: string; is_dir: boolean }[]>("list_dir", { path }),
  /** 是普通文件才为 true。 */
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  readFileBytes: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path })),
  /** 只新建不覆盖：目标已存在时 reject。 */
  writeNewFile: (path: string, bytes: Uint8Array) => invoke<void>("write_new_file", bytes, { headers: { "x-path": encodeURIComponent(path) } }),
};

/** 网关请求走 Rust 侧 HTTP（不受 WebView CORS 限制）。 */
export const httpFetch: FetchLike = (url, init) => tauriFetch(url, init);

export const fileUrl = (absPath: string) => convertFileSrc(absPath);
