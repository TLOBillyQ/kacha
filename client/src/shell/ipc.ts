// Rust 壳命令的类型化封装；命令实现见 src-tauri/src/lib.rs。
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

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
};

export const fileUrl = (absPath: string) => convertFileSrc(absPath);
