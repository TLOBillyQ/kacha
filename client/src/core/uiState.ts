// 界面状态：可随时丢弃并静默重置，不迁移（规格第 12 节）。

export interface UiState {
  window: { width: number; height: number } | null;
  open_boards: string[];
  active_board: string | null;
}

export const DEFAULT_UI_STATE: UiState = { window: null, open_boards: [], active_board: null };

export function parseUiState(text: string | null): UiState {
  if (text === null) return DEFAULT_UI_STATE;
  try {
    const raw = JSON.parse(text);
    const win = raw.window;
    const windowOk = win === null || (typeof win?.width === "number" && typeof win?.height === "number" && win.width > 0 && win.height > 0);
    const boardsOk = Array.isArray(raw.open_boards) && raw.open_boards.every((p: unknown) => typeof p === "string");
    if (!windowOk || !boardsOk) return DEFAULT_UI_STATE;
    const open: string[] = raw.open_boards;
    const active = open.includes(raw.active_board) ? raw.active_board : (open[0] ?? null);
    return { window: win === null ? null : { width: win.width, height: win.height }, open_boards: open, active_board: active };
  } catch {
    return DEFAULT_UI_STATE;
  }
}

export function serializeUiState(state: UiState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
